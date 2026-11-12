export type MediaKind = 'image' | 'audio' | 'file';

export interface MediaResource {
  kind: MediaKind;
  key: string;
  name?: string;
  durationMs?: number;
}

export interface Attachment {
  kind: MediaKind;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  durationMs?: number;
  transcript?: string;
}

export interface Inbound {
  agentId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  resources?: MediaResource[];
  attachments?: Attachment[];
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface Run {
  id: string;
  agent_id: string;
  chat_id: string;
  session_key: string;
  source_key: string;
  kind: 'chat' | 'scheduled';
  input: string;
  status: RunStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  result: string | null;
  error: string | null;
  sdk_session: string | null;
  attachments: Attachment[];
}

export interface Schedule {
  id: string;
  agent_id: string;
  chat_id: string;
  name: string;
  cron: string | null;
  at: number | null;
  timezone: string;
  action: 'reminder' | 'agent';
  prompt: string;
  misfire: 'skip' | 'latest';
  grace_seconds: number;
  enabled: number;
  next_at: number | null;
  created_at: number;
}

export interface Outbound {
  id: string;
  agent_id: string;
  chat_id: string;
  text: string;
  attempts: number;
  next_at: number;
  status: 'pending' | 'sent' | 'failed';
  remote_id: string | null;
  error: string | null;
  first_attempt_at: number | null;
  run_id: string | null;
  kind: 'text' | MediaKind;
  file_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  duration_ms: number | null;
}

export interface Messenger {
  send(message: Outbound): Promise<string>;
  react?(message: Inbound): Promise<string>;
  unreact?(message: Inbound, reactionId: string): Promise<void>;
}

export interface DocumentReadResult {
  document_id: string;
  title: string;
  revision_id: number | null;
  content: string;
  truncated: boolean;
}

export interface DocumentWriteResult {
  saved: true;
  document_id: string;
  mode: 'append' | 'overwrite';
  revision_id: number | null;
  blocks: number;
}

export interface DocumentService {
  read(agentId: string, document: string, signal: AbortSignal): Promise<DocumentReadResult>;
  write(agentId: string, document: string, content: string, mode: 'append' | 'overwrite', signal: AbortSignal, operationId: string): Promise<DocumentWriteResult>;
}

export type SpreadsheetCell = string | number | boolean | null;
export interface SpreadsheetReadResult {
  spreadsheet_token: string;
  title: string;
  revision_id: number | null;
  range: string;
  values: unknown[][];
  truncated: boolean;
  sheets: { sheet_id: string; title: string; index: number | null; rows: number | null; columns: number | null }[];
}

export interface SpreadsheetWriteResult {
  saved: true;
  spreadsheet_token: string;
  sheet_id: string;
  mode: 'append' | 'overwrite';
  range: string;
  revision_id: number | null;
  updated_cells: number | null;
}

export interface SpreadsheetService {
  read(agentId: string, spreadsheet: string, range: string | undefined, signal: AbortSignal): Promise<SpreadsheetReadResult>;
  write(agentId: string, spreadsheet: string, range: string | undefined, values: SpreadsheetCell[][], mode: 'append' | 'overwrite', signal: AbortSignal): Promise<SpreadsheetWriteResult>;
}

export interface EngineRequest {
  run: Run;
  signal: AbortSignal;
  onSession(path: string): void;
}

export interface Engine {
  execute(request: EngineRequest): Promise<string>;
}
