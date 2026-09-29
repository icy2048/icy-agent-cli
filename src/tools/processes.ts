import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import type { SessionStore } from '../sessions/store.js';
import type { ProcessRecord } from '../core/types.js';
export type { ProcessRecord } from '../core/types.js';
import { redact } from '../core/text.js';
import { utf8PrefixLength } from './output.js';
import { BASH_UNAVAILABLE, killBashTree, resolveBashShell, spawnBash, type BashOptions } from './bash.js';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_WAIT = 10_000;
const DEFAULT_TIMING = { escalationMs: 300, killConfirmMs: 2_000, identityTimeoutMs: 3_000, watchdogRetryMs: 5_000, firstOutputWaitMs: 200 } as const;
const OUTPUT_LINE_FLUSH = 64 * 1024;
const LOG_INDEX_STRIDE = 65_536;
const MAX_PAGE_BYTES = 1 * 1024 * 1024;

type ProcessChange = (record: ProcessRecord) => void | Promise<void>;
type BeforePersist = (record: ProcessRecord) => void;
type IdentityCapture = (pid: number) => string | undefined | Promise<string | undefined>;
type IdentityExecFile = (file: string, args: string[], options: { timeout?: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv }) => { stdout: string | Buffer } | Promise<{ stdout: string | Buffer }>;
type LivenessCheck = (pid: number) => boolean | Promise<boolean>;
export interface ProcessLogWriter {
  write(data: Uint8Array): Promise<void>;
  end(): Promise<void>;
}
export type ProcessLogWriterFactory = (path: string) => ProcessLogWriter | Promise<ProcessLogWriter>;
export type ProcessLogReader = (path: string, offset: number, length: number) => Promise<Uint8Array>;
interface LogIndexEntry { chars: number; bytes: number }
interface LogIndex { entries: LogIndexEntry[]; total: number; bytes: number; complete: boolean; building?: Promise<void> }
interface OutputState {
  source: 'stdout' | 'stderr';
  decoder: StringDecoder;
  pending: string;
  ended: boolean;
}
interface ActiveProcess {
  record: ProcessRecord;
  child: ChildProcess;
  log: string;
  writer: ProcessLogWriter;
  index: LogIndex;
  outputStates: OutputState[];
  outputRemaining: number;
  reason?: 'killed' | 'timeout' | 'output_limit' | 'spawn_error';
  killTimer?: ReturnType<typeof setTimeout>;
  timeout?: ReturnType<typeof setTimeout>;
  settled: boolean;
  closed: boolean;
  terminating?: boolean;
  pendingLog: Buffer;
  pendingLogBytes: number;
  logWriteInFlight: boolean;
  logDrain: Promise<void>;
  resolveLogDrain: () => void;
  outputsFinished: boolean;
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
  beforePersist?: BeforePersist;
  outputLimit?: number;
  captureIdentity?: IdentityCapture;
  execFile?: IdentityExecFile;
  isAlive?: LivenessCheck;
  logWriterFactory?: ProcessLogWriterFactory;
  logReader?: ProcessLogReader;
  timing?: Partial<{ escalationMs: number; killConfirmMs: number; identityTimeoutMs: number; watchdogRetryMs: number; firstOutputWaitMs: number }>;
}

const clone = (record: ProcessRecord): ProcessRecord => structuredClone(record);
const terminal = (status: ProcessRecord['status']) => status !== 'running';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const isGone = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ESRCH';
const defaultLogWriter: ProcessLogWriterFactory = file => {
  const stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
  let streamError: unknown;
  stream.on('error', error => { streamError ??= error; });
  return {
    write(data: Uint8Array) {
      return new Promise<void>((resolve, reject) => {
        if (streamError) { reject(streamError); return; }
        stream.write(data, (error?: Error | null) => error ? reject(error) : resolve());
      });
    },
    end() {
      return new Promise<void>((resolve, reject) => {
        if (streamError) { reject(streamError); return; }
        stream.end((error?: Error | null) => error ? reject(error) : resolve());
      });
    },
  };
};
const defaultLogReader: ProcessLogReader = async (file, offset, length) => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length), result = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, result.bytesRead);
  } finally { await handle.close(); }
};

