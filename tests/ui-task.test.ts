import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App, type ApprovalBridge } from '../src/ui/App.js';
import type { Agent } from '../src/core/agent.js';
import type { AgentEvent, Message } from '../src/core/types.js';
import type { RunState, TaskState } from '../src/core/run-state.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const timestamp = '2026-09-27T00:00:00.000Z';
function fixture() {
  const task: TaskState = { id: 'task-1', goal: '保留原始任务目标', status: 'limited', remaining: ['运行测试'], completed: ['完成修改'], mutationRevision: 2,
    verificationChecks: [{ id: 'check-1', source: 'user', command: 'npm test', cwd: '/fixture', createdAt: timestamp }],
    verificationRecords: [{ id: 'record-1', checkId: 'check-1', source: 'user', command: 'npm test', cwd: '/fixture', ok: true, output: '旧测试通过', mutationRevision: 1, recordedAt: timestamp }],
  };
  const run: RunState = { id: 'run-1', taskId: task.id, goal: task.goal, status: 'limited', startedAt: timestamp, endedAt: timestamp, updatedAt: timestamp,
    checkpoint: 'stopped', turns: 3, toolCalls: 2, usage: { tokens: 900, estimated: false },
    budget: { maxModelTurns: 3, maxToolCalls: 5, maxTokens: 1000, maxContextChars: 120000 }, budgetSource: 'new_task', reason: 'max_model_turns',
  };
  const data = { id: 'original-session', messages: [{ role: 'user', content: task.goal }] as Message[], task, runs: [run] };
  let listener: (event: AgentEvent) => void = () => {};
  const agent = {
    config: { home: '/unused', cwd: '/fixture', model: 'fixture-model', baseUrl: 'http://localhost', permissions: 'workspace-edit' },
    store: { data }, setListener: (next: typeof listener) => { listener = next; },
    run: async () => { assert.fail('task commands must not become model prompts'); },
    continue: async (_signal: AbortSignal) => ({ ok: true, reason: 'completed' }),
    verify: async (_command: string, _signal: AbortSignal) => ({ ok: true, reason: 'completed' }),
    addTodo: async (_text: string) => {}, completeTodo: async (_index: number) => {},
    resumeSession: async (_id: string) => ({ recovered: 0 }),
  };
  const bridge: ApprovalBridge = {};
  const ui = render(React.createElement(App, { agent: agent as unknown as Agent, approval: bridge }));
  Object.defineProperty(ui.stdout, 'columns', { configurable: true, value: 120 });
  Object.defineProperty(ui.stdout, 'rows', { configurable: true, value: 70 });
  ui.stdout.emit('resize');
  return { agent, data, task, run, ui, bridge, event: (event: AgentEvent) => listener(event), close: () => { ui.unmount(); ui.cleanup(); } };
}
async function command(ui: ReturnType<typeof render>, value: string) {
  ui.stdin.write(value); await tick(); ui.stdin.write('\r'); await tick();
}

test('/task restores status, checkpoint, budget, todos and stale verification records', async () => {
  const f = fixture();
  try {
    await tick();
    assert.match(f.ui.lastFrame()!, /达到限制/); assert.match(f.ui.lastFrame()!, /剩余 tokens 100/);
    assert.match(f.ui.lastFrame()!, /max_model_turns/);
    await command(f.ui, '/task');
    const frame = f.ui.lastFrame()!;
    assert.match(frame, /目标：保留原始任务目标/); assert.match(frame, /最近检查点：stopped/);
    assert.match(frame, /1\. 运行测试/); assert.match(frame, /完成修改/);
    assert.match(frame, /已过期 · npm test/); assert.match(frame, /旧测试通过/);
    assert.doesNotMatch(frame, /已验证完成/);
  } finally { f.close(); }
});

test('/continue dispatches explicit continuation and keeps answered distinct from verified', async () => {
  const f = fixture(); let continued = 0;
  f.agent.continue = async signal => {
    continued++; assert.equal(signal.aborted, false);
    f.task.status = 'answered'; f.run.status = 'answered'; f.run.budgetSource = 'explicit_resume';
    f.event({ type: 'task', task: f.task, run: f.run });
    f.event({ type: 'done', ok: true, reason: 'completed' });
    return { ok: true, reason: 'completed' };
  };
  try {
    await tick(); await command(f.ui, '/continue');
    assert.equal(continued, 1); assert.equal(f.task.goal, '保留原始任务目标');
    assert.match(f.ui.lastFrame()!, /已回答 · 未验证/); assert.doesNotMatch(f.ui.lastFrame()!, /已验证完成/);
    assert.match(f.ui.lastFrame()!, /开启并记录新预算/);
  } finally { f.close(); }
});

