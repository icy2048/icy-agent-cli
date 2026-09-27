import type { Config } from '../config/load.js';
import type { SessionStore } from '../sessions/store.js';
import type { Message } from './types.js';

export interface ContextStats {
  beforeChars: number; afterChars: number; estimatedTokens: number;
  compactedToolResults: number; fallback: boolean;
}

/** A disposable view over the source history. Never edits a saved message. */
export class ContextManager {
  private references = new Map<string, string>();
  constructor(private config: Pick<Config, 'promptCompaction' | 'maxContextChars'>, private store: SessionStore) {}

  async build(history: Message[], signal: AbortSignal, reminder?: Message): Promise<{ messages: Message[]; stats: ContextStats }> {
    signal.throwIfAborted();
    const appendReminder = (messages: Message[]) => reminder ? [...messages, reminder] : messages;
    const original = appendReminder(history);
    const beforeChars = JSON.stringify(original).length;
    const stats: ContextStats = { beforeChars, afterChars: beforeChars, estimatedTokens: Math.ceil(beforeChars / 2), compactedToolResults: 0, fallback: false };
    if (this.config.promptCompaction === 'off' || beforeChars < this.config.maxContextChars * 0.8) return { messages: original, stats };
    try {
      const toolIndexes = history.flatMap((m, i) => m.role === 'tool' ? [i] : []);
      const eligible = new Set(toolIndexes.slice(0, -4));
      const messages: Message[] = [];
      for (let i = 0; i < history.length; i++) {
        signal.throwIfAborted();
        const message = history[i];
        if (message.role !== 'tool' || !eligible.has(i) || message.content.length <= 4000) { messages.push(message); continue; }
        const raw = message.content;
        let reference = this.references.get(raw);
        if (!reference) {
          reference = `icy-output:${await this.store.output(raw)}`;
          this.references.set(raw, reference);
        }
        const metadata: Record<string, unknown> = {};
        try {
          const result = JSON.parse(raw);
          for (const key of ['ok', 'error', 'changedFile', 'durationMs'] as const) {
            const value = result?.[key];
            if (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 500)) metadata[key] = value;
          }
        } catch { /* Unstructured output remains readable through the reference. */ }
        messages.push({ ...message, content: JSON.stringify({ ...metadata, compacted: true, content: `Earlier tool output (${raw.length} characters) stored in ${reference}. Use read to retrieve the original before relying on its details.`, outputRef: reference }) });
        stats.compactedToolResults++;
      }
      signal.throwIfAborted();
      const request = appendReminder(messages);
      stats.afterChars = JSON.stringify(request).length;
      stats.estimatedTokens = Math.ceil(stats.afterChars / 2);
      return { messages: request, stats };
    } catch {
      signal.throwIfAborted();
      return { messages: original, stats: { ...stats, afterChars: beforeChars, estimatedTokens: Math.ceil(beforeChars / 2), compactedToolResults: 0, fallback: true } };
    }
  }
}
