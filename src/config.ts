import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const agentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  persona: z.string(),
  workspace: z.string().optional(),
  skills: z.array(z.string()).default([]),
  sharedKnowledge: z.array(z.string()).default([]),
  builtinTools: z.array(z.enum(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])).default(['read']),
  healthTools: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(10).max(7200).default(300),
  maxToolCalls: z.number().int().min(1).max(500).default(50),
  model: z.object({ provider: z.string(), id: z.string(), apiKeyEnv: z.string().optional() }),
  feishu: z.object({
    appIdEnv: z.string(), appSecretEnv: z.string(), ownerOpenIdEnv: z.string(),
  }),
}).strict();

const schema = z.object({
  timezone: z.string().default('Asia/Shanghai'),
  dataDir: z.string().default('./data'),
  maxConcurrentRuns: z.number().int().min(1).max(8).default(2),
  maxQueuedPerAgent: z.number().int().min(1).max(1000).default(50),
  modelsFile: z.string().optional(),
  agents: z.array(agentSchema).min(1),
}).strict();

export type AgentConfig = z.infer<typeof agentSchema> & { directory: string };
export interface Config extends Omit<z.infer<typeof schema>, 'agents'> {
  root: string;
  agents: AgentConfig[];
}

export function loadConfig(file: string, demo = false): Config {
  const root = dirname(resolve(file));
  const input = schema.parse(parse(readFileSync(file, 'utf8')));
  new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
  const dataDir = resolve(root, demo ? './data-demo' : input.dataDir);
  const ids = new Set<string>();
  const appIds = new Set<string>();
  const agents = input.agents.filter(a => a.enabled).map(a => {
    if (ids.has(a.id)) throw new Error(`重复 Agent ID: ${a.id}`);
    ids.add(a.id);
    if (!demo) {
      for (const key of Object.values(a.feishu)) {
        if (!process.env[key]?.trim()) throw new Error(`缺少环境变量 ${key}`);
      }
      const appId = process.env[a.feishu.appIdEnv]!;
      if (appIds.has(appId)) throw new Error('每个 Agent 必须使用不同的飞书 App ID');
      appIds.add(appId);
    }
    const directory = join(dataDir, 'agents', a.id);
    const workspace = a.workspace ? resolve(root, a.workspace) : join(directory, 'workspace');
    const persona = resolve(root, a.persona);
    readFileSync(persona, 'utf8');
    const sharedKnowledge = a.sharedKnowledge.map(p => resolve(root, p));
    sharedKnowledge.forEach(p => readFileSync(p, 'utf8'));
    const skills = a.skills.map(p => resolve(root, p));
    for (const p of [directory, workspace, join(directory, 'sessions'), join(directory, 'pi')]) {
      mkdirSync(p, { recursive: true, mode: 0o700 });
    }
    return { ...a, directory, workspace, persona, sharedKnowledge, skills };
  });
  if (!agents.length) throw new Error('至少启用一个 Agent');
  return { ...input, root, dataDir, agents, modelsFile: input.modelsFile ? resolve(root, input.modelsFile) : undefined };
}
