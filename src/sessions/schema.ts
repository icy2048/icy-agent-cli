import path from 'node:path';
import { z } from 'zod';
import type { SessionData } from './store.js';
import { canVerifyTask, isActiveRun, type TaskState } from '../core/run-state.js';
import type { ProcessRecord } from '../core/types.js';

export const sessionIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const callId = z.string().min(1);
const toolCallSchema = z.object({ id: callId, name: z.string().min(1), arguments: z.string() }).passthrough();
const preparedRequestSchema = z.object({
  schema: z.literal('icy.user-request.v2'), task: z.string(),
  keywords: z.array(z.string()), constraints: z.array(z.string()), original_ref: z.string().optional(),
}).passthrough();
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string(), preparedContent: z.string().optional(), preparedRequest: preparedRequestSchema.optional() }).passthrough(),
  z.object({ role: z.literal('assistant'), content: z.string(), calls: z.array(toolCallSchema), opaque: z.array(z.unknown()).optional(), reasoning: z.string().optional() }).passthrough(),
  z.object({ role: z.literal('tool'), id: callId, content: z.string() }).passthrough(),
]);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const status = z.enum(['running', 'awaiting_approval', 'cancelled', 'limited', 'failed', 'answered', 'verified', 'interrupted']);
const absolutePath = z.string().refine(value => path.isAbsolute(value) && !value.includes('\0'), 'Expected an absolute path');
const processRecordSchema = z.object({
  id: z.string().uuid(), toolCallId: callId, command: z.string().min(1), cwd: absolutePath, pid: z.number().int().positive().optional(),
  startedAt: timestamp, endedAt: timestamp.optional(), timeoutMs: z.number().int().min(1).max(1_800_000),
  status: z.enum(['running', 'exited', 'killed', 'timeout', 'output_limit', 'spawn_error', 'unknown']),
  exitCode: z.number().int().nullable().optional(), signal: z.string().optional(), bytes: count,
  truncated: z.boolean().optional(), reason: z.string().optional(), pidAlive: z.boolean().optional(),
}).passthrough();
const verificationCheckSchema = z.object({
  id: callId, source: z.literal('user'), command: z.string().min(1), cwd: absolutePath, createdAt: timestamp,
}).passthrough();
const verificationRecordSchema = z.object({
  id: callId, checkId: callId, source: z.literal('user'), command: z.string().min(1), cwd: absolutePath,
  ok: z.boolean(), output: z.string().refine(value => Array.from(value).length <= 3000, 'Verification output exceeds 3000 characters'),
  mutationRevision: count, toolCallId: callId.optional(), runId: callId.optional(), recordedAt: timestamp,
}).passthrough();
const taskSchema = z.object({
  id: callId, goal: z.string().min(1), status, remaining: z.array(z.string().min(1)), completed: z.array(z.string().min(1)), mutationRevision: count,
  verificationChecks: z.array(verificationCheckSchema), verificationRecords: z.array(verificationRecordSchema),
}).passthrough();
const runSchema = z.object({
  id: callId, taskId: callId, goal: z.string().min(1), status, startedAt: timestamp, endedAt: timestamp.optional(), updatedAt: timestamp,
  checkpoint: z.string().min(1), turns: count, toolCalls: count,
  usage: z.object({ tokens: count, estimated: z.boolean(), inputTokens: count.optional(), outputTokens: count.optional(), cachedInputTokens: count.optional() }).passthrough(),
  budget: z.object({ maxModelTurns: count.positive(), maxToolCalls: count.positive(), maxTokens: count.positive(), maxContextChars: count.positive() }).passthrough(),
  budgetSource: z.enum(['new_task', 'explicit_resume']), continuationOf: callId.optional(), reason: z.string().optional(), taskSnapshot: taskSchema.optional(),
}).passthrough();
const sessionMetadata = {
  id: sessionIdSchema,
  cwd: z.string().refine(value => path.isAbsolute(value) && !value.includes('\0'), 'Expected an absolute workspace path'),
  provider: z.enum(['chat-completions', 'responses']), model: z.string(), baseUrl: z.string().url(),
  messages: z.array(messageSchema), running: callId.optional(), updatedAt: timestamp,
};
const sessionSchema = z.discriminatedUnion('version', [
  z.object({ ...sessionMetadata, version: z.literal(1) }).passthrough(),
  z.object({ ...sessionMetadata, version: z.literal(2), task: taskSchema.optional(), runs: z.array(runSchema), processes: z.array(processRecordSchema).default([]) }).passthrough(),
]);

function invalid(location: string, reason: string): never {
  throw new Error(`不支持或损坏的会话（${location}: ${reason}）。`);
}

