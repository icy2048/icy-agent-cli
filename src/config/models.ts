import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { readFile, mkdir, writeFile, rename, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { validateBaseUrl, type Config } from './load.js';
import { ModelProvider } from '../providers/model.js';
import { clean, redact, errorText } from '../core/text.js';

export interface ModelProfile {
  name: string; baseUrl: string; provider: Config['provider']; model: string; apiKey: string;
  reasoningEffort?: Config['reasoningEffort']; reasoningSummary?: boolean;
}
export interface ModelServices {
  discover(): Promise<ModelProfile[]>;
  list(profile: ModelProfile, signal: AbortSignal): Promise<string[]>;
  verify(profile: ModelProfile, config: Config, signal: AbortSignal): Promise<void>;
}
export function parseCCProfile(name: string, settings: string): ModelProfile | undefined {
  const data = JSON.parse(settings), toml = parse(data.config || '');
  const providers = toml.model_providers as Record<string, Record<string, unknown>> | undefined;
  const active = providers?.[String(toml.model_provider)];
  if (!active || typeof active.base_url !== 'string') return;
  const apiKey = data.auth?.OPENAI_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) return;
  if (active.wire_api && !['responses', 'chat'].includes(String(active.wire_api))) return;
  const effort = String(toml.model_reasoning_effort || '');
  return { name: clean(name), baseUrl: validateBaseUrl(active.base_url), provider: active.wire_api === 'responses' ? 'responses' : 'chat-completions',
    model: typeof toml.model === 'string' ? toml.model : '', apiKey: apiKey.trim(),
    ...(['low', 'medium', 'high', 'xhigh'].includes(effort) ? { reasoningEffort: effort as Config['reasoningEffort'] } : {}) };
}
export async function discoverCCProfiles(database = path.join(homedir(), '.cc-switch/cc-switch.db')): Promise<ModelProfile[]> {
  try { await access(database); } catch { return []; }
  let output: string;
  try {
    output = (await promisify(execFile)('sqlite3', ['-readonly', '-json', database, "SELECT name,settings_config FROM providers WHERE app_type='codex' ORDER BY is_current DESC,sort_index,name"], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 })).stdout;
  } catch { throw new Error('无法读取 CC Switch；请确认 sqlite3 可用，或选择手动配置。'); }
  const profiles: ModelProfile[] = [];
  for (const row of JSON.parse(output || '[]')) {
    try { const profile = parseCCProfile(row.name, row.settings_config); if (profile) profiles.push(profile); } catch { /* Skip incompatible or incomplete entries. */ }
  }
  return profiles;
}
export async function listModels(profile: ModelProfile, signal: AbortSignal): Promise<string[]> {
  const base = validateBaseUrl(profile.baseUrl);
  const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${profile.apiKey}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), redirect: 'error' });
  if (!response.ok) throw new Error(`模型列表不可用（HTTP ${response.status}），可以手动填写模型名。`);
  const body = await response.json() as { data?: { id?: unknown }[] };
  if (!Array.isArray(body.data)) throw new Error('服务未提供标准模型列表，可以手动填写模型名。');
  return [...new Set(body.data.map(m => m.id).filter((id): id is string => typeof id === 'string' && !!id && clean(id) === id))].sort();
}
export function profileConfig(config: Config, profile: ModelProfile): Config {
  if (!profile.model.trim()) throw new Error('请填写模型名。');
  if (!profile.apiKey.trim()) throw new Error('请填写 API key。');
  return { ...config, baseUrl: validateBaseUrl(profile.baseUrl), provider: profile.provider, model: profile.model.trim(), apiKey: profile.apiKey.trim(), reasoningEffort: profile.reasoningEffort, reasoningSummary: profile.reasoningSummary };
}
export async function verifyModel(profile: ModelProfile, config: Config, signal: AbortSignal): Promise<void> {
  const candidate = profileConfig(config, profile);
  try {
    const response = await new ModelProvider({ ...candidate, requestTimeoutMs: 20000 }).complete([{ role: 'user', content: 'Reply with OK only. Do not call tools.' }], [], AbortSignal.any([signal, AbortSignal.timeout(30000)]), () => {});
    if (response.incomplete || !response.text.trim()) throw new Error('服务没有返回完整文本，请检查协议和模型名。');
  } catch (e) { throw new Error(redact(errorText(e), [profile.apiKey])); }
}
export async function saveModelProfile(home: string, profile: ModelProfile): Promise<void> {
  validateBaseUrl(profile.baseUrl);
  let previous: Record<string, unknown> = {};
  try { previous = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await mkdir(path.join(home, 'credentials'), { recursive: true, mode: 0o700 });
  const keyFile = `credentials/model-${randomUUID()}.key`, temp = path.join(home, `config-${randomUUID()}.tmp`);
  try {
    await writeFile(path.join(home, keyFile), profile.apiKey.trim(), { mode: 0o600, flag: 'wx' });
    const next = { ...previous, provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model.trim(), apiKeyEnv: 'ICY_API_KEY', apiKeyFile: keyFile, reasoningEffort: profile.reasoningEffort, reasoningSummary: profile.reasoningSummary };
    delete (next as Record<string, unknown>).apiKey;
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path.join(home, 'config.json'));
  } catch (e) { await rm(path.join(home, keyFile), { force: true }); throw e; }
  finally { await rm(temp, { force: true }); }
}
export const modelServices: ModelServices = { discover: () => discoverCCProfiles(), list: listModels, verify: verifyModel };
