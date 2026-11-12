import type { Config } from './config.js';
import type { Engine, Inbound, Messenger, Run } from './types.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { localDay, log } from './util.js';

export const HELP = `MyClaw 命令：
/help 帮助
/status 当前任务、最近结果、发送失败数
/new 开启新会话（有任务时先 /stop 并等待结束）
/stop 停止当前任务并清空此聊天等待队列
/weight 72.3 [YYYY-MM-DD] 记录体重，单位 kg
/weights 查询最近体重
/exercise 30 [YYYY-MM-DD] 记录当天累计运动分钟
/remind 20:30 提醒内容（每天）
/once 2026-12-01T20:30:00+08:00 提醒内容
/schedule list
/schedule add {"name":"日报","cron":"0 21 * * *","action":"agent","prompt":"总结今天","misfire":"latest"}
/schedule pause|resume|delete <完整ID>
/schedule update <完整ID> <完整计划JSON>
自然语言任务会交给当前助理。`;

export class Dispatcher {
  private active = new Map<string, { run: Run; abort: AbortController; promise: Promise<void> }>();
  private reactions = new Map<string, Promise<{ message: Inbound; reactionId: string } | null>>();
  private delivering = false;
  private closing = false;
  constructor(readonly config: Config, readonly store: Store, readonly scheduler: Scheduler,
    private engine: Engine, private messenger: Messenger) {}

