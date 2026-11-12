import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Attachment, Inbound, Messenger, Outbound } from './types.js';
import { log } from './util.js';
import { FeishuDocuments } from './feishu-documents.js';
import { FeishuSheets } from './feishu-sheets.js';
import { MAX_IMAGE_BYTES, MAX_MEDIA_BYTES, mimeTypeForFile, safeFileName } from './media.js';
import { transcribeAudio } from './speech.js';

const eventSchema = z.object({
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: z.string() }) }),
  message: z.object({ message_id: z.string(), chat_id: z.string(), chat_type: z.string(), message_type: z.string(), content: z.string() }),
});

function parsePost(content: unknown): { text: string; images: { kind: 'image'; key: string; name: string }[] } {
  const post = z.object({
    title: z.string().optional(),
    content: z.array(z.array(z.object({ tag: z.string(), text: z.string().optional(), href: z.string().optional(), name: z.string().optional(), image_key: z.string().optional() }).passthrough())),
  }).parse(content);
  const images: { kind: 'image'; key: string; name: string }[] = [];
  const paragraphs = post.content.map(paragraph => {
    const text = paragraph.map(part => {
      if (part.tag === 'img' && part.image_key) { images.push({ kind: 'image', key: part.image_key, name: `image-${images.length + 1}` }); return ''; }
      if (part.tag === 'a') return part.href && part.text !== part.href ? `${part.text ?? ''} ${part.href}` : part.text ?? part.href ?? '';
      if (part.tag === 'at') return part.name ?? part.text ?? '';
      return part.text ?? '';
    }).join('');
    return text;
  });
  const text = [post.title ?? '', ...paragraphs].filter(part => part.trim()).join('\n');
  return { text: text || (images.length ? '请查看并处理富文本中的图片。' : '/unsupported'), images };
}

export function parseFeishuEvent(agentId: string, ownerId: string, event: unknown): Inbound | null {
  const result = eventSchema.safeParse(event);
  if (!result.success) return null;
  const { sender, message } = result.data;
  if (sender.sender_type !== 'user' || sender.sender_id.open_id !== ownerId || message.chat_type !== 'p2p') return null;
  const inbound: Inbound = {
    agentId, messageId: message.message_id, chatId: message.chat_id, senderId: sender.sender_id.open_id, text: '/unsupported',
  };
  if (message.content.length > 100_000) return inbound;
  try {
    const content: unknown = JSON.parse(message.content);
    if (message.message_type === 'text') inbound.text = z.object({ text: z.string() }).parse(content).text;
    if (message.message_type === 'post') {
      const post = parsePost(content);
      inbound.text = post.text;
      if (post.images.length) inbound.resources = post.images;
    }
    if (message.message_type === 'image') {
      const image = z.object({ image_key: z.string().min(1) }).parse(content);
      inbound.text = '请查看并处理这张图片。';
      inbound.resources = [{ kind: 'image', key: image.image_key, name: 'image' }];
    }
    if (message.message_type === 'audio' || message.message_type === 'file') {
      const media = z.object({ file_key: z.string().min(1), file_name: z.string().optional(), duration: z.union([z.number(), z.string()]).optional() }).parse(content);
      const durationMs = media.duration === undefined ? undefined : Number(media.duration);
      if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) return inbound;
      inbound.text = message.message_type === 'audio' ? '请处理这条语音消息。' : '请查看并处理这个文件。';
      inbound.resources = [{ kind: message.message_type, key: media.file_key, name: media.file_name, durationMs }];
    }
  } catch { return inbound; }
  return inbound;
}

