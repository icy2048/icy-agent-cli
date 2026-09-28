import { randomUUID } from 'node:crypto';
import path from 'node:path';

export type ExecutionStatus = 'running' | 'awaiting_approval' | 'cancelled' | 'limited' | 'failed' | 'answered' | 'verified' | 'interrupted';
export type RunStatus = ExecutionStatus;
export type TaskStatus = ExecutionStatus;
export type RunOutcome = Exclude<RunStatus, 'running' | 'awaiting_approval'>;
export interface RunBudget { maxModelTurns: number; maxToolCalls: number; maxTokens: number; maxContextChars: number }
export interface RunUsage { tokens: number; estimated: boolean; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
export interface VerificationCheck { id: string; source: 'user'; command: string; cwd: string; createdAt: string }
export interface VerificationRecord {
  id: string; checkId: string; source: 'user'; command: string; cwd: string; ok: boolean; output: string;
  mutationRevision: number; toolCallId?: string; runId?: string; recordedAt: string;
}
export interface TaskState {
  id: string; goal: string; status: TaskStatus; remaining: string[]; completed: string[]; mutationRevision: number;
  verificationChecks: VerificationCheck[]; verificationRecords: VerificationRecord[];
}
export interface RunState {
  id: string; taskId: string; goal: string; status: RunStatus; startedAt: string; endedAt?: string; updatedAt: string;
  checkpoint: string; turns: number; toolCalls: number; usage: RunUsage; budget: RunBudget;
  budgetSource: 'new_task' | 'explicit_resume'; continuationOf?: string; reason?: string; taskSnapshot?: TaskState;
}
export interface SessionExecutionState { task?: TaskState; runs: RunState[] }
export interface RunProgress {
  turns?: number; toolCalls?: number; usage?: Partial<RunUsage>; checkpoint?: string;
  status?: 'running' | 'awaiting_approval';
}
const now = () => new Date().toISOString();
export const isActiveRun = (run: Pick<RunState, 'status'>) => run.status === 'running' || run.status === 'awaiting_approval';
function requireTask(state: SessionExecutionState): TaskState {
  if (!state.task) throw new Error('没有可继续的任务。');
  return state.task;
}
function currentRun(state: SessionExecutionState): RunState {
  const task = requireTask(state), run = state.runs.at(-1);
  if (!run || run.taskId !== task.id) throw new Error('没有当前任务的运行记录。');
  return run;
}
function nonnegative(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数。`);
}
function invalidateVerified(task: TaskState) { if (task.status === 'verified') task.status = 'answered'; }

/** A resumed run is an explicit operation with a new, recorded budget; it never replays tools. */
export function startRun(state: SessionExecutionState, goal: string, budget: RunBudget, options: { resume?: boolean } = {}): RunState {
  if (!goal.trim()) throw new Error('任务目标不能为空。');
  if (state.runs.some(isActiveRun)) throw new Error('已有任务在运行。');
  for (const key of ['maxModelTurns', 'maxToolCalls', 'maxTokens', 'maxContextChars'] as const) {
    const value = budget[key];
    nonnegative(value, key); if (!value) throw new Error(`${key} 必须大于零。`);
  }
  let previous: RunState | undefined;
  if (options.resume) {
    const task = requireTask(state);
    if (task.goal !== goal) throw new Error('继续任务不能改变原目标。');
    previous = state.runs.findLast(run => run.taskId === task.id);
    if (!previous) throw new Error('没有可继续的运行记录。');
    task.status = 'running';
  } else {
    state.task = { id: randomUUID(), goal, status: 'running', remaining: [], completed: [], mutationRevision: 0, verificationChecks: [], verificationRecords: [] };
  }
  const at = now(), task = requireTask(state);
  const run: RunState = {
    id: randomUUID(), taskId: task.id, goal: task.goal, status: 'running', startedAt: at, updatedAt: at,
    checkpoint: 'started', turns: 0, toolCalls: 0, usage: { tokens: 0, estimated: false }, budget: { ...budget },
    budgetSource: options.resume ? 'explicit_resume' : 'new_task', ...(previous ? { continuationOf: previous.id } : {}),
  };
  state.runs.push(run); return run;
}

/** Metrics are cumulative within the current run. Reject decreases instead of silently resetting usage. */
export function updateRun(state: SessionExecutionState, patch: RunProgress): RunState {
  const run = currentRun(state);
  if (!isActiveRun(run)) throw new Error('当前运行已经结束。');
  for (const key of ['turns', 'toolCalls'] as const) if (patch[key] !== undefined) {
    nonnegative(patch[key], key);
    if (patch[key] < run[key]) throw new Error(`${key} 不能倒退。`);
  }
  const usage = { ...run.usage, ...patch.usage, estimated: run.usage.estimated || patch.usage?.estimated === true };
  for (const key of ['tokens', 'inputTokens', 'outputTokens', 'cachedInputTokens'] as const) if (usage[key] !== undefined) {
    nonnegative(usage[key], key);
    if (run.usage[key] !== undefined && usage[key] < run.usage[key]) throw new Error(`${key} 不能倒退。`);
  }
  if (patch.checkpoint !== undefined && !patch.checkpoint.trim()) throw new Error('检查点不能为空。');
  if (patch.turns !== undefined) run.turns = patch.turns;
  if (patch.toolCalls !== undefined) run.toolCalls = patch.toolCalls;
  run.usage = usage;
  if (patch.checkpoint !== undefined) run.checkpoint = patch.checkpoint;
  if (patch.status) { run.status = patch.status; requireTask(state).status = patch.status; }
  run.updatedAt = now(); return run;
}

export function canVerifyTask(state: SessionExecutionState): boolean {
  const task = state.task;
  return Boolean(task && task.remaining.length === 0 && task.verificationChecks.length > 0 && task.verificationChecks.every(check => {
    const record = task.verificationRecords.findLast(item => item.checkId === check.id);
    return record?.ok === true && record.mutationRevision === task.mutationRevision;
  }));
}

export function finishRun(state: SessionExecutionState, status: RunOutcome, reason?: string): RunState {
  const run = currentRun(state);
  if (!isActiveRun(run)) throw new Error('当前运行已经结束。');
  if (status === 'verified' && !canVerifyTask(state)) throw new Error('缺少当前修改版本的用户指定验收证据。');
  const at = now();
  run.status = status; run.endedAt = at; run.updatedAt = at; run.checkpoint = 'stopped';
  run.reason = reason; requireTask(state).status = status; run.taskSnapshot = structuredClone(requireTask(state)); return run;
}

export function markMutation(state: SessionExecutionState): number {
  const task = requireTask(state);
  nonnegative(task.mutationRevision + 1, 'mutationRevision');
  task.mutationRevision++; invalidateVerified(task); return task.mutationRevision;
}

export function setRemaining(state: SessionExecutionState, items: string[]): void {
  if (items.some(item => typeof item !== 'string' || !item.trim())) throw new Error('待办事项不能为空。');
  const task = requireTask(state); task.remaining = [...items];
  if (items.length) invalidateVerified(task);
}

export function completeRemaining(state: SessionExecutionState, index: number): string {
  const task = requireTask(state);
  if (!Number.isSafeInteger(index) || index < 0 || index >= task.remaining.length) throw new Error('无效待办事项编号。');
  const [item] = task.remaining.splice(index, 1); task.completed.push(item); return item;
}

/** Call only from an explicit user action. Models cannot register checks through the standard tools. */
export function registerVerification(state: SessionExecutionState, check: { command: string; cwd: string }): string {
  if (!check.command.trim() || !path.isAbsolute(check.cwd) || check.cwd.includes('\0')) throw new Error('验收需要明确命令和绝对工作目录。');
  const task = requireTask(state), id = randomUUID();
  task.verificationChecks.push({ id, source: 'user', command: check.command, cwd: check.cwd, createdAt: now() }); invalidateVerified(task); return id;
}

export function recordVerification(state: SessionExecutionState, checkId: string, result: { ok: boolean; output: string; mutationRevision: number; toolCallId?: string }): VerificationRecord {
  const task = requireTask(state), check = task.verificationChecks.find(item => item.id === checkId);
  if (!check) throw new Error('验收检查必须由用户明确指定。');
  nonnegative(result.mutationRevision, 'mutationRevision');
  if (result.mutationRevision > task.mutationRevision) throw new Error('验收不能引用未来的修改版本。');
  const run = state.runs.findLast(item => item.taskId === task.id);
  const record: VerificationRecord = {
    id: randomUUID(), checkId, source: 'user', command: check.command, cwd: check.cwd,
    ok: result.ok, output: Array.from(result.output).slice(0, 3000).join(''), mutationRevision: result.mutationRevision,
    ...(result.toolCallId ? { toolCallId: result.toolCallId } : {}), ...(run ? { runId: run.id } : {}), recordedAt: now(),
  };
  task.verificationRecords.push(record);
  if (!canVerifyTask(state)) invalidateVerified(task);
  return record;
}

/** Recovery records interruption only; explicit continuation starts a separate run and budget. */
export function interruptActiveRun(state: SessionExecutionState): number {
  let interrupted = 0;
  for (const run of state.runs) if (isActiveRun(run)) {
    const at = now(); run.status = 'interrupted'; run.endedAt = at; run.updatedAt = at;
    run.checkpoint = 'interrupted'; run.reason = 'process_interrupted'; interrupted++;
    if (state.task?.id === run.taskId) { state.task.status = 'interrupted'; run.taskSnapshot = structuredClone(state.task); }
  }
  return interrupted;
}
