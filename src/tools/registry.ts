import { readFile, stat, mkdir, writeFile, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import type { Config } from '../config/load.js';
import type { Approve, ToolCall, ToolDefinition, ToolResult } from '../core/types.js';
import type { SessionStore } from '../sessions/store.js';
import { redact, errorText } from '../core/text.js';
import { workspacePath } from './paths.js';
import { runBash } from './bash.js';

const text = z.string();
const optionalPath = text.nullable().describe('Relative workspace path; null means current directory.');
const limit = z.number().int().min(1).max(10000).nullable();
const hash = text.nullable().describe('SHA256 returned by read; null only when creating a NEW file.');
const schemas = {
  read: z.object({ path: text, offset: z.number().int().min(1).nullable(), limit }),
  write: z.object({ path: text, content: text.max(1_000_000), expectedHash: hash }),
  edit: z.object({ path: text, oldText: text.min(1).max(1_000_000), newText: text.max(1_000_000) }),
  bash: z.object({ command: text.min(1).max(20_000), cwd: optionalPath, timeoutMs: z.number().int().min(1).max(60_000).nullable() }),
} as const;
const descriptions: Record<keyof typeof schemas, string> = {
  read: 'Read a UTF-8 workspace file with line numbers and SHA256. Offset and limit are lines (1-based, default 1/200). Also reads icy-output:<id>.txt references returned by tools: for these references offset and limit count Unicode characters, default 1/6000; follow the returned next offset. Does not list directories.',
  write: 'Create or fully replace a UTF-8 file. Existing files require expectedHash from a prior read; new files require null. Use edit for targeted changes.',
  edit: 'Edit an existing file by replacing oldText with newText. oldText must match exactly ONE occurrence, including whitespace. No regex or unified diff; ambiguous or missing matches are rejected. Read first and include enough surrounding text to make the match unique.',
  bash: 'Execute a Bash command using /bin/bash. Use for listing files (ls/find/rg --files), searching (rg/grep), tests and other commands. Requires permission even for read-only commands. No interactive stdin; max 60 seconds.',
};
export const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const page = (content: string, offset: number | null, limit: number | null) => {
  const lines = content.split('\n'), start = (offset ?? 1) - 1;
  return lines.slice(start, start + (limit ?? 200)).map((line, i) => `${start + i + 1}: ${line}`).join('\n') + `\n[lines ${Math.min(start + 1, lines.length)}–${Math.min(start + (limit ?? 200), lines.length)} of ${lines.length}]`;
};
export class ToolRegistry {
  private allowed = new Set<string>();
  private denied = new Set<string>();
  constructor(readonly config: Config, private store: SessionStore, private approve?: Approve) {}
  forSession(config: Config, store: SessionStore) { return new ToolRegistry(config, store, this.approve); }
  definitions(): ToolDefinition[] {
    return Object.entries(schemas).filter(([name]) => this.config.permissions !== 'read-only' || name === 'read').map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof schemas], parameters: z.toJSONSchema(schema.strict()) }));
  }
  private async read(file: string) {
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
    try { before = await this.read(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e; }
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
        if (sha256(await this.read(file)) !== expectedHash) throw new Error('file_changed');
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
  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    try {
      signal.throwIfAborted();
      const schema = Object.hasOwn(schemas, call.name) ? schemas[call.name as keyof typeof schemas] : undefined;
      if (!schema) throw new Error('unknown_tool');
      if (this.config.permissions === 'read-only' && call.name !== 'read') throw new Error('read_only');
      const parsed = schema.strict().safeParse(JSON.parse(call.arguments));
      if (!parsed.success) throw new Error(`invalid_arguments: ${parsed.error.message}`);
      let result: ToolResult;
      switch (call.name) {
        case 'read': {
          const a = schemas.read.parse(parsed.data);
          if (a.path.startsWith('icy-output:')) { result = await this.readOutput(a.path, a.offset, a.limit); break; }
          const content = await this.read(a.path);
          result = { ok: true, content: `SHA256: ${sha256(content)}\n${page(content, a.offset, a.limit)}` }; break;
        }
        case 'write': { const a = schemas.write.parse(parsed.data); result = await this.write(a.path, a.content, a.expectedHash, signal); break; }
        case 'edit': {
          const a = schemas.edit.parse(parsed.data);
          if (a.path.startsWith('icy-output:')) throw new Error('output_reference_is_read_only');
          const before = await this.read(a.path), index = before.indexOf(a.oldText);
          if (index < 0) throw new Error('edit_text_not_found');
          if (before.indexOf(a.oldText, index + 1) >= 0) throw new Error('edit_text_not_unique');
          const after = before.slice(0, index) + a.newText + before.slice(index + a.oldText.length);
          result = await this.write(a.path, after, sha256(before), signal); break;
        }
        case 'bash': {
          const a = schemas.bash.parse(parsed.data), cwd = await workspacePath(this.config.cwd, a.cwd ?? '.');
          const request = { command: a.command, cwd, timeoutMs: a.timeoutMs ?? 60_000 };
          const key = JSON.stringify(request);
          if (this.denied.has(key)) throw new Error('permission_denied');
          if (!this.allowed.has(key)) {
            if (!this.approve) throw new Error('approval_required');
            const choice = await this.approve(request, signal); signal.throwIfAborted();
            if (choice === 'deny') { this.denied.add(key); throw new Error('permission_denied'); }
            if (choice === 'session') this.allowed.add(key);
          }
          result = await runBash(a.command, cwd, request.timeoutMs, signal); break;
        }
        default: throw new Error('unknown_tool');
      }
      result.content = redact(result.content, [this.config.apiKey]);
      if (result.diff) result.diff = redact(result.diff, [this.config.apiKey]);
      if (Buffer.byteLength(result.content) > 32768) {
        const id = await this.store.output(result.content);
        result.content = result.content.slice(0, 8000) + `\n[TRUNCATED: read path="icy-output:${id}" offset=1 limit=6000]`; result.truncated = true;
      }
      if (result.diff && result.diff.length > 8000) { const id = await this.store.output(result.diff); result.diff = result.diff.slice(0, 8000) + `\n[Diff truncated: read path="icy-output:${id}" offset=1 limit=6000]`; }
      result.durationMs ??= Date.now() - start; return result;
    } catch (e) { return { ok: false, error: signal.aborted ? 'cancelled' : 'tool_error', content: redact(errorText(e), [this.config.apiKey]), durationMs: Date.now() - start }; }
  }
}
