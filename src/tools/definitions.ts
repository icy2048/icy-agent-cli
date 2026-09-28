import { z } from 'zod';

const text = z.string();
const optionalPath = text.nullable().describe('Relative workspace path; null means current directory.');
const limit = z.number().int().min(1).max(10000).nullable();
const hash = text.nullable().describe('SHA256 returned by read; null only when creating a NEW file.');
export const schemas = {
  read: z.object({
    path: text,
    offset: z.number().int().min(1).nullable(),
    limit,
    depth: z.number().int().min(1).max(5).nullable(),
    pattern: text.min(1).max(500).nullable(),
    regex: z.boolean().nullable(),
  }),
  write: z.object({ path: text, content: text.max(1_000_000), expectedHash: hash }),
  edit: z.object({ path: text, oldText: text.min(1).max(1_000_000), newText: text.max(1_000_000) }),
  bash: z.object({ command: text.min(1).max(20_000), cwd: optionalPath, timeoutMs: z.number().int().min(1).max(60_000).nullable() }),
} as const;
export const descriptions: Record<keyof typeof schemas, string> = {
  read: 'Use read instead of shell commands such as ls, find, cat, grep, rg, sha256sum or shasum: read needs no approval, lists directories when path is a directory, searches when pattern is set, and every file read already returns its SHA256, so never compute hashes with bash. Read a UTF-8 workspace file with line numbers and SHA256, list a directory, or search its contents without approval. Directory listings support depth 1–5 (default 1), sorted entries, relative paths, sizes, and a 500-entry bound. Set pattern for a case-sensitive fixed-string recursive search, or regex=true for a JavaScript regular expression (regex patterns max 200 characters); searches are limited to 200 matches, 2,000 files, 1 MB per file, and 10 seconds. Offset is a 1-based start index and limit a count over file lines, directory entries, or matches. Also reads icy-output:<id>.txt references returned by tools: for these references offset and limit count Unicode characters, default 1/6000; follow the returned next offset.',
  write: 'Create or fully replace a UTF-8 file. Existing files require expectedHash from a prior read; new files require null. Use edit for targeted changes.',
  edit: 'Edit an existing file by replacing oldText with newText. oldText must match exactly ONE occurrence, including whitespace. No regex or unified diff; ambiguous or missing matches are rejected. Read first and include enough surrounding text to make the match unique.',
  bash: 'Execute a Bash command using /bin/bash; on Windows requires Git for Windows bash. Use ONLY for running tests, build steps and other commands that read cannot do. Do not use it to list files, print or hash files, or search (use read; bash requires explicit user approval for every command, including read-only ones, and unapproved commands are rejected). No interactive stdin; max 60 seconds.',
};

export type ToolName = keyof typeof schemas;
export type ToolInput = { [K in ToolName]: { name: K; args: z.infer<(typeof schemas)[K]> } }[ToolName];
export function parseToolInput(name: string, json: string): ToolInput {
  if (!Object.hasOwn(schemas, name)) throw new Error('unknown_tool');
  let data: unknown = JSON.parse(json);
  // Older saved/provider calls omit newly added nullable fields. Normalize those
  // calls before strict validation while keeping the advertised schema strict.
  if (name === 'read' && data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const readData = data as Record<string, unknown>;
    for (const key of ['depth', 'pattern', 'regex']) if (!Object.hasOwn(readData, key)) readData[key] = null;
  }
  const parsed = schemas[name as ToolName].strict().safeParse(data);
  if (!parsed.success) throw new Error(`invalid_arguments: ${parsed.error.message}`);
  // The selected schema supplies the matching discriminant and argument type.
  return { name, args: parsed.data } as ToolInput;
}
