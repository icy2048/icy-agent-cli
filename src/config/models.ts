import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { readFile, mkdir, writeFile, rename, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { APIConnectionError, APIConnectionTimeoutError, APIError, AuthenticationError, NotFoundError, PermissionDeniedError } from 'openai';
import { parse } from 'smol-toml';
import { validateBaseUrl, type Config } from './load.js';
import { ModelProvider } from '../providers/model.js';
import { clean, redact, errorText } from '../core/text.js';

export interface ModelProfile {
  name: string; baseUrl: string; provider: Config['provider']; model: string; apiKey: string;
  reasoningEffort?: Config['reasoningEffort']; reasoningSummary?: boolean;
  allowPrivateHttp?: boolean;
}
export type ModelVerification =
  | { ok: true; textReply: true; toolCalls: true }
  | { ok: false; stage: 'auth' | 'connect' | 'protocol' | 'model' | 'text' | 'tool_call' | 'tool_result'; message: string };
export interface ModelServices {
  discover(): Promise<ModelProfile[]>;
  list(profile: ModelProfile, signal: AbortSignal): Promise<string[]>;
  verify(profile: ModelProfile, config: Config, signal: AbortSignal): Promise<ModelVerification>;
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
  const base = validateBaseUrl(profile.baseUrl, profile.allowPrivateHttp);
  const response = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${profile.apiKey}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), redirect: 'error' });
  if (!response.ok) throw new Error(`模型列表不可用（HTTP ${response.status}），可以手动填写模型名。`);
  const body = await response.json() as { data?: { id?: unknown }[] };
  if (!Array.isArray(body.data)) throw new Error('服务未提供标准模型列表，可以手动填写模型名。');
  return [...new Set(body.data.map(m => m.id).filter((id): id is string => typeof id === 'string' && !!id && clean(id) === id))].sort();
}
export function profileConfig(config: Config, profile: ModelProfile): Config {
  if (!profile.model.trim()) throw new Error('请填写模型名。');
  if (!profile.apiKey.trim()) throw new Error('请填写 API key。');
  return { ...config, baseUrl: validateBaseUrl(profile.baseUrl, profile.allowPrivateHttp), allowPrivateHttp: profile.allowPrivateHttp, provider: profile.provider, model: profile.model.trim(), apiKey: profile.apiKey.trim(), reasoningEffort: profile.reasoningEffort, reasoningSummary: profile.reasoningSummary };
}
function detail(error: unknown, apiKey: string): string {
  return redact(errorText(error), [apiKey]);
}
function statusOf(error: unknown): number | undefined {
  return error instanceof APIError ? error.status : typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}
