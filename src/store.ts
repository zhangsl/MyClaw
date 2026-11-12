import { DatabaseSync } from 'node:sqlite';
import { id, splitText, validDay } from './util.js';
import type { Attachment, Inbound, MediaKind, Outbound, Run, RunStatus, Schedule } from './types.js';

type RunRow = Omit<Run, 'attachments'> & { attachments: string };

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if ((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version > 4) throw new Error('数据库版本比当前程序新，请升级程序');
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS inbox (
        agent_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(agent_id, message_id));
      CREATE TABLE IF NOT EXISTS sessions (
        agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_key TEXT NOT NULL, sdk_session TEXT,
        PRIMARY KEY(agent_id, chat_id));
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_key TEXT NOT NULL,
        source_key TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, result TEXT, error TEXT, sdk_session TEXT,
        attachments TEXT NOT NULL DEFAULT '[]', UNIQUE(agent_id, source_key));
      CREATE INDEX IF NOT EXISTS runs_queue ON runs(status, created_at);
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT NOT NULL,
        cron TEXT, at INTEGER, timezone TEXT NOT NULL, action TEXT NOT NULL, prompt TEXT NOT NULL,
        misfire TEXT NOT NULL, grace_seconds INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        next_at INTEGER, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_at);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, dedup TEXT UNIQUE NOT NULL, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', remote_id TEXT, error TEXT, first_attempt_at INTEGER, run_id TEXT,
        kind TEXT NOT NULL DEFAULT 'text', file_path TEXT, file_name TEXT, mime_type TEXT, duration_ms INTEGER);
      CREATE TABLE IF NOT EXISTS health_records (
        agent_id TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, value REAL NOT NULL,
        note TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(agent_id, kind, day));
      CREATE TABLE IF NOT EXISTS tool_receipts (
        run_id TEXT NOT NULL, call_id TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(run_id, call_id));
    `);
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
    if (!runColumns.some(c => c.name === 'attachments')) this.db.exec("ALTER TABLE runs ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    const columns = this.db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'first_attempt_at')) this.db.exec('ALTER TABLE outbox ADD COLUMN first_attempt_at INTEGER');
    if (!columns.some(c => c.name === 'run_id')) this.db.exec('ALTER TABLE outbox ADD COLUMN run_id TEXT');
    if (!columns.some(c => c.name === 'kind')) this.db.exec("ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
    for (const [name, type] of [['file_path', 'TEXT'], ['file_name', 'TEXT'], ['mime_type', 'TEXT'], ['duration_ms', 'INTEGER']]) {
      if (!columns.some(c => c.name === name)) this.db.exec(`ALTER TABLE outbox ADD COLUMN ${name} ${type}`);
    }
    this.db.exec('PRAGMA user_version=4');
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  accept(message: Inbound): boolean {
    return !!this.db.prepare('INSERT OR IGNORE INTO inbox VALUES(?,?,?)')
      .run(message.agentId, message.messageId, Date.now()).changes;
  }

  session(agentId: string, chatId: string): { session_key: string; sdk_session: string | null } {
    this.db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?,NULL)').run(agentId, chatId, id());
    return this.db.prepare('SELECT session_key,sdk_session FROM sessions WHERE agent_id=? AND chat_id=?')
      .get(agentId, chatId) as { session_key: string; sdk_session: string | null };
  }

  newSession(agentId: string, chatId: string): void {
    this.session(agentId, chatId);
    this.db.prepare('UPDATE sessions SET session_key=?,sdk_session=NULL WHERE agent_id=? AND chat_id=?').run(id(), agentId, chatId);
  }

  saveSession(run: Run, path: string): void {
    this.db.prepare('UPDATE runs SET sdk_session=? WHERE id=?').run(path, run.id);
    if (run.kind === 'chat') this.db.prepare('UPDATE sessions SET sdk_session=? WHERE agent_id=? AND chat_id=? AND session_key=?')
      .run(path, run.agent_id, run.chat_id, run.session_key);
  }

  enqueue(agentId: string, chatId: string, source: string, input: string, kind: Run['kind'] = 'chat', now = Date.now(), attachments: Attachment[] = []): string {
    const runId = id();
    const key = kind === 'chat' ? this.session(agentId, chatId).session_key : id();
    this.db.prepare(`INSERT OR IGNORE INTO runs(id,agent_id,chat_id,session_key,source_key,kind,input,status,created_at,attachments)
      VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(runId, agentId, chatId, key, source, kind, input, now, JSON.stringify(attachments));
    return (this.db.prepare('SELECT id FROM runs WHERE agent_id=? AND source_key=?').get(agentId, source) as { id: string }).id;
  }

  private hydrate(row: RunRow | undefined): Run | undefined {
    return row ? { ...row, attachments: JSON.parse(row.attachments) as Attachment[] } : undefined;
  }

  claim(excludedAgents: string[], now = Date.now(), allowedAgents?: string[]): Run | undefined {
    const slots = excludedAgents.map(() => '?').join(',');
    const allowed = allowedAgents?.map(() => '?').join(',');
    if (allowedAgents && !allowedAgents.length) return;
    const row = this.db.prepare(`SELECT * FROM runs WHERE status='queued' ${slots ? `AND agent_id NOT IN (${slots})` : ''}
      ${allowed ? `AND agent_id IN (${allowed})` : ''}
      ORDER BY CASE kind WHEN 'chat' THEN 0 ELSE 1 END,created_at,rowid LIMIT 1`).get(...excludedAgents, ...(allowedAgents ?? [])) as RunRow | undefined;
    const run = this.hydrate(row);
    if (!run) return;
    this.db.prepare("UPDATE runs SET status='running',started_at=? WHERE id=?").run(now, run.id);
    // Resolve at execution time: a previous queued chat may have created the SDK session.
    if (run.kind === 'chat') run.sdk_session = this.session(run.agent_id, run.chat_id).sdk_session;
    run.status = 'running'; run.started_at = now;
    return run;
  }

  finish(runId: string, status: RunStatus, result: string | null, error: string | null = null): void {
    this.db.prepare('UPDATE runs SET status=?,result=?,error=?,finished_at=? WHERE id=?')
      .run(status, result, error, Date.now(), runId);
  }

  run(runId: string): Run | undefined { return this.hydrate(this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined); }
  active(agentId: string): Run[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE agent_id=? AND status IN ('queued','running') ORDER BY created_at").all(agentId) as unknown as RunRow[];
    return rows.map(row => this.hydrate(row)!);
  }
  recent(agentId: string, chatId: string): Run[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE agent_id=? AND chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10')
      .all(agentId, chatId) as unknown as RunRow[];
    return rows.map(row => this.hydrate(row)!);
  }

  queueReply(agentId: string, chatId: string, text: string, dedup: string, now = Date.now(), runId: string | null = null): void {
    splitText(text).forEach((chunk, i) => this.db.prepare('INSERT OR IGNORE INTO outbox(id,dedup,agent_id,chat_id,text,next_at,run_id) VALUES(?,?,?,?,?,?,?)')
      .run(id(), `${dedup}:${i}`, agentId, chatId, chunk, now, runId));
  }
  queueMedia(agentId: string, chatId: string, kind: MediaKind, path: string, name: string, mimeType: string, dedup: string, runId: string, durationMs?: number): string {
    const messageId = id();
    this.db.prepare(`INSERT OR IGNORE INTO outbox(id,dedup,agent_id,chat_id,text,next_at,run_id,kind,file_path,file_name,mime_type,duration_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, dedup, agentId, chatId, '', Date.now(), runId, kind, path, name, mimeType, durationMs ?? null);
    return (this.db.prepare('SELECT id FROM outbox WHERE dedup=?').get(dedup) as { id: string }).id;
  }
  pending(now = Date.now()): Outbound[] {
    // Preserve message/chunk ordering within a chat; other bots are not held up.
    return this.db.prepare(`SELECT o.* FROM outbox o WHERE o.status='pending' AND o.next_at<=?
      AND NOT EXISTS (SELECT 1 FROM outbox earlier WHERE earlier.agent_id=o.agent_id
        AND earlier.chat_id=o.chat_id AND earlier.status='pending' AND earlier.rowid<o.rowid)
      ORDER BY o.rowid LIMIT 20`).all(now) as unknown as Outbound[];
  }
  sent(message: Outbound, remoteId: string): void {
    this.db.prepare("UPDATE outbox SET status='sent',remote_id=?,error=NULL WHERE id=?").run(remoteId, message.id);
  }
  hasPendingReply(runId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE run_id=? AND status='pending' LIMIT 1").get(runId);
  }
  beginAttempt(message: Outbound, now = Date.now()): boolean {
    if (message.first_attempt_at !== null && now - message.first_attempt_at > 50 * 60_000) {
      // A process may have died after the remote send succeeded. Do not replay beyond the deduplication window.
      this.db.prepare("UPDATE outbox SET status='failed',error='delivery_ambiguous' WHERE id=?").run(message.id);
      return false;
    }
    this.db.prepare('UPDATE outbox SET first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=?').run(now, message.id);
    return true;
  }
  sendFailed(message: Outbound, now = Date.now()): void {
    const attempts = message.attempts + 1;
    // Stop automatic retries before platform idempotency windows can expire; manual replay may duplicate a delivered message.
    this.db.prepare('UPDATE outbox SET status=?,attempts=?,next_at=?,error=? WHERE id=?')
      .run(attempts >= 8 ? 'failed' : 'pending', attempts, now + Math.min(60_000, 1000 * 2 ** attempts), 'delivery_failed', message.id);
  }
  failedDeliveries(agentId: string): number {
    return (this.db.prepare("SELECT count(*) n FROM outbox WHERE agent_id=? AND status='failed'").get(agentId) as { n: number }).n;
  }

  recover(): number {
    return this.transaction(() => {
      const runs = this.db.prepare("SELECT * FROM runs WHERE status='running'").all() as unknown as RunRow[];
      for (const row of runs) {
        const run = this.hydrate(row)!;
        this.finish(run.id, 'interrupted', null, 'process_restarted');
        this.queueReply(run.agent_id, run.chat_id, `任务 ${run.id.slice(0, 8)} 因服务重启而中断。已执行的操作不会撤销；请检查后告诉我如何继续。`, `interrupted:${run.id}`);
      }
      return runs.length;
    });
  }

  schedules(agentId: string, chatId: string): Schedule[] {
    return this.db.prepare('SELECT * FROM schedules WHERE agent_id=? AND chat_id=? ORDER BY created_at').all(agentId, chatId) as unknown as Schedule[];
  }
  schedule(agentId: string, chatId: string, scheduleId: string): Schedule | undefined {
    return this.db.prepare('SELECT * FROM schedules WHERE id=? AND agent_id=? AND chat_id=?').get(scheduleId, agentId, chatId) as Schedule | undefined;
  }

  writeHealth(agentId: string, kind: 'weight' | 'exercise', day: string, value: number, note: string, source: string): void {
    validDay(day);
    if (!Number.isFinite(value) || (kind === 'weight' ? value < 1 || value > 600 : value < 0 || value > 1440)) throw new Error('记录数值超出允许范围');
    this.db.prepare(`INSERT INTO health_records VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id,kind,day)
      DO UPDATE SET value=excluded.value,note=excluded.note,source=excluded.source,updated_at=excluded.updated_at`)
      .run(agentId, kind, day, value, note.slice(0, 2000), source, Date.now());
  }
  health(agentId: string, kind: string, limit = 30): unknown[] {
    return this.db.prepare('SELECT kind,day,value,note FROM health_records WHERE agent_id=? AND kind=? ORDER BY day DESC LIMIT ?')
      .all(agentId, kind, Math.max(1, Math.min(366, limit)));
  }
  deleteHealth(agentId: string, kind: string, day: string): void {
    this.db.prepare('DELETE FROM health_records WHERE agent_id=? AND kind=? AND day=?').run(agentId, kind, validDay(day));
  }
  close(): void { this.db.close(); }
}
