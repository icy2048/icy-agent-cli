import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSessionData, sessionIdSchema } from './schema.js';
import { errorText, redact } from '../core/text.js';
import { resolveWorkspacePath } from '../tools/paths.js';

export interface SessionSummary {
  id: string; cwd?: string; model?: string; provider?: string; updatedAt?: string;
  goal?: string; status?: string; error?: string;
}

/** The nine task statuses a session can report: ExecutionStatus values plus 'legacy' for sessions without a task. */
export const sessionStatuses = ['running', 'awaiting_approval', 'cancelled', 'limited', 'failed', 'answered', 'verified', 'interrupted', 'legacy'] as const;

export interface SessionFilter { status?: string[]; cwd?: string }

const knownStatus = (status: string): boolean => (sessionStatuses as readonly string[]).includes(status);
function invalidStatus(status: string): never { throw new Error(`invalid_status: ${status}`); }

/** Split a comma-separated status argument; throws invalid_status before any directory is read. */
export function parseStatusFilter(value: string): string[] {
  const statuses = value.split(',').map(item => item.trim()).filter(item => item.length > 0);
  for (const status of statuses) if (!knownStatus(status)) invalidStatus(status);
  return statuses;
}

/** Render an invalid_status error as the operator-facing message; undefined for unrelated errors. */
export function invalidStatusText(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message.startsWith('invalid_status: ')) return undefined;
  return `无效的状态：${error.message.slice('invalid_status: '.length)}；可用：${sessionStatuses.join(', ')}`;
}

/** Read-only discovery: listing never acquires locks, migrates, or recovers a session. */
export async function listSessions(home: string, filter?: SessionFilter, platform = process.platform): Promise<SessionSummary[]> {
  // Validate before touching the filesystem: a bad status must not read (or depend on) any directory.
  const statuses = filter?.status ?? [];
  for (const status of statuses) if (!knownStatus(status)) invalidStatus(status);
  // A filter cwd may name a removed workspace; path resolution is read-only and falls back without creating or locking it.
  const separator = platform === 'win32' ? '\\' : path.sep;
  let workspace: string | undefined;
  if (filter?.cwd !== undefined) workspace = await resolveWorkspacePath(filter.cwd, platform);
  const comparable = (value: string) => platform === 'win32' ? value.toLowerCase() : value;
  const comparableWorkspace = workspace === undefined ? undefined : comparable(workspace);
  const filtering = statuses.length > 0 || workspace !== undefined;
  let entries;
  try { entries = await readdir(path.join(home, 'sessions'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const summaries = await Promise.all(entries.filter(e => e.isDirectory() && sessionIdSchema.safeParse(e.name).success).map(async entry => {
    try {
      const data = parseSessionData(JSON.parse(await readFile(path.join(home, 'sessions', entry.name, 'session.json'), 'utf8')), entry.name);
      const task = 'task' in data ? data.task as { goal?: string; status?: string } | undefined : undefined;
      const first = data.messages.find(m => m.role === 'user');
      return { id: data.id, cwd: await resolveWorkspacePath(data.cwd, platform), model: data.model, provider: data.provider, updatedAt: data.updatedAt, goal: redact(task?.goal ?? first?.content ?? '').replace(/\s+/g, ' ').slice(0, 120), status: task?.status ?? 'legacy' };
    } catch (error) { return { id: entry.name, error: redact(errorText(error)).slice(0, 240) }; }
  }));
  const safe: SessionSummary[] = JSON.parse(JSON.stringify(summaries, (_key, value) => typeof value === 'string' ? redact(value) : value));
  const listed = safe.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  // Unreadable entries carry no status or workspace, so they are only shown in unfiltered listings.
  if (!filtering) return listed;
  return listed.filter(summary => !summary.error
    && (statuses.length === 0 || (summary.status !== undefined && statuses.includes(summary.status)))
    && (comparableWorkspace === undefined || (summary.cwd !== undefined && (() => {
      const summaryCwd = comparable(summary.cwd);
      return summaryCwd === comparableWorkspace || summaryCwd.startsWith(comparableWorkspace + separator);
    })())));
}
