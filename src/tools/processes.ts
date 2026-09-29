import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { SessionStore } from '../sessions/store.js';
import type { ProcessRecord } from '../core/types.js';
export type { ProcessRecord } from '../core/types.js';
import { redact } from '../core/text.js';
import { BASH_UNAVAILABLE, killBashTree, resolveBashShell, spawnBash, type BashOptions } from './bash.js';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_WAIT = 10_000;
const KILL_CONFIRM_WAIT = 2_000;

type ProcessChange = (record: ProcessRecord) => void | Promise<void>;
type IdentityCapture = (pid: number) => string | undefined | Promise<string | undefined>;
type LivenessCheck = (pid: number) => boolean | Promise<boolean>;
interface ActiveProcess {
  record: ProcessRecord;
  child: ChildProcess;
  log: string;
  reason?: 'killed' | 'timeout' | 'output_limit' | 'spawn_error';
  killTimer?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
  settled: boolean;
  terminating?: boolean;
  logWrites: Promise<void>;
  outputDone: Promise<void>;
  resolveOutputDone: () => void;
  drained: Promise<void>;
  resolveDrained: () => void;
  escalation?: Promise<void>;
  resolveEscalation?: () => void;
  rejectEscalation?: (error: unknown) => void;
}
interface Waiter { resolve: (record: ProcessRecord) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort?: () => void }
export interface ProcessManagerOptions extends BashOptions {
  onChange?: ProcessChange;
  outputLimit?: number;
  captureIdentity?: IdentityCapture;
  identityCapture?: IdentityCapture;
  identity?: IdentityCapture;
  isAlive?: LivenessCheck;
  isPidAlive?: LivenessCheck;
  liveness?: LivenessCheck;
  processAlive?: LivenessCheck;
  processAppendFile?: (path: string, data: Uint8Array) => Promise<void>;
}

const clone = (record: ProcessRecord): ProcessRecord => structuredClone(record);
const terminal = (status: ProcessRecord['status']) => status !== 'running';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const isGone = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ESRCH';

