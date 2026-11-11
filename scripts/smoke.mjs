#!/usr/bin/env node
// Run the compiled application twice with a disposable configuration and no credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';

const root = mkdtempSync(join(tmpdir(), 'myclaw-smoke-'));
const configPath = join(root, 'config.yaml');
mkdirSync(join(root, 'skills'));
writeFileSync(join(root, 'persona.md'), '你是测试助理。');
writeFileSync(configPath, stringify({ timezone: 'Asia/Shanghai', agents: [{
  id: 'health', name: 'Smoke Health', persona: 'persona.md', healthTools: true, skills: ['skills'],
  model: { provider: 'unused', id: 'unused' },
  feishu: { appIdEnv: 'NOT_USED', appSecretEnv: 'NOT_USED', ownerOpenIdEnv: 'NOT_USED' },
}] }));
const children = [];
function launch() {
  const child = spawn(process.execPath, [resolve('dist/main.js'), '--demo', '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const wait = async text => {
    const until = Date.now() + 12000;
    while (!output.includes(text)) {
      if (Date.now() > until || child.exitCode !== null) throw new Error(`等待 ${text} 失败：\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const send = text => child.stdin.write(`${text}\n`);
  const stop = async () => {
    const ended = once(child, 'exit');
    send('exit');
    const timeout = setTimeout(() => { console.error(`应用退出超时：${output}`); child.kill('SIGKILL'); }, 6000);
    try { const [code] = await ended; assert.equal(code, 0, output); }
    finally { clearTimeout(timeout); }
  };
  return { child, wait, send, stop, output: () => output };
}

try {
  const app = launch();
  await app.wait('输入格式');
  app.send('health /weight 72.3 2026-10-22');
  await app.wait('已记录 2026-10-22');
  app.send('health 测试任务');
  await app.wait('[演示模式 · health]');
  app.send(`health /once ${new Date(Date.now() + 1800).toISOString()} SMOKE_DUE_MESSAGE`);
  await app.wait('一次性');
  const before = app.output().split('SMOKE_DUE_MESSAGE').length;
  const until = Date.now() + 6000;
  while (app.output().split('SMOKE_DUE_MESSAGE').length <= before) {
    if (Date.now() > until) throw new Error('一次性提醒未触发');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await app.stop();
  const restarted = launch();
  await restarted.wait('输入格式');
  restarted.send('health /weights');
  await restarted.wait('2026-10-22  72.3 kg');
  restarted.send('health /schedule list');
  await restarted.wait('暂停/已结束');
  await restarted.stop();
  console.log('PASS: compiled app starts, records weight, executes task, delivers a scheduled reminder, restarts with data, and exits cleanly.');
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
