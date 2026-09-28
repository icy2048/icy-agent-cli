import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { SessionStore } from '../sessions/store.js';
import type { ProcessRecord } from '../core/types.js';
export type { ProcessRecord } from '../core/types.js';
import { redact } from '../core/text.js';
import { BASH_UNAVAILABLE, killBashTree, resolveBashShell, spawnBash, type BashOptions } from './bash.js';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_WAIT = 10_000;

type ProcessChange = (record: ProcessRecord) => void | Promise<void>;
interface ActiveProcess {
  record: ProcessRecord;
  child: ChildProcess;
  log: string;
  reason?: 'killed' | 'timeout' | 'output_limit' | 'spawn_error';
  killTimer?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
  settled: boolean;
  logWrites: Promise<void>;
}
interface Waiter { resolve: (record: ProcessRecord) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void }
export interface ProcessManagerOptions extends BashOptions {
  onChange?: ProcessChange;
}

const clone = (record: ProcessRecord): ProcessRecord => structuredClone(record);
const terminal = (status: ProcessRecord['status']) => status !== 'running';

/** Session-owned detached process state and its bounded, redacted output logs. */
export class ProcessManager {
  private readonly secrets: string[];
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly shellPath?: string;
  private readonly spawnProcess: typeof spawn;
  private readonly processKill?: BashOptions['kill'];
  private onChange?: ProcessChange;
  private active = new Map<string, ActiveProcess>();
  private waiters = new Map<string, Waiter[]>();
  private saveQueue = Promise.resolve();

  constructor(private readonly store: SessionStore, secretsOrOptions: string[] | ProcessManagerOptions = [], suppliedOptions: ProcessManagerOptions = {}) {
    const secrets = Array.isArray(secretsOrOptions) ? secretsOrOptions : [];
    const options = Array.isArray(secretsOrOptions) ? suppliedOptions : secretsOrOptions;
    this.secrets = secrets;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.shellPath = options.shellPath;
    this.spawnProcess = options.spawn ?? spawn;
    this.processKill = options.kill;
    this.onChange = options.onChange;
  }

  setOnChange(onChange?: ProcessChange) { this.onChange = onChange; }
  private records() { return this.store.data.processes; }
  private find(id: string) { return this.records().find(record => record.id === id); }
  private logPath(id: string) { return `${this.store.dir}/processes/${id}.log`; }
  private async persist(record: ProcessRecord, notify = true, eventRecord = clone(record)) {
    this.saveQueue = this.saveQueue.then(() => this.store.save());
    await this.saveQueue;
    if (notify) {
      try { await this.onChange?.(eventRecord); } catch { /* status persistence must not lose the process result */ }
    }
  }
  private enqueueLog(active: ActiveProcess, value: string) {
    const output = Buffer.from(redact(value, this.secrets));
    const available = Math.max(0, OUTPUT_LIMIT - active.record.bytes);
    const written = output.subarray(0, available);
    active.record.bytes += written.length;
    if (written.length) active.logWrites = active.logWrites.then(() => appendFile(active.log, written));
    if (output.length > available) {
      active.record.truncated = true;
      this.terminate(active, 'output_limit', false);
    }
  }
  private terminate(active: ActiveProcess, reason: ActiveProcess['reason'], propagate: boolean, detail: string = reason ?? '') {
    if (active.settled || active.reason) return;
    active.reason = reason;
    active.record.reason = detail;
    if (active.child.pid) {
      try { killBashTree(active.child.pid, this.platform, this.spawnProcess, this.processKill, reason === 'timeout' || reason === 'output_limit' ? 'SIGTERM' : 'SIGTERM'); }
      catch (error) { if (propagate) throw error; }
      if (!active.settled) active.killTimer = setTimeout(() => {
        if (!active.settled && active.child.pid) {
          try { killBashTree(active.child.pid, this.platform, this.spawnProcess, this.processKill, 'SIGKILL'); }
          catch { /* the child may have exited between escalation attempts */ }
        }
      }, 300);
    }
  }
  private async finish(active: ActiveProcess, code: number | null, signal?: NodeJS.Signals, error?: string) {
    if (active.settled) return;
    active.settled = true;
    if (active.timeout) clearTimeout(active.timeout);
    if (active.killTimer) clearTimeout(active.killTimer);
    await active.logWrites.catch(() => {});
    const record = active.record;
    const reason = active.reason;
    record.status = reason === 'killed' ? 'killed' : reason === 'timeout' ? 'timeout' : reason === 'output_limit' ? 'output_limit' : reason === 'spawn_error' ? 'spawn_error' : 'exited';
    record.endedAt = new Date().toISOString();
    record.exitCode = code;
    if (signal) record.signal = signal;
    record.pidAlive = false;
    if (error) record.reason = error;
    this.active.delete(record.id);
    await this.persist(record);
    this.resolveWaiters(record.id, record);
  }

