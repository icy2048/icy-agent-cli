import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { clean } from '../core/text.js';
import { utf8PrefixLength } from './output.js';
import type { ToolResult } from '../core/types.js';

export interface BashOptions {
  platform?: NodeJS.Platform;
  shellPath?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  kill?: (pid: number, tree: boolean, signal?: NodeJS.Signals) => void | Promise<void>;
}

const isSystem32Bash = (candidate: string) => /(?:^|\\)windows\\system32\\bash\.exe$/i.test(path.win32.normalize(candidate));

export function resolveBashShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = existsSync,
): string | undefined {
  if (platform !== 'win32') return '/bin/bash';

  const configuredShell = env.ICY_BASH;
  if (configuredShell && exists(configuredShell)) return configuredShell;

  for (const directory of (env.PATH ?? '').split(';').filter(Boolean)) {
    const candidate = path.win32.join(directory, 'bash.exe');
    if (!isSystem32Bash(candidate) && exists(candidate)) return candidate;
  }

  const gitLocations = [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LocalAppData && path.win32.join(env.LocalAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const candidate of gitLocations) {
    if (candidate && exists(candidate)) return candidate;
  }
  return undefined;
}

export const BASH_UNAVAILABLE = 'bash 不可用：请安装 Git for Windows，或用 ICY_BASH 指定 bash.exe 路径。';
export const bashArgs = (command: string) => ['--noprofile', '--norc', '-c', command];
const detachedBashCommand = (command: string) => `${command}\n__ICY_EXIT_STATUS=$?\n: \nexit "$__ICY_EXIT_STATUS"`;

/** Spawn and tree-kill details are shared by foreground and detached commands. */
export function spawnBash(
  command: string,
  cwd: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  shellPath: string | undefined,
  spawnProcess: typeof spawn,
  preserveShell = false,
) {
  if (platform === 'win32' && !shellPath) return undefined;
  return spawnProcess(shellPath ?? '/bin/bash', bashArgs(preserveShell ? detachedBashCommand(command) : command), {
    cwd,
    detached: platform !== 'win32',
    ...(platform === 'win32' ? { windowsHide: true } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, TERM: 'dumb', NO_COLOR: '1' },
  });
}

/** The injected kill keeps the legacy two arguments and may accept a signal as the third. */
export async function killBashTree(
  pid: number,
  platform: NodeJS.Platform,
  spawnProcess: typeof spawn,
  kill: BashOptions['kill'] | undefined,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (platform === 'win32') {
    if (kill) { await kill(pid, true, signal); return false; }
    const args = ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
    const taskkill = spawnProcess('taskkill.exe', args, {
      windowsHide: true, detached: false, stdio: 'ignore',
    });
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const done = (error?: Error, gone = false) => { if (settled) return; settled = true; error ? reject(error) : resolve(gone); };
      taskkill.once('error', error => done(error instanceof Error ? error : new Error(String(error))));
      taskkill.once('close', code => {
        // taskkill reports an already-dead process as 128 or 1282. Both are
        // successful outcomes for tree termination.
        if (code === 0) done(undefined, false);
        else if (code === 128 || code === 1282) done(undefined, true);
        else done(new Error(`taskkill_failed:${code ?? 'signal'}`));
      });
    });
  }
  if (kill) { await kill(-pid, false, signal); return false; }
  process.kill(-pid, signal); return false;
}

export function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  options: BashOptions = {},
): Promise<ToolResult> {
  signal.throwIfAborted();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const shellPath = options.shellPath ?? resolveBashShell(platform, env);
  if (platform === 'win32' && !shellPath) {
    return Promise.resolve({ ok: false, error: 'bash_unavailable', content: BASH_UNAVAILABLE });
  }

  const spawnProcess = options.spawn ?? spawn;
  const started = Date.now();
  return new Promise(resolve => {
    let child;
    try { child = spawnBash(command, cwd, platform, env, shellPath, spawnProcess)!; }
    catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error), content: '' }); return;
    }
    let output = '', bytes = 0, reason = '', settled = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const incomplete: Record<'stdout' | 'stderr', Uint8Array> = { stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      void killBashTree(child.pid, platform, spawnProcess, options.kill, sig).catch(() => { /* already exited */ });
    };
    const terminate = (why: string) => {
      if (reason || settled) return;
      reason = why; killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 300);
    };
    const onAbort = () => terminate('cancelled');
    const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const collect = (source: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), before = bytes;
      const prefix = incomplete[source].length ? Buffer.concat([incomplete[source], value]) : value;
      const available = Math.max(0, 256 * 1024 - before);
      bytes += value.length;
      const length = utf8PrefixLength(prefix, incomplete[source].length + available);
      if (bytes <= 256 * 1024) incomplete[source] = prefix.subarray(length);
      else incomplete[source] = Buffer.alloc(0);
      if (available > 0) output += (source === 'stderr' ? '[stderr] ' : '') + decoders[source].write(prefix.subarray(0, length));
      if (bytes > 256 * 1024) terminate('output_limit');
    };
    child.stdout!.on('data', collect('stdout')); child.stderr!.on('data', collect('stderr'));
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      output += decoders.stdout.end() + decoders.stderr.end();
      settled = true; clearTimeout(timeout); signal.removeEventListener('abort', onAbort);
      if (!reason && killTimer) clearTimeout(killTimer);
      resolve({ ok: code === 0 && !reason && !error, content: clean(output) + `\nExit code: ${code ?? 'signal'}`, error: reason || error || (code !== 0 ? 'command_failed' : undefined), truncated: bytes > 256 * 1024, durationMs: Date.now() - started });
    };
    child.once('error', error => finish(null, error.message));
    child.once('close', code => finish(code));
  });
}
