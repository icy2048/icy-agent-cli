import type { AgentEvent, Message, Provider, RunResult, ToolCall } from './types.js';
import type { Config } from '../config/load.js';
import { ToolRegistry } from '../tools/registry.js';
import { SessionStore } from '../sessions/store.js';
import { errorText, redact } from './text.js';
import type { SemanticProviderFactory } from './semantic.js';
import { preparePrompt, modelMessage, reminderMessage } from './harness.js';

export class Agent {
  private busy = false;
  constructor(public config: Config, public provider: Provider, public tools: ToolRegistry, public store: SessionStore, private emit: (event: AgentEvent) => void = () => {}, private semanticFactory?: SemanticProviderFactory) {}
  async configure(config: Config, provider: Provider, persist: () => Promise<void>) {
    if (this.busy) throw new Error('请先结束当前任务。');
    this.busy = true;
    try {
      const next = await SessionStore.create(config.home, { cwd: config.cwd, model: config.model, provider: config.provider, baseUrl: config.baseUrl }, [config.apiKey]);
      try { await persist(); } catch (e) { await next.close(); throw e; }
      await this.store.close();
      this.tools = this.tools.forSession(config, next);
      this.config = config; this.provider = provider; this.store = next;
    } finally { this.busy = false; }
  }
  async newConversation() { await this.configure(this.config, this.provider, async () => {}); }
  setListener(emit: (event: AgentEvent) => void) { this.emit = emit; }
  private async event(event: AgentEvent) {
    const safe = JSON.parse(JSON.stringify(event, (_k, v) => typeof v === 'string' ? redact(v, [this.config.apiKey]) : v)) as AgentEvent;
    this.emit(safe); await this.store.event(safe);
  }
  async run(input: string, signal: AbortSignal): Promise<RunResult> {
    if (this.busy) throw new Error('已有任务在运行。');
    this.busy = true;
    let count = 0, spent = 0, estimated = false, repeated = 0, previousError = '', pending: ToolCall[] = [];
    const history = this.store.data.messages;
    const finish = async (reason: string, ok: boolean, text?: string): Promise<RunResult> => {
      // Close the rest of the batch on cancellation or limits so the next user turn has valid call/result pairs.
      for (const call of pending) history.push({ role: 'tool', id: call.id, content: JSON.stringify({ ok: false, error: 'not_executed', content: reason }) });
      pending = []; this.store.data.running = undefined;
      await this.store.save(); await this.event({ type: 'done', reason, ok }); return { ok, reason, text };
    };
    try {
      signal.throwIfAborted(); history.push({ role: 'user', content: redact(input, [this.config.apiKey]) });
      await this.store.save(); await this.event({ type: 'user', text: input });
      await this.event({ type: 'harness_start' });
      const prepared = await preparePrompt(history, this.config, this.store, signal, this.semanticFactory);
      const modelHistory = prepared.messages;
      spent += prepared.stats.preprocessingTokens; estimated ||= prepared.stats.preprocessingEstimated;
      await this.store.save();
      await this.event({ type: 'harness_end', stats: prepared.stats });
      if (spent) await this.event({ type: 'usage', tokens: spent, estimated });
      for (let turn = 1; turn <= this.config.maxModelTurns; turn++) {
        signal.throwIfAborted();
        const reminder = modelHistory.slice(modelHistory.findLastIndex(m => m.role === 'user') + 1).some(m => m.role === 'tool') ? reminderMessage(history) : undefined;
        const request = reminder ? [...modelHistory, reminder] : modelHistory;
        if (JSON.stringify(request).length > this.config.maxContextChars) return await finish('context_limit', false);
        if (spent >= this.config.maxTokens) return await finish('token_budget', false);
        await this.event({ type: 'turn', turn, ...(reminder ? { reminderChars: reminder.content.length } : {}) });
        const completion = await this.provider.complete(request, this.tools.definitions(), signal,
          text => this.emit({ type: 'delta', text: redact(text, [this.config.apiKey]) }),
          text => this.emit({ type: 'reasoning_delta', text: redact(text, [this.config.apiKey]) }));
        await this.event({ type: 'reasoning', text: completion.reasoning || '' });
        spent += completion.tokens ?? Math.ceil((JSON.stringify(request).length + completion.text.length + JSON.stringify(completion.calls).length) / 2);
        estimated ||= completion.tokens === undefined;
        await this.event({ type: 'usage', tokens: spent, estimated });
        signal.throwIfAborted();
        // A length-limited/failed response is not safe to execute.
        if (completion.incomplete) return await finish(`incomplete: ${completion.incomplete}`, false);
        const ids = completion.calls.map(c => c.id);
        const previous = new Set(history.filter(m => m.role === 'assistant').flatMap(m => m.calls.map(c => c.id)));
        if (new Set(ids).size !== ids.length || ids.some(id => !id || previous.has(id))) return await finish('invalid_call_ids', false);
        history.push({ role: 'assistant', content: completion.text, calls: completion.calls, opaque: completion.opaque, reasoning: completion.reasoning });
        modelHistory.push(modelMessage(history.at(-1)!));
        pending = [...completion.calls]; await this.store.save();
        if (completion.text) await this.event({ type: 'assistant', text: completion.text });
        if (!pending.length) return await finish(completion.text ? 'completed' : 'empty_response', Boolean(completion.text), completion.text);
        while (pending.length) {
          signal.throwIfAborted();
          if (count >= this.config.maxToolCalls) return await finish('max_tool_calls', false);
          if (spent >= this.config.maxTokens) return await finish('token_budget', false);
          const call = pending[0]; count++;
          this.store.data.running = call.id; await this.store.save(); await this.event({ type: 'tool_start', call });
          const result = await this.tools.execute(call, signal);
          history.push({ role: 'tool', id: call.id, content: JSON.stringify(result) }); pending.shift();
          modelHistory.push(modelMessage(history.at(-1)!));
          this.store.data.running = undefined; await this.store.save(); await this.event({ type: 'tool_end', call, result });
          if (!result.ok) {
            const key = call.name + call.arguments + result.error + result.content;
            repeated = key === previousError ? repeated + 1 : 1; previousError = key;
            if (repeated >= 3) return await finish('repeated_tool_failure', false);
          } else { repeated = 0; previousError = ''; }
          // Noninteractive callers cannot grant permission. Return an actionable exit code, not a misleading success.
          if (!result.ok && result.content === 'approval_required') return await finish('approval_required', false);
        }
      }
      return await finish('max_model_turns', false);
    } catch (e) {
      return await finish(signal.aborted ? 'cancelled' : redact(errorText(e), [this.config.apiKey]), false);
    } finally { this.busy = false; }
  }
  async clear() { if (this.busy) throw new Error('请先取消任务。'); this.store.data.messages = []; await this.store.save(); }
}