/** Session-owned detached process state and its bounded, redacted output logs. */
export class ProcessManager {
  private readonly secrets: string[];
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly shellPath?: string;
  private readonly spawnProcess: typeof spawn;
  private readonly processKill?: BashOptions['kill'];
  private readonly captureIdentityOption?: IdentityCapture;
  private readonly identityExecFile: IdentityExecFile;
  private readonly livenessCheck?: LivenessCheck;
  private readonly logWriterFactory: ProcessLogWriterFactory;
  private readonly logReader: ProcessLogReader;
  private readonly outputLimit: number;
  private readonly timing: { escalationMs: number; killConfirmMs: number; identityTimeoutMs: number; watchdogRetryMs: number; firstOutputWaitMs: number };
  private onChange?: ProcessChange;
  private beforePersist?: BeforePersist;
  private active = new Map<string, ActiveProcess>();
  private waiters = new Map<string, Waiter[]>();
  private watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private watchdogRetries = new Map<string, number>();
  private logIndexes = new Map<string, LogIndex>();

  constructor(private readonly store: SessionStore, secretsOrOptions: string[] | ProcessManagerOptions = [], suppliedOptions: ProcessManagerOptions = {}) {
    const secrets = Array.isArray(secretsOrOptions) ? secretsOrOptions : [];
    const options = Array.isArray(secretsOrOptions) ? suppliedOptions : secretsOrOptions;
    this.secrets = secrets;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.shellPath = options.shellPath;
    this.spawnProcess = options.spawn ?? spawn;
    this.processKill = options.kill;
    this.captureIdentityOption = options.captureIdentity;
    this.identityExecFile = options.execFile ?? ((file, args, execOptions) => execFileAsync(file, args, execOptions) as Promise<{ stdout: string | Buffer }>);
    this.livenessCheck = options.isAlive;
    this.logWriterFactory = options.logWriterFactory ?? defaultLogWriter;
    this.logReader = options.logReader ?? defaultLogReader;
    this.outputLimit = options.outputLimit ?? OUTPUT_LIMIT;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.onChange = options.onChange;
    this.beforePersist = options.beforePersist;
  }

