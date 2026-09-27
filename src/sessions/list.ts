import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSessionData, sessionIdSchema } from './schema.js';
import { errorText, redact } from '../core/text.js';

export interface SessionSummary {
  id: string; cwd?: string; model?: string; provider?: string; updatedAt?: string;
  goal?: string; status?: string; error?: string;
}

/** Read-only discovery: listing never acquires locks, migrates, or recovers a session. */
export async function listSessions(home: string): Promise<SessionSummary[]> {
  let entries;
  try { entries = await readdir(path.join(home, 'sessions'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const summaries = await Promise.all(entries.filter(e => e.isDirectory() && sessionIdSchema.safeParse(e.name).success).map(async entry => {
    try {
      const data = parseSessionData(JSON.parse(await readFile(path.join(home, 'sessions', entry.name, 'session.json'), 'utf8')), entry.name);
      const task = 'task' in data ? data.task as { goal?: string; status?: string } | undefined : undefined;
      const first = data.messages.find(m => m.role === 'user');
      return { id: data.id, cwd: data.cwd, model: data.model, provider: data.provider, updatedAt: data.updatedAt, goal: redact(task?.goal ?? first?.content ?? '').replace(/\s+/g, ' ').slice(0, 120), status: task?.status ?? 'legacy' };
    } catch (error) { return { id: entry.name, error: redact(errorText(error)).slice(0, 240) }; }
  }));
  const safe: SessionSummary[] = JSON.parse(JSON.stringify(summaries, (_key, value) => typeof value === 'string' ? redact(value) : value));
  return safe.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
}