  async start(input: { toolCallId: string; command: string; cwd: string; timeoutMs: number }, _signal?: AbortSignal): Promise<ProcessRecord> {
    const record: ProcessRecord = {
      id: randomUUID(), toolCallId: input.toolCallId, command: input.command, cwd: input.cwd,
      startedAt: new Date().toISOString(), timeoutMs: input.timeoutMs, status: 'running', bytes: 0,
    };
    const log = this.logPath(record.id);
    await mkdir(`${this.store.dir}/processes`, { recursive: true, mode: 0o700 });
    await writeFile(log, '', { flag: 'wx', mode: 0o600 });
    this.records().push(record);
    let child: ChildProcess;
    try {
      const shell = this.shellPath ?? resolveBashShell(this.platform, this.env);
      if (this.platform === 'win32' && !shell) throw new Error(BASH_UNAVAILABLE);
      child = spawnBash(input.command, input.cwd, this.platform, this.env, shell, this.spawnProcess)!;
    } catch (error) {
      record.status = 'spawn_error'; record.endedAt = new Date().toISOString(); record.exitCode = null;
      record.reason = error instanceof Error ? error.message : String(error); record.pidAlive = false;
      await this.persist(record);
      return record;
    }
    const active: ActiveProcess = { record, child, log, settled: false, logWrites: Promise.resolve() };
    this.active.set(record.id, active);
    if (child.pid !== undefined) record.pid = child.pid;
    record.pidAlive = Boolean(child.pid);
    const collect = (source: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      const value = `${source === 'stderr' ? '[stderr] ' : ''}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk}`;
      this.enqueueLog(active, value);
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    let failed: Promise<void> | undefined;
    child.once('error', error => {
      if (!active.reason) active.reason = 'spawn_error';
      failed = this.finish(active, null, undefined, error.message);
      void failed.catch(() => {});
    });
    child.once('close', (code, signal) => { void this.finish(active, code, signal ?? undefined).catch(() => {}); });
    active.timeout = setTimeout(() => this.terminate(active, 'timeout', false), input.timeoutMs);
    if (!child.pid) {
      await new Promise<void>(resolve => child.once('close', () => resolve()));
      await failed;
      return record;
    }
    await this.persist(record, true, clone(record));
    return record;
  }

  private resolveWaiters(id: string, record: ProcessRecord) {
    const waiters = this.waiters.get(id);
    if (!waiters) return;
    this.waiters.delete(id);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer); if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve(clone(record));
    }
  }
  async status(id: string, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<ProcessRecord> {
    const record = this.find(id);
    if (!record) throw new Error('process_not_found');
    if (terminal(record.status)) return clone(record);
    const waitMs = Math.max(0, Math.min(options.waitMs ?? 0, MAX_WAIT));
    if (!waitMs) return clone(record);
    if (options.signal?.aborted) return clone(record);
    return new Promise(resolve => {
      const waiter: Waiter = { resolve, timer: setTimeout(() => {
        this.removeWaiter(id, waiter); resolve(clone(record));
      }, waitMs), signal: options.signal };
      if (options.signal) {
        waiter.abort = () => { this.removeWaiter(id, waiter); resolve(clone(record)); };
        options.signal.addEventListener('abort', waiter.abort, { once: true });
      }
      const list = this.waiters.get(id) ?? []; list.push(waiter); this.waiters.set(id, list);
    });
  }
  private removeWaiter(id: string, waiter: Waiter) {
    const list = this.waiters.get(id); if (!list) return;
    const remaining = list.filter(item => item !== waiter);
    if (remaining.length) this.waiters.set(id, remaining); else this.waiters.delete(id);
    clearTimeout(waiter.timer); if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
  }

  async readOutput(id: string, offset: number | null = null, limit: number | null = null) {
    if (!this.find(id)) throw new Error('process_not_found');
    const chars = Array.from(await readFile(this.logPath(id), 'utf8'));
    const start = (offset ?? 1) - 1, size = Math.min(limit ?? 6000, 6000);
    if (start < 0 || start > chars.length) throw new Error('offset_out_of_range');
    const end = Math.min(chars.length, start + size);
    return { text: chars.slice(start, end).join(''), end, total: chars.length, truncated: end < chars.length };
  }

  private async matching(record: ProcessRecord): Promise<boolean> {
    if (!record.pid || record.pid < 1) return false;
    try {
      if (this.platform === 'win32') {
        const result = await execFileAsync('tasklist', ['/FI', `PID eq ${record.pid}`], { windowsHide: true });
        return new RegExp(`\\b${record.pid}\\b`).test(result.stdout);
      }
      const result = await execFileAsync('ps', ['-o', 'command=', '-p', String(record.pid)]);
      return result.stdout.includes(record.command);
    } catch { return false; }
  }
  async recover(): Promise<number> {
    const changed: ProcessRecord[] = [];
    for (const record of this.records()) if (record.status === 'running') {
      record.status = 'unknown'; delete record.endedAt; record.reason = 'icy_restarted'; record.pidAlive = await this.matching(record); changed.push(clone(record));
    }
    if (changed.length) {
      this.saveQueue = this.saveQueue.then(() => this.store.save()); await this.saveQueue;
      for (const record of changed) {
        try { await this.onChange?.(record); } catch { /* recovery remains durable even if an observer is unavailable */ }
      }
    }
    return changed.length;
  }

  async kill(id: string, reason: 'user_kill' | 'model_kill' | 'session_closed'): Promise<ProcessRecord> {
    const record = this.find(id);
    if (!record) throw new Error('process_not_found');
    if (record.status === 'running') {
      const active = this.active.get(id);
      if (!active) throw new Error('process_not_found');
      if (active.child.exitCode !== null || active.child.signalCode !== null) {
        await this.finish(active, active.child.exitCode, active.child.signalCode ?? undefined);
        return clone(record);
      }
      this.terminate(active, 'killed', true, reason);
      return this.status(id, { waitMs: MAX_WAIT });
    }
    if (record.status !== 'unknown') return clone(record);
    if (!record.pidAlive || !(await this.matching(record))) {
      record.pidAlive = false; await this.persist(record); return clone(record);
    }
    if (!record.pid) return clone(record);
    killBashTree(record.pid, this.platform, this.spawnProcess, this.processKill, 'SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 300));
    try { killBashTree(record.pid!, this.platform, this.spawnProcess, this.processKill, 'SIGKILL'); } catch { /* already gone */ }
    record.status = 'killed'; record.endedAt = new Date().toISOString(); record.reason = reason; record.pidAlive = false; record.exitCode = null;
    await this.persist(record); this.resolveWaiters(id, record); return clone(record);
  }
  async closeAll(reason: 'session_closed' | 'user_kill' | 'model_kill' = 'session_closed') {
    const ids = this.records().filter(record => record.status === 'running').map(record => record.id);
    const failures: unknown[] = []; let terminated = 0;
    for (const id of ids) {
      try { const record = await this.kill(id, reason); if (record.status === 'killed') terminated++; }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
    return terminated;
  }
}

export { OUTPUT_LIMIT as DETACHED_OUTPUT_LIMIT };
