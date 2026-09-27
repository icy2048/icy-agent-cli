import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  provider: z.enum(['chat-completions', 'responses']).default('chat-completions'),
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  model: z.string().default(''),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('ICY_API_KEY'),
  apiKeyFile: z.string().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  reasoningSummary: z.boolean().optional(),
  thinkingExpanded: z.boolean().optional(),
  promptCompaction: z.enum(['model', 'local', 'off']).optional(),
  compactionModel: z.string().min(1).optional(),
  compactionMinChars: z.number().int().min(0).max(100_000).default(200),
  permissions: z.enum(['read-only', 'workspace-edit']).default('workspace-edit'),
  maxModelTurns: z.number().int().min(1).max(100).default(20),
  maxToolCalls: z.number().int().min(1).max(200).default(50),
  maxTokens: z.number().int().min(1000).max(2_000_000).default(100_000),
  maxContextChars: z.number().int().min(1000).max(1_000_000).default(120_000),
  requestTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
});
export type Config = z.infer<typeof schema> & { home: string; cwd: string; apiKey: string };
async function readJson(file: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error(`无法读取配置 ${file}: ${e instanceof Error ? e.message : e}`); }
}
export async function loadConfig(cwd: string, overrides: Record<string, unknown> = {}): Promise<Config> {
  const home = path.resolve(process.env.ICY_HOME || path.join(homedir(), '.icy'));
  const user = await readJson(path.join(home, 'config.json'));
  const ui = await readJson(path.join(home, 'ui.json'));
  const project = await readJson(path.join(cwd, '.icy/config.json'));
  const defaults = schema.parse({ promptCompaction: 'local', ...user });
  const safeProject: Record<string, unknown> = {};
  if (typeof project.model === 'string') safeProject.model = project.model;
  for (const key of ['maxModelTurns', 'maxToolCalls', 'maxTokens', 'maxContextChars'] as const) {
    if (typeof project[key] === 'number') safeProject[key] = Math.min(project[key] as number, defaults[key]);
  }
  const env = Object.fromEntries(Object.entries({ model: process.env.ICY_MODEL, baseUrl: process.env.ICY_BASE_URL, provider: process.env.ICY_PROVIDER }).filter(([, v]) => v !== undefined));
  const config = schema.parse({ ...defaults, ...(typeof ui.thinkingExpanded === 'boolean' ? { thinkingExpanded: ui.thinkingExpanded } : {}), ...safeProject, ...env, ...overrides });
  validateBaseUrl(config.baseUrl);
  let apiKey = process.env[config.apiKeyEnv] || '';
  if (!apiKey && config.apiKeyFile) {
    const keyFile = path.resolve(home, config.apiKeyFile);
    const relative = path.relative(home, keyFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('私有密钥文件必须位于 ICY_HOME 内。');
    apiKey = (await readFile(keyFile, 'utf8')).trim();
  }
  return { ...config, baseUrl: config.baseUrl.replace(/\/$/, ''), home, cwd: path.resolve(cwd), apiKey };
}
export function validateBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含凭据、查询参数或 fragment。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程 API 必须使用 HTTPS；本机服务可用 HTTP。');
  return url.href.replace(/\/$/, '');
}
export async function saveThinkingPreference(home: string, thinkingExpanded: boolean): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'ui.json'), temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ thinkingExpanded }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
export async function initConfig(home: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'config.json');
  await writeFile(file, JSON.stringify({ provider: 'chat-completions', baseUrl: 'https://api.openai.com/v1', model: '', apiKeyEnv: 'ICY_API_KEY', permissions: 'workspace-edit', promptCompaction: 'local', maxModelTurns: 20, maxToolCalls: 50 }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}
