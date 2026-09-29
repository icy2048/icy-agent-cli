import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore, type SessionStoreOptions } from '../../src/sessions/store.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Config } from '../../src/config/load.js';

export const posix = process.platform !== 'win32';
export const skipWindows = 'POSIX process-group test is skipped on Windows';
export const nodeCommand = (script: string) => `${process.execPath} -e '${script.replaceAll("'", String.fromCharCode(39, 34, 39, 34, 39))}'`;
export const bashArgs = (command: string, extra: Record<string, unknown> = {}) => ({ command, cwd: null, timeoutMs: null, detach: false, kill: null, ...extra });
export const testProcessTiming = { escalationMs: 25, killConfirmMs: 50, identityTimeoutMs: 200, watchdogRetryMs: 35, firstOutputWaitMs: 20 };

export async function fixture(options: Pick<SessionStoreOptions, 'platform' | 'processPlatform' | 'shellPath' | 'processSpawn' | 'processKill' | 'processIdentity' | 'processExecFile' | 'processAlive' | 'processOutputLimit' | 'processLogWriterFactory' | 'processLogReader' | 'processTiming' | 'fsWriteFile'> & { secrets?: string[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-process-')), cwd = path.join(root, 'workspace'), home = path.join(root, 'home');
  await mkdir(cwd);
  const config: Config = { home, cwd, provider: 'responses', baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: '', apiKeyEnv: 'ICY_TEST_KEY', permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100_000, maxContextChars: 120_000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, config, options.secrets ?? [], {
    platform: options.platform === 'win32' ? undefined : options.platform, processPlatform: options.processPlatform ?? options.platform, shellPath: options.shellPath, processSpawn: options.processSpawn, processKill: options.processKill,
    processIdentity: options.processIdentity, processExecFile: options.processExecFile, processAlive: options.processAlive, processOutputLimit: options.processOutputLimit,
    processLogWriterFactory: options.processLogWriterFactory, processLogReader: options.processLogReader,
    processTiming: { ...testProcessTiming, ...options.processTiming }, fsWriteFile: options.fsWriteFile,
  });
  const approvals: unknown[] = [], tools = new ToolRegistry(config, store, async request => { approvals.push(request); return 'once'; });
  const call = (id: string, name: string, args: unknown, signal = new AbortController().signal) => tools.execute({ id, name, arguments: JSON.stringify(args) }, signal);
  return { root, cwd, home, config, store, tools, approvals, call, cleanup: async () => { try { await store.close(); } finally { await rm(root, { recursive: true, force: true }); } } };
}

export function fakeChild(pid = 4242): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: null, stderr: null });
  return child;
}

export function outputChild(pid = 4242) {
  const child = fakeChild(pid), stdout = new EventEmitter(), stderr = new EventEmitter();
  Object.assign(child, { stdout, stderr });
  return { child, stdout, stderr };
}

export const identityToken = (date: Date) => {
  if (!posix) return date.toISOString();
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${weekdays[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')} ${date.getUTCFullYear()}`;
};

export async function pollFor(condition: () => boolean | Promise<boolean>, timeoutMs = 1000, intervalMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return Boolean(await condition());
}
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 1000, intervalMs = 5) {
  if (!await pollFor(condition, timeoutMs, intervalMs)) throw new Error(`condition not met within ${timeoutMs}ms`);
}