test('/verify passes the complete command and waits for the existing approval flow', async () => {
  const f = fixture(); let verified = '';
  f.agent.verify = async (value, signal) => {
    const decision = await f.bridge.current!({ command: value, cwd: '/fixture', timeoutMs: 1000 }, signal);
    assert.equal(decision, 'once'); verified = value;
    f.task.status = 'verified'; f.run.status = 'verified';
    f.event({ type: 'task', task: f.task, run: f.run });
    f.event({ type: 'done', ok: true, reason: 'verified' });
    return { ok: true, reason: 'verified' };
  };
  try {
    await tick(); f.ui.stdin.write('/ver'); await tick(); f.ui.stdin.write('\t'); await tick();
    f.ui.stdin.write('printf "a b" && npm test'); await tick(); f.ui.stdin.write('\r'); await tick();
    assert.equal(verified, ''); assert.match(f.ui.lastFrame()!, /允许执行命令/);
    assert.match(f.ui.lastFrame()!, /printf "a b" && npm test/);
    f.ui.stdin.write('y'); await tick(); await tick();
    assert.equal(verified, 'printf "a b" && npm test');
    assert.match(f.ui.lastFrame()!, /已验证完成/);
  } finally { f.close(); }
});

test('/todo and /done preserve text and use one-based user numbering', async () => {
  const f = fixture(); const completed: number[] = [];
  f.agent.addTodo = async text => { f.task.remaining.push(text); };
  f.agent.completeTodo = async index => { completed.push(index); f.task.completed.push(...f.task.remaining.splice(index, 1)); };
  try {
    await tick(); await command(f.ui, '/todo 核对中文 与 emoji 🙂');
    assert.equal(f.task.remaining.at(-1), '核对中文 与 emoji 🙂');
    await command(f.ui, '/done 0'); assert.deepEqual(completed, []);
    assert.match(f.ui.lastFrame()!, /从 1 开始的整数/);
    await command(f.ui, '/done 2'); assert.deepEqual(completed, [1]);
    assert.equal(f.task.completed.at(-1), '核对中文 与 emoji 🙂');
    await command(f.ui, '/task'); assert.match(f.ui.lastFrame()!, /✓ 核对中文 与 emoji 🙂/);
  } finally { f.close(); }
});

test('/resume preserves the current view on failure and restores the selected session on success', async () => {
  const f = fixture();
  f.agent.resumeSession = async id => {
    if (id !== 'next-session') throw new Error('恢复会话需要相同模型和工作区');
    f.data.id = id;
    f.data.messages = [
      { role: 'user', content: '恢复后的目标' },
      { role: 'assistant', content: '', calls: [{ id: 'restore-call', name: 'write', arguments: '{"path":"restored.txt"}' }] },
      { role: 'tool', id: 'restore-call', content: JSON.stringify({ ok: true, content: 'created', changedFile: 'restored.txt', diff: '+restored' }) },
    ];
    f.task.goal = '恢复后的目标'; f.task.status = 'interrupted';
    return { recovered: 1 };
  };
  try {
    await tick(); await command(f.ui, '/resume wrong-session');
    assert.match(f.ui.lastFrame()!, /original-session/); assert.match(f.ui.lastFrame()!, /保留原始任务目标/);
    assert.match(f.ui.lastFrame()!, /恢复会话需要相同模型和工作区/);
    await command(f.ui, '/resume next-session');
    assert.match(f.ui.lastFrame()!, /next-session/); assert.match(f.ui.lastFrame()!, /恢复后的目标/);
    assert.match(f.ui.lastFrame()!, /restored.txt/); assert.match(f.ui.lastFrame()!, /已中断/);
    assert.doesNotMatch(f.ui.lastFrame()!, /保留原始任务目标/);
  } finally { f.close(); }
});

test('/sessions lists saved IDs, goals, models and timestamps without running the model', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-ui-sessions-'));
  const f = fixture(); f.agent.config.home = home;
  try {
    await mkdir(path.join(home, 'sessions', 'saved-session'), { recursive: true });
    await writeFile(path.join(home, 'sessions', 'saved-session', 'session.json'), JSON.stringify({
      version: 1, id: 'saved-session', cwd: '/fixture', provider: 'responses', model: 'saved-model', baseUrl: 'http://localhost',
      messages: [{ role: 'user', content: '保存的会话目标' }], updatedAt: timestamp,
    }));
    await tick(); await command(f.ui, '/sessions'); await tick();
    assert.match(f.ui.lastFrame()!, /saved-session/); assert.match(f.ui.lastFrame()!, /保存的会话目标/);
    assert.match(f.ui.lastFrame()!, /saved-model/); assert.match(f.ui.lastFrame()!, /2026-09-27/);
    assert.match(f.ui.lastFrame()!, /不会自动执行任务/);
  } finally { f.close(); await rm(home, { recursive: true, force: true }); }
});
