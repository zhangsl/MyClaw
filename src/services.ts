import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from './config.js';
import type { Run } from './types.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { id, localDay } from './util.js';

export class Services {
  constructor(readonly store: Store, readonly scheduler: Scheduler, readonly timezone: string) {}
  memory(agent: AgentConfig): string {
    const file = join(agent.directory, 'memory.md');
    return existsSync(file) ? readFileSync(file, 'utf8') : '尚无长期记忆。';
  }
  writeMemory(agent: AgentConfig, content: string): void {
    z.string().max(16000).parse(content);
    const path = join(agent.directory, 'memory.md');
    const temp = `${path}.${id()}.tmp`;
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, path);
  }
  call(agent: AgentConfig, run: Run, tool: string, args: unknown, callId: string): unknown {
    if (agent.id !== run.agent_id) throw new Error('Agent 与任务不匹配');
    return this.store.transaction(() => {
      const receipt = this.store.db.prepare('SELECT result FROM tool_receipts WHERE run_id=? AND call_id=?').get(run.id, callId) as { result: string } | undefined;
      if (receipt) return JSON.parse(receipt.result);
      const result = this.dispatch(agent, run, tool, args);
      this.store.db.prepare('INSERT INTO tool_receipts VALUES(?,?,?)').run(run.id, callId, JSON.stringify(result));
      return result;
    });
  }
  private dispatch(agent: AgentConfig, run: Run, tool: string, args: unknown): unknown {
    if (tool === 'memory_read') return { memory: this.memory(agent) };
    if (tool === 'memory_write') {
      const { content } = z.object({ content: z.string().max(16000) }).strict().parse(args);
      this.writeMemory(agent, content);
      return { saved: true };
    }
    if (tool === 'recent_runs') return this.store.recent(agent.id, run.chat_id).filter(r => r.id !== run.id)
      .map(r => ({ id: r.id, kind: r.kind, status: r.status, input: r.input.slice(0, 2000), result: r.result?.slice(0, 12000), at: r.created_at }));
    if (tool === 'schedule_list') return this.store.schedules(agent.id, run.chat_id);
    if (tool === 'schedule_create') return this.scheduler.create(agent.id, run.chat_id, { timezone: this.timezone, ...(args as object) });
    if (tool === 'schedule_update') {
      const a = z.object({ id: z.string(), schedule: z.record(z.string(), z.unknown()) }).strict().parse(args);
      return this.scheduler.update(agent.id, run.chat_id, a.id, { timezone: this.timezone, ...a.schedule });
    }
    if (tool === 'schedule_change') {
      const a = z.object({ id: z.string(), operation: z.enum(['pause', 'resume', 'delete']) }).strict().parse(args);
      this.scheduler.change(agent.id, run.chat_id, a.id, a.operation);
      return { done: true, ...a };
    }
    if (tool === 'health_record' && agent.healthTools) {
      const a = z.object({ kind: z.enum(['weight', 'exercise']), day: z.string().default(localDay(this.timezone)),
        value: z.number(), note: z.string().max(2000).default('') }).strict().parse(args);
      this.store.writeHealth(agent.id, a.kind, a.day, a.value, a.note, run.source_key);
      return { saved: true, ...a, unit: a.kind === 'weight' ? 'kg' : 'minutes' };
    }
    if (tool === 'health_query' && agent.healthTools) {
      const a = z.object({ kind: z.enum(['weight', 'exercise']), limit: z.number().int().min(1).max(366).default(30) }).strict().parse(args);
      return this.store.health(agent.id, a.kind, a.limit);
    }
    if (tool === 'health_delete' && agent.healthTools) {
      const a = z.object({ kind: z.enum(['weight', 'exercise']), day: z.string() }).strict().parse(args);
      this.store.deleteHealth(agent.id, a.kind, a.day);
      return { deleted: true, ...a };
    }
    throw new Error(`工具不可用: ${tool}`);
  }
}
