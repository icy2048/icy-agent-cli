import { constants } from 'node:fs';
import { stat, lstat, mkdir, writeFile, rename, unlink, link, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { Config } from '../config/load.js';
import type { ToolResult } from '../core/types.js';
import type { SessionStore } from '../sessions/store.js';
import { workspacePath } from './paths.js';
import { listDirectory, searchWorkspace } from './explore.js';
import { runBash } from './bash.js';
import type { ProcessRecord } from '../core/types.js';

import type { ToolInput } from './definitions.js';

export const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const page = (content: string, offset: number | null, limit: number | null) => {
  const lines = content.split('\n'), start = (offset ?? 1) - 1;
  return lines.slice(start, start + (limit ?? 200)).map((line, i) => `${start + i + 1}: ${line}`).join('\n') + `\n[lines ${Math.min(start + 1, lines.length)}–${Math.min(start + (limit ?? 200), lines.length)} of ${lines.length}]`;
};
export interface ToolExecutorOptions {
  platform?: NodeJS.Platform;
  pathModule?: Pick<typeof path, 'dirname' | 'join'>;
  link?: typeof link;
  open?: typeof open;
  stat?: typeof stat;
  rename?: typeof rename;
}

export class ToolExecutor {
  private readonly platform: NodeJS.Platform;
  private readonly pathModule: Pick<typeof path, 'dirname' | 'join'>;
  private readonly link: typeof link;
  private readonly open: typeof open;
  private readonly stat: typeof stat;
  private readonly rename: typeof rename;
  constructor(private config: Pick<Config, 'cwd'>, private store: SessionStore, options: ToolExecutorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.pathModule = options.pathModule ?? path;
    this.link = options.link ?? link;
    this.open = options.open ?? open;
    this.stat = options.stat ?? stat;
    this.rename = options.rename ?? rename;
  }
  private async readFileContent(file: string) {
    const resolved = await workspacePath(this.config.cwd, file, { mustExist: true });
    const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const handle = await this.open(resolved, constants.O_RDONLY | noFollow);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1_000_000) throw new Error('not_text_file_or_too_large');
      const content = await handle.readFile({ encoding: 'utf8' });
      try {
        const checked = await workspacePath(this.config.cwd, file, { mustExist: true });
        const pathInfo = await lstat(checked);
        if (!pathInfo.isFile() || pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) throw new Error('file_changed_during_read');
      } catch (error) {
        if (error instanceof Error && error.message === 'file_changed_during_read') throw error;
        throw new Error('file_changed_during_read');
      }
      if (content.includes('\0')) throw new Error('binary_file');
      return content;
    } finally { await handle.close(); }
  }
  private async write(file: string, content: string, expectedHash: string | null, signal: AbortSignal): Promise<ToolResult> {
    if (file.startsWith('icy-output:') || file.startsWith('icy-process:')) throw new Error('output_reference_is_read_only');
    let before = '', exists = true;
    const target = await workspacePath(this.config.cwd, file);
    try { before = await this.readFileContent(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e; }
    if (exists ? expectedHash !== sha256(before) : expectedHash !== null) throw new Error('file_changed_or_hash_required');
    signal.throwIfAborted();
    await mkdir(this.pathModule.dirname(target), { recursive: true });
    await workspacePath(this.config.cwd, file);
    const temp = this.pathModule.join(this.pathModule.dirname(target), `.icy-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { flag: 'wx', mode: exists ? (await this.stat(target)).mode : 0o644 });
      signal.throwIfAborted();
      await workspacePath(this.config.cwd, file);
      if (exists) {
        if (sha256(await this.readFileContent(file)) !== expectedHash) throw new Error('file_changed');
        await this.rename(temp, target);
      } else {
        const createExclusively = async () => {
          let handle;
          try {
            handle = await this.open(target, 'wx', 0o644);
            await handle.writeFile(content);
            await handle.sync();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('file_changed');
            throw error;
          } finally { await handle?.close(); }
        };
        let linked = false;
        try { await this.link(temp, target); linked = true; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') throw new Error('file_changed');
          if (!['EPERM', 'EXDEV', 'ENOSYS', 'EINVAL', 'ENOTSUP', 'EACCES'].includes(code ?? '')) throw error;
          await createExclusively();
        }
        if (linked) await unlink(temp);
      } // no overwrite if another process creates the target
    } finally { await unlink(temp).catch(() => {}); }
    return { ok: true, content: `Updated ${file}\nSHA256: ${sha256(content)}`, changedFile: file, diff: createTwoFilesPatch(file, file, before, content) };
  }
  private processHeader(reference: string, record: ProcessRecord) {
    const details = [
      record.exitCode !== undefined && record.exitCode !== null ? `exit code ${record.exitCode}` : undefined,
      record.signal ? `signal ${record.signal}` : undefined, record.reason ? `reason ${record.reason}` : undefined,
    ].filter(Boolean).join(' | ');
    const end = record.endedAt ? Date.parse(record.endedAt) : Date.now();
    const duration = Math.max(0, Math.floor((end - Date.parse(record.startedAt)) / 1000));
    return `Process ${reference}\nStatus: ${record.status}${details ? ` (${details})` : ''}\nCommand: ${record.command}\nCwd: ${record.cwd}\nStarted: ${record.startedAt}  Duration: ${duration}s  Output bytes: ${record.bytes}${record.truncated ? ' (truncated at 16 MiB)' : ''}\n---`;
  }
  private async readProcess(reference: string, offset: number | null, limit: number | null, signal: AbortSignal): Promise<ToolResult> {
    const id = reference.slice('icy-process:'.length), manager = this.store.getProcessManager();
    const record = await manager.status(id, { waitMs: offset === null && limit === null ? 10_000 : 0, signal });
    const output = await manager.readOutput(id, offset, limit);
    const next = output.truncated ? `\n[More output: read path="${reference}" offset=${output.end + 1} limit=6000]` : '\n[End of output]';
    const ok = record.status === 'running' || record.status === 'exited' && record.exitCode === 0;
    return { ok, error: ok ? undefined : record.status === 'exited' ? 'command_failed' : record.status, content: `${this.processHeader(reference, record)}\n${output.text}${next}`, truncated: output.truncated };
  }
  private async readOutput(reference: string, offset: number | null, limit: number | null): Promise<ToolResult> {
    const chars = Array.from(await this.store.readOutput(reference.slice('icy-output:'.length)));
    const start = (offset ?? 1) - 1;
    if (start > chars.length) throw new Error('offset_out_of_range');
    const end = Math.min(chars.length, start + Math.min(limit ?? 6000, 6000));
    return { ok: true, content: chars.slice(start, end).join('') + (end < chars.length
      ? `\n[More output: read path="${reference}" offset=${end + 1} limit=6000]`
      : '\n[End of output]'), truncated: end < chars.length };
  }
  /** Execute a validated and authorized request; registry owns errors and output projection. */
  async execute(input: ToolInput, signal: AbortSignal, context: { callId: string } = { callId: 'unknown' }): Promise<ToolResult> {
    signal.throwIfAborted();
    switch (input.name) {
      case 'read': {
        const a = input.args;
        if (a.path.startsWith('icy-process:')) {
          if (a.depth !== null || a.pattern !== null || a.regex !== null) throw new Error('arguments_not_supported_for_process');
          return this.readProcess(a.path, a.offset, a.limit, signal);
        }
        if (a.path.startsWith('icy-output:')) {
          if (a.depth !== null || a.pattern !== null || a.regex !== null) throw new Error('arguments_not_supported_for_output');
          return this.readOutput(a.path, a.offset, a.limit);
        }
        if (a.pattern !== null) {
          return { ok: true, content: await searchWorkspace(this.config.cwd, a.path, a.pattern, a.regex ?? false, a.offset, a.limit, a.depth, signal) };
        }
        const resolved = await workspacePath(this.config.cwd, a.path, { mustExist: true });
        const info = await stat(resolved);
        if (info.isDirectory()) return { ok: true, content: await listDirectory(this.config.cwd, a.path, a.offset, a.limit, a.depth, signal) };
        const content = await this.readFileContent(a.path);
        return { ok: true, content: `SHA256: ${sha256(content)}\n${page(content, a.offset, a.limit)}` };
      }
      case 'write': {
        const a = input.args;
        return this.write(a.path, a.content, a.expectedHash, signal);
      }
      case 'edit': {
        const a = input.args;
        if (a.path.startsWith('icy-output:') || a.path.startsWith('icy-process:')) throw new Error('output_reference_is_read_only');
        const before = await this.readFileContent(a.path), index = before.indexOf(a.oldText);
        if (index < 0) throw new Error('edit_text_not_found');
        if (before.indexOf(a.oldText, index + 1) >= 0) throw new Error('edit_text_not_unique');
        const after = before.slice(0, index) + a.newText + before.slice(index + a.oldText.length);
        return this.write(a.path, after, sha256(before), signal);
      }
      case 'bash': {
        const a = input.args, detach = a.detach ?? false, kill = a.kill ?? null;
        // Revalidate after an approval wait: a directory may have become a symlink.
        const cwd = await workspacePath(this.config.cwd, a.cwd ?? '.');
        const timeoutMs = a.timeoutMs ?? (detach ? 1_800_000 : 60_000);
        if (kill !== null) {
          const reference = kill.startsWith('icy-process:') ? kill.slice('icy-process:'.length) : kill;
          const record = await this.store.getProcessManager().kill(reference, 'model_kill');
          return { ok: record.status === 'killed', error: record.status === 'killed' ? undefined : record.status, content: `Process icy-process:${record.id} Status: ${record.status}${record.reason ? ` (reason ${record.reason})` : ''}` };
        }
        if (detach) {
          const record = await this.store.getProcessManager().start({ toolCallId: context.callId, command: a.command, cwd, timeoutMs }, signal);
          if (record.status === 'spawn_error') return { ok: false, error: record.status, content: `Process icy-process:${record.id} Status: ${record.status}${record.reason ? `: ${record.reason}` : ''}` };
          return { ok: true, content: `Started icy-process:${record.id} (pid ${record.pid}). Poll with read path="icy-process:${record.id}"; stop with bash command="kill" kill="icy-process:${record.id}".` };
        }
        return runBash(a.command, cwd, timeoutMs, signal);
      }
    }
  }
}
