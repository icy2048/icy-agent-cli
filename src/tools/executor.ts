import { readFile, stat, mkdir, writeFile, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { Config } from '../config/load.js';
import type { ToolResult } from '../core/types.js';
import type { SessionStore } from '../sessions/store.js';
import { workspacePath } from './paths.js';
import { listDirectory, searchWorkspace } from './explore.js';
import { runBash } from './bash.js';

import type { ToolInput } from './definitions.js';

export const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const page = (content: string, offset: number | null, limit: number | null) => {
  const lines = content.split('\n'), start = (offset ?? 1) - 1;
  return lines.slice(start, start + (limit ?? 200)).map((line, i) => `${start + i + 1}: ${line}`).join('\n') + `\n[lines ${Math.min(start + 1, lines.length)}–${Math.min(start + (limit ?? 200), lines.length)} of ${lines.length}]`;
};
export class ToolExecutor {
  constructor(private config: Pick<Config, 'cwd'>, private store: SessionStore) {}
  private async readFileContent(file: string) {
    const resolved = await workspacePath(this.config.cwd, file);
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 1_000_000) throw new Error('not_text_file_or_too_large');
    const content = await readFile(resolved, 'utf8');
    if (content.includes('\0')) throw new Error('binary_file');
    return content;
  }
  private async write(file: string, content: string, expectedHash: string | null, signal: AbortSignal): Promise<ToolResult> {
    if (file.startsWith('icy-output:')) throw new Error('output_reference_is_read_only');
    let before = '', exists = true;
    const target = await workspacePath(this.config.cwd, file);
    try { before = await this.readFileContent(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e; }
    if (exists ? expectedHash !== sha256(before) : expectedHash !== null) throw new Error('file_changed_or_hash_required');
    signal.throwIfAborted();
    await mkdir(path.dirname(target), { recursive: true });
    await workspacePath(this.config.cwd, file);
    const temp = path.join(path.dirname(target), `.icy-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { flag: 'wx', mode: exists ? (await stat(target)).mode : 0o644 });
      signal.throwIfAborted();
      await workspacePath(this.config.cwd, file);
      if (exists) {
        if (sha256(await this.readFileContent(file)) !== expectedHash) throw new Error('file_changed');
        await rename(temp, target);
      } else { await link(temp, target); await unlink(temp); } // no overwrite if another process creates the target
    } finally { await unlink(temp).catch(() => {}); }
    return { ok: true, content: `Updated ${file}\nSHA256: ${sha256(content)}`, changedFile: file, diff: createTwoFilesPatch(file, file, before, content) };
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
  async execute(input: ToolInput, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    switch (input.name) {
      case 'read': {
        const a = input.args;
        if (a.path.startsWith('icy-output:')) {
          if (a.depth !== null || a.pattern !== null || a.regex !== null) throw new Error('arguments_not_supported_for_output');
          return this.readOutput(a.path, a.offset, a.limit);
        }
        if (a.pattern !== null) {
          return { ok: true, content: await searchWorkspace(this.config.cwd, a.path, a.pattern, a.regex ?? false, a.offset, a.limit, a.depth, signal) };
        }
        const resolved = await workspacePath(this.config.cwd, a.path);
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
        if (a.path.startsWith('icy-output:')) throw new Error('output_reference_is_read_only');
        const before = await this.readFileContent(a.path), index = before.indexOf(a.oldText);
        if (index < 0) throw new Error('edit_text_not_found');
        if (before.indexOf(a.oldText, index + 1) >= 0) throw new Error('edit_text_not_unique');
        const after = before.slice(0, index) + a.newText + before.slice(index + a.oldText.length);
        return this.write(a.path, after, sha256(before), signal);
      }
      case 'bash': {
        const a = input.args;
        // Revalidate after an approval wait: a directory may have become a symlink.
        const cwd = await workspacePath(this.config.cwd, a.cwd ?? '.');
        return runBash(a.command, cwd, a.timeoutMs ?? 60_000, signal);
      }
    }
  }
}
