import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FeishuGateway, parseFeishuEvent } from '../src/feishu.js';
import { Store } from '../src/store.js';
import type { Inbound, Outbound } from '../src/types.js';
import { fixture } from './helpers.js';

function mediaEvent(type: string, content: unknown) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
    message: { message_id: 'media-message', chat_id: 'chat-health', chat_type: 'p2p', message_type: type, content: JSON.stringify(content) },
  };
}

test('Feishu parses image, audio and file resources without weakening owner checks', () => {
  const image = parseFeishuEvent('health', 'owner', mediaEvent('image', { image_key: 'image-key' }))!;
  assert.deepEqual(image.resources, [{ kind: 'image', key: 'image-key', name: 'image' }]);
  const audio = parseFeishuEvent('health', 'owner', mediaEvent('audio', { file_key: 'audio-key', duration: 2300 }))!;
  assert.equal(audio.resources?.[0].kind, 'audio');
  assert.equal(audio.resources?.[0].durationMs, 2300);
  const file = parseFeishuEvent('health', 'owner', mediaEvent('file', { file_key: 'file-key', file_name: 'report.pdf' }))!;
  assert.equal(file.resources?.[0].name, 'report.pdf');
  assert.equal(parseFeishuEvent('health', 'other', mediaEvent('file', { file_key: 'file-key' })), null);
  const post = parseFeishuEvent('health', 'owner', mediaEvent('post', {
    title: '标题', content: [[{ tag: 'text', text: '你好' }, { tag: 'a', text: '链接', href: 'https://example.com' }], [{ tag: 'img', image_key: 'post-image' }]],
  }))!;
  assert.equal(post.text, '标题\n你好链接 https://example.com');
  assert.equal(post.resources?.[0].key, 'post-image');
  assert.equal(parseFeishuEvent('health', 'owner', mediaEvent('video', { file_key: 'video-key' }))?.text, '/unsupported');
});

