import 'dotenv/config';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import lockfile from 'proper-lockfile';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { Services } from './services.js';
import { DemoEngine, PiEngine } from './agent.js';
import { ConsoleMessenger, FeishuGateway } from './feishu.js';
import { Dispatcher } from './dispatcher.js';
import { id, log } from './util.js';

process.umask(0o077);
const args = process.argv.slice(2);
const demo = args.includes('--demo');
const local = demo || args.includes('--console');
const configIndex = args.indexOf('--config');
const path = configIndex < 0 ? local ? 'config.example.yaml' : 'config.yaml' : args[configIndex + 1];
if (!path) throw new Error('--config 后需要配置文件路径');

async function main() {
  const config = loadConfig(path, local);
  const release = await lockfile.lock(config.dataDir, { retries: 0, stale: 30_000, update: 10_000 });
  const store = new Store(join(config.dataDir, 'myclaw.sqlite'));
  const scheduler = new Scheduler(store, config.agents.map(a => a.id));
  const services = new Services(store, scheduler, config.timezone);
  const engine = demo ? new DemoEngine() : new PiEngine(config, services);
  let gateway: FeishuGateway | undefined;
  let dispatcher: Dispatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let deliveryTimer: NodeJS.Timeout | undefined;
  let input: ReturnType<typeof createInterface> | undefined;
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer); clearInterval(deliveryTimer); input?.close(); gateway?.close();
    if (local) process.stdin.destroy();
    const hardStop = setTimeout(() => { log('forced_shutdown'); process.exit(1); }, 20_000);
    try { await dispatcher?.close(); store.close(); await release(); log('stopped'); }
    finally { clearTimeout(hardStop); }
  };
  try {
    if (engine instanceof PiEngine) await engine.checkModels();
    if (args.includes('--check')) {
      log('configuration_valid', { agents: config.agents.map(a => a.id), model: demo ? 'mock' : 'pi', transport: local ? 'console' : 'feishu' });
      await shutdown(); return;
    }
    gateway = local ? undefined : new FeishuGateway(config);
    dispatcher = new Dispatcher(config, store, scheduler, engine, gateway ?? new ConsoleMessenger());
    const recovered = store.recover();
    log('started', { agents: config.agents.map(a => a.id), mode: demo ? 'demo' : local ? 'console' : 'feishu', recovered });
    const tick = () => { try { dispatcher!.tick(); } catch { log('scheduler_error'); } };
    const deliver = () => { void dispatcher!.deliver().catch(() => log('outbox_error')); };
    if (gateway) await gateway.start(m => dispatcher!.receive(m));
    else {
      console.log('输入格式：health /weight 72.3 或 coder 帮我查看工作目录。输入 exit 退出。\n演示数据位于 data-demo；不会发送飞书消息。');
      input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
      input.on('line', line => {
        if (line.trim() === 'exit') { void shutdown(); return; }
        const match = line.match(/^(\S+)\s+([\s\S]+)$/);
        if (!match || !config.agents.some(a => a.id === match[1])) { console.log('请先输入 Agent ID：' + config.agents.map(a => a.id).join(', ')); return; }
        dispatcher!.receive({ agentId: match[1], chatId: `console-${match[1]}`, senderId: 'local-owner', messageId: id(), text: match[2] });
        tick(); deliver();
      });
      input.on('close', () => { if (!closing) void shutdown(); });
    }
    timer = setInterval(tick, 1000);
    deliveryTimer = setInterval(deliver, 300);
    tick(); deliver();
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
  } catch (error) { await shutdown(); throw error; }
}

main().catch(error => {
  // Configuration errors contain field names, not credential values. Avoid dumping SDK request objects.
  console.error(`启动失败：${error instanceof Error ? error.message : '未知错误'}`);
  process.exitCode = 1;
});
