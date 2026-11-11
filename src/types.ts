export interface Inbound {
  agentId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
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
}

export interface Messenger {
  send(message: Outbound): Promise<string>;
  react?(message: Inbound): Promise<string>;
  unreact?(message: Inbound, reactionId: string): Promise<void>;
}

export interface EngineRequest {
  run: Run;
  signal: AbortSignal;
  onSession(path: string): void;
}

export interface Engine {
  execute(request: EngineRequest): Promise<string>;
}