  receive(message: Inbound): void {
    const agent = this.config.agents.find(a => a.id === message.agentId);
    if (!agent || this.closing) return;
    if (message.text.length > 30000) message = { ...message, text: '/invalid-message-too-long' };
    let runId: string | undefined;
    this.store.transaction(() => {
      if (!this.store.accept(message)) return;
      const reply = (text: string) => this.store.queueReply(agent.id, message.chatId, text, `command:${agent.id}:${message.messageId}`);
      try {
        const text = message.text.trim();
        if (!text) return;
        if (text === '/unsupported') return reply('暂不支持这种消息。可发送文字、图片、语音或普通文件；暂不支持合并转发、卡片内附件和表情资源。');
        if (text === '/media-download-failed') return reply('附件下载失败或超过大小限制。图片最大 10 MB，语音和文件最大 30 MB，请重试。');
        if (text === '/audio-too-long') return reply('语音已超过 60 秒，当前无法转写；请缩短语音，或将音频作为文件发送。');
        if (text === '/audio-empty') return reply('没有识别出语音内容，请重试或改用文字。');
        if (text === '/audio-transcribe-failed') return reply('本地语音转写失败。请检查 FFmpeg、faster-whisper 和模型安装，或改用文字。');
        if (text === '/help') return reply(HELP);
        if (text === '/status') {
          const active = this.store.active(agent.id).filter(r => r.chat_id === message.chatId);
          const recent = this.store.recent(agent.id, message.chatId).slice(0, 3);
          return reply(`当前任务：${active.length ? active.map(r => `${r.id.slice(0, 8)} ${r.status}`).join('\n') : '无'}\n最近：${recent.map(r => `${r.id.slice(0, 8)} ${r.status}`).join('；') || '无'}\n发送失败：${this.store.failedDeliveries(agent.id)} 条`);
        }
        if (text === '/stop') {
          const active = this.active.get(agent.id);
          if (active?.run.chat_id === message.chatId) active.abort.abort(new Error('user_cancelled'));
          this.store.db.prepare("UPDATE runs SET status='cancelled',finished_at=? WHERE agent_id=? AND chat_id=? AND status='queued'")
            .run(Date.now(), agent.id, message.chatId);
          return reply('已请求停止当前任务，并取消等待任务。已经发生的操作不会撤销。');
        }
        if (text === '/new') {
          if (this.store.active(agent.id).some(r => r.chat_id === message.chatId)) return reply('还有任务执行或排队。请先 /stop，待 /status 确认结束后再 /new。');
          this.store.newSession(agent.id, message.chatId);
          return reply('已开启新会话。长期记忆、健康数据和定时计划仍然保留。');
        }
        if (/^\/(weight|exercise)\s/.test(text)) {
          if (!agent.healthTools) return reply('请向健康助理发送健康记录。');
          const parts = text.split(/\s+/);
          if (parts.length < 2 || parts.length > 3) throw new Error('格式：/weight 72.3 [YYYY-MM-DD] 或 /exercise 30 [YYYY-MM-DD]');
          const kind = parts[0] === '/weight' ? 'weight' : 'exercise';
          const day = parts[2] ?? localDay(this.config.timezone);
          this.store.writeHealth(agent.id, kind, day, Number(parts[1]), '', message.messageId);
          return reply(`已记录 ${day}：${parts[1]} ${kind === 'weight' ? 'kg' : '分钟（当天累计）'}。`);
        }
        if (text === '/weights') {
          if (!agent.healthTools) return reply('请向健康助理查询体重。');
          const records = this.store.health(agent.id, 'weight') as { day: string; value: number }[];
          return reply(records.length ? records.map(r => `${r.day}  ${r.value} kg`).join('\n') : '还没有体重记录。');
        }
        if (text.startsWith('/remind ') || text.startsWith('/once ')) {
          const match = text.match(/^\/(remind|once)\s+(\S+)\s+([\s\S]+)$/);
          if (!match) throw new Error('请提供时间和提醒内容');
          const [, mode, time, prompt] = match;
          let trigger: { cron: string } | { at: string };
          if (mode === 'remind') {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('时间格式为 HH:mm，例如 20:30');
            const [hour, minute] = time.split(':').map(Number);
            trigger = { cron: `${minute} ${hour} * * *` };
          } else trigger = { at: time };
          const schedule = this.scheduler.create(agent.id, message.chatId, { ...trigger, name: prompt.slice(0, 50), prompt, action: 'reminder', timezone: this.config.timezone });
          return reply(this.formatSchedule(schedule));
        }
        if (text.startsWith('/schedule')) {
          const match = text.match(/^\/schedule(?:\s+(\S+))?(?:\s+([\s\S]+))?$/);
          if (!match) throw new Error('计划命令格式错误，请用 /help');
          const operation = match[1] ?? 'list', tail = match[2] ?? '';
          if (operation === 'list') return reply(this.store.schedules(agent.id, message.chatId).map(s => this.formatSchedule(s)).join('\n\n') || '暂无计划。');
          if (operation === 'add') return reply(this.formatSchedule(this.scheduler.create(agent.id, message.chatId, { timezone: this.config.timezone, ...JSON.parse(tail) })));
          if (['pause', 'resume', 'delete'].includes(operation)) {
            this.scheduler.change(agent.id, message.chatId, tail.trim(), operation as 'pause' | 'resume' | 'delete');
            return reply(`计划 ${tail.trim()} 已${{ pause: '暂停', resume: '恢复', delete: '删除' }[operation]}。已入队任务不受影响，可用 /stop 取消。`);
          }
          if (operation === 'update') {
            const boundary = tail.indexOf(' ');
            if (boundary < 0) throw new Error('格式：/schedule update <ID> <完整JSON>');
            return reply(this.formatSchedule(this.scheduler.update(agent.id, message.chatId, tail.slice(0, boundary), { timezone: this.config.timezone, ...JSON.parse(tail.slice(boundary + 1)) })));
          }
          throw new Error('未知计划操作，请用 /help');
        }
        if (text.startsWith('/')) return reply('未知命令或消息过长。输入 /help 查看用法。');
        if (this.store.active(agent.id).length >= this.config.maxQueuedPerAgent) return reply('此助理的等待队列已满，请稍后再发。');
        runId = this.store.enqueue(agent.id, message.chatId, `message:${message.messageId}`, text, 'chat', Date.now(), message.attachments ?? []);
      } catch (error) {
        // User-facing command validation only; never print raw SDK errors or credentials.
        const reason = error instanceof SyntaxError ? 'JSON 格式不正确' : error instanceof Error ? error.message : '参数错误';
        reply(`未完成：${reason.slice(0, 1200)}`);
      }
    });
    if (runId && this.messenger.react) {
      const id = runId;
      this.reactions.set(id, Promise.resolve().then(() => this.messenger.react!(message))
        .then(reactionId => ({ message, reactionId }))
        .catch(() => { log('reaction_failed', { agent: message.agentId, run: id }); return null; }));
    }
  }

