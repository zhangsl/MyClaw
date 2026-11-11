import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Dispatcher } from '../src/dispatcher.js';
import { nextCron } from '../src/scheduler.js';
import { parseFeishuEvent } from '../src/feishu.js';
import { localDay, splitText } from '../src/util.js';
import { fixture } from './helpers.js';

test('Feishu accepts only the configured owner in private text chats', () => {
  const event = { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { message_id: 'm1', chat_id: 'c1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '今天72.3公斤' }) } };
  assert.equal(parseFeishuEvent('health', 'owner', event)?.text, '今天72.3公斤');
  assert.equal(parseFeishuEvent('health', 'someone-else', event), null);
  assert.equal(parseFeishuEvent('health', 'owner', { ...event, message: { ...event.message, chat_type: 'group' } }), null);
  assert.equal(parseFeishuEvent('health', 'owner', { ...event, sender: { ...event.sender, sender_type: 'app' } }), null);
  assert.equal(parseFeishuEvent('health', 'owner', { ...event, message: { ...event.message, message_type: 'image' } })?.text, '/unsupported');
  assert.equal(parseFeishuEvent('health', 'owner', { bad: 'input' }), null);
});

test('incoming message replay creates exactly one run and health updates are validated', async () => {
  const f = fixture();
  try {
    const input = f.message('帮我总结');
    f.dispatcher.receive(input); f.dispatcher.receive(input);
    assert.equal(f.store.active('health').length, 1);
    f.dispatcher.receive(f.message('/weight 72.3 2026-10-22'));
    f.dispatcher.receive(f.message('/weight 71.9 2026-10-22'));
    f.dispatcher.receive(f.message('/weight 9999 2026-10-23'));
    f.dispatcher.receive(f.message('/weight 70 2026-02-30'));
    assert.deepEqual(f.store.health('health', 'weight').map(r => ({ ...r as object })), [{ kind: 'weight', day: '2026-10-22', value: 71.9, note: '' }]);
    f.dispatcher.receive(f.message('/weight 55', 'finance'));
    assert.equal(f.store.health('finance', 'weight').length, 0);
    await f.dispatcher.waitIdle();
    assert.equal(f.store.recent('health', 'chat-health')[0].status, 'succeeded');
  } finally { await f.cleanup(); }
});

test('session mapping resolves at execution time, runs serialize per agent and overlap across agents', async () => {
  const running = new Set<string>();
  let peak = 0;
  const inputs: { text: string; session: string | null }[] = [];
  const f = fixture({ async execute({ run, onSession }) {
    assert.ok(!running.has(run.agent_id));
    running.add(run.agent_id); peak = Math.max(peak, running.size);
    inputs.push({ text: run.input, session: run.sdk_session });
    onSession(`${run.agent_id}-session.jsonl`);
    await delay(15);
    running.delete(run.agent_id);
    return 'done';
  } });
  try {
    f.dispatcher.receive(f.message('one'));
    f.dispatcher.receive(f.message('two'));
    f.dispatcher.receive(f.message('finance', 'finance'));
    await f.dispatcher.waitIdle();
    assert.equal(peak, 2);
    assert.equal(inputs.find(x => x.text === 'two')!.session, 'health-session.jsonl');
    assert.equal(f.store.session('finance', 'chat-finance').sdk_session, 'finance-session.jsonl');
    const oldKey = f.store.session('health', 'chat-health').session_key;
    f.dispatcher.receive(f.message('/new'));
    assert.notEqual(f.store.session('health', 'chat-health').session_key, oldKey);
    assert.equal(f.store.session('health', 'chat-health').sdk_session, null);
  } finally { await f.cleanup(); }
});

test('/stop cancels running and queued work without waiting behind the active run', async () => {
  const f = fixture({ async execute({ signal }) { await delay(10_000, null, { signal }); return 'should not deliver'; } });
  try {
    f.dispatcher.receive(f.message('one')); f.dispatcher.receive(f.message('two'));
    f.dispatcher.tick();
    await delay(5);
    f.dispatcher.receive(f.message('/stop'));
    await f.dispatcher.waitIdle();
    assert.deepEqual(f.store.recent('health', 'chat-health').map(r => r.status), ['cancelled', 'cancelled']);
    assert.equal(f.store.active('health').length, 0);
  } finally { await f.cleanup(); }
});

test('cron honors Shanghai, New York daylight saving and input validation', () => {
  assert.equal(new Date(nextCron('30 20 * * *', 'Asia/Shanghai', Date.parse('2026-10-22T00:00:00Z'))).toISOString(), '2026-10-22T12:30:00.000Z');
  assert.equal(new Date(nextCron('30 9 * * 1-5', 'America/New_York', Date.parse('2026-07-06T00:00:00Z'))).toISOString(), '2026-07-06T13:30:00.000Z');
  assert.equal(new Date(nextCron('30 9 * * 1-5', 'America/New_York', Date.parse('2026-12-07T00:00:00Z'))).toISOString(), '2026-12-07T14:30:00.000Z');
  assert.throws(() => nextCron('* * * * * *', 'UTC', Date.now()));
  assert.throws(() => nextCron('* * * * *', 'Invalid/Zone', Date.now()));
  assert.equal(localDay('Asia/Shanghai', Date.parse('2026-10-22T18:00:00Z')), '2026-10-23');
});

test('schedules are durable, trigger once, skip stale reminders and coalesce catch-up reports', async () => {
  const f = fixture();
  const start = Date.parse('2026-10-22T00:00:00Z');
  try {
    const reminder = f.scheduler.create('health', 'chat-health', { name: '运动', cron: '* * * * *', action: 'reminder', prompt: '动一动', timezone: 'UTC' }, start);
    assert.equal(f.scheduler.tick(start + 60_000), 1);
    assert.equal(f.scheduler.tick(start + 60_000), 0);
    assert.equal(f.store.recent('health', 'chat-health').length, 1);
    assert.equal(f.store.pending(start + 60_000)[0].text, '动一动');
    f.scheduler.tick(start + 86400_000);
    assert.equal(f.store.recent('health', 'chat-health').length, 1, 'stale reminder must not replay');
    f.scheduler.change('health', 'chat-health', reminder.id, 'pause');
    f.scheduler.create('finance', 'chat-finance', { name: '复盘', cron: '* * * * *', action: 'agent', prompt: '总结', misfire: 'latest', timezone: 'UTC' }, start);
    assert.equal(f.scheduler.tick(start + 86400_000), 1);
    assert.equal(f.store.active('finance').length, 1);
    assert.equal(f.scheduler.tick(start + 86400_000), 0);
    const report = f.store.active('finance')[0];
    assert.notEqual(report.session_key, f.store.session('finance', 'chat-finance').session_key);
    const second = new Store(f.root + '/db.sqlite');
    assert.equal(second.schedules('health', 'chat-health')[0].enabled, 0);
    second.close();
  } finally { await f.cleanup(); }
});

test('one-time tasks, scoped changes and command schedule management work', async () => {
  const f = fixture();
  try {
    const now = Date.now(), at = new Date(now + 1000).toISOString();
    const s = f.scheduler.create('health', 'chat-health', { name: '一次', at, action: 'reminder', prompt: '提醒' }, now);
    assert.throws(() => f.scheduler.change('finance', 'chat-health', s.id, 'delete'));
    f.scheduler.tick(now + 1000); f.scheduler.tick(now + 2000);
    assert.equal(f.store.schedule('health', 'chat-health', s.id)!.enabled, 0);
    assert.equal(f.store.recent('health', 'chat-health').length, 1);
    assert.throws(() => f.scheduler.change('health', 'chat-health', s.id, 'resume', now + 2000));
    f.dispatcher.receive(f.message('/remind 20:30 去运动'));
    const daily = f.store.schedules('health', 'chat-health').find(x => x.name === '去运动')!;
    assert.equal(daily.cron, '30 20 * * *');
    f.dispatcher.receive(f.message(`/schedule pause ${daily.id}`));
    assert.equal(f.store.schedule('health', 'chat-health', daily.id)!.enabled, 0);
    f.dispatcher.receive(f.message(`/schedule update ${daily.id} {"name":"吃饭","cron":"0 18 * * *","action":"reminder","prompt":"晚餐"}`));
    assert.equal(f.store.schedule('health', 'chat-health', daily.id)!.prompt, '晚餐');
    assert.equal(f.store.schedule('health', 'chat-health', daily.id)!.enabled, 0);
    f.dispatcher.receive(f.message(`/schedule resume ${daily.id}`));
    assert.equal(f.store.schedule('health', 'chat-health', daily.id)!.enabled, 1);
    f.dispatcher.receive(f.message(`/schedule delete ${daily.id}`));
    assert.equal(f.store.schedule('health', 'chat-health', daily.id), undefined);
  } finally { await f.cleanup(); }
});

test('restart interrupts running work, keeps queued work, and retries only delivery', async () => {
  const f = fixture();
  try {
    const a = f.store.enqueue('health', 'chat-health', 'a', 'running');
    const b = f.store.enqueue('health', 'chat-health', 'b', 'queued');
    f.store.claim([]);
    assert.equal(f.store.recover(), 1);
    assert.equal(f.store.run(a)!.status, 'interrupted');
    assert.equal(f.store.run(b)!.status, 'queued');
    assert.equal(f.store.recover(), 0);
    const attempts: string[] = [];
    let executions = 0;
    const d = new Dispatcher(f.config, f.store, f.scheduler, { async execute() { executions++; return 'result'; } }, {
      async send(m) { attempts.push(m.id); if (attempts.length === 1) throw new Error('network'); return 'remote-id'; },
    });
    await d.waitIdle(); await d.deliver();
    f.store.db.prepare("UPDATE outbox SET next_at=0 WHERE status='pending'").run();
    await d.deliver(); await d.deliver();
    assert.equal(attempts[0], attempts[1]);
    assert.equal(executions, 1);
    assert.equal(f.store.run(b)!.status, 'succeeded');
    await d.close();
  } finally { await f.cleanup(); }
});

test('private memories, structured tools, tool idempotence and cross-agent access', async () => {
  const f = fixture();
  try {
    const runId = f.store.enqueue('health', 'chat-health', 'm', 'remember');
    const run = f.store.run(runId)!;
    const health = f.config.agents[0], finance = f.config.agents[1];
    f.services.call(health, run, 'memory_write', { content: '喜欢散步' }, 'm1');
    assert.equal(f.services.memory(health), '喜欢散步');
    assert.equal(f.services.memory(finance), '尚无长期记忆。');
    const args = { name: '体重', cron: '0 8 * * *', action: 'reminder', prompt: '记录体重' };
    const one = f.services.call(health, run, 'schedule_create', args, 'c1');
    const replay = f.services.call(health, run, 'schedule_create', args, 'c1');
    assert.deepEqual(JSON.parse(JSON.stringify(one)), replay);
    assert.equal(f.store.schedules('health', 'chat-health').length, 1);
    assert.throws(() => f.services.call(finance, run, 'health_query', { kind: 'weight' }, 'denied'));
    f.services.call(health, run, 'health_record', { kind: 'weight', value: 72.3, day: '2026-10-22' }, 'w1');
    f.services.call(health, run, 'health_delete', { kind: 'weight', day: '2026-10-22' }, 'w2');
    assert.equal(f.store.health('health', 'weight').length, 0);
  } finally { await f.cleanup(); }
});

test('text splitting preserves CJK and emoji and bounds UTF-8 payload bytes', () => {
  const text = '运动🏃身体健康\n'.repeat(5000);
  const parts = splitText(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 9000));
});

test('old uncertain deliveries require manual review, while unsent replies remain deliverable', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.store.queueReply('health', 'chat-health', '可能已投递', 'uncertain', now);
    const message = f.store.pending(now)[0];
    assert.equal(f.store.beginAttempt(message, now), true);
    const pending = f.store.pending(now + 51 * 60000)[0];
    assert.equal(f.store.beginAttempt(pending, now + 51 * 60000), false);
    assert.equal(f.store.failedDeliveries('health'), 1);
    f.store.queueReply('health', 'chat-health', '尚未发送', 'new', now);
    const unsent = f.store.pending(now + 86400_000)[0];
    assert.equal(f.store.beginAttempt(unsent, now + 86400_000), true);
  } finally { await f.cleanup(); }
});

test('busy scheduled agents do not accumulate repeated occurrences of one schedule', async () => {
  const f = fixture();
  try {
    const start = Date.parse('2026-10-22T00:00:00Z');
    f.scheduler.create('finance', 'chat-finance', { name: '监测', cron: '* * * * *', action: 'agent', prompt: '检查' }, start);
    assert.equal(f.scheduler.tick(start + 60_000), 1);
    assert.equal(f.scheduler.tick(start + 120_000), 0);
    assert.equal(f.store.active('finance').length, 1);
    const claimed = f.store.claim([])!;
    assert.equal(f.scheduler.tick(start + 180_000), 0);
    f.store.finish(claimed.id, 'succeeded', '[NO_REPLY]');
    assert.equal(f.scheduler.tick(start + 240_000), 1);
  } finally { await f.cleanup(); }
});