export class FeishuGateway implements Messenger {
  private clients = new Map<string, lark.Client>();
  private sockets: lark.WSClient[] = [];
  readonly documents: FeishuDocuments;
  readonly spreadsheets: FeishuSheets;
  constructor(private config: Config, private transcribe: (path: string) => Promise<string> = path => transcribeAudio(path, config)) {
    lark.defaultHttpInstance.defaults.timeout = 15_000;
    for (const agent of config.agents) {
      this.clients.set(agent.id, new lark.Client({
        appId: process.env[agent.feishu.appIdEnv]!, appSecret: process.env[agent.feishu.appSecretEnv]!,
        appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu, logger: this.logger(agent.id),
      }));
    }
    const clientFor = (agentId: string) => {
      const client = this.clients.get(agentId);
      if (!client) throw new Error('Agent 未启用');
      return client;
    };
    this.documents = new FeishuDocuments(config, clientFor);
    this.spreadsheets = new FeishuSheets(config, clientFor);
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
          if (!message) return;
          let prepared: Inbound;
          try { prepared = await this.prepare(message); }
          catch {
            log('media_download_failed', { agent: agent.id, message: message.messageId });
            prepared = { ...message, text: '/media-download-failed', resources: [], attachments: [] };
          }
          receive(prepared);
        },
      }) });
    }));
  }

  async prepare(message: Inbound): Promise<Inbound> {
    if (!message.resources?.length) return message;
    const agent = this.config.agents.find(a => a.id === message.agentId);
    if (!agent) return message;
    const directory = join(agent.directory, 'attachments', 'incoming');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const attachments: Attachment[] = [];
    for (const [index, resource] of message.resources.entries()) {
      const client = this.clients.get(message.agentId)!;
      const response = await client.im.v1.messageResource.get({
        path: { message_id: message.messageId, file_key: resource.key },
        params: { type: resource.kind === 'image' ? 'image' : 'file' },
      });
      const length = Number(response.headers?.['content-length'] ?? 0);
      const limit = resource.kind === 'image' ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES;
      if (length > limit) throw new Error('附件超过大小限制');
      const fallback = resource.kind === 'image' ? 'image' : resource.kind === 'audio' ? 'voice.opus' : 'attachment';
      const name = safeFileName(resource.name, fallback);
      const extension = extname(name).toLowerCase().match(/^\.[a-z0-9]{1,10}$/)?.[0] ?? (resource.kind === 'audio' ? '.opus' : '');
      const path = join(directory, `${message.messageId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}-${index}${extension}`);
      try {
        await response.writeFile(path);
        const size = (await stat(path)).size;
        if (!size || size > limit) throw new Error('附件为空或超过大小限制');
        const attachment: Attachment = { kind: resource.kind, name, path, mimeType: mimeTypeForFile(name), size, durationMs: resource.durationMs };
        if (resource.kind === 'audio') {
          if (resource.durationMs && resource.durationMs > 60_000) {
            return { ...message, text: '/audio-too-long', resources: [], attachments: [attachment] };
          }
          try {
            const transcript = (await this.transcribe(path)).trim();
            if (!transcript) return { ...message, text: '/audio-empty', resources: [], attachments: [attachment] };
            attachment.transcript = transcript;
            message = { ...message, text: transcript };
          } catch {
            log('audio_transcription_failed', { agent: message.agentId, message: message.messageId });
            return { ...message, text: '/audio-transcribe-failed', resources: [], attachments: [attachment] };
          }
        }
        attachments.push(attachment);
      } catch (error) {
        await unlink(path).catch(() => {});
        throw error;
      }
    }
    return { ...message, attachments, resources: [] };
  }

  private async createMessage(client: lark.Client, message: Outbound, msgType: string, content: unknown): Promise<string> {
    const response = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: message.chat_id, msg_type: msgType, content: JSON.stringify(content), uuid: message.id },
    });
    if (response.code !== 0 || !response.data?.message_id) throw new Error(`飞书发送失败 code=${response.code}`);
    return response.data.message_id;
  }

  async send(message: Outbound): Promise<string> {
    const client = this.clients.get(message.agent_id);
    if (!client) throw new Error('Agent 未启用');
    if (message.kind === 'text') return this.createMessage(client, message, 'text', { text: message.text });
    if (!message.file_path || !message.file_name) throw new Error('附件路径缺失');
    const size = (await stat(message.file_path)).size;
    if (!size || size > (message.kind === 'image' ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES)) throw new Error('附件为空或超过大小限制');
    if (message.kind === 'image') {
      const uploaded = await client.im.v1.image.create({ data: { image_type: 'message', image: createReadStream(message.file_path) } });
      if (!uploaded?.image_key) throw new Error('飞书图片上传失败');
      return this.createMessage(client, message, 'image', { image_key: uploaded.image_key });
    }
    const extension = extname(message.file_name).toLowerCase();
    const fileType = message.kind === 'audio' ? 'opus' : extension === '.pdf' ? 'pdf' : extension === '.mp4' ? 'mp4'
      : ['.doc', '.docx'].includes(extension) ? 'doc' : ['.xls', '.xlsx', '.csv'].includes(extension) ? 'xls'
        : ['.ppt', '.pptx'].includes(extension) ? 'ppt' : 'stream';
    if (message.kind === 'audio' && (!['.opus', '.ogg'].includes(extension) || !message.duration_ms)) throw new Error('语音必须为 OPUS/Ogg 并提供时长');
    const uploaded = await client.im.v1.file.create({ data: {
      file_type: fileType, file_name: message.file_name, file: createReadStream(message.file_path), duration: message.duration_ms ?? undefined,
    } });
    if (!uploaded?.file_key) throw new Error('飞书文件上传失败');
    return this.createMessage(client, message, message.kind, { file_key: uploaded.file_key });
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
    console.log(message.kind === 'text'
      ? `\n[${message.agent_id} → ${message.chat_id}]\n${message.text}\n`
      : `\n[${message.agent_id} → ${message.chat_id}] ${message.kind}: ${message.file_path}\n`);
    return `console:${message.id}`;
  }
}