test('version 3 databases keep existing runs and text outbox entries after media migration', async () => {
  const f = fixture();
  const path = join(f.root, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA user_version=3;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_key TEXT NOT NULL,
      source_key TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, result TEXT, error TEXT, sdk_session TEXT,
      UNIQUE(agent_id, source_key));
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, dedup TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', remote_id TEXT, error TEXT, first_attempt_at INTEGER, run_id TEXT);
    INSERT INTO runs(id,agent_id,chat_id,session_key,source_key,kind,input,status,created_at)
      VALUES('old-run','health','chat-health','session','old','chat','old input','succeeded',1);
    INSERT INTO outbox(id,dedup,agent_id,chat_id,text,next_at) VALUES('old-outbox','old','health','chat-health','old reply',0);
  `);
  legacy.close();
  const store = new Store(path);
  try {
    assert.equal(store.run('old-run')?.input, 'old input');
    assert.deepEqual(store.run('old-run')?.attachments, []);
    assert.equal(store.pending()[0].kind, 'text');
    assert.equal(store.pending()[0].text, 'old reply');
  } finally { store.close(); await f.cleanup(); }
});

test('incoming attachments survive queueing and restart recovery', async () => {
  const f = fixture();
  try {
    const message: Inbound = { ...f.message('分析附件'), attachments: [{ kind: 'file', name: 'a.txt', path: '/tmp/a.txt', mimeType: 'text/plain', size: 3 }] };
    f.dispatcher.receive(message);
    const queued = f.store.active('health')[0];
    assert.equal(queued.attachments[0].name, 'a.txt');
    await f.dispatcher.waitIdle();
    assert.deepEqual(f.store.recent('health', 'chat-health')[0].attachments, message.attachments);
    assert.equal(f.store.run(queued.id)?.attachments[0].path, '/tmp/a.txt');
  } finally { await f.cleanup(); }
});

test('send_media queues durable file, image and voice replies and rejects paths outside allowed roots', async () => {
  const f = fixture();
  try {
    const agent = f.config.agents[0];
    const run = f.store.run(f.store.enqueue('health', 'chat-health', 'media', 'send files'))!;
    writeFileSync(join(agent.workspace!, 'report.txt'), 'report');
    writeFileSync(join(agent.workspace!, 'chart.png'), 'png');
    writeFileSync(join(agent.workspace!, 'voice.opus'), 'opus');
    writeFileSync(join(f.root, 'private.txt'), 'private');
    const first = f.services.call(agent, run, 'send_media', { path: 'report.txt' }, 'file-call') as { queued: boolean };
    const replay = f.services.call(agent, run, 'send_media', { path: 'report.txt' }, 'file-call');
    assert.equal(first.queued, true);
    assert.deepEqual(replay, first);
    f.services.call(agent, run, 'send_media', { path: 'chart.png', kind: 'image' }, 'image-call');
    f.services.call(agent, run, 'send_media', { path: 'voice.opus', kind: 'audio', durationMs: 1200 }, 'audio-call');
    assert.throws(() => f.services.call(agent, run, 'send_media', { path: join(f.root, 'private.txt') }, 'denied'), /只能发送/);
    assert.throws(() => f.services.call(agent, run, 'send_media', { path: 'voice.opus', kind: 'audio' }, 'no-duration'), /durationMs/);
    const pending = f.store.pending();
    assert.equal(pending.length, 1, 'chat ordering exposes the first item until it is sent');
    assert.equal(pending[0].kind, 'file');
    assert.equal(pending[0].file_name, 'report.txt');
    for (const expected of ['file', 'image', 'audio']) {
      const message = f.store.pending()[0];
      assert.equal(message.kind, expected);
      f.store.sent(message, `remote:${expected}`);
    }
    assert.equal(f.store.pending().length, 0);
  } finally { await f.cleanup(); }
});

test('Feishu downloads resources, transcribes voice and uploads each outbound media type', async () => {
  const f = fixture();
  const credentials = f.config.agents.flatMap(a => [a.feishu.appIdEnv, a.feishu.appSecretEnv]).map(key => [key, process.env[key]] as const);
  for (const [key] of credentials) process.env[key] = 'test';
  const gateway = new FeishuGateway(f.config, async path => {
    assert.equal(readFileSync(path, 'utf8'), 'opus');
    return '明天早上提醒我运动';
  });
  const uploads: string[] = [];
  const sent: { type: string; content: string }[] = [];
  const client = {
    im: { v1: {
      messageResource: { async get({ path }: { path: { file_key: string } }) {
        return { headers: { 'content-length': '4' }, async writeFile(target: string) { writeFileSync(target, path.file_key === 'audio-key' ? 'opus' : 'data'); } };
      } },
      image: { async create({ data }: { data: { image: AsyncIterable<unknown> } }) { for await (const _ of data.image) void _; uploads.push('image'); return { image_key: 'uploaded-image' }; } },
      file: { async create({ data }: { data: { file_type: string; duration?: number; file: AsyncIterable<unknown> } }) { for await (const _ of data.file) void _; uploads.push(`${data.file_type}:${data.duration ?? ''}`); return { file_key: 'uploaded-file' }; } },
      message: { async create({ data }: { data: { msg_type: string; content: string } }) { sent.push({ type: data.msg_type, content: data.content }); return { code: 0, data: { message_id: `remote-${data.msg_type}` } }; } },
    } },
  };
  const clients = (gateway as unknown as { clients: Map<string, unknown> }).clients;
  clients.set('health', client);
  try {
    const audio = parseFeishuEvent('health', 'owner', mediaEvent('audio', { file_key: 'audio-key', duration: 1200 }))!;
    const prepared = await gateway.prepare(audio);
    assert.equal(prepared.text, '明天早上提醒我运动');
    assert.equal(prepared.attachments?.[0].transcript, '明天早上提醒我运动');
    assert.equal(readFileSync(prepared.attachments![0].path, 'utf8'), 'opus');

    for (const [kind, name, duration] of [['image', 'chart.png', undefined], ['audio', 'voice.opus', 1200], ['file', 'report.pdf', undefined]] as const) {
      const path = join(f.config.agents[0].workspace!, name);
      writeFileSync(path, 'data');
      f.store.queueMedia('health', 'chat-health', kind, path, name, kind === 'image' ? 'image/png' : 'application/octet-stream', `out:${kind}`, 'run', duration);
      const message: Outbound = f.store.pending()[0];
      assert.equal(await gateway.send(message), `remote-${kind}`);
      f.store.sent(message, `remote:${kind}`);
    }
    assert.deepEqual(uploads, ['image', 'opus:1200', 'pdf:']);
    assert.deepEqual(sent.map(m => m.type), ['image', 'audio', 'file']);
    assert.equal(JSON.parse(sent[0].content).image_key, 'uploaded-image');
    assert.equal(JSON.parse(sent[2].content).file_key, 'uploaded-file');
  } finally {
    gateway.close();
    for (const [key, value] of credentials) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.cleanup();
  }
});
