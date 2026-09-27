import type { Config } from '../config/load.js';
import type { SessionStore } from '../sessions/store.js';
import type { Message } from './types.js';

export interface ContextStats {
  beforeChars: number; afterChars: number; estimatedTokens: number;
  compactedToolResults: number; fallback: boolean;
  recentToolPreviews?: number;
  archivedExchanges?: number;
}

/** A disposable view over the source history. Never edits a saved message. */
export class ContextManager {
  private references = new Map<string, string>();
  constructor(private config: Pick<Config, 'promptCompaction' | 'maxContextChars'>, private store: SessionStore) {}

  async build(history: Message[], signal: AbortSignal, reminder?: Message, measure = (messages: Message[]) => JSON.stringify(messages).length): Promise<{ messages: Message[]; stats: ContextStats }> {
    signal.throwIfAborted();
    const appendReminder = (messages: Message[]) => reminder ? [...messages, reminder] : messages;
    const original = appendReminder(history);
    const beforeChars = measure(original);
    const stats: ContextStats = { beforeChars, afterChars: beforeChars, estimatedTokens: Math.ceil(beforeChars / 2), compactedToolResults: 0, fallback: false };
    if (this.config.promptCompaction === 'off' || beforeChars < this.config.maxContextChars * 0.8) return { messages: original, stats };
    try {
      const toolIndexes = history.flatMap((m, i) => m.role === 'tool' ? [i] : []);
      const latestAssistant = history.findLastIndex(message => message.role === 'assistant');
      const eligible = new Set(toolIndexes.slice(0, -4).filter(index => index < latestAssistant));
      const recent = toolIndexes.filter(index => !eligible.has(index));
      const externalize = async (message: Extract<Message, { role: 'tool' }>, preview = false): Promise<Message> => {
        const raw = message.content;
        let reference = this.references.get(raw);
        if (!reference) {
          reference = `icy-output:${await this.store.output(raw)}`;
          this.references.set(raw, reference);
        }
        const metadata: Record<string, unknown> = {};
        let body = raw;
        try {
          const result = JSON.parse(raw);
          if (typeof result?.content === 'string') body = result.content;
          for (const key of ['ok', 'error', 'changedFile', 'durationMs'] as const) {
            const value = result?.[key];
            if (typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 500)) metadata[key] = value;
          }
        } catch { /* Unstructured output remains readable through the reference. */ }
        const excerpt = preview ? `Recent tool output preview:\n${body.slice(0, 1600)}\n[... omitted; read the full reference ...]\n${body.slice(-800)}\n` : '';
        return { ...message, content: JSON.stringify({ ...metadata, compacted: true, content: `${excerpt}Original tool output (${raw.length} characters) stored in ${reference}. Use read to retrieve the original before relying on its details.`, outputRef: reference }) };
      };
      const messages: Message[] = [];
      for (let i = 0; i < history.length; i++) {
        signal.throwIfAborted();
        const message = history[i];
        if (message.role !== 'tool' || !eligible.has(i) || message.content.length <= 4000) { messages.push(message); continue; }
        messages.push(await externalize(message));
        stats.compactedToolResults++;
      }
      // Smaller old results also accumulate across restarts. The normal 4,000
      // character threshold is a preference, not an unshrinkable history floor.
      if (measure(appendReminder(messages)) > this.config.maxContextChars) {
        for (const i of eligible) {
          signal.throwIfAborted();
          const message = history[i];
          if (message.role !== 'tool' || message.content.length <= 1000 || message.content.length > 4000) continue;
          messages[i] = await externalize(message);
          stats.compactedToolResults++;
          if (measure(appendReminder(messages)) <= this.config.maxContextChars * 0.8) break;
        }
      }
      // Opaque reasoning and historical write arguments can dominate the window
      // even after every output is bounded. Archive only complete exchanges as
      // exact JSON, never split a call/result pair or rewrite retained opaque
      // items. All user requirements and the four most recent tool observations
      // (including their whole assistant batches) remain in the active view.
      const archived = new Set<number>();
      const active = () => appendReminder(messages.filter((_, i) => !archived.has(i)));
      if (measure(active()) > this.config.maxContextChars) {
        const protectedFrom = toolIndexes.at(-4) ?? toolIndexes[0] ?? history.length;
        for (let i = 0; i < history.length; i++) {
          signal.throwIfAborted();
          const message = history[i];
          if (message.role !== 'assistant' || i === latestAssistant) continue;
          const ids = new Set(message.calls.map(call => call.id));
          if (ids.size !== message.calls.length) continue;
          let end = i + 1;
          const observed = new Set<string>();
          while (end < history.length && history[end].role === 'tool') {
            const result = history[end] as Extract<Message, { role: 'tool' }>;
            if (!ids.has(result.id) || observed.has(result.id)) break;
            observed.add(result.id); end++;
          }
          if (observed.size !== ids.size || end > protectedFrom || end <= i) continue;
          const exchange = history.slice(i, end), raw = JSON.stringify(exchange);
          let reference = this.references.get(raw);
          if (!reference) { reference = `icy-output:${await this.store.output(raw)}`; this.references.set(raw, reference); }
          const outcomes = exchange.filter((entry): entry is Extract<Message, { role: 'tool' }> => entry.role === 'tool').map(entry => {
            const call = message.calls.find(call => call.id === entry.id)!;
            const request: Record<string, unknown> = {};
            try {
              const args = JSON.parse(call.arguments);
              for (const key of ['path', 'offset', 'limit', 'command', 'cwd', 'timeoutMs']) {
                const value = args?.[key];
                if (value === null || typeof value === 'number' || typeof value === 'string' && value.length <= 500) request[key] = value;
              }
            } catch { /* Exact arguments remain in the archive. */ }
            try {
              const result = JSON.parse(entry.content);
              const outcome: Record<string, unknown> = { id: entry.id, tool: call.name, request };
              for (const key of ['ok', 'error', 'changedFile']) {
                const value = result?.[key];
                if (typeof value === 'boolean' || typeof value === 'string' && value.length <= 500) outcome[key] = value;
              }
              return outcome;
            } catch { return { id: entry.id, tool: call.name, request, outcome: 'see original' }; }
          });
          messages[i] = { role: 'assistant', calls: [], content: JSON.stringify({ kind: 'icy.archived-exchange', outputRef: reference, outcomes }) };
          for (let index = i + 1; index < end; index++) archived.add(index);
          stats.archivedExchanges = (stats.archivedExchanges ?? 0) + 1;
          if (measure(active()) <= this.config.maxContextChars * 0.8) break;
          i = end - 1;
        }
      }
      // A whole batch of large recent reads can exceed the whole window on their own.
      // Under hard-limit pressure preserve bounded observations and reversible
      // references, instead of making every explicit continuation fail forever.
      if (measure(active()) > this.config.maxContextChars) {
        for (const i of recent) {
          signal.throwIfAborted();
          const message = history[i];
          if (message.role !== 'tool' || message.content.length <= 4000) continue;
          messages[i] = await externalize(message, true);
          stats.compactedToolResults++;
          stats.recentToolPreviews = (stats.recentToolPreviews ?? 0) + 1;
          if (measure(active()) <= this.config.maxContextChars * 0.8) break;
        }
      }
      signal.throwIfAborted();
      const request = active();
      stats.afterChars = measure(request);
      stats.estimatedTokens = Math.ceil(stats.afterChars / 2);
      return { messages: request, stats };
    } catch {
      signal.throwIfAborted();
      return { messages: original, stats: { ...stats, afterChars: beforeChars, estimatedTokens: Math.ceil(beforeChars / 2), compactedToolResults: 0, recentToolPreviews: undefined, archivedExchanges: undefined, fallback: true } };
    }
  }
}
