import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, Config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { Services } from '../src/services.js';
import { Dispatcher } from '../src/dispatcher.js';
import type { Engine, Inbound, Messenger, Outbound } from '../src/types.js';

export function fixture(engine: Engine = { async execute({ run }) { return `完成:${run.input}`; } }) {
  const root = mkdtempSync(join(tmpdir(), 'myclaw-test-'));
  const agents: AgentConfig[] = ['health', 'finance', 'coder'].map(agentId => {
    const directory = join(root, agentId);
    for (const folder of ['', 'workspace', 'sessions', 'pi', 'skills']) mkdirSync(join(directory, folder), { recursive: true });
    const persona = join(directory, 'persona.md');
    writeFileSync(persona, `你是 ${agentId}。`);
    return { id: agentId, name: agentId, enabled: true, directory, workspace: join(directory, 'workspace'), persona,
      skills: [join(directory, 'skills')], sharedKnowledge: [], builtinTools: [], healthTools: agentId === 'health',
      timeoutSeconds: 30, maxToolCalls: 20, model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
      feishu: { appIdEnv: `${agentId}_ID`, appSecretEnv: `${agentId}_SECRET`, ownerOpenIdEnv: `${agentId}_OWNER` } };
  });
  const config: Config = { root, dataDir: root, timezone: 'Asia/Shanghai', agents, maxConcurrentRuns: 2, maxQueuedPerAgent: 50 };
  const store = new Store(join(root, 'db.sqlite'));
  const scheduler = new Scheduler(store, agents.map(a => a.id));
  const services = new Services(store, scheduler, config.timezone);
  const sent: Outbound[] = [];
  const messenger: Messenger = { async send(m: Outbound) { sent.push(m); return `remote:${m.id}`; } };
  const dispatcher = new Dispatcher(config, store, scheduler, engine, messenger);
  const message = (text: string, agentId = 'health', messageId = crypto.randomUUID()): Inbound => ({ agentId, chatId: `chat-${agentId}`, senderId: 'owner', messageId, text });
  return { root, config, store, scheduler, services, sent, messenger, dispatcher, message,
    async cleanup() { await dispatcher.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