function validateTask(task: TaskState, location: string, runs: Map<string, SessionData['runs'][number]>, processes: ProcessRecord[] = []) {
  const checks = new Map<string, TaskState['verificationChecks'][number]>(), records = new Set<string>();
  for (const [index, check] of task.verificationChecks.entries()) {
    if (checks.has(check.id)) invalid(`${location}.verificationChecks.${index}.id`, 'duplicate check ID');
    checks.set(check.id, check);
  }
  for (const [index, record] of task.verificationRecords.entries()) {
    const at = `${location}.verificationRecords.${index}`, check = checks.get(record.checkId);
    if (records.has(record.id)) invalid(`${at}.id`, 'duplicate verification record ID');
    records.add(record.id);
    if (!check || record.command !== check.command || record.cwd !== check.cwd) invalid(`${at}.checkId`, 'record does not match a user-specified check');
    if (record.mutationRevision > task.mutationRevision) invalid(`${at}.mutationRevision`, 'record refers to a future mutation');
    if (record.runId && runs.get(record.runId)?.taskId !== task.id) invalid(`${at}.runId`, 'record must belong to a run of this task');
  }
  if (task.status === 'verified' && !canVerifyTask({ task, runs: [], processes }, processes)) invalid(`${location}.status`, 'verified status requires current user-specified evidence and no remaining items');
}

/** Validate persisted data and migrate v1 history without inventing tasks or verification evidence. */
export function parseSessionData(value: unknown, expectedId: string): SessionData {
  const parsed = sessionSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    invalid(issue.path.map(String).join('.') || 'session', issue.message);
  }
  const data: SessionData = parsed.data.version === 1
    ? { ...parsed.data, version: 2, task: undefined, runs: [], processes: [] }
    : parsed.data;
  if (data.id !== expectedId) invalid('id', 'does not match the requested session');
  const calls = new Set<string>(), results = new Set<string>(), pending = new Set<string>();
  for (const [index, message] of data.messages.entries()) {
    const location = `messages.${index}`;
    if (message.role === 'tool') {
      if (!calls.has(message.id)) invalid(`${location}.id`, 'orphan tool result');
      if (results.has(message.id)) invalid(`${location}.id`, 'duplicate tool result');
      results.add(message.id); pending.delete(message.id);
      continue;
    }
    // An unfinished batch is valid only at the end of a snapshot. It will be closed on resume.
    if (pending.size) invalid(location, 'message follows unfinished tool calls');
    if (message.role === 'assistant') {
      for (const [callIndex, call] of message.calls.entries()) {
        if (calls.has(call.id)) invalid(`${location}.calls.${callIndex}.id`, 'duplicate tool call ID');
        calls.add(call.id); pending.add(call.id);
      }
    }
  }
  if (data.running !== undefined && !pending.has(data.running)) invalid('running', 'must identify an unfinished tool call');
  const runs = new Map<string, SessionData['runs'][number]>();
  for (const [index, run] of data.runs.entries()) {
    const location = `runs.${index}`;
    if (runs.has(run.id)) invalid(`${location}.id`, 'duplicate run ID');
    if (run.budgetSource === 'explicit_resume') {
      const previous = run.continuationOf ? runs.get(run.continuationOf) : undefined;
      if (!previous || previous.taskId !== run.taskId || previous.goal !== run.goal) invalid(`${location}.continuationOf`, 'continuation must reference an earlier run of the same task');
    } else if (run.continuationOf !== undefined) invalid(`${location}.continuationOf`, 'new task cannot continue another run');
    if (isActiveRun(run) ? run.endedAt !== undefined : run.endedAt === undefined) invalid(`${location}.endedAt`, 'end time must match the run status');
    if (Date.parse(run.updatedAt) < Date.parse(run.startedAt) || (run.endedAt && Date.parse(run.endedAt) < Date.parse(run.startedAt))) invalid(location, 'run timestamps are out of order');
    if (run.taskSnapshot && (run.taskSnapshot.id !== run.taskId || run.taskSnapshot.goal !== run.goal || run.taskSnapshot.status !== run.status)) invalid(`${location}.taskSnapshot`, 'task snapshot does not match its run');
    if (run.status === 'verified' && (!run.taskSnapshot || !canVerifyTask({ task: run.taskSnapshot, runs: [] }))) invalid(`${location}.status`, 'verified run requires a task snapshot with verification evidence');
    runs.set(run.id, run);
  }
  if (data.task) validateTask(data.task, 'task', runs, data.processes);
  for (const [index, run] of data.runs.entries()) if (run.taskSnapshot) validateTask(run.taskSnapshot, `runs.${index}.taskSnapshot`, runs);
  const activeRuns = data.runs.filter(isActiveRun);
  if (activeRuns.length > 1) invalid('runs', 'only one run can be active');
  if (activeRuns.length) {
    const active = activeRuns[0];
    if (active !== data.runs.at(-1) || !data.task || active.taskId !== data.task.id || active.goal !== data.task.goal || active.status !== data.task.status) invalid('task', 'active run must match the current task');
  } else if (data.task && ['running', 'awaiting_approval'].includes(data.task.status)) invalid('task.status', 'active task requires an active run');
  return data;
}
