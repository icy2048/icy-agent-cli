import { mkdir, open, readFile, rename, unlink, writeFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Message, ToolCall } from '../core/types.js';
import type { ProcessManager, ProcessManagerOptions } from '../tools/processes.js';
import { ProcessManager as SessionProcessManager } from '../tools/processes.js';
import { redact } from '../core/text.js';
import { parseSessionData } from './schema.js';
import { interruptActiveRun, markMutation, type SessionExecutionState } from '../core/run-state.js';
import { canonicalPath } from '../tools/paths.js';

interface SessionMetadata {
  id: string; cwd: string; provider: string; model: string; baseUrl: string;
  messages: Message[]; running?: string; updatedAt: string;
}
export interface LegacySessionData extends SessionMetadata { version: 1 }
export interface SessionData extends SessionMetadata, SessionExecutionState { version: 2; processes: NonNullable<SessionExecutionState['processes']> }
export interface SessionStoreOptions {
  platform?: NodeJS.Platform;
  kill?: typeof process.kill;
  processSpawn?: typeof spawn;
  processKill?: ProcessManagerOptions['kill'];
  processEnv?: NodeJS.ProcessEnv;
  shellPath?: string;
}
export class SessionStore {
  readonly dir: string;
  private locked = false;
  private snapshot: SessionData;
  private readonly platform: NodeJS.Platform;
  private readonly kill: typeof process.kill;
  private readonly processOptions: ProcessManagerOptions;
  private manager?: ProcessManager;
  get data(): SessionData { return this.snapshot; }
  constructor(readonly home: string, data: SessionData | LegacySessionData, private secrets: string[] = [], options: SessionStoreOptions = {}) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(data.id)) throw new Error('无效会话 ID。');
    this.platform = options.platform ?? process.platform;
    this.kill = options.kill ?? process.kill.bind(process);
    this.processOptions = { platform: this.platform, spawn: options.processSpawn, kill: options.processKill, env: options.processEnv, shellPath: options.shellPath };
    this.snapshot = this.normalize(data);
    this.dir = path.join(home, 'sessions', data.id);
  }
  private normalize(data: SessionData | LegacySessionData): SessionData {
    const snapshot = data.version === 1 ? { ...data, version: 2 as const, task: undefined, runs: [], processes: [] } : data;
    return { ...snapshot, cwd: canonicalPath(snapshot.cwd, this.platform), processes: snapshot.processes ?? [] };
  }
  static async create(home: string, metadata: Pick<SessionData, 'cwd' | 'provider' | 'model' | 'baseUrl'>, secrets: string[] = [], options: SessionStoreOptions = {}) {
    const { cwd, provider, model, baseUrl } = metadata;
    const store = new SessionStore(home, { version: 2, id: randomUUID(), cwd, provider, model, baseUrl, messages: [], runs: [], processes: [], updatedAt: new Date().toISOString() }, secrets, options);
    try { await store.lock(); await store.save(); return store; }
    catch (error) { await store.close(); throw error; }
  }
  static async resume(home: string, id: string, secrets: string[] = [], options: SessionStoreOptions = {}) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('无效会话 ID。');
    const location = path.join(home, 'sessions', id, 'session.json');
    const readSnapshot = async () => {
      let snapshot: unknown;
      try { snapshot = JSON.parse(await readFile(location, 'utf8')); }
      catch (error) {
        if (error instanceof SyntaxError) throw new Error(`不支持或损坏的会话（${location}: invalid JSON）。`);
        throw error;
      }
      return parseSessionData(snapshot, id);
    };
    const store = new SessionStore(home, await readSnapshot(), secrets, options);
    try {
      await store.lock();
      // Another writer may have saved and released the lock after our initial read.
      store.snapshot = store.normalize(await readSnapshot());
      const data = store.data;
      const unknownProcesses = await store.getProcessManager().recover();
      if (unknownProcesses && data.task) markMutation(data);
      // A recorded tool call may have changed the filesystem before its result was saved.
      // Close every unmatched call; never replay side effects on resume.
      const results = new Set(data.messages.filter(m => m.role === 'tool').map(m => m.id));
      const pending: ToolCall[] = data.messages.flatMap(m => m.role === 'assistant' ? m.calls : []).filter(c => !results.has(c.id));
      // A verification command can mutate before crashing too; prior evidence is no longer current.
      if (data.task && pending.some(call => call.id === data.running && ['write', 'edit', 'bash'].includes(call.name))) markMutation(data);
      for (const call of pending) data.messages.push({ role: 'tool', id: call.id, content: JSON.stringify({ ok: false, error: data.running === call.id ? 'interrupted_unknown' : 'not_executed', content: '上次运行中断。先检查实际状态；不要自动重放有副作用的操作。' }) });
      data.running = undefined;
      const interrupted = interruptActiveRun(data);
      await store.save();
      return { store, recovered: pending.length, interrupted, unknownProcesses };
    } catch (error) { await store.close(); throw error; }
  }
  private async lock(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, 'lock');
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error(`会话锁损坏，请检查 ${file}`);
      try { this.kill(pid, 0); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') { await unlink(file); return this.lock(); }
        // EPERM means the process exists but is owned by another user; it is live.
        if (code !== 'EPERM') { /* Unknown errors are conservative: keep the lock. */ }
      }
      throw new Error('这个会话正在其他 icy 进程中使用。');
    }
    // Ownership starts at exclusive creation, including failures while writing the PID.
    this.locked = true;
    try { await handle.writeFile(String(process.pid)); }
    finally { await handle.close(); }
  }
  getProcessManager(onChange?: ProcessManagerOptions['onChange']): ProcessManager {
    if (!this.manager) this.manager = new SessionProcessManager(this, this.secrets, this.processOptions);
    if (onChange) this.manager.setOnChange(onChange);
    return this.manager;
  }
  get processManager(): ProcessManager { return this.getProcessManager(); }
  async save() {
    parseSessionData(this.data, this.data.id);
    this.data.updatedAt = new Date().toISOString();
    const temp = path.join(this.dir, `session-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, this.sanitize(JSON.stringify(this.data)), { mode: 0o600, flag: 'wx' });
      await rename(temp, path.join(this.dir, 'session.json'));
    } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  // JSON escaping must remain valid; sanitize strings before JSON serialization.
  private sanitize(json: string) {
    return JSON.stringify(JSON.parse(json), (_key, value) => typeof value === 'string' ? redact(value, this.secrets) : value);
  }
  async event(event: AgentEvent) { await appendFile(path.join(this.dir, 'events.jsonl'), this.sanitize(JSON.stringify({ ...event, at: new Date().toISOString() })) + '\n', { mode: 0o600 }); }
  async output(content: string): Promise<string> {
    const name = `${randomUUID()}.txt`;
    await mkdir(path.join(this.dir, 'outputs'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.dir, 'outputs', name), redact(content, this.secrets), { mode: 0o600 });
    return name;
  }
  async readOutput(name: string) {
    if (!/^[a-f0-9-]+\.txt$/.test(name)) throw new Error('无效输出 ID。');
    return readFile(path.join(this.dir, 'outputs', name), 'utf8');
  }
  async close() {
    if (!this.locked) return 0;
    let failure: unknown, terminated = 0;
    try { terminated = await this.getProcessManager().closeAll('session_closed'); } catch (error) { failure = error; }
    try { await unlink(path.join(this.dir, 'lock')); this.locked = false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.locked = false;
      else if (!failure) failure = error;
    }
    if (failure) throw failure;
    return terminated;
  }
}
