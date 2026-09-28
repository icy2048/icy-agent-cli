import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { clean } from '../core/text.js';
import type { ToolResult } from '../core/types.js';

export interface BashOptions {
  platform?: NodeJS.Platform;
  shellPath?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  kill?: (pid: number, tree: boolean) => void;
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

const BASH_UNAVAILABLE = 'bash 不可用：请安装 Git for Windows，或用 ICY_BASH 指定 bash.exe 路径。';

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
  const args = ['--noprofile', '--norc', '-c', command];
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawnProcess(shellPath!, args, {
      cwd,
      detached: platform !== 'win32',
      ...(platform === 'win32' ? { windowsHide: true } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, TERM: 'dumb', NO_COLOR: '1' },
    });
    let output = '', bytes = 0, reason = '', settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let killSignal: NodeJS.Signals = 'SIGTERM';
    const realKill: NonNullable<BashOptions['kill']> = (pid, tree) => {
      if (platform === 'win32') {
        try {
          const taskkill = spawnProcess('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            detached: false,
            stdio: 'ignore',
          });
          taskkill.once('error', () => {});
        } catch { /* taskkill is best effort */ }
      } else {
        process.kill(tree ? -pid : pid, killSignal);
      }
    };
    const kill = options.kill ?? realKill;
    const killGroup = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      killSignal = sig;
      try {
        // POSIX receives the already-negated process-group ID; Windows receives
        // a positive PID and asks the injected/default implementation for a tree.
        kill(platform === 'win32' ? child.pid : -child.pid, platform === 'win32');
      } catch { /* already exited */ }
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
    const collect = (source: string) => (chunk: Buffer) => {
      const available = Math.max(0, 256 * 1024 - bytes);
      bytes += chunk.length;
      if (available > 0) output += (source === 'stderr' ? '[stderr] ' : '') + chunk.subarray(0, available).toString('utf8');
      if (bytes > 256 * 1024) terminate('output_limit');
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal.removeEventListener('abort', onAbort);
      // Keep the escalation timer when cancellation was requested: descendants may outlive the shell.
      if (!reason && killTimer) clearTimeout(killTimer);
      resolve({ ok: code === 0 && !reason && !error, content: clean(output) + `\nExit code: ${code ?? 'signal'}`, error: reason || error || (code !== 0 ? 'command_failed' : undefined), truncated: bytes > 256 * 1024, durationMs: Date.now() - started });
    };
    child.once('error', error => finish(null, error.message));
    child.once('close', code => finish(code));
  });
}
