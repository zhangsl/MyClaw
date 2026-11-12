import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';

export function transcribeAudio(path: string, config: Config): Promise<string> {
  const python = process.env.FASTER_WHISPER_PYTHON ?? join(config.dataDir, 'asr', 'venv', 'bin', 'python');
  const model = process.env.FASTER_WHISPER_MODEL ?? 'base';
  const modelDirectory = join(config.dataDir, 'asr', 'models');
  const script = join(config.root, 'scripts', 'transcribe.py');
  const args = [script, path, '--model', model, '--model-dir', modelDirectory];
  const language = process.env.FASTER_WHISPER_LANGUAGE;
  if (language) args.push('--language', language);
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.on('data', chunk => { if (stdout.length < 100_000) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 64_000) stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`本地语音识别失败 exit=${code ?? 'unknown'}`)); return; }
      try { resolve(z.object({ text: z.string() }).parse(JSON.parse(stdout)).text); }
      catch { reject(new Error('本地语音识别返回格式错误')); }
    });
  });
}
