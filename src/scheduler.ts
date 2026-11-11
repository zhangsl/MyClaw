import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { id } from './util.js';
import { Store } from './store.js';
import type { Schedule } from './types.js';

export const scheduleInput = z.object({
  name: z.string().min(1).max(120),
  cron: z.string().optional(),
  at: z.string().optional(),
  timezone: z.string().default('Asia/Shanghai'),
  action: z.enum(['reminder', 'agent']),
  prompt: z.string().min(1).max(12000),
  misfire: z.enum(['skip', 'latest']).default('skip'),
  graceSeconds: z.number().int().min(0).max(86400).default(120),
}).strict().refine(x => !!x.cron !== !!x.at, 'cron 与 at 必须且只能填写一个');
export type ScheduleInput = z.input<typeof scheduleInput>;

export function nextCron(cron: string, timezone: string, after: number): number {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error('cron 必须为五段，最小粒度为分钟');
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  return CronExpressionParser.parse(cron, { currentDate: new Date(after), tz: timezone }).next().getTime();
}

function validate(input: unknown, now: number) {
  const value = scheduleInput.parse(input);
  new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
  let due: number;
  if (value.cron) due = nextCron(value.cron, value.timezone, now);
  else {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(value.at!)) throw new Error('at 必须包含时区，例如 2026-12-01T20:30:00+08:00');
    due = Date.parse(value.at!);
    if (!Number.isFinite(due) || due <= now) throw new Error('一次性任务必须设置有效的未来时间');
  }
  return { value, due };
}

export class Scheduler {
  constructor(private store: Store, private enabledAgents: string[]) {}
  create(agentId: string, chatId: string, input: unknown, now = Date.now()): Schedule {
    if (this.store.schedules(agentId, chatId).length >= 100) throw new Error('每个助理最多保留 100 个计划，请删除不再使用的计划');
    const { value: v, due } = validate(input, now);
    const scheduleId = id();
    this.store.db.prepare(`INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(scheduleId, agentId, chatId, v.name, v.cron ?? null, v.at ? due : null, v.timezone,
        v.action, v.prompt, v.misfire, v.graceSeconds, 1, due, now);
    return this.store.schedule(agentId, chatId, scheduleId)!;
  }
  update(agentId: string, chatId: string, scheduleId: string, input: unknown, now = Date.now()): Schedule {
    if (!this.store.schedule(agentId, chatId, scheduleId)) throw new Error('找不到此计划');
    const { value: v, due } = validate(input, now);
    this.store.db.prepare(`UPDATE schedules SET name=?,cron=?,at=?,timezone=?,action=?,prompt=?,misfire=?,grace_seconds=?,next_at=?
      WHERE id=? AND agent_id=? AND chat_id=?`)
      .run(v.name, v.cron ?? null, v.at ? due : null, v.timezone, v.action, v.prompt, v.misfire, v.graceSeconds, due, scheduleId, agentId, chatId);
    return this.store.schedule(agentId, chatId, scheduleId)!;
  }
  change(agentId: string, chatId: string, scheduleId: string, operation: 'pause' | 'resume' | 'delete', now = Date.now()): void {
    const s = this.store.schedule(agentId, chatId, scheduleId);
    if (!s) throw new Error('找不到此计划');
    if (operation === 'delete') this.store.db.prepare('DELETE FROM schedules WHERE id=?').run(s.id);
    else if (operation === 'pause') this.store.db.prepare('UPDATE schedules SET enabled=0 WHERE id=?').run(s.id);
    else {
      const due = s.cron ? nextCron(s.cron, s.timezone, now) : s.at;
      if (due === null || due <= now) throw new Error('一次性任务已过期，请修改时间');
      this.store.db.prepare('UPDATE schedules SET enabled=1,next_at=? WHERE id=?').run(due, s.id);
    }
  }
  tick(now = Date.now()): number {
    return this.store.transaction(() => {
      const due = this.store.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next_at<=? ORDER BY next_at').all(now) as unknown as Schedule[];
      let count = 0;
      for (const s of due) {
        if (!this.enabledAgents.includes(s.agent_id)) continue;
        let occurrence = s.next_at!;
        if (s.cron && s.misfire === 'latest') {
          // At most one catch-up run, even after weeks of downtime.
          occurrence = CronExpressionParser.parse(s.cron, { currentDate: new Date(now + 1), tz: s.timezone }).prev().getTime();
        }
        const stale = now - occurrence > s.grace_seconds * 1000;
        const outstanding = s.action === 'agent' && this.store.db.prepare(
          "SELECT id FROM runs WHERE agent_id=? AND source_key LIKE ? AND status IN ('queued','running') LIMIT 1"
        ).get(s.agent_id, `schedule:${s.id}:%`);
        if (!(stale && s.misfire === 'skip') && !outstanding) {
          const source = `schedule:${s.id}:${occurrence}`;
          const runId = this.store.enqueue(s.agent_id, s.chat_id, source, s.prompt, 'scheduled', now);
          if (s.action === 'reminder') {
            this.store.finish(runId, 'succeeded', s.prompt);
            this.store.queueReply(s.agent_id, s.chat_id, s.prompt, `result:${runId}`, now);
          }
          count++;
        }
        this.store.db.prepare('UPDATE schedules SET next_at=?,enabled=? WHERE id=?')
          .run(s.cron ? nextCron(s.cron, s.timezone, now) : null, s.cron ? 1 : 0, s.id);
      }
      return count;
    });
  }
}
