import { z } from 'zod';

const text = z.string();
const optionalPath = text.nullable().describe('Relative workspace path; null means current directory.');
const limit = z.number().int().min(1).max(10000).nullable();
const hash = text.nullable().describe('SHA256 returned by read; null only when creating a NEW file.');
export const schemas = {
  read: z.object({ path: text, offset: z.number().int().min(1).nullable(), limit }),
  write: z.object({ path: text, content: text.max(1_000_000), expectedHash: hash }),
  edit: z.object({ path: text, oldText: text.min(1).max(1_000_000), newText: text.max(1_000_000) }),
  bash: z.object({ command: text.min(1).max(20_000), cwd: optionalPath, timeoutMs: z.number().int().min(1).max(60_000).nullable() }),
} as const;
export const descriptions: Record<keyof typeof schemas, string> = {
  read: 'Read a UTF-8 workspace file with line numbers and SHA256. Offset and limit are lines (1-based, default 1/200). Also reads icy-output:<id>.txt references returned by tools: for these references offset and limit count Unicode characters, default 1/6000; follow the returned next offset. Does not list directories.',
  write: 'Create or fully replace a UTF-8 file. Existing files require expectedHash from a prior read; new files require null. Use edit for targeted changes.',
  edit: 'Edit an existing file by replacing oldText with newText. oldText must match exactly ONE occurrence, including whitespace. No regex or unified diff; ambiguous or missing matches are rejected. Read first and include enough surrounding text to make the match unique.',
  bash: 'Execute a Bash command using /bin/bash. Use for listing files (ls/find/rg --files), searching (rg/grep), tests and other commands. Requires permission even for read-only commands. No interactive stdin; max 60 seconds.',
};

export type ToolName = keyof typeof schemas;
export type ToolInput = { [K in ToolName]: { name: K; args: z.infer<(typeof schemas)[K]> } }[ToolName];
export function parseToolInput(name: string, json: string): ToolInput {
  if (!Object.hasOwn(schemas, name)) throw new Error('unknown_tool');
  const data: unknown = JSON.parse(json);
  const parsed = schemas[name as ToolName].strict().safeParse(data);
  if (!parsed.success) throw new Error(`invalid_arguments: ${parsed.error.message}`);
  // The selected schema supplies the matching discriminant and argument type.
  return { name, args: parsed.data } as ToolInput;
}