/** Session-owned detached process state and its bounded, redacted output logs. */
export class ProcessManager {
  private readonly secrets: string[];
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly shellPath?: string;
  private readonly spawnProcess: typeof spawn;
  private readonly processKill?: BashOptions['kill'];
  private readonly captureIdentityOption?: IdentityCapture;
  private readonly livenessCheck?: LivenessCheck;
  private readonly processAppendFile: NonNullable<ProcessManagerOptions['processAppendFile']>;
  private readonly outputLimit: number;
  private onChange?: ProcessChange;
  private active = new Map<string, ActiveProcess>();
  private waiters = new Map<string, Waiter[]>();
  private watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private watchdogRetries = new Map<string, number>();
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
    this.captureIdentityOption = options.captureIdentity ?? options.identityCapture ?? options.identity;
    this.livenessCheck = options.isAlive ?? options.isPidAlive ?? options.liveness ?? options.processAlive;
    this.processAppendFile = options.processAppendFile ?? appendFile;
    this.outputLimit = options.outputLimit ?? OUTPUT_LIMIT;
    this.onChange = options.onChange;
  }

  setOnChange(onChange?: ProcessChange) { this.onChange = onChange; }
  private records() { return this.store.data.processes; }
  private find(id: string) { return this.records().find(record => record.id === id); }
  private logPath(id: string) { return `${this.store.dir}/processes/${id}.log`; }
  private queueSave() {
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.store.save());
    return this.saveQueue;
  }
  private async persist(_record: ProcessRecord, notify = true, eventRecord = clone(_record)) {
    await this.queueSave();
    if (notify) {
      try { await this.onChange?.(eventRecord); } catch { /* status persistence must not lose the process result */ }
    }
  }
  private async persistWithFailure(record: ProcessRecord, notify = true) {
    try { await this.persist(record, notify); }
    catch (error) {
      await this.reportPersistFailure(record, error);
      throw error;
    }
  }
  private async reportPersistFailure(record: ProcessRecord, error: unknown) {
    record.reason = `persist_failed:${errorMessage(error)}`;
    try { await this.onChange?.(clone(record)); } catch { /* the in-memory terminal result remains available */ }
  }
  private enqueueLog(active: ActiveProcess, value: string) {
    if (active.settled) return;
    const output = Buffer.from(redact(value, this.secrets));
    const available = Math.max(0, this.outputLimit - active.record.bytes);
    const written = output.subarray(0, available);
    active.record.bytes += written.length;
    if (written.length) active.logWrites = active.logWrites.catch(() => {}).then(() => this.processAppendFile(active.log, written));
    if (output.length > available) {
      active.record.truncated = true;
      void this.terminate(active, 'output_limit', false).catch(() => {});
    }
  }
  private async terminate(active: ActiveProcess, reason: ActiveProcess['reason'], propagate: boolean, detail: string = reason ?? '') {
    if (active.settled) return;
    if (active.terminating || active.reason) {
      if (active.escalation) await active.escalation;
      return;
    }
    active.terminating = true;
    // Reserve the terminal reason before asynchronous signal delivery so a
    // very fast child cannot turn an output/timeout event into plain exit.
    active.reason = reason;
    active.record.reason = detail;
    let softError: unknown;
    try { await killBashTree(active.child.pid!, this.platform, this.spawnProcess, this.processKill, 'SIGTERM'); }
    catch (error) {
      softError = error;
      // A failed graceful Windows taskkill is not a protocol failure: the
      // forced tree kill below is still required.
      active.record.reason = errorMessage(error);
    }
    active.terminating = false;
    if (active.settled) return;
    let resolveEscalation!: () => void;
    let rejectEscalation!: (error: unknown) => void;
    active.escalation = new Promise<void>((resolve, reject) => { resolveEscalation = resolve; rejectEscalation = reject; });
    active.resolveEscalation = resolveEscalation;
    active.rejectEscalation = rejectEscalation;
    const timer = active.killTimer = setTimeout(async () => {
      if (active.settled) { resolveEscalation(); return; }
      try {
        const gone = await killBashTree(active.child.pid!, this.platform, this.spawnProcess, this.processKill, 'SIGKILL');
        if (gone && !active.settled) void this.finish(active, null).catch(() => {});
        resolveEscalation();
      } catch (error) {
        if (isGone(error)) resolveEscalation();
        else {
          active.record.reason = errorMessage(error);
          rejectEscalation(error);
        }
      }
    }, 300);
    timer.unref?.();
    if (propagate) await active.escalation;
    else void active.escalation.catch(() => { /* timeout/output cleanup reports the failure on the record */ });
    void softError;
  }
  private async finish(active: ActiveProcess, code: number | null, signal?: NodeJS.Signals, error?: string) {
    if (active.settled) {
      await active.drained;
      return;
    }
    active.settled = true;
    if (active.timeout) clearTimeout(active.timeout);
    if (active.killTimer) clearTimeout(active.killTimer);
    active.resolveEscalation?.();
    const record = active.record;
    const reason = active.reason;
    record.status = reason === 'killed' ? 'killed' : reason === 'timeout' ? 'timeout' : reason === 'output_limit' ? 'output_limit' : reason === 'spawn_error' ? 'spawn_error' : 'exited';
    record.endedAt = new Date().toISOString();
    record.exitCode = code;
    if (signal) record.signal = signal;
    record.pidAlive = false;
    if (error) record.reason = error;
    // A reader must never wait for a failed snapshot write. The terminal state
    // is visible in memory before the snapshot is awaited; keep the active
    // entry until the accepted output has drained so readers can await it.
    try {
      await active.outputDone;
      let stableWrites = 0;
      while (stableWrites < 2) {
        const writes = active.logWrites;
        await writes.catch(() => {});
        await new Promise<void>(resolve => setImmediate(resolve));
        if (writes === active.logWrites) stableWrites++;
        else stableWrites = 0;
      }
    } finally {
      active.resolveDrained();
      this.active.delete(record.id);
    }
    this.resolveWaiters(record.id, record);
    try { await this.persist(record); }
    catch (persistError) {
      await this.reportPersistFailure(record, persistError);
      throw persistError;
    }
  }

  private async captureIdentity(pid: number): Promise<string | undefined> {
    const capture = this.captureIdentityOption
      ? Promise.resolve().then(() => this.captureIdentityOption!(pid))
      : this.platform === 'win32'
        ? execFileAsync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CreationDate`], { windowsHide: true, timeout: 3_000 }).then(result => result.stdout)
        : execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 3_000 }).then(result => result.stdout);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([capture, new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), 3_000);
      })]);
      return typeof value === 'string' ? value.trim() || undefined : undefined;
    } catch { return undefined; }
    finally { if (timer) clearTimeout(timer); }
  }
  private async identityMatch(record: ProcessRecord): Promise<'match' | 'mismatch' | 'unavailable'> {
    if (!record.pid || record.pid < 1 || record.identity === undefined) return 'unavailable';
    const identity = await this.captureIdentity(record.pid);
    if (!identity) return 'unavailable';
    return identity === record.identity ? 'match' : 'mismatch';
  }
  private async matching(record: ProcessRecord): Promise<boolean> {
    return (await this.identityMatch(record)) === 'match';
  }
  private async pidAlive(pid: number): Promise<boolean> {
    if (this.livenessCheck) {
      try { return await this.livenessCheck(pid); } catch { return false; }
    }
    if (this.platform === 'win32') {
      try {
        const result = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`], { windowsHide: true, timeout: 3_000 });
        return new RegExp(`\\b${pid}\\b`).test(String(result.stdout));
      } catch { return false; }
    }
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  private async inspect(record: ProcessRecord) {
    if (!record.pid || record.pid < 1) return { alive: false, identity: 'unavailable' as const };
    const alive = await this.pidAlive(record.pid);
    return { alive, identity: alive ? await this.identityMatch(record) : 'unavailable' as const };
  }
  private clearWatchdog(id: string) {
    const timer = this.watchdogs.get(id);
    if (timer) clearTimeout(timer);
    this.watchdogs.delete(id);
  }
  private armWatchdog(record: ProcessRecord, retryDelay?: number) {
    this.clearWatchdog(record.id);
    const due = Date.parse(record.startedAt) + record.timeoutMs;
    const delay = retryDelay ?? Math.max(0, due - Date.now());
    const timer = setTimeout(() => {
      this.watchdogs.delete(record.id);
      void this.handleWatchdog(record).catch(() => {});
    }, delay);
    timer.unref?.();
    this.watchdogs.set(record.id, timer);
  }
  private async handleWatchdog(record: ProcessRecord) {
    if (record.status !== 'unknown' || !record.pid) return;
    const state = await this.inspect(record);
    if (!state.alive) {
      record.pidAlive = false;
      await this.persist(record);
      return;
    }
    record.pidAlive = true;
    if (state.identity === 'match') {
      this.watchdogRetries.delete(record.id);
      try { await this.confirmRecoveredKill(record, 'timeout', true); } catch (error) {
        record.reason = errorMessage(error);
        await this.persist(record).catch(() => {});
      }
      return;
    }
    record.reason = 'identity_unconfirmed';
    const retries = (this.watchdogRetries.get(record.id) ?? 0) + 1;
    if (retries <= 3) {
      this.watchdogRetries.set(record.id, retries);
      this.armWatchdog(record, 5_000);
    } else {
      this.watchdogRetries.delete(record.id);
      await this.persist(record);
    }
  }

  async start(input: { toolCallId: string; command: string; cwd: string; timeoutMs: number }, signal?: AbortSignal): Promise<ProcessRecord> {
    signal?.throwIfAborted();
    const record: ProcessRecord = {
      id: randomUUID(), toolCallId: input.toolCallId, command: input.command, cwd: input.cwd,
      startedAt: new Date().toISOString(), timeoutMs: input.timeoutMs, status: 'running', bytes: 0,
    };
    const log = this.logPath(record.id);
    await mkdir(`${this.store.dir}/processes`, { recursive: true, mode: 0o700 });
    await writeFile(log, '', { flag: 'wx', mode: 0o600 });
    // This check is deliberately immediately before spawn. Once a child is
    // created, cancellation does not undo the detached process contract.
    signal?.throwIfAborted();
    this.records().push(record);
    let child: ChildProcess;
    try {
      signal?.throwIfAborted();
      const shell = this.shellPath ?? resolveBashShell(this.platform, this.env);
      if (this.platform === 'win32' && !shell) throw new Error(BASH_UNAVAILABLE);
      child = spawnBash(input.command, input.cwd, this.platform, this.env, shell, this.spawnProcess, true)!;
    } catch (error) {
      if (signal?.aborted) {
        this.records().splice(this.records().indexOf(record), 1);
        await unlink(log).catch(() => {});
        throw error;
      }
      record.status = 'spawn_error'; record.endedAt = new Date().toISOString(); record.exitCode = null;
      record.reason = errorMessage(error); record.pidAlive = false;
      await this.persistWithFailure(record);
      return record;
    }
    let resolveOutputDone!: () => void;
    const outputDone = new Promise<void>(resolve => { resolveOutputDone = resolve; });
    let resolveDrained!: () => void;
    const drained = new Promise<void>(resolve => { resolveDrained = resolve; });
    const active: ActiveProcess = { record, child, log, settled: false, logWrites: Promise.resolve(), outputDone, resolveOutputDone, drained, resolveDrained };
    this.active.set(record.id, active);
    const outputStreams = [child.stdout, child.stderr].filter((stream): stream is NonNullable<ChildProcess['stdout']> => stream !== null);
    let outputRemaining = outputStreams.length;
    const endedStreams = new Set<NonNullable<ChildProcess['stdout']>>();
    const markOutputDone = (stream: NonNullable<ChildProcess['stdout']>) => {
      if (endedStreams.has(stream)) return;
      endedStreams.add(stream);
      if (--outputRemaining === 0) active.resolveOutputDone();
    };
    for (const stream of outputStreams) { stream.once('end', () => markOutputDone(stream)); stream.once('close', () => markOutputDone(stream)); }
    if (!outputRemaining) active.resolveOutputDone();
    if (child.pid !== undefined) record.pid = child.pid;
    record.pidAlive = Boolean(child.pid);
    let firstOutputResolve!: () => void;
    const firstOutput = new Promise<void>(resolve => { firstOutputResolve = resolve; });
    const collect = (source: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      firstOutputResolve();
      const value = `${source === 'stderr' ? '[stderr] ' : ''}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk}`;
      this.enqueueLog(active, value);
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    let failed: Promise<void> | undefined;
    child.once('error', error => {
      if (!active.reason) active.reason = 'spawn_error';
      active.resolveOutputDone();
      failed = this.finish(active, null, undefined, error.message);
      void failed.catch(() => {});
    });
    child.once('close', (code, signalCode) => {
      // Give stdout/stderr data events queued with the close notification a
      // chance to enqueue their final log writes before finish persists.
      setImmediate(() => {
        if (outputStreams.every(stream => stream.readable === undefined)) active.resolveOutputDone();
      });
      firstOutputResolve();
      void this.finish(active, code, signalCode ?? undefined).catch(() => {});
    });
    if (child.pid === undefined) {
      await new Promise<void>(resolve => child.once('close', () => resolve()));
      await failed;
      return record;
    }
    // Arm the timeout before identity capture: ps/powershell is a best-effort
    // safety check and must never postpone the detached process deadline.
    const remaining = Math.max(0, input.timeoutMs - (Date.now() - Date.parse(record.startedAt)));
    active.timeout = setTimeout(() => { void this.terminate(active, 'timeout', false).catch(() => {}); }, remaining);
    // Identity is needed only after a restart; an in-session ChildProcess is
    // always signalled through its live handle/pgid.
    record.identity = await this.captureIdentity(child.pid);
    if (active.settled) return record;
    await this.persist(record, true, clone(record));
    await Promise.race([firstOutput, new Promise<void>(resolve => setTimeout(resolve, 200))]);
    return record;
  }

  private async waitForDrain(id: string) {
    const active = this.active.get(id);
    if (active && terminal(active.record.status)) await active.drained;
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
    if (terminal(record.status)) {
      await this.waitForDrain(id);
      return clone(record);
    }
    const waitMs = Math.max(0, Math.min(options.waitMs ?? 0, MAX_WAIT));
    if (!waitMs) return clone(record);
    if (options.signal?.aborted) return clone(record);
    return new Promise(resolve => {
      const waiter: Waiter = { resolve, timer: setTimeout(() => {
        this.removeWaiter(id, waiter);
        void this.waitForDrain(id).then(() => resolve(clone(record)));
      }, waitMs), signal: options.signal };
      if (options.signal) {
        waiter.abort = () => {
          this.removeWaiter(id, waiter);
          void this.waitForDrain(id).then(() => resolve(clone(record)));
        };
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
    const record = this.find(id);
    if (!record) throw new Error('process_not_found');
    await this.waitForDrain(id);
    const chars = Array.from(await readFile(this.logPath(id), 'utf8'));
    const start = (offset ?? 1) - 1, size = Math.min(limit ?? 6000, 6000);
    if (start < 0 || start > chars.length) throw new Error('offset_out_of_range');
    const end = Math.min(chars.length, start + size);
    return { text: chars.slice(start, end).join(''), end, total: chars.length, truncated: end < chars.length };
  }

  async recover(): Promise<number> {
    const changed: ProcessRecord[] = [];
    let recovered = 0;
    for (const record of this.records()) {
      if (record.status === 'running') {
        record.status = 'unknown'; delete record.endedAt; record.reason = 'icy_restarted'; recovered++;
        const state = await this.inspect(record);
        record.pidAlive = state.alive;
        if (state.alive && state.identity !== 'match') record.reason = 'identity_unconfirmed';
        changed.push(clone(record));
      } else if (record.status === 'unknown' && record.pid) {
        // Re-probe every unknown PID, including records previously marked
        // unconfirmed. A failed identity capture must not become permanent.
        const state = await this.inspect(record);
        const wasAlive = record.pidAlive;
        record.pidAlive = state.alive;
        if (state.alive && state.identity !== 'match') record.reason = 'identity_unconfirmed';
        else if (state.alive && record.reason === 'identity_unconfirmed') record.reason = 'icy_restarted';
        if (wasAlive !== record.pidAlive || state.alive && state.identity === 'match' && record.reason === 'icy_restarted') changed.push(clone(record));
      }
    }
    if (changed.length) {
      await this.queueSave();
      for (const record of changed) {
        try { await this.onChange?.(record); } catch { /* recovery remains durable even if an observer is unavailable */ }
      }
    }
    for (const record of this.records()) if (record.status === 'unknown' && record.pidAlive === true) {
      const due = Date.parse(record.startedAt) + record.timeoutMs;
      if (due <= Date.now()) await this.handleWatchdog(record);
      else this.armWatchdog(record);
    }
    return recovered;
  }

  private resolveKillReference(reference: string) {
    const id = reference.startsWith('icy-process:') ? reference.slice('icy-process:'.length) : reference;
    if (!id || (id.length < 8 && !this.find(id))) throw new Error('process_not_found');
    const matches = this.records().filter(record => record.id === id || record.id.startsWith(id));
    if (!matches.length) throw new Error('process_not_found');
    if (matches.length > 1) throw new Error('process_ambiguous');
    return matches[0];
  }
  private async confirmRecoveredKill(record: ProcessRecord, reason: 'user_kill' | 'model_kill' | 'session_closed' | 'timeout', identityVerified = false) {
    this.clearWatchdog(record.id);
    this.watchdogRetries.delete(record.id);
    if (!record.pid) {
      record.pidAlive = false;
      record.reason = 'identity_unconfirmed';
      await this.persistWithFailure(record); return clone(record);
    }
    const initial = identityVerified
      ? { alive: await this.pidAlive(record.pid), identity: 'match' as const }
      : await this.inspect(record);
    record.pidAlive = initial.alive;
    if (!initial.alive || initial.identity !== 'match') {
      // Identity mismatch/capture failure is not proof that the PID is dead.
      // Keep the liveness result visible and fail closed without signalling.
      record.reason = 'identity_unconfirmed';
      await this.persistWithFailure(record); return clone(record);
    }
    const pid = record.pid;
    let softError: unknown;
    try { await killBashTree(pid, this.platform, this.spawnProcess, this.processKill, 'SIGTERM'); }
    catch (error) {
      softError = error;
      record.reason = errorMessage(error);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    let forcedGone = false;
    try { forcedGone = await killBashTree(pid, this.platform, this.spawnProcess, this.processKill, 'SIGKILL'); }
    catch (error) {
      if (!isGone(error)) {
        record.reason = errorMessage(error);
        try { await this.persist(record); } catch { /* the original termination error is the useful failure */ }
        throw error;
      }
      forcedGone = true;
    }
    // Even a taskkill "not found" result is followed by the normal liveness
    // probe; pidAlive is never cleared from an identity result alone.
    const deadline = Date.now() + (forcedGone ? 0 : KILL_CONFIRM_WAIT);
    let alive = await this.pidAlive(pid);
    while (alive && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      alive = await this.pidAlive(pid);
    }
    if (alive) {
      record.status = 'unknown'; record.pidAlive = true; record.reason = 'kill_unconfirmed';
      await this.persistWithFailure(record); return clone(record);
    }
    record.status = 'timeout' === reason ? 'timeout' : 'killed'; record.endedAt = new Date().toISOString();
    record.reason = softError ? errorMessage(softError) : reason;
    record.pidAlive = false; record.exitCode = null;
    await this.persistWithFailure(record); this.resolveWaiters(record.id, record); return clone(record);
  }

  async kill(reference: string, reason: 'user_kill' | 'model_kill' | 'session_closed' | 'timeout'): Promise<ProcessRecord> {
    const record = this.resolveKillReference(reference);
    if (record.status === 'running') {
      const active = this.active.get(record.id);
      if (!active) throw new Error('process_not_found');
      if (active.settled) return this.status(record.id, { waitMs: MAX_WAIT });
      if (active.child.exitCode !== null || active.child.signalCode !== null) {
        await this.finish(active, active.child.exitCode, active.child.signalCode ?? undefined);
        return this.status(record.id, { waitMs: MAX_WAIT });
      }
      await this.terminate(active, 'timeout' === reason ? 'timeout' : 'killed', true, reason);
      return this.status(record.id, { waitMs: MAX_WAIT });
    }
    if (record.status !== 'unknown') return clone(record);
    return this.confirmRecoveredKill(record, reason);
  }
  async closeAll(reason: 'session_closed' | 'user_kill' | 'model_kill' = 'session_closed') {
    for (const id of this.watchdogs.keys()) this.clearWatchdog(id);
    this.watchdogRetries.clear();
    const ids = this.records().filter(record => record.status === 'running' || record.status === 'unknown' && record.pidAlive === true).map(record => record.id);
    const results = await Promise.allSettled(ids.map(id => this.kill(id, reason)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw failures[0].reason;
    return results.filter(result => result.status === 'fulfilled' && result.value.status === 'killed').length;
  }
}

export { OUTPUT_LIMIT as DETACHED_OUTPUT_LIMIT };
