import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PiEngine } from '../src/agent.js';
import { fixture } from './helpers.js';

test('real Pi SDK calls a local model, executes a health tool, resumes session and refreshes shared context', { timeout: 30000 }, async () => {
  const f = fixture();
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'local-chat', object: 'chat.completion.chunk', created: 1, model: 'myclaw-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (requests.length === 1) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_weight_1', type: 'function', function: { name: 'health_record', arguments: JSON.stringify({ kind: 'weight', value: 72.3, day: '2026-10-22' }) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: requests.length === 2 ? '已记录 72.3 kg。' : '已恢复上下文。' });
      chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    const modelsFile = join(f.root, 'models.json');
    writeFileSync(modelsFile, JSON.stringify({ providers: { 'local-test': {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-test-only',
      models: [{ id: 'myclaw-test', name: 'Local Test', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsStore: false } }],
    } } }));
    const sharedFile = join(f.root, 'shared.md'); writeFileSync(sharedFile, '共同偏好版本一');
    f.config.modelsFile = modelsFile;
    f.config.agents = [f.config.agents[0]];
    f.config.agents[0].model = { provider: 'local-test', id: 'myclaw-test' };
    f.config.agents[0].sharedKnowledge = [sharedFile];
    const engine = new PiEngine(f.config, f.services);
    await engine.checkModels();
    f.store.enqueue('health', 'chat-health', 'first', '今天体重72.3公斤');
    const first = f.store.claim([])!;
    const result = await engine.execute({ run: first, signal: AbortSignal.timeout(20000), onSession: p => f.store.saveSession(first, p) });
    f.store.finish(first.id, 'succeeded', result);
    assert.equal(result, '已记录 72.3 kg。');
    assert.equal((f.store.health('health', 'weight')[0] as { value: number }).value, 72.3);
    const sessionFile = f.store.session('health', 'chat-health').sdk_session!;
    assert.ok(existsSync(sessionFile));
    assert.ok(requests[1].messages.some((m: any) => m.role === 'tool' && m.content.includes('72.3')));
    assert.ok(!requests[0].tools.some((t: any) => t.function.name === 'bash'));
    writeFileSync(sharedFile, '共同偏好版本二');
    f.store.enqueue('health', 'chat-health', 'second', '继续');
    const second = f.store.claim([])!;
    const answer = await engine.execute({ run: second, signal: AbortSignal.timeout(20000), onSession: p => f.store.saveSession(second, p) });
    f.store.finish(second.id, 'succeeded', answer);
    assert.equal(second.sdk_session, sessionFile);
    assert.ok(requests.at(-1).messages.some((m: any) => m.role === 'assistant' && m.content?.includes('已记录 72.3')));
    assert.ok(JSON.stringify(requests.at(-1).messages[0]).includes('共同偏好版本二'));
    assert.ok(!JSON.stringify(requests.at(-1).messages[0]).includes('共同偏好版本一'));
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await f.cleanup();
  }
});
