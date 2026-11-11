#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parse } from 'yaml';
import * as lark from '@larksuiteoapi/node-sdk';

const [agentId, configPath = 'config.yaml'] = process.argv.slice(2);
if (!agentId) throw new Error('用法：node scripts/identify-owner.mjs health [config.yaml]');
const config = parse(readFileSync(configPath, 'utf8'));
const agent = config.agents.find(a => a.id === agentId);
if (!agent) throw new Error('配置中不存在此 Agent');
const appId = process.env[agent.feishu.appIdEnv], appSecret = process.env[agent.feishu.appSecretEnv];
if (!appId || !appSecret) throw new Error('请先在 .env 填写此机器人的 App ID / App Secret');
const code = `pair ${randomBytes(8).toString('hex')}`;
console.log(`请在 5 分钟内私聊 ${agent.name}，发送下面这行文字：\n\n${code}\n\n此脚本只识别身份，不回复消息，也不执行 Agent。不要同时运行正式服务。`);
lark.defaultHttpInstance.defaults.timeout = 15000;
const socket = new lark.WSClient({ appId, appSecret, domain: lark.Domain.Feishu, logger: {
  trace() {}, debug() {}, info() {}, warn() { console.error('飞书连接警告'); }, error() { console.error('飞书连接错误，请检查应用配置'); },
} });
const stop = () => { clearTimeout(timer); socket.close({ force: true }); };
const timer = setTimeout(() => { console.error('识别超时'); stop(); process.exitCode = 1; }, 300000);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await socket.start({ eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async event => {
      if (event.sender?.sender_type !== 'user' || event.message?.chat_type !== 'p2p' || event.message.message_type !== 'text') return;
      let text;
      try { text = JSON.parse(event.message.content).text; } catch { return; }
      if (text !== code || !event.sender.sender_id?.open_id) return;
      console.log(`\n请把下面一行填入 .env：\n${agent.feishu.ownerOpenIdEnv}=${event.sender.sender_id.open_id}`);
      stop();
    },
  }) });
} catch { stop(); throw new Error('飞书连接启动失败'); }
