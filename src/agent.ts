import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createAgentSession, DefaultResourceLoader, loadSkills, ModelRuntime, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentConfig, Config } from './config.js';
import type { Engine, EngineRequest } from './types.js';
import { Services } from './services.js';
import { makeTools } from './tools.js';

export class PiEngine implements Engine {
  private models = new Map<string, Promise<ModelRuntime>>();
  constructor(private config: Config, private services: Services) {}

  async modelRuntime(agent: AgentConfig): Promise<ModelRuntime> {
    let runtime = this.models.get(agent.id);
    if (!runtime) {
      runtime = (async () => {
        const modelRuntime = await ModelRuntime.create({
          authPath: join(agent.directory, 'pi', 'auth.json'),
          modelsStorePath: join(agent.directory, 'pi', 'models-cache.json'),
          modelsPath: this.config.modelsFile ?? null,
          allowModelNetwork: false,
        });
        if (agent.model.apiKeyEnv) {
          const key = process.env[agent.model.apiKeyEnv];
          if (!key) throw new Error(`缺少模型环境变量 ${agent.model.apiKeyEnv}`);
          await modelRuntime.setRuntimeApiKey(agent.model.provider, key);
        }
        return modelRuntime;
      })();
      this.models.set(agent.id, runtime);
      runtime.catch(() => this.models.delete(agent.id));
    }
    return runtime;
  }

  async checkModels(): Promise<void> {
    for (const agent of this.config.agents) {
      const models = await this.modelRuntime(agent);
      if (!models.getModel(agent.model.provider, agent.model.id)) throw new Error(`未知模型 ${agent.model.provider}/${agent.model.id}；请修改配置或提供 modelsFile`);
      if (!models.hasConfiguredAuth(agent.model.provider)) throw new Error(`尚未配置 ${agent.model.provider} 模型认证`);
    }
  }

  async execute({ run, signal, onSession }: EngineRequest): Promise<string> {
    signal.throwIfAborted();
    const agent = this.config.agents.find(a => a.id === run.agent_id)!;
    const models = await this.modelRuntime(agent);
    const model = models.getModel(agent.model.provider, agent.model.id);
    if (!model) throw new Error(`未知模型 ${agent.model.provider}/${agent.model.id}`);
    const workspace = agent.workspace!;
    const agentDir = join(agent.directory, 'pi');
    const tools = makeTools(agent, run, this.services, signal);
    const shared = agent.sharedKnowledge.map(p => `文件 ${p}:\n${readFileSync(p, 'utf8')}`).join('\n\n');
    const systemPrompt = [
      `你是 MyClaw 的 ${agent.name}，Agent ID 为 ${agent.id}。用户时区是 ${this.config.timezone}。`,
      readFileSync(agent.persona, 'utf8'),
      '你通过飞书私聊服务用户。不要声称已执行尚未成功的工具操作。工具返回成功才代表已保存记录或计划。',
      '已有会话中的旧资料可能过时，以下私有记忆与共享知识是本次执行的最新版本。共享知识默认只读。',
      `私有记忆:\n${this.services.memory(agent)}`,
      `共享知识:\n${shared || '无'}`,
      '定时任务必须调用 schedule 工具保存，不要仅在回复中承诺。简单提醒使用 reminder，需推理或工具的任务使用 agent。',
      this.services.documents ? '读写飞书文档必须使用 feishu_doc_read / feishu_doc_write，支持 docx 链接和指向 docx 的 Wiki 链接。写入默认追加；只有用户明确要求替换全文时才使用 overwrite，不要对旧版 doc 或非 docx 的 Wiki 节点宣称写入成功。' : '',
      this.services.spreadsheets ? '读写飞书电子表格必须使用 feishu_sheet_read / feishu_sheet_write，支持 sheets 链接和指向电子表格的 Wiki 链接。写入默认追加；覆盖必须明确指定 range。先用读取结果中的工作表 ID 构造 range，不要把工作表标题当 ID。' : '',
      '用户询问最近的定时报告或执行结果时使用 recent_runs。除非用户要求更新计划，后台任务不能自行创建重复计划。',
      '健康记录只来自用户明确提供的数据。记录单位为公斤或当天累计运动分钟；有歧义先提问。',
      '将最终需要发送给用户的内容放在最后回复中。后台检查无需通知时，最终回复必须恰好为 [NO_REPLY]。',
    ].join('\n\n');
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace, agentDir, settingsManager,
      noExtensions: true, disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'],
      noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      systemPrompt,
      skillsOverride: () => loadSkills({ cwd: workspace, agentDir, skillPaths: agent.skills, includeDefaults: false }),
    });
    await resourceLoader.reload();
    signal.throwIfAborted();
    // Never silently discard a referenced but missing conversation.
    if (run.sdk_session && !existsSync(run.sdk_session)) throw new Error('SDK 会话文件丢失，请恢复备份或使用 /new');
    const manager = run.sdk_session
      ? SessionManager.open(run.sdk_session)
      : SessionManager.create(workspace, join(agent.directory, 'sessions'));
    const { session } = await createAgentSession({
      cwd: workspace, agentDir, modelRuntime: models, model, thinkingLevel: 'off',
      tools: [...agent.builtinTools, ...tools.map(t => t.name)], customTools: tools,
      settingsManager, resourceLoader, sessionManager: manager,
    });
    let modelError = false, budgetExceeded = false, calls = 0;
    const abort = () => { void session.abort().catch(() => {}); };
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'tool_execution_start' && ++calls > agent.maxToolCalls) { budgetExceeded = true; abort(); }
      if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') modelError = true;
      if (session.sessionFile) onSession(session.sessionFile);
    });
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      if (session.sessionFile) onSession(session.sessionFile);
      const timestamp = new Intl.DateTimeFormat('zh-CN', { timeZone: this.config.timezone, dateStyle: 'full', timeStyle: 'long' }).format();
      await session.prompt(`当前时间：${timestamp}\n任务来源：${run.kind === 'scheduled' ? '后台定时任务（独立会话）' : '用户私聊'}\n\n${run.input}`, { expandPromptTemplates: false });
      signal.throwIfAborted();
      if (budgetExceeded) throw new Error('超过本次工具调用上限');
      // Check the final assistant message: an earlier failed request may have recovered through SDK retry.
      const last = [...session.messages].reverse().find(m => m.role === 'assistant');
      if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) throw new Error('模型请求未成功完成');
      const answer = session.getLastAssistantText();
      if (!answer?.trim()) throw new Error(modelError ? '模型请求失败' : '模型未返回最终内容');
      return answer;
    } finally {
      signal.removeEventListener('abort', abort);
      unsubscribe();
      session.dispose();
    }
  }
}

export class DemoEngine implements Engine {
  async execute({ run, signal }: EngineRequest): Promise<string> {
    signal.throwIfAborted();
    return `[演示模式 · ${run.agent_id}] 收到：${run.input}\n此模式不调用模型。可用 /weight、/exercise、/remind、/schedule、/status 验证持久化和调度。`;
  }
}
