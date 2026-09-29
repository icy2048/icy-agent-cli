import { randomUUID } from 'node:crypto';
import type { AgentEvent, Provider, RunResult, ToolCall, ToolResult } from './types.js';
import type { Config } from '../config/load.js';
import { ToolRegistry } from '../tools/registry.js';
import { SessionStore } from '../sessions/store.js';
import { errorText, redact } from './text.js';
import { PreprocessingInterrupted, type SemanticProviderFactory } from './semantic.js';
import { preparePrompt, modelMessage, reminderMessage } from './harness.js';
import { ContextManager } from './context.js';
import { Budget } from './budget.js';
import { fingerprintWorkspace } from './workspace-fingerprint.js';
import { startRun, updateRun, finishRun, isActiveRun, canVerifyTask, markMutation, registerVerification, recordVerification, setRemaining, completeRemaining, type RunProgress, type RunOutcome } from './run-state.js';

const limitedReasons = new Set(['context_limit', 'token_budget', 'budget_exceeded', 'max_tool_calls', 'max_model_turns']);
export class Agent {
  private busy = false;
  private switchingStore = false;
  private executing?: string;
  private startedCalls = new Set<string>();
  private endedCalls = new Set<string>();
  constructor(public config: Config, public provider: Provider, public tools: ToolRegistry, public store: SessionStore, private emit: (event: AgentEvent) => void = () => {}, private semanticFactory?: SemanticProviderFactory) {
    this.bindProcessEvents(store);
  }
  private bindProcessEvents(owner: SessionStore) {
    owner.getProcessManager(async record => {
      const safe = JSON.parse(JSON.stringify({ type: 'process', record }, (_key, value) => typeof value === 'string' ? redact(value, [this.config.apiKey]) : value)) as AgentEvent;
      await owner.event(safe);
      if (this.store === owner) this.emit(safe);
    }, record => {
      if (owner.data.task && record.status !== 'spawn_error') markMutation(owner.data);
    });
  }
  async configure(config: Config, provider: Provider, persist: () => Promise<void>) {
    if (this.busy) throw new Error('请先结束当前任务。');
    this.busy = true; this.switchingStore = true;
    try {
      const next = await SessionStore.create(config.home, { cwd: config.cwd, model: config.model, provider: config.provider, baseUrl: config.baseUrl }, [config.apiKey]);
      try { await persist(); await this.store.close(); } catch (e) { await next.close(); throw e; }
      this.tools = this.tools.forSession(config, next);
      this.config = config; this.provider = provider; this.store = next; this.bindProcessEvents(next);
    } finally { this.switchingStore = false; this.busy = false; }
  }
  async newConversation() { await this.configure(this.config, this.provider, async () => {}); }
  async resumeSession(id: string): Promise<{ recovered: number; unknownProcesses: number }> {
    if (this.busy) throw new Error('请先结束当前任务。');
    if (id === this.store.data.id) return { recovered: 0, unknownProcesses: 0 };
    this.busy = true; this.switchingStore = true;
    let next: SessionStore | undefined;
    try {
      const restored = await SessionStore.resume(this.config.home, id, [this.config.apiKey]); next = restored.store;
      if (next.data.cwd !== this.config.cwd || next.data.provider !== this.config.provider || next.data.model !== this.config.model || next.data.baseUrl !== this.config.baseUrl) throw new Error('恢复需要相同工作区、provider、model 和 baseUrl；请从对应工作区启动并选择原模型。');
      await this.store.close();
      this.store = next; this.tools = this.tools.forSession(this.config, next); this.bindProcessEvents(next); next = undefined;
      return { recovered: restored.recovered, unknownProcesses: restored.unknownProcesses };
    } finally { await next?.close(); this.switchingStore = false; this.busy = false; }
  }
  setListener(emit: (event: AgentEvent) => void) { this.emit = emit; }
  async killProcess(reference: string) {
    if (this.switchingStore) throw new Error('正在切换会话。');
    const id = reference.startsWith('icy-process:') ? reference.slice('icy-process:'.length) : reference;
    if (!id || (id.length < 8 && !this.store.data.processes.some(record => record.id === id))) throw new Error('process_not_found');
    const matches = this.store.data.processes.filter(record => record.id === id || record.id.startsWith(id));
    if (!matches.length) throw new Error('process_not_found');
    if (matches.length > 1) throw new Error('process_ambiguous');
    return this.store.getProcessManager().kill(matches[0].id, 'user_kill');
  }
  private async eventFor(owner: SessionStore, event: AgentEvent) {
    const safe = JSON.parse(JSON.stringify(event, (_k, v) => typeof v === 'string' ? redact(v, [this.config.apiKey]) : v)) as AgentEvent;
    await owner.event(safe); if (this.store === owner) this.emit(safe);
  }
  private async event(event: AgentEvent) { await this.eventFor(this.store, event); }
  private async progress(patch: RunProgress) {
    updateRun(this.store.data, patch);
    await this.store.save();
    await this.event({ type: 'task', task: this.store.data.task, run: this.store.data.runs.at(-1) });
  }
  private observeApproval() {
    this.tools.setApprovalListener(async waiting => {
      await this.progress({ status: waiting ? 'awaiting_approval' : 'running', checkpoint: waiting ? 'awaiting_approval' : 'approval_resolved' });
    });
  }
  private runBudget() {
    const { maxModelTurns, maxToolCalls, maxTokens, maxContextChars } = this.config;
    return { maxModelTurns, maxToolCalls, maxTokens, maxContextChars };
  }
  private async executeTool(call: ToolCall, signal: AbortSignal, verification = false): Promise<ToolResult> {
    const fingerprintOptions = { ignorePaths: [this.store.dir], signal };
    const before = verification ? await fingerprintWorkspace(this.config.cwd, fingerprintOptions) : undefined;
    // Invalidate evidence before any possibly mutating operation, including uncertain failures.
    let detached = false;
    if (call.name === 'bash') { try { detached = JSON.parse(call.arguments).detach === true; } catch { /* parseToolInput reports malformed arguments later */ } }
    if (!verification && ['write', 'edit'].includes(call.name) || !verification && call.name === 'bash' && !detached || !verification && detached && this.store.data.task?.status === 'verified') markMutation(this.store.data);
    this.store.data.running = call.id;
    await this.progress({ toolCalls: (this.store.data.runs.at(-1)?.toolCalls ?? 0) + 1, checkpoint: `before_tool:${call.id}` });
    this.startedCalls.add(call.id); await this.event({ type: 'tool_start', call });
    this.executing = call.id;
    let result: ToolResult;
    try { result = await this.tools.execute(call, signal); }
    catch (error) {
      if (verification) markMutation(this.store.data);
      throw error;
    }
    this.executing = undefined;
    this.store.data.messages.push({ role: 'tool', id: call.id, content: JSON.stringify(result) });
    this.store.data.running = undefined;
    if (verification) {
      // Keep a known tool result even when cancellation interrupts the post-check.
      // A changed or unobservable workspace makes all earlier evidence stale.
      const after = signal.aborted ? undefined : await fingerprintWorkspace(this.config.cwd, fingerprintOptions).catch(() => undefined);
      if (before === undefined || after === undefined || before !== after) markMutation(this.store.data);
    }
    await this.progress({ checkpoint: `after_tool:${call.id}` });
    await this.event({ type: 'tool_end', call, result }); this.endedCalls.add(call.id);
    return result;
  }
  private async closePending(pending: ToolCall[], reason: string) {
    const results = new Map(this.store.data.messages.filter(m => m.role === 'tool').map(m => [m.id, m.content]));
    const events: AgentEvent[] = [];
    for (const call of pending) {
      if (results.has(call.id)) {
        // Execution may have succeeded before a checkpoint write failed. Preserve
        // that known result and finish the live event; never relabel it unknown.
        if (!this.endedCalls.has(call.id)) {
          if (!this.startedCalls.has(call.id)) events.push({ type: 'tool_start', call });
          events.push({ type: 'tool_end', call, result: JSON.parse(results.get(call.id)!) as ToolResult });
        }
        continue;
      }
      const unknown = this.executing === call.id;
      const result: ToolResult = { ok: false, error: unknown ? 'interrupted_unknown' : 'not_executed', content: unknown ? '执行结果未知。先检查实际状态，不要自动重放有副作用的操作。' : reason };
      this.store.data.messages.push({ role: 'tool', id: call.id, content: JSON.stringify(result) });
      if (!this.startedCalls.has(call.id)) events.push({ type: 'tool_start', call });
      events.push({ type: 'tool_end', call, result });
    }
    this.executing = undefined; this.store.data.running = undefined;
    // Close the entire batch before saving, so a cancellation always preserves valid pairs.
    await this.store.save();
    for (const event of events) {
      await this.event(event);
      if (event.type === 'tool_end') this.endedCalls.add(event.call.id);
    }
  }
  private async finish(reason: string, ok: boolean, pending: ToolCall[], text?: string): Promise<RunResult> {
    await this.closePending(pending, reason);
    const run = this.store.data.runs.at(-1);
    if (run && isActiveRun(run)) {
      const status: RunOutcome = ok ? canVerifyTask(this.store.data, this.store.data.processes) ? 'verified' : 'answered' : reason === 'cancelled' ? 'cancelled' : limitedReasons.has(reason) ? 'limited' : 'failed';
      finishRun(this.store.data, status, reason);
    }
    await this.store.save();
    await this.event({ type: 'task', task: this.store.data.task, run: this.store.data.runs.at(-1) });
    await this.event({ type: 'done', reason, ok });
    return { ok, reason, text };
  }
  async run(input: string, signal: AbortSignal, options: { resume?: boolean } = {}): Promise<RunResult> {
    if (this.busy) throw new Error('已有任务在运行。');
    this.busy = true; this.startedCalls.clear(); this.endedCalls.clear();
    let runStarted = false;
    let repeated = 0, previousError = '', pending: ToolCall[] = [];
    let unaccountedInput = 0, partialText = '', partialReasoning = '';
    const history = this.store.data.messages;
    const budget = new Budget(this.config.maxTokens);
    const accounting = async () => {
      const { tokens, estimated, usage } = budget.snapshot();
      await this.progress({ usage: { tokens, estimated, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens } });
      await this.event({ type: 'usage', tokens, estimated, usage });
    };
    try {
      startRun(this.store.data, redact(input, [this.config.apiKey]), this.runBudget(), options);
      runStarted = true;
      this.observeApproval();
      signal.throwIfAborted();
      if (!options.resume) {
        history.push({ role: 'user', content: redact(input, [this.config.apiKey]) });
        await this.store.save(); await this.event({ type: 'user', text: input });
      }
      await this.progress({ checkpoint: options.resume ? 'explicit_continuation' : 'preprocessing' });
      await this.event({ type: 'harness_start' });
      const prepared = await preparePrompt(history, this.config, this.store, signal, this.semanticFactory);
      const modelHistory = prepared.messages, context = new ContextManager(this.config, this.store);
      budget.recordPreprocessing(prepared.stats.preprocessingTokens, prepared.stats.preprocessingEstimated, prepared.stats.preprocessingUsage);
      await this.store.save(); await this.event({ type: 'harness_end', stats: prepared.stats });
      if (budget.snapshot().tokens) await accounting();
      for (let turn = 1; turn <= this.config.maxModelTurns; turn++) {
        signal.throwIfAborted();
        const reminder = modelHistory.slice(modelHistory.findLastIndex(m => m.role === 'user') + 1).some(m => m.role === 'tool') ? reminderMessage(history) : undefined;
        const taskReminder = options.resume ? { role: 'user' as const, content: `[icy 任务续跑] 用户明确要求继续原任务，本次有新的运行预算。原始目标：\n${this.store.data.task!.goal}\n待办：${JSON.stringify(this.store.data.task!.remaining)}\n沿用已保存的结果，优先处理最近未完成的修改或失败检查；不必重读全部历史引用。未知写操作先读取目标文件核对现状，不能盲目重放。` } : reminder;
        const definitions = this.tools.definitions();
        // Sessions retain both normalized calls and protocol opaque data. Count
        // the actual provider request, where only one representation is sent.
        const measure = (messages: typeof modelHistory) => this.provider.estimateInputChars?.(messages, definitions) ?? JSON.stringify({ messages, tools: definitions }).length;
        const built = await context.build(modelHistory, signal, taskReminder, measure), request = built.messages;
        await this.event({ type: 'context', stats: built.stats });
        if (built.stats.afterChars > this.config.maxContextChars) return await this.finish('context_limit', false, pending);
        const stop = budget.stopReason();
        if (stop) return await this.finish(stop, false, pending);
        const inputChars = built.stats.afterChars;
        const requestBudget = budget.requestOptions(inputChars);
        if (!requestBudget) return await this.finish('token_budget', false, pending);
        await this.progress({ turns: turn, checkpoint: `before_model:${turn}` });
        await this.event({ type: 'turn', turn, ...(reminder ? { reminderChars: reminder.content.length } : {}) });
        unaccountedInput = inputChars; partialText = ''; partialReasoning = '';
        const completion = await this.provider.complete(request, definitions, signal,
          text => { partialText += text; this.emit({ type: 'delta', text: redact(text, [this.config.apiKey]) }); },
          text => { partialReasoning += text; this.emit({ type: 'reasoning_delta', text: redact(text, [this.config.apiKey]) }); }, requestBudget);
        budget.record(completion, inputChars); unaccountedInput = 0; await accounting();
        await this.event({ type: 'reasoning', text: completion.reasoning || '' });
        signal.throwIfAborted();
        if (completion.incomplete) return await this.finish(`incomplete: ${completion.incomplete}`, false, pending);
        const ids = completion.calls.map(c => c.id), previous = new Set(history.filter(m => m.role === 'assistant').flatMap(m => m.calls.map(c => c.id)));
        if (new Set(ids).size !== ids.length || ids.some(id => !id || previous.has(id))) return await this.finish('invalid_call_ids', false, pending);
        history.push({ role: 'assistant', content: completion.text, calls: completion.calls, opaque: completion.opaque, reasoning: completion.reasoning });
        modelHistory.push(modelMessage(history.at(-1)!)); pending = [...completion.calls]; await this.store.save();
        if (completion.text) await this.event({ type: 'assistant', text: completion.text });
        if (budget.stopReason() === 'budget_exceeded') return await this.finish('budget_exceeded', false, pending, completion.text);
        if (!pending.length) return await this.finish(completion.text ? 'completed' : 'empty_response', Boolean(completion.text), pending, completion.text);
        while (pending.length) {
          signal.throwIfAborted();
          if ((this.store.data.runs.at(-1)?.toolCalls ?? 0) >= this.config.maxToolCalls) return await this.finish('max_tool_calls', false, pending);
          const stop = budget.stopReason(); if (stop) return await this.finish(stop, false, pending);
          const call = pending[0], result = await this.executeTool(call, signal);
          pending.shift(); modelHistory.push(modelMessage(history.at(-1)!));
          if (!result.ok) {
            const key = call.name + call.arguments + result.error + result.content;
            repeated = key === previousError ? repeated + 1 : 1; previousError = key;
            if (repeated >= 3) return await this.finish('repeated_tool_failure', false, pending);
          } else { repeated = 0; previousError = ''; }
          if (!result.ok && result.content === 'approval_required') return await this.finish('approval_required', false, pending);
        }
      }
      return await this.finish('max_model_turns', false, pending);
    } catch (error) {
      if (!runStarted) throw error;
      if (error instanceof PreprocessingInterrupted) {
        budget.recordPreprocessing(error.tokens, error.estimated, error.usage);
        await accounting();
      }
      if (unaccountedInput) {
        budget.record({ text: partialText, reasoning: partialReasoning, calls: [] }, unaccountedInput);
        await accounting();
      }
      return await this.finish(signal.aborted ? 'cancelled' : redact(errorText(error), [this.config.apiKey]), false, pending);
    } finally { this.tools.setApprovalListener(undefined); this.busy = false; }
  }
  async continue(signal: AbortSignal): Promise<RunResult> {
    const task = this.store.data.task;
    if (!task) throw new Error('旧会话没有任务检查点。请先提交目标，或根据历史开始新任务。');
    return this.run(task.goal, signal, { resume: true });
  }
  async verify(command: string, signal: AbortSignal): Promise<RunResult> {
    if (this.busy) throw new Error('已有任务在运行。');
    const task = this.store.data.task;
    if (!task) throw new Error('请先执行一个任务，再指定验收命令。');
    if (!command.trim()) throw new Error('请提供验收命令：/verify <命令>');
    const live = this.store.data.processes.find(record => record.status === 'running' || record.status === 'unknown' && record.pidAlive === true);
    if (live) throw new Error(`有后台进程仍在运行（icy-process:${live.id.slice(0, 8)}），验收结果不可靠。先用 /ps 查看，/kill 终止或等待结束后再 /verify。`);
    this.busy = true; this.startedCalls.clear(); this.endedCalls.clear();
    const call: ToolCall = { id: randomUUID(), name: 'bash', arguments: JSON.stringify({ command, cwd: null, timeoutMs: null, detach: false, kill: null }) };
    let pending: ToolCall[] = [];
    let runStarted = false;
    try {
      startRun(this.store.data, task.goal, this.runBudget(), { resume: true });
      runStarted = true;
      const checkId = task.verificationChecks.find(check => check.command === command && check.cwd === this.config.cwd)?.id ?? registerVerification(this.store.data, { command, cwd: this.config.cwd });
      this.observeApproval(); signal.throwIfAborted();
      this.store.data.messages.push({ role: 'user', content: `用户指定验收命令：${command}` }, { role: 'assistant', content: '', calls: [call] }); pending = [call];
      await this.store.save(); await this.event({ type: 'user', text: `用户指定验收命令：${command}` });
      const result = await this.executeTool(call, signal, true); pending = [];
      recordVerification(this.store.data, checkId, { ok: result.ok && !signal.aborted, output: result.content, mutationRevision: task.mutationRevision, toolCallId: call.id });
      return await this.finish(signal.aborted ? 'cancelled' : result.ok ? 'verification_passed' : result.content === 'approval_required' ? 'approval_required' : 'verification_failed', result.ok && !signal.aborted, pending);
    } catch (error) {
      if (!runStarted) throw error;
      return await this.finish(signal.aborted ? 'cancelled' : redact(errorText(error), [this.config.apiKey]), false, pending);
    } finally { this.tools.setApprovalListener(undefined); this.busy = false; }
  }
  async addTodo(text: string) {
    if (this.busy) throw new Error('请先结束当前任务。');
    setRemaining(this.store.data, [...(this.store.data.task?.remaining ?? []), text]);
    await this.store.save(); await this.event({ type: 'task', task: this.store.data.task, run: this.store.data.runs.at(-1) });
  }
  async completeTodo(index: number) {
    if (this.busy) throw new Error('请先结束当前任务。');
    completeRemaining(this.store.data, index);
    await this.store.save(); await this.event({ type: 'task', task: this.store.data.task, run: this.store.data.runs.at(-1) });
  }
  async clear() {
    if (this.busy) throw new Error('请先取消任务。');
    this.store.data.messages = []; this.store.data.task = undefined; this.store.data.runs = []; this.store.data.running = undefined;
    await this.store.save();
  }
}
