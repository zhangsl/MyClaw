import { randomUUID } from 'node:crypto';
export const id = () => randomUUID();
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function localDay(timezone: string, now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function validDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error('日期必须是有效的 YYYY-MM-DD');
  }
  return value;
}

export function splitText(text: string, byteLimit = 9000): string[] {
  const parts: string[] = [];
  let part = '', size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > byteLimit) { parts.push(part); part = ''; size = 0; }
    part += char; size += bytes;
  }
  if (part) parts.push(part);
  return parts;
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  // Do not put chat content, health values, API keys or SDK request objects in logs.
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
