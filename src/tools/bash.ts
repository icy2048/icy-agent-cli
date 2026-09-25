import { spawn } from 'node:child_process';
import { clean } from '../core/text.js';
import type { ToolResult } from '../core/types.js';

export function runBash(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
  signal.throwIfAborted();
  const started = Date.now();
  return new Promise(resolve => {
    let output = '', bytes = 0, reason = '', settled = false;
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (sig: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, sig); } catch { /* already exited */ } } };
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
