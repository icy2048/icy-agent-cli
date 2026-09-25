import { mkdir, open, readFile, rename, unlink, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Message, ToolCall } from '../core/types.js';
import { redact } from '../core/text.js';

export interface SessionData {
  version: 1; id: string; cwd: string; provider: string; model: string; baseUrl: string;
  messages: Message[]; running?: string; updatedAt: string;
}
export class SessionStore {
  readonly dir: string;
  private locked = false;
  constructor(readonly home: string, readonly data: SessionData, private secrets: string[] = []) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(data.id)) throw new Error('无效会话 ID。');
    this.dir = path.join(home, 'sessions', data.id);
  }
  static async create(home: string, metadata: Pick<SessionData, 'cwd' | 'provider' | 'model' | 'baseUrl'>, secrets: string[] = []) {
    const store = new SessionStore(home, { version: 1, id: randomUUID(), ...metadata, messages: [], updatedAt: new Date().toISOString() }, secrets);
    await store.lock(); await store.save(); return store;
  }
  static async resume(home: string, id: string, secrets: string[] = []) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('无效会话 ID。');
    const location = path.join(home, 'sessions', id, 'session.json');
    const data = JSON.parse(await readFile(location, 'utf8')) as SessionData;
    if (data.version !== 1 || data.id !== id || !Array.isArray(data.messages) || !path.isAbsolute(data.cwd)) throw new Error('不支持或损坏的会话。');
    const store = new SessionStore(home, data, secrets);
    await store.lock();
    // A recorded tool call may have changed the filesystem before its result was saved.
    // Close every unmatched call; never replay side effects on resume.
    const results = new Set(data.messages.filter(m => m.role === 'tool').map(m => m.id));
    const pending: ToolCall[] = data.messages.flatMap(m => m.role === 'assistant' ? m.calls : []).filter(c => !results.has(c.id));
    for (const call of pending) data.messages.push({ role: 'tool', id: call.id, content: JSON.stringify({ ok: false, error: data.running === call.id ? 'interrupted_unknown' : 'not_executed', content: '上次运行中断。先检查实际状态；不要自动重放有副作用的操作。' }) });
    data.running = undefined;
    try { await store.save(); } catch (e) { await store.close(); throw e; }
    return { store, recovered: pending.length };
  }
  private async lock(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, 'lock');
    try { const handle = await open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); await handle.close(); this.locked = true; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error(`会话锁损坏，请检查 ${file}`);
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(file); return this.lock(); }
      }
      throw new Error('这个会话正在其他 icy 进程中使用。');
    }
  }
  async save() {
    this.data.updatedAt = new Date().toISOString();
    const temp = path.join(this.dir, `session-${randomUUID()}.tmp`);
    await writeFile(temp, this.sanitize(JSON.stringify(this.data)), { mode: 0o600 });
    await rename(temp, path.join(this.dir, 'session.json'));
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
  async close() { if (this.locked) { this.locked = false; await unlink(path.join(this.dir, 'lock')).catch(() => {}); } }
}