function hasCause(error: unknown, predicate: (value: unknown) => boolean): boolean {
  let current: unknown = error;
  for (let i = 0; i < 5 && current; i++) {
    if (predicate(current)) return true;
    current = typeof current === 'object' && current !== null && 'cause' in current ? current.cause : undefined;
  }
  return false;
}
function isConnectionFailure(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APIConnectionTimeoutError) return true;
  return hasCause(error, value => {
    const code = typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined;
    const message = errorText(value);
    return ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(String(code)) || /timed? ?out|connection error|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(message);
  });
}
function isModelNotFound(error: unknown): boolean {
  return (statusOf(error) === 404 || error instanceof NotFoundError) && /model/i.test(errorText(error));
}
function isProtocolFailure(error: unknown): boolean {
  const message = errorText(error);
  return statusOf(error) === 404 || /(?:^|:)\s*invalid_[a-z_]+|stream_interrupted|malformed (?:server-sent event|newline-delimited) JSON|missing its output array|error reading response/i.test(message);
}
function classifiedFailure(error: unknown, apiKey: string, fallback: 'text' | 'tool_call' | 'tool_result'): ModelVerification {
  const message = detail(error, apiKey);
  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError || statusOf(error) === 401 || statusOf(error) === 403) return { ok: false, stage: 'auth', message: `认证失败：${message}` };
  if (isModelNotFound(error)) return { ok: false, stage: 'model', message: `模型不存在：${message}` };
  if (isProtocolFailure(error)) return { ok: false, stage: 'protocol', message: `协议不兼容：请在 responses 与 chat-completions 之间切换，或检查 base URL 是否包含正确的路径前缀。${message ? `（${message}）` : ''}` };
  if (isConnectionFailure(error)) return { ok: false, stage: 'connect', message: `无法连接：${message}` };
  return { ok: false, stage: fallback, message };
}
function invalidToolCall(profile: ModelProfile, reason: string): ModelVerification {
  return { ok: false, stage: 'tool_call', message: `工具调用不正确：${reason}（模型：${profile.model}）` };
}
export async function verifyModel(profile: ModelProfile, config: Config, signal: AbortSignal): Promise<ModelVerification> {
  let candidate: Config;
  try { candidate = profileConfig(config, profile); }
  catch (e) { return classifiedFailure(e, profile.apiKey, 'text'); }
  const total = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const requestSignal = () => AbortSignal.any([total, AbortSignal.timeout(30000)]);
  const provider = new ModelProvider({ ...candidate, requestTimeoutMs: 30000 }), secret = candidate.apiKey;
  try {
    const textResponse = await provider.complete([{ role: 'user', content: 'Reply with OK only. Do not call tools.' }], [], requestSignal(), () => {});
    if (textResponse.incomplete || !textResponse.text.trim()) throw new Error('服务没有返回完整文本，请检查协议和模型名。');
  } catch (e) { return classifiedFailure(e, secret, 'text'); }

  const probeTool = {
    name: 'icy_probe',
    description: 'Diagnostic probe. Call it with {"value":"ping"} and then answer with the returned text.',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    strict: true,
  } as const;
  let probe;
  try {
    probe = await provider.complete([{ role: 'user', content: 'Call the icy_probe tool with {"value":"ping"}. Do not answer until you have called it.' }], [probeTool], requestSignal(), () => {});
  } catch (e) { return classifiedFailure(e, secret, 'tool_call'); }
  if (probe.incomplete) return classifiedFailure(new Error('服务没有返回完整工具调用，请检查协议和模型名。'), secret, 'tool_call');
  if (probe.calls.length === 0) return { ok: false, stage: 'tool_call', message: `不支持工具调用：模型 ${profile.model} 没有返回 icy_probe 工具调用。` };
  if (probe.calls.length !== 1) return invalidToolCall(profile, `期望恰好一次 icy_probe 调用，实际收到 ${probe.calls.length} 次`);
  const call = probe.calls[0]!;
  let argumentsValue: unknown;
  try { argumentsValue = JSON.parse(call.arguments); } catch { return invalidToolCall(profile, '参数不是有效 JSON'); }
  if (call.name !== 'icy_probe' || typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)
    || Object.keys(argumentsValue).length !== 1 || (argumentsValue as { value?: unknown }).value !== 'ping') return invalidToolCall(profile, '调用名称或参数不是 icy_probe({value:"ping"})');

  const token = `pong-${randomBytes(3).toString('hex')}`;
  let followUp;
  try {
    followUp = await provider.complete([
      { role: 'user', content: 'Call the icy_probe tool with {"value":"ping"}. Do not answer until you have called it.' },
      { role: 'assistant', content: probe.text, calls: probe.calls, opaque: probe.opaque },
      { role: 'tool', id: call.id, content: token },
    ], [], requestSignal(), () => {});
  } catch (e) { return classifiedFailure(e, secret, 'tool_result'); }
  if (followUp.incomplete) return classifiedFailure(new Error('服务没有返回完整文本，请检查协议和模型名。'), secret, 'tool_result');
  if (!followUp.text.includes(token)) return { ok: false, stage: 'tool_result', message: `工具结果续接失败：模型未在后续文本中返回探针结果 ${token}。` };
  return { ok: true, textReply: true, toolCalls: true };
}
export async function saveModelProfile(home: string, profile: ModelProfile): Promise<void> {
  validateBaseUrl(profile.baseUrl, profile.allowPrivateHttp);
  let previous: Record<string, unknown> = {};
  try { previous = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await mkdir(path.join(home, 'credentials'), { recursive: true, mode: 0o700 });
  const keyFile = `credentials/model-${randomUUID()}.key`, temp = path.join(home, `config-${randomUUID()}.tmp`);
  try {
    await writeFile(path.join(home, keyFile), profile.apiKey.trim(), { mode: 0o600, flag: 'wx' });
    const next = { ...previous, provider: profile.provider, baseUrl: profile.baseUrl, allowPrivateHttp: profile.allowPrivateHttp, model: profile.model.trim(), apiKeyEnv: 'ICY_API_KEY', apiKeyFile: keyFile, reasoningEffort: profile.reasoningEffort, reasoningSummary: profile.reasoningSummary };
    delete (next as Record<string, unknown>).apiKey;
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path.join(home, 'config.json'));
  } catch (e) { await rm(path.join(home, keyFile), { force: true }); throw e; }
  finally { await rm(temp, { force: true }); }
}
export const modelServices: ModelServices = { discover: () => discoverCCProfiles(), list: listModels, verify: verifyModel };