  setOnChange(onChange?: ProcessChange) { this.onChange = onChange; }
  setHooks(onChange?: ProcessChange, beforePersist?: BeforePersist) { this.onChange = onChange; this.beforePersist = beforePersist; }
  private records() { return this.store.data.processes; }
  private find(id: string) { return this.records().find(record => record.id === id); }
  private logPath(id: string) { return `${this.store.dir}/processes/${id}.log`; }
  private async persist(record: ProcessRecord, notify = true, eventRecord = clone(record), prepared = false) {
    if (!prepared) this.beforePersist?.(record);
    await this.store.save();
    if (notify) {
      try { await this.onChange?.(eventRecord); } catch { /* status persistence must not lose the process result */ }
    }
  }
  private async persistWithFailure(record: ProcessRecord, notify = true, prepared = false) {
    try { await this.persist(record, notify, clone(record), prepared); }
    catch (error) {
      await this.reportPersistFailure(record, error);
      throw error;
    }
  }
  private async reportPersistFailure(record: ProcessRecord, error: unknown) {
    record.reason = `persist_failed:${errorMessage(error)}`;
    try { await this.onChange?.(clone(record)); } catch { /* the in-memory terminal result remains available */ }
  }
  private indexText(index: LogIndex, text: string) {
    for (let offset = 0; offset < text.length;) {
      if (index.total % LOG_INDEX_STRIDE === 0 && index.entries[index.entries.length - 1]?.chars !== index.total) index.entries.push({ chars: index.total, bytes: index.bytes });
      const codePoint = text.codePointAt(offset)!;
      index.total++;
      index.bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      offset += codePoint > 0xffff ? 2 : 1;
    }
    if (index.total % LOG_INDEX_STRIDE === 0 && index.entries[index.entries.length - 1]?.chars !== index.total) index.entries.push({ chars: index.total, bytes: index.bytes });
  }
  private indexBytes(index: LogIndex, data: Uint8Array) { this.indexText(index, Buffer.from(data).toString('utf8')); }
  private logError(active: ActiveProcess, error: unknown) {
    if (!active.record.reason) active.record.reason = errorMessage(error);
  }
  private appendPendingLog(active: ActiveProcess, data: Buffer) {
    const required = active.pendingLogBytes + data.length;
    if (required > active.pendingLog.length) {
      const capacity = Math.max(required, Math.max(64 * 1024, active.pendingLog.length * 2));
      const pending = Buffer.allocUnsafe(capacity);
      active.pendingLog.copy(pending, 0, 0, active.pendingLogBytes);
      active.pendingLog = pending;
    }
    data.copy(active.pendingLog, active.pendingLogBytes);
    active.pendingLogBytes = required;
  }
  private takePendingLog(active: ActiveProcess) {
    if (!active.pendingLogBytes) return undefined;
    const pending = active.pendingLog.subarray(0, active.pendingLogBytes);
    active.pendingLog = Buffer.allocUnsafe(0);
    active.pendingLogBytes = 0;
    return pending;
  }
  private maybeResolveLogDrain(active: ActiveProcess) {
    if (active.outputsFinished && !active.logWriteInFlight && !active.pendingLogBytes) active.resolveLogDrain();
  }
  private writeLog(active: ActiveProcess, data: Buffer) {
    active.logWriteInFlight = true;
    let write: Promise<void>;
    try { write = Promise.resolve(active.writer.write(data)); }
    catch (error) { write = Promise.reject(error); }
    void (async () => {
      try {
        await write;
        this.indexBytes(active.index, data);
      } catch (error) {
        active.record.bytes = Math.max(0, active.record.bytes - data.length);
        this.logError(active, error);
      }
      const pending = this.takePendingLog(active);
      if (pending) this.writeLog(active, pending);
      else {
        active.logWriteInFlight = false;
        this.maybeResolveLogDrain(active);
      }
    })();
  }
  private enqueueLog(active: ActiveProcess, value: string, alreadyRedacted = false) {
    const output = Buffer.from(alreadyRedacted ? value : redact(value, this.secrets));
    const available = Math.max(0, this.outputLimit - active.record.bytes);
    const length = utf8PrefixLength(output, available), written = output.subarray(0, length);
    active.record.bytes += written.length;
    if (written.length) {
      if (active.logWriteInFlight) this.appendPendingLog(active, written);
      else this.writeLog(active, written);
    }
    if (output.length > available) {
      active.record.truncated = true;
      if (active.settled) { active.reason ??= 'output_limit'; active.record.reason ??= 'output_limit'; }
      else void this.terminate(active, 'output_limit', false).catch(() => {});
    }
  }
  private enqueueLine(active: ActiveProcess, state: OutputState, line: string) {
    const prefix = state.source === 'stderr' ? '[stderr] ' : '';
    this.enqueueLog(active, `${prefix}${redact(line, this.secrets)}`, true);
  }
  private consumeOutput(active: ActiveProcess, state: OutputState, chunk: Buffer | string) {
    if (state.ended) return;
    state.pending += state.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    while (true) {
      const newline = state.pending.indexOf('\n');
      if (newline < 0) break;
      const line = state.pending.slice(0, newline + 1); state.pending = state.pending.slice(newline + 1);
      this.enqueueLine(active, state, line);
    }
    if (Buffer.byteLength(state.pending) > OUTPUT_LINE_FLUSH) {
      const pending = state.pending;
      let windowStart = pending.length, windowBytes = 0;
      while (windowStart > 0 && windowBytes < 8 * 1024) {
        const start = pending.charCodeAt(windowStart - 1) >= 0xdc00 ? windowStart - 2 : windowStart - 1;
        windowBytes += Buffer.byteLength(pending.slice(start, windowStart)); windowStart = start;
      }
      let flushEnd = -1;
      for (let index = pending.length - 1; index >= windowStart; index--) {
        if (/\s/u.test(pending[index])) { flushEnd = index + 1; break; }
      }
      if (flushEnd < 0) {
        const keep = Math.max(256, ...this.secrets.map(secret => secret.length), 0);
        flushEnd = Math.max(0, pending.length - keep);
      }
      if (flushEnd > 0) {
        state.pending = pending.slice(flushEnd);
        this.enqueueLine(active, state, pending.slice(0, flushEnd));
      }
    }
  }
  private finishOutput(active: ActiveProcess, state: OutputState) {
    if (state.ended) return;
    state.ended = true;
    try { state.pending += state.decoder.end(); }
    catch (error) { this.logError(active, error); }
    while (true) {
      const newline = state.pending.indexOf('\n');
      if (newline < 0) break;
      const line = state.pending.slice(0, newline + 1); state.pending = state.pending.slice(newline + 1);
      this.enqueueLine(active, state, line);
    }
    if (state.pending) {
      const pending = state.pending; state.pending = '';
      this.enqueueLine(active, state, pending);
    }
    if (--active.outputRemaining === 0) active.resolveOutputDone();
  }
  private finishOutputs(active: ActiveProcess) {
    for (const state of active.outputStates) this.finishOutput(active, state);
    active.outputsFinished = true;
    if (!active.outputRemaining) active.resolveOutputDone();
    this.maybeResolveLogDrain(active);
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
    }, this.timing.escalationMs);
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
    this.finishOutputs(active);
    const reason = active.reason;
    record.status = reason === 'killed' ? 'killed' : reason === 'timeout' ? 'timeout' : reason === 'output_limit' ? 'output_limit' : reason === 'spawn_error' ? 'spawn_error' : 'exited';
    record.endedAt = new Date().toISOString();
    record.exitCode = code;
    if (signal) record.signal = signal;
    record.pidAlive = false;
    if (error) record.reason = error;
    let prepared = false, preparationError: unknown;
    try { this.beforePersist?.(record); prepared = true; } catch (error) { preparationError = error; }
    // A reader must never wait for a failed snapshot write. The terminal state
    // is visible in memory before the snapshot is awaited; keep the active
    // entry until the accepted output has drained so readers can await it.
    try {
      await active.outputDone;
      await active.logDrain;
      try { await active.writer.end(); }
      catch (writeError) { this.logError(active, writeError); }
      active.index.complete = true;
    } finally {
      active.resolveDrained();
      this.active.delete(record.id);
    }
    this.resolveWaiters(record.id, record);
    try {
      if (preparationError) throw preparationError;
      await this.persist(record, true, clone(record), prepared);
    } catch (persistError) {
      await this.reportPersistFailure(record, persistError);
      throw persistError;
    }
  }

  private async captureIdentity(pid: number, scheme: 'v2' | 'legacy' = 'v2'): Promise<string | undefined> {
    const capture = this.captureIdentityOption
      ? Promise.resolve().then(() => this.captureIdentityOption!(pid))
      : this.platform === 'win32'
        ? Promise.resolve().then(() => this.identityExecFile('powershell.exe', ['-NoProfile', '-Command', scheme === 'v2'
          ? `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToString('o')`
          : `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CreationDate`], { windowsHide: true, timeout: this.timing.identityTimeoutMs })).then(result => result.stdout)
        : Promise.resolve().then(() => this.identityExecFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: this.timing.identityTimeoutMs, env: scheme === 'v2'
          ? { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }
          : { ...process.env } })).then(result => result.stdout);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([capture, new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), this.timing.identityTimeoutMs);
      })]);
      return typeof value === 'string' || Buffer.isBuffer(value) ? String(value).trim() || undefined : undefined;
    } catch { return undefined; }
    finally { if (timer) clearTimeout(timer); }
  }
  private async identityMatch(record: ProcessRecord): Promise<'match' | 'mismatch' | 'unavailable'> {
    if (!record.pid || record.pid < 1 || record.identity === undefined) return 'unavailable';
    const identity = await this.captureIdentity(record.pid);
    if (record.identity !== undefined) {
      if (identity === record.identity) return 'match';
      if (record.identityScheme === 'v2') return identity ? 'mismatch' : 'unavailable';
      const legacy = this.captureIdentityOption ? identity : await this.captureIdentity(record.pid, 'legacy');
      if (legacy === record.identity) return 'match';
      return identity || legacy ? 'mismatch' : 'unavailable';
    }
    return 'unavailable';
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
        const result = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`], { windowsHide: true, timeout: this.timing.identityTimeoutMs });
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
      this.armWatchdog(record, this.timing.watchdogRetryMs);
    } else {
      this.watchdogRetries.delete(record.id);
      await this.persist(record);
    }
  }

  async start(input: { toolCallId: string; command: string; cwd: string; timeoutMs: number }, signal?: AbortSignal): Promise<ProcessRecord> {
    signal?.throwIfAborted();
    const record: ProcessRecord = {
      id: randomUUID(), toolCallId: input.toolCallId, command: input.command, cwd: input.cwd,
      startedAt: new Date().toISOString(), timeoutMs: input.timeoutMs, status: 'running', bytes: 0, identityScheme: 'v2',
    };
    const log = this.logPath(record.id);
    await mkdir(`${this.store.dir}/processes`, { recursive: true, mode: 0o700 });
    await writeFile(log, '', { flag: 'wx', mode: 0o600 });
    // This check is deliberately immediately before spawn. Once a child is
    // created, cancellation does not undo the detached process contract.
    signal?.throwIfAborted();
    this.records().push(record);
    let child: ChildProcess, writer: ProcessLogWriter | undefined;
    try {
      signal?.throwIfAborted();
      writer = await this.logWriterFactory(log);
      signal?.throwIfAborted();
      const shell = this.shellPath ?? resolveBashShell(this.platform, this.env);
      if (this.platform === 'win32' && !shell) throw new Error(BASH_UNAVAILABLE);
      child = spawnBash(input.command, input.cwd, this.platform, this.env, shell, this.spawnProcess, true)!;
    } catch (error) {
      if (writer) await writer.end().catch(endError => { record.reason = errorMessage(endError); });
      if (signal?.aborted) {
        this.records().splice(this.records().indexOf(record), 1);
        await unlink(log).catch(() => {});
        throw error;
      }
      record.status = 'spawn_error'; record.endedAt = new Date().toISOString(); record.exitCode = null;
      record.reason ??= errorMessage(error); record.pidAlive = false;
      await this.persistWithFailure(record);
      return record;
    }
    const index: LogIndex = { entries: [{ chars: 0, bytes: 0 }], total: 0, bytes: 0, complete: false };
    this.logIndexes.set(record.id, index);
    let resolveOutputDone!: () => void;
    const outputDone = new Promise<void>(resolve => { resolveOutputDone = resolve; });
    let resolveDrained!: () => void;
    const drained = new Promise<void>(resolve => { resolveDrained = resolve; });
    let resolveLogDrain!: () => void;
    const logDrain = new Promise<void>(resolve => { resolveLogDrain = resolve; });
    const outputStates: OutputState[] = [];
    if (child.stdout) outputStates.push({ source: 'stdout', decoder: new StringDecoder('utf8'), pending: '', ended: false });
    if (child.stderr) outputStates.push({ source: 'stderr', decoder: new StringDecoder('utf8'), pending: '', ended: false });
    const active: ActiveProcess = { record, child, log, writer: writer!, index, outputStates, outputRemaining: outputStates.length,
      settled: false, closed: false, pendingLog: Buffer.allocUnsafe(0), pendingLogBytes: 0, logWriteInFlight: false, logDrain, resolveLogDrain,
      outputsFinished: false, outputDone, resolveOutputDone, drained, resolveDrained };
    this.active.set(record.id, active);
    if (!active.outputRemaining) active.resolveOutputDone();
    if (child.pid !== undefined) record.pid = child.pid;
    record.pidAlive = Boolean(child.pid);
    let firstOutputResolve!: () => void;
    const firstOutput = new Promise<void>(resolve => { firstOutputResolve = resolve; });
    for (const state of outputStates) {
      const stream = state.source === 'stdout' ? child.stdout : child.stderr;
      stream?.on('data', (chunk: Buffer | string) => { firstOutputResolve(); this.consumeOutput(active, state, chunk); });
      stream?.once('end', () => this.finishOutput(active, state));
      stream?.once('close', () => this.finishOutput(active, state));
    }
    let failed: Promise<void> | undefined;
    child.once('error', error => {
      active.closed = true;
      if (!active.reason) active.reason = 'spawn_error';
      firstOutputResolve();
      failed = this.finish(active, null, undefined, error.message);
      void failed.catch(() => {});
    });
    child.once('close', (code, signalCode) => {
      active.closed = true;
      firstOutputResolve();
      setImmediate(() => { void this.finish(active, code, signalCode ?? undefined).catch(() => {}); });
    });
    if (child.pid === undefined) {
      await new Promise<void>(resolve => child.once('close', () => resolve()));
      await failed;
      return record;
    }
    // Reserve the start mutation before identity probing can yield to another
    // snapshot writer. A fast child may add the terminal bump separately.
    this.beforePersist?.(record);
    // Arm the timeout before the first snapshot and identity capture: neither
    // the writer nor ps/powershell may postpone the detached process deadline.
    const remaining = Math.max(0, input.timeoutMs - (Date.now() - Date.parse(record.startedAt)));
    active.timeout = setTimeout(() => { void this.terminate(active, 'timeout', false).catch(() => {}); }, remaining);
    // The PID and start-time scheme is durable before identity probing. This
    // is the crash boundary that lets recovery inspect the child safely.
    try {
      await this.persistWithFailure(record, true, true);
    } catch (error) {
      const reason = `persist_failed:${errorMessage(error)}`;
      try { await this.terminate(active, 'killed', true, reason); } catch { /* the failure is reported below */ }
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([active.drained, new Promise<void>(resolve => {
          drainTimer = setTimeout(resolve, this.timing.killConfirmMs); drainTimer.unref?.();
        })]);
      } finally { if (drainTimer) clearTimeout(drainTimer); }
      record.status = 'killed'; record.endedAt ??= new Date().toISOString(); record.exitCode = null; record.pidAlive = false; record.reason = reason;
      try { await this.persist(record, true, clone(record), true); } catch { /* best effort after stopping the child */ }
      throw new Error(`session could not be saved and the process was stopped: ${errorMessage(error)}`);
    }
    // Identity is needed only after a restart; an in-session ChildProcess is
    // always signalled through the live handle/pgid.
    const identity = await this.captureIdentity(child.pid);
    if (active.settled || active.closed || child.exitCode !== null || child.signalCode !== null) return record;
    record.identity = identity;
    await this.persistWithFailure(record, false, true);
    await Promise.race([firstOutput, new Promise<void>(resolve => setTimeout(resolve, this.timing.firstOutputWaitMs))]);
    return record;
  }

  private async waitForDrain(id: string) {
    const active = this.active.get(id);
    if (active && terminal(active.record.status)) await active.drained;
  }
  private async buildLogIndex(id: string, index: LogIndex) {
    const decoder = new StringDecoder('utf8'), log = this.logPath(id);
    let offset = 0;
    while (true) {
      const chunk = await this.logReader(log, offset, 64 * 1024);
      if (!chunk.length) break;
      offset += chunk.length;
      this.indexText(index, decoder.write(Buffer.from(chunk)));
    }
    this.indexText(index, decoder.end());
    index.bytes = offset;
    index.complete = true;
  }
  private async ensureLogIndex(id: string) {
    const active = this.active.get(id);
    if (active) return active.index;
    let index = this.logIndexes.get(id);
    if (!index) {
      index = { entries: [{ chars: 0, bytes: 0 }], total: 0, bytes: 0, complete: false };
      this.logIndexes.set(id, index);
    }
    if (!index.complete) {
      if (!index.building) {
        index.building = this.buildLogIndex(id, index).catch(error => {
          index!.entries = [{ chars: 0, bytes: 0 }]; index!.total = 0; index!.bytes = 0; index!.complete = false;
          throw error;
        }).finally(() => { index!.building = undefined; });
      }
      await index.building;
    }
    return index;
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
    const index = await this.ensureLogIndex(id), start = (offset ?? 1) - 1, size = Math.min(limit ?? 6000, 6000);
    if (start < 0 || start > index.total) throw new Error('offset_out_of_range');
    const end = Math.min(index.total, start + size);
    if (end <= start) return { text: '', end, total: index.total, truncated: end < index.total };
    let entry = index.entries[0];
    for (const candidate of index.entries) {
      if (candidate.chars > start) break;
      entry = candidate;
    }
    const bytes = await this.logReader(this.logPath(id), entry.bytes, Math.min(MAX_PAGE_BYTES, index.bytes - entry.bytes));
    const chars = Array.from(Buffer.from(bytes).toString('utf8'));
    const localStart = start - entry.chars;
    return { text: chars.slice(localStart, localStart + end - start).join(''), end, total: index.total, truncated: end < index.total };
  }

  async recover(): Promise<number> {
    const changed: ProcessRecord[] = [];
    let recovered = 0;
    for (const record of this.records()) {
      if (record.status === 'running') {
        record.status = 'unknown'; delete record.endedAt; record.reason = 'icy_restarted'; recovered++;
        const state = await this.inspect(record);
        record.pidAlive = state.alive;
        if (record.identity === undefined || state.alive && state.identity !== 'match') record.reason = 'identity_unconfirmed';
        changed.push(clone(record));
      } else if (record.status === 'unknown' && record.pid) {
        // Re-probe every unknown PID, including records previously marked
        // unconfirmed. A failed identity capture must not become permanent.
        const state = await this.inspect(record);
        const wasAlive = record.pidAlive, wasReason = record.reason;
        record.pidAlive = state.alive;
        if (record.identity === undefined || state.alive && state.identity !== 'match') record.reason = 'identity_unconfirmed';
        else if (state.alive && record.reason === 'identity_unconfirmed') record.reason = 'icy_restarted';
        if (wasAlive !== record.pidAlive || wasReason !== record.reason || state.alive && state.identity === 'match' && record.reason === 'icy_restarted') changed.push(clone(record));
      }
    }
    if (changed.length) {
      await this.store.save();
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

  /** Refresh stale unknown liveness before a safety-sensitive verification. */
  async refreshUnknownLiveness(): Promise<boolean> {
    const changed: ProcessRecord[] = [];
    for (const record of this.records()) {
      if (record.status !== 'unknown' || record.pidAlive === true || !record.pid || record.pid < 1) continue;
      const alive = await this.pidAlive(record.pid);
      if (record.pidAlive !== alive) { record.pidAlive = alive; changed.push(clone(record)); }
    }
    if (changed.length) {
      await this.store.save();
      for (const record of changed) {
        try { await this.onChange?.(record); } catch { /* liveness remains durable */ }
      }
    }
    return this.records().some(record => record.status === 'unknown' && record.pidAlive === true);
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
    const initial = identityVerified && record.identity !== undefined
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
    await new Promise(resolve => setTimeout(resolve, this.timing.escalationMs));
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
    const deadline = Date.now() + (forcedGone ? 0 : this.timing.killConfirmMs);
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
