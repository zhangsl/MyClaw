#!/usr/bin/env node
// Offline maintenance: stop the systemd service first. Does not send messages.
import { resolve, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import lockfile from 'proper-lockfile';
import { Store } from '../dist/store.js';

const [command, configPath = 'config.yaml', target] = process.argv.slice(2);
if (!['failed', 'retry'].includes(command)) {
  console.error('用法：node scripts/admin.mjs failed <config.yaml>\n      node scripts/admin.mjs retry <config.yaml> <outbox-id>\n先停止 MyClaw 服务。retry 可能重复投递，请先核对飞书。');
  process.exit(1);
}
const root = dirname(resolve(configPath));
const config = parse(readFileSync(resolve(configPath), 'utf8'));
const directory = resolve(root, config.dataDir ?? './data');
const release = await lockfile.lock(directory, { retries: 0 });
const store = new Store(join(directory, 'myclaw.sqlite'));
try {
  if (command === 'failed') {
    console.log(JSON.stringify(store.db.prepare("SELECT id,agent_id,chat_id,kind,file_name,text,attempts,error FROM outbox WHERE status='failed' ORDER BY rowid").all(), null, 2));
  } else {
    if (!target) throw new Error('缺少 outbox-id');
    const result = store.db.prepare("UPDATE outbox SET status='pending',attempts=0,next_at=0,first_attempt_at=NULL,error=NULL WHERE id=? AND status='failed'").run(target);
    console.log(`已重新入队 ${result.changes} 条回复；未重新执行 Agent。启动服务后投递。`);
  }
} finally { store.close(); await release(); }
