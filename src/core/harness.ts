import type { Config } from '../config/load.js';
import { assembleRequest } from './prompt-schema.js';
import type { Message, PreparedRequest } from './types.js';
import { compactSemantically, type SemanticProviderFactory } from './semantic.js';
import type { SessionStore } from '../sessions/store.js';

export interface PromptStats {
  mode: 'model' | 'local' | 'off'; beforeChars: number; afterChars: number;
  savedChars: number; compactedToolResults: number; inputChanged: boolean; fallback: boolean;
  semantic: 'off' | 'cached' | 'applied' | 'invalid' | 'failed';
  semanticModel?: string; preprocessingTokens: number; preprocessingEstimated: boolean;
}

/** Conservative formatting cleanup, never paraphrases or truncates user requirements. */
export function slimUserPrompt(input: string): string {
  // Literal/code-oriented inputs may depend on every byte, including blank lines.
  if (/```|~~~|`|\r|\t|[{}<>]|^[ ]{2,}\S|原样|逐字|空白|空格|换行|缩进|verbatim|whitespace|indent|exact|literal/im.test(input)) return input;
  return input.replace(/^(?:[ ]*\n)+/, '').replace(/(?:\n[ ]*)+$/, '').replace(/\n(?:[ ]*\n){2,}/g, '\n\n');
}

/** Only protocol data enters the provider; UI metadata stays in the session. */
export function modelMessage(message: Message, compact = false, structured = false): Message {
  if (message.role === 'user') return { role: 'user', content: structured ? JSON.stringify(message.preparedRequest ?? assembleRequest(message.content, message.preparedContent ?? message.content)) : compact ? slimUserPrompt(message.content) : message.content };
  if (message.role === 'tool') return { role: 'tool', id: message.id, content: message.content };
  return { role: 'assistant', content: message.content, calls: message.calls, ...(message.opaque ? { opaque: message.opaque } : {}) };
}

/** Runs once per submitted user turn, before entering the autonomous tool loop. */
export async function preparePrompt(history: Message[], config: Config, store: SessionStore, signal: AbortSignal, semanticFactory?: SemanticProviderFactory): Promise<{ messages: Message[]; stats: PromptStats }> {
  signal.throwIfAborted();
  const original = history.map(m => modelMessage(m));
  const beforeChars = JSON.stringify(original).length;
  const stats: PromptStats = { mode: config.promptCompaction ?? 'model', beforeChars, afterChars: beforeChars, savedChars: 0, compactedToolResults: 0, inputChanged: false, fallback: false, semantic: 'off', preprocessingTokens: 0, preprocessingEstimated: false };
  if (stats.mode === 'off') return { messages: original, stats };
  try {
    const messages = history.map(m => modelMessage(m, true, stats.mode === 'model'));
    const latest = history.findLastIndex(m => m.role === 'user');
    const current = history[latest];
    let preparedRequest: PreparedRequest | undefined;
    if (stats.mode === 'model' && current?.role === 'user') {
      stats.semanticModel = config.compactionModel ?? 'gpt-5.6-luna';
      if (current.preparedRequest) stats.semantic = 'cached';
      else {
        const semantic = await compactSemantically(current.content, config, signal, semanticFactory);
        stats.semantic = semantic.outcome; stats.preprocessingTokens = semantic.tokens; stats.preprocessingEstimated = semantic.estimated;
        stats.fallback = ['failed', 'invalid'].includes(semantic.outcome);
        let originalRef: string | undefined;
        try { originalRef = `icy-output:${await store.output(current.content)}`; }
        catch { stats.fallback = true; stats.semantic = 'failed'; }
        preparedRequest = assembleRequest(current.content, stats.fallback ? current.content : (semantic.text ?? current.content), semantic.keywords, semantic.constraints, originalRef);
        messages[latest].content = JSON.stringify(preparedRequest);
      }
    }
    stats.inputChanged = messages.some((m, i) => m.role === 'user' && m.content !== original[i].content);
    const toolIndexes = history.flatMap((m, i) => m.role === 'tool' ? [i] : []);
    // Keep the latest four observations in full. Preserve every call/result ID and order.
    const eligible = new Set(toolIndexes.slice(0, -4));
    const references = new Map<string, string>();
    for (let i = 0; i < messages.length; i++) {
      signal.throwIfAborted();
      const message = messages[i];
      if (message.role !== 'tool' || !eligible.has(i) || message.content.length <= 4000) continue;
      const raw = message.content;
      let reference = references.get(raw);
      if (!reference) { reference = `icy-output:${await store.output(raw)}`; references.set(raw, reference); }
      // Summary fields are copied verbatim, never inferred from untrusted output.
      let metadata: Record<string, unknown> = {};
      try {
        const result = JSON.parse(raw);
        for (const key of ['ok', 'error', 'changedFile', 'durationMs'] as const) {
          if (typeof result?.[key] === 'boolean' || typeof result?.[key] === 'number' || (typeof result?.[key] === 'string' && result[key].length <= 500)) metadata[key] = result[key];
        }
      } catch { /* Non-JSON results remain retrievable verbatim. */ }
      message.content = JSON.stringify({ ...metadata, compacted: true, content: `Earlier tool output (${raw.length} characters) stored in ${reference}. Use read with this path to retrieve the full original result before relying on its details.`, outputRef: reference });
      stats.compactedToolResults++;
    }
    signal.throwIfAborted();
    stats.afterChars = JSON.stringify(messages).length;
    if (stats.mode !== 'model' && stats.afterChars >= beforeChars) return { messages: original, stats: { ...stats, afterChars: beforeChars, savedChars: 0, compactedToolResults: 0, inputChanged: false } };
    stats.savedChars = Math.max(0, beforeChars - stats.afterChars);
    if (preparedRequest && current?.role === 'user') current.preparedRequest = preparedRequest;
    return { messages, stats };
  } catch (error) {
    signal.throwIfAborted();
    // A preprocessing failure must not prevent the original request from running.
    const fallback = stats.mode === 'model' ? history.map(m => m.role === 'user' ? { role: 'user' as const, content: JSON.stringify(assembleRequest(m.content, m.content)) } : modelMessage(m)) : original;
    return { messages: fallback, stats: { ...stats, semantic: stats.semantic === 'applied' ? 'failed' : stats.semantic, afterChars: JSON.stringify(fallback).length, savedChars: 0, compactedToolResults: 0, inputChanged: false, fallback: true } };
  }
}
