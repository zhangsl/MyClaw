import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Inbound, Messenger, Outbound } from './types.js';
import { log } from './util.js';

const eventSchema = z.object({
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: z.string() }) }),
  message: z.object({ message_id: z.string(), chat_id: z.string(), chat_type: z.string(), message_type: z.string(), content: z.string() }),
});

export function parseFeishuEvent(agentId: string, ownerId: string, event: unknown): Inbound | null {
  const result = eventSchema.safeParse(event);
  if (!result.success) return null;
  const { sender, message } = result.data;
  if (sender.sender_type !== 'user' || sender.sender_id.open_id !== ownerId || message.chat_type !== 'p2p') return null;
  let text = '/unsupported';
  if (message.message_type === 'text' && message.content.length <= 100_000) {
    try { text = z.object({ text: z.string() }).parse(JSON.parse(message.content)).text; }
    catch { text = '/unsupported'; }
  }
  return { agentId, messageId: message.message_id, chatId: message.chat_id, senderId: sender.sender_id.open_id, text };
}

export class FeishuGateway implements Messenger {
  private clients = new Map<string, lark.Client>();
  private sockets: lark.WSClient[] = [];
  constructor(private config: Config) {
    lark.defaultHttpInstance.defaults.timeout = 15_000;
    for (const agent of config.agents) {
      this.clients.set(agent.id, new lark.Client({
        appId: process.env[agent.feishu.appIdEnv]!, appSecret: process.env[agent.feishu.appSecretEnv]!,
        appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu, logger: this.logger(agent.id),
      }));
    }
  }
  private logger(agent: string) {
    return {
      trace: () => {}, debug: () => {}, info: () => {},
      warn: () => log('feishu_warning', { agent }),
      error: () => log('feishu_error', { agent }),
    };
  }
  async start(receive: (message: Inbound) => void): Promise<void> {
    await Promise.all(this.config.agents.map(async agent => {
      const socket = new lark.WSClient({
        appId: process.env[agent.feishu.appIdEnv]!, appSecret: process.env[agent.feishu.appSecretEnv]!,
        domain: lark.Domain.Feishu, logger: this.logger(agent.id),
        onReady: () => log('feishu_connected', { agent: agent.id }),
        onReconnected: () => log('feishu_reconnected', { agent: agent.id }),
      });
      this.sockets.push(socket);
      await socket.start({ eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async event => {
          const message = parseFeishuEvent(agent.id, process.env[agent.feishu.ownerOpenIdEnv]!, event);
          if (message) receive(message); // Only local durable work; no SDK/model/network awaits here.
        },
      }) });
    }));
  }
  async send(message: Outbound): Promise<string> {
    const client = this.clients.get(message.agent_id);
    if (!client) throw new Error('Agent 未启用');
    const response = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: message.chat_id, msg_type: 'text', content: JSON.stringify({ text: message.text }), uuid: message.id },
    });
    if (response.code !== 0 || !response.data?.message_id) throw new Error(`飞书发送失败 code=${response.code}`);
    return response.data.message_id;
  }
  async react(message: Inbound): Promise<string> {
    const client = this.clients.get(message.agentId);
    if (!client) throw new Error('Agent 未启用');
    const response = await client.im.v1.messageReaction.create({
      path: { message_id: message.messageId },
      data: { reaction_type: { emoji_type: 'Get' } },
    });
    if (response.code !== 0 || !response.data?.reaction_id) throw new Error(`飞书表情回复失败 code=${response.code}`);
    return response.data.reaction_id;
  }
  async unreact(message: Inbound, reactionId: string): Promise<void> {
    const client = this.clients.get(message.agentId);
    if (!client) throw new Error('Agent 未启用');
    const response = await client.im.v1.messageReaction.delete({ path: { message_id: message.messageId, reaction_id: reactionId } });
    if (response.code !== 0) throw new Error(`飞书撤回表情回复失败 code=${response.code}`);
  }
  close(): void { this.sockets.forEach(s => s.close({ force: true })); }
}

export class ConsoleMessenger implements Messenger {
  async send(message: Outbound): Promise<string> {
    console.log(`\n[${message.agent_id} → ${message.chat_id}]\n${message.text}\n`);
    return `console:${message.id}`;
  }
}
