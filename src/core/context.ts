import type { Config } from '../config/load.js';
import type { SessionStore } from '../sessions/store.js';
import type { Message } from './types.js';
import { outputPreview } from '../tools/output.js';

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
      // Keep one blocking observation visible across later file/log reads. A
      // successful retry of the exact command in the same cwd resolves it;
      // another command's success does not. This is literal outcome tracking,
      // not a summary or a claim that the overall task has passed.
      const calls = new Map(history.filter(message => message.role === 'assistant').flatMap(message => message.calls).map(call => [call.id, call]));
      let failure: { index: number; command: string } | undefined;
      const commandResults = new Map<string, number>();
      for (const index of toolIndexes) {
        const message = history[index] as Extract<Message, { role: 'tool' }>;
        const call = calls.get(message.id);
        if (call?.name !== 'bash') continue;
        try {
          const args = JSON.parse(call.arguments), result = JSON.parse(message.content);
          if (typeof args?.command !== 'string') continue;
          const command = JSON.stringify([args.command, args.cwd ?? null]);
          if (typeof result?.ok === 'boolean') {
            commandResults.delete(command);
            commandResults.set(command, index);
          }
          if (result?.ok === false) failure = { index, command };
          else if (result?.ok === true && failure?.command === command) failure = undefined;
        } catch { /* Malformed legacy entries cannot establish or resolve a failure. */ }
      }
      // Retain the latest outcomes of three distinct commands as well: log
      // reads must not erase successful checks and cause needless reruns.
      const protectedResults = new Set([...commandResults.values()].slice(-3));
      if (failure) protectedResults.add(failure.index);
      const eligible = new Set(toolIndexes.slice(0, -4).filter(index => index < latestAssistant && !protectedResults.has(index)));
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
        const excerpt = preview ? `Recent tool output preview:\n${outputPreview(body, metadata.ok === false)}\n` : '';
        return { ...message, content: JSON.stringify({ ...metadata, compacted: true, content: `${excerpt}Original tool output (${raw.length} characters) stored in ${reference}. Use read to retrieve the original before relying on its details.`, outputRef: reference }) };
      };
      const messages: Message[] = [...history];
      for (let i = 0; i < history.length; i++) {
        signal.throwIfAborted();
        const message = history[i];
        if (message.role !== 'tool' || !eligible.has(i) || message.content.length <= 4000) continue;
        messages[i] = await externalize(message);
        stats.compactedToolResults++;
        if (measure(appendReminder(messages)) <= this.config.maxContextChars * 0.8) break;
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
      // (including their whole assistant batches), recent command outcomes and
      // the current failed command remain in the active view.
      const archived = new Set<number>();
      const active = () => appendReminder(messages.filter((_, i) => !archived.has(i)));
      if (measure(active()) > this.config.maxContextChars) {
        const protectedFrom = toolIndexes.at(-4) ?? toolIndexes[0] ?? history.length;
        for (let i = 0; i < history.length; i++) {
          signal.throwIfAborted();
          const message = history[i];
          if (message.role !== 'assistant' || i === latestAssistant) continue;
          const completeEnd = (start: number) => {
            const assistant = history[start];
            if (assistant?.role !== 'assistant' || start === latestAssistant) return start;
            const ids = new Set(assistant.calls.map(call => call.id));
            if (ids.size !== assistant.calls.length) return start;
            let end = start + 1;
            const observed = new Set<string>();
            while (end < history.length && history[end].role === 'tool') {
              const result = history[end] as Extract<Message, { role: 'tool' }>;
              if (protectedResults.has(end)) return start;
              if (!ids.has(result.id) || observed.has(result.id)) return start;
              observed.add(result.id); end++;
            }
            return observed.size === ids.size && end <= protectedFrom ? end : start;
          };
          let end = completeEnd(i), exchangeCount = 1;
          if (end === i) continue;
          // A reference per old read still grows without bound. Group adjacent
          // complete exchanges, but never cross a user message or a recent batch.
          while (end < history.length) {
            const next = completeEnd(end);
            if (next === end) break;
            end = next; exchangeCount++;
          }
          const exchange = history.slice(i, end), raw = JSON.stringify(exchange);
          const archivedCalls = new Map(exchange.filter(entry => entry.role === 'assistant').flatMap(entry => entry.calls).map(call => [call.id, call]));
          let reference = this.references.get(raw);
          if (!reference) { reference = `icy-output:${await this.store.output(raw)}`; this.references.set(raw, reference); }
          const outcomes = exchange.filter((entry): entry is Extract<Message, { role: 'tool' }> => entry.role === 'tool').map(entry => {
            const call = archivedCalls.get(entry.id)!;
            const request: Record<string, unknown> = {};
            try {
              const args = JSON.parse(call.arguments);
              for (const key of ['path', 'offset', 'limit', 'command', 'cwd', 'timeoutMs', 'detach', 'kill']) {
                const value = args?.[key];
                if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' && value.length <= 500) request[key] = value;
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
          // Mechanical index only: keep every unknown result, the latest
          // mutation per file, the last failed command, and three latest actions.
          const selected = new Set(outcomes.slice(-3));
          const mutations = new Map<string, (typeof outcomes)[number]>();
          let lastFailedCommand: (typeof outcomes)[number] | undefined;
          for (const outcome of outcomes) {
            if (outcome.error === 'interrupted_unknown') selected.add(outcome);
            if (typeof outcome.changedFile === 'string') mutations.set(outcome.changedFile, outcome);
            if (outcome.tool === 'bash' && outcome.ok === false) lastFailedCommand = outcome;
          }
          for (const mutation of mutations.values()) selected.add(mutation);
          if (lastFailedCommand) selected.add(lastFailedCommand);
          messages[i] = { role: 'assistant', calls: [], content: JSON.stringify({ kind: 'icy.archived-exchange', outputRef: reference, exchangeCount, toolResultCount: outcomes.length, outcomes: outcomes.filter(outcome => selected.has(outcome)) }) };
          for (let index = i + 1; index < end; index++) archived.add(index);
          stats.archivedExchanges = (stats.archivedExchanges ?? 0) + exchangeCount;
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
