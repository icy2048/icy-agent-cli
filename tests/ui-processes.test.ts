import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App, type ApprovalBridge } from '../src/ui/App.js';
import type { Agent } from '../src/core/agent.js';
import type { AgentEvent, ApprovalRequest, ProcessRecord } from '../src/core/types.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const now = '2026-09-28T00:00:00.000Z';
const record = (status: ProcessRecord['status'] = 'running'): ProcessRecord => ({
  id: '11111111-1111-4111-8111-111111111111', toolCallId: 'call-1', command: 'sleep 30', cwd: '/fixture', pid: 12345,
  startedAt: now, ...(status === 'running' ? {} : { endedAt: now }), timeoutMs: 1_800_000, status, ...(status === 'exited' ? { exitCode: 0 } : {}), bytes: 42,
});
function fixture(processes: ProcessRecord[] = [], options: { closeError?: boolean } = {}) {
  let listener: (event: AgentEvent) => void = () => {};
  let releaseRun: (() => void) | undefined;
  const data = { id: 'ui-process-session', messages: [], runs: [], processes };
  const agent = {
    config: { home: '/unused', cwd: '/fixture', model: 'fixture', baseUrl: 'http://localhost', permissions: 'workspace-edit' },
    store: { data, close: async () => { if (options.closeError) throw new Error('close_failed'); return 0; } }, setListener: (next: typeof listener) => { listener = next; },
    run: async () => { await new Promise<void>(resolve => { releaseRun = resolve; }); return { ok: true, reason: 'completed' }; },
    killProcess: async (id: string) => {
      const normalized = id.startsWith('icy-process:') ? id.slice('icy-process:'.length) : id;
      if (normalized !== processes[0]?.id) throw new Error('process_not_found');
      processes[0].status = 'killed'; processes[0].endedAt = now; processes[0].reason = 'user_kill'; return processes[0];
    },
  };
  const bridge: ApprovalBridge = {};
  const ui = render(React.createElement(App, { agent: agent as unknown as Agent, approval: bridge }));
  Object.defineProperty(ui.stdout, 'columns', { configurable: true, value: 90 });
  Object.defineProperty(ui.stdout, 'rows', { configurable: true, value: 60 });
  ui.stdout.emit('resize');
  return { ui, agent, bridge, event: (event: AgentEvent) => listener(event), finishRun: () => releaseRun?.(), close: () => { ui.unmount(); ui.cleanup(); } };
}
async function command(ui: ReturnType<typeof render>, value: string, expected: RegExp) {
  await tick(); ui.stdin.write(value); await tick(); ui.stdin.write('\r');
  for (let i = 0; i < 100 && !expected.test(ui.lastFrame() ?? ''); i++) await tick();
  assert.match(ui.lastFrame() ?? '', expected);
}

test('/ps shows an empty and a populated process list, and /kill handles unknown and known IDs', async () => {
  const empty = fixture();
  try { await command(empty.ui, '/ps', /没有后台进程。/); } finally { empty.close(); }
  const running = record(); const f = fixture([running]);
  try {
    await command(f.ui, '/ps', /icy-process:11111111/);
    assert.match(f.ui.lastFrame()!, /状态：running/); assert.match(f.ui.lastFrame()!, /pid 12345/); assert.match(f.ui.lastFrame()!, /字节 42/); assert.match(f.ui.lastFrame()!, /sleep 30/);
    await command(f.ui, '/kill 00000000-0000-4000-8000-000000000000', /无法终止后台进程.*process_not_found/);
    await command(f.ui, '/kill icy-process:11111111-1111-4111-8111-111111111111', /当前状态：killed.*user_kill/);
  } finally { f.close(); }
});

test('/ps and /kill remain available while a model run is busy', async () => {
  const f = fixture([record()]);
  try {
    f.ui.stdin.write('long-running request'); f.ui.stdin.write('\r'); await tick();
    await command(f.ui, '/ps', /icy-process:11111111/);
    await command(f.ui, '/kill 11111111-1111-4111-8111-111111111111', /当前状态：killed.*user_kill/);
    f.finishRun(); await tick();
  } finally { f.close(); }
});

test('busy composer keeps a non-process draft and explains the accepted commands', async () => {
  const f = fixture();
  try {
    f.ui.stdin.write('long-running request'); f.ui.stdin.write('\r'); await tick();
    f.ui.stdin.write('draft kept while busy'); await tick(); f.ui.stdin.write('\r');
    for (let i = 0; i < 100 && !/运行中：只接受 \/ps 和 \/kill；Esc 取消当前运行。/.test(f.ui.lastFrame() ?? ''); i++) await tick();
    assert.match(f.ui.lastFrame() ?? '', /运行中：只接受 \/ps 和 \/kill；Esc 取消当前运行。/);
    assert.match(f.ui.lastFrame() ?? '', /draft kept while busy/);
    f.finishRun(); await tick();
  } finally { f.close(); }
});

test('interactive close failure sets a non-zero exit code', async () => {
  const previous = process.exitCode; process.exitCode = undefined;
  const f = fixture([], { closeError: true });
  try {
    f.ui.stdin.write('/exit'); f.ui.stdin.write('\r');
    for (let i = 0; i < 100 && process.exitCode !== 1; i++) await tick();
    assert.equal(process.exitCode, 1);
  } finally { f.close(); process.exitCode = previous; }
});

test('detached approval clearly describes persistence and keeps long-command paging', async () => {
  const f = fixture();
  try {
    const request: ApprovalRequest = { command: 'sleep 30', cwd: '/fixture', timeoutMs: 1_800_000, detach: true };
    const decision = f.bridge.current!(request, new AbortController().signal);
    await tick();
    assert.match(f.ui.lastFrame()!, /后台命令（最长 30 分钟，输出写入会话目录）/);
    assert.match(f.ui.lastFrame()!, /输出写入磁盘；命令会在当前轮结束后继续运行/);
    f.ui.stdin.write('n'); assert.equal(await decision, 'deny');
  } finally { f.close(); }
});

test('/ps and /task label identity-unconfirmed processes as 未确认', async () => {
  const f = fixture([{ ...record('unknown'), pidAlive: true, reason: 'identity_unconfirmed' }]);
  try {
    await command(f.ui, '/ps', /状态：未确认/);
    await command(f.ui, '/task', /未确认/);
  } finally { f.close(); }
});

test('process transcript events show start, exit and unknown recovery states', async () => {
  const f = fixture();
  try {
    f.event({ type: 'process', record: record('running') }); await tick(); assert.match(f.ui.lastFrame()!, /▶ 后台进程 icy-process:11111111 已启动：sleep 30/);
    f.event({ type: 'process', record: { ...record('exited'), exitCode: 0 } }); await tick(); assert.match(f.ui.lastFrame()!, /■ 后台进程 icy-process:11111111 已结束，退出码 0/);
    f.event({ type: 'process', record: { ...record('unknown'), pidAlive: true } }); await tick(); assert.match(f.ui.lastFrame()!, /状态未知（icy 重启后不再跟踪，pid 仍存活）/);
  } finally { f.close(); }
});

test('restored process snapshots use the same transcript projection', async () => {
  const f = fixture([{ ...record('unknown'), pidAlive: false }]);
  try { await tick(); assert.match(f.ui.lastFrame()!, /\? 后台进程 icy-process:11111111 状态未知（icy 重启后不再跟踪，pid 已不存在）/); } finally { f.close(); }
});