  private formatSchedule(s: { id: string; name: string; enabled: number; timezone: string; next_at: number | null; action: string; cron: string | null }): string {
    const next = s.next_at === null ? '无' : new Intl.DateTimeFormat('zh-CN', { timeZone: s.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(s.next_at);
    return `${s.name}\nID: ${s.id}\n${s.enabled ? '启用' : '暂停/已结束'} · ${s.action} · ${s.cron ?? '一次性'}\n下次：${next} (${s.timezone})`;
  }

  tick(): void {
    if (this.closing) return;
    this.scheduler.tick();
    while (this.active.size < this.config.maxConcurrentRuns) {
      const run = this.store.claim([...this.active.keys()], Date.now(), this.config.agents.map(a => a.id));
      if (!run) break;
      const abort = new AbortController();
      // Defer execution until the active entry has been registered.
      const promise = Promise.resolve().then(() => this.execute(run, abort));
      this.active.set(run.agent_id, { run, abort, promise });
    }
  }
  private async execute(run: Run, abort: AbortController): Promise<void> {
    const agent = this.config.agents.find(a => a.id === run.agent_id)!;
    const timer = setTimeout(() => abort.abort(new Error('timeout')), agent.timeoutSeconds * 1000);
    log('run_started', { agent: run.agent_id, run: run.id, kind: run.kind });
    try {
      const result = await this.engine.execute({ run, signal: abort.signal, onSession: path => this.store.saveSession(run, path) });
      abort.signal.throwIfAborted();
      this.store.transaction(() => {
        this.store.finish(run.id, 'succeeded', result);
        if (result.trim() !== '[NO_REPLY]' || run.kind === 'chat') this.store.queueReply(run.agent_id, run.chat_id, result, `result:${run.id}`, Date.now(), run.id);
      });
      log('run_finished', { agent: run.agent_id, run: run.id });
    } catch (error) {
      const reason = abort.signal.aborted ? (abort.signal.reason as Error)?.message ?? 'cancelled' : 'engine_error';
      const status = reason === 'shutdown' ? 'interrupted' : abort.signal.aborted ? 'cancelled' : 'failed';
      this.store.transaction(() => {
        this.store.finish(run.id, status, null, reason);
        const text = reason === 'timeout' ? '执行超时，已请求停止。' : status === 'cancelled' ? '任务已停止。' : status === 'interrupted' ? '服务退出，任务已中断。' : '执行失败，请检查模型配置或服务日志。';
        this.store.queueReply(run.agent_id, run.chat_id, `${text} 任务 ${run.id.slice(0, 8)}。已发生的操作不会撤销。`, `result:${run.id}`, Date.now(), run.id);
      });
      log('run_failed', { agent: run.agent_id, run: run.id, reason, errorType: error instanceof Error ? error.name : 'unknown' });
    } finally {
      clearTimeout(timer);
      this.active.delete(run.agent_id);
    }
  }
  private async removeReaction(runId: string): Promise<void> {
    const pending = this.reactions.get(runId);
    if (!pending) return;
    this.reactions.delete(runId);
    const reaction = await pending;
    if (!reaction || !this.messenger.unreact) return;
    try { await this.messenger.unreact(reaction.message, reaction.reactionId); }
    catch { log('reaction_removal_failed', { agent: reaction.message.agentId, run: runId }); }
  }
  async deliver(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      const enabled = new Set(this.config.agents.map(a => a.id));
      await Promise.all(this.store.pending().filter(m => enabled.has(m.agent_id)).map(async message => {
        if (!this.store.beginAttempt(message)) { log('delivery_ambiguous', { agent: message.agent_id, message: message.id }); return; }
        try { this.store.sent(message, await this.messenger.send(message)); }
        catch {
          this.store.sendFailed(message); log('delivery_failed', { agent: message.agent_id, message: message.id });
          return;
        }
        if (message.run_id && !this.store.hasPendingReply(message.run_id)) await this.removeReaction(message.run_id);
      }));
    } finally { this.delivering = false; }
  }
  async waitIdle(): Promise<void> {
    while (true) {
      this.tick();
      if (!this.active.size) return;
      await Promise.all([...this.active.values()].map(a => a.promise));
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const item of this.active.values()) item.abort.abort(new Error('shutdown'));
    await Promise.all([...this.active.values()].map(a => a.promise));
    // The outer process supervisor provides a hard shutdown timeout for uncooperative tools.
    while (this.delivering) await new Promise(resolve => setTimeout(resolve, 25));
  }
}
