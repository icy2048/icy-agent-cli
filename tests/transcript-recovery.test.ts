import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import type { Agent } from '../src/core/agent.js';
import type { AgentEvent, Message, ToolCall, ToolResult } from '../src/core/types.js';
import { App } from '../src/ui/App.js';
import { changedFiles, entryLines, projectTranscriptEvent, transcriptFromMessages, type Entry } from '../src/ui/transcript.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 35));
const edit: ToolCall = { id: 'edit-1', name: 'edit', arguments: JSON.stringify({ path: 'note.txt', oldText: 'before', newText: 'after' }) };
const shell: ToolCall = { id: 'bash-1', name: 'bash', arguments: JSON.stringify({ command: 'check note.txt', cwd: null, timeoutMs: null }) };
const skipped: ToolCall = { id: 'read-1', name: 'read', arguments: JSON.stringify({ path: 'report.txt', offset: null, limit: null }) };
const edited: ToolResult = { ok: true, content: '替换成功。', changedFile: 'note.txt', durationMs: 12, diff: '--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after' };
const unknown: ToolResult = { ok: false, error: 'interrupted_unknown', content: '上次运行中断，请核对实际状态。' };
const notExecuted: ToolResult = { ok: false, error: 'not_executed', content: 'cancelled' };
const messages: Message[] = [
  { role: 'user', content: '修改并验证 note.txt', preparedContent: '不应在界面显示的提炼文本' },
  { role: 'assistant', content: '检查并修改文件。', reasoning: '先检查内容，再验证结果。', calls: [edit, shell, skipped] },
  { role: 'tool', id: edit.id, content: JSON.stringify(edited) },
  { role: 'tool', id: shell.id, content: JSON.stringify(unknown) },
  { role: 'tool', id: skipped.id, content: JSON.stringify(notExecuted) },
];

test('live and recovered transcripts preserve the same ordered tool results and changes', () => {
  const events: AgentEvent[] = [
    { type: 'user', text: messages[0].content }, { type: 'turn', turn: 1 },
    { type: 'reasoning_delta', text: '先检查' }, { type: 'reasoning', text: '先检查内容，再验证结果。' },
    { type: 'assistant', text: '检查并修改文件。' },
    { type: 'tool_start', call: edit }, { type: 'tool_end', call: edit, result: edited },
    { type: 'tool_start', call: shell }, { type: 'tool_end', call: shell, result: unknown },
    { type: 'tool_start', call: skipped }, { type: 'tool_end', call: skipped, result: notExecuted },
  ];
  const before = structuredClone(messages);
  const restored = transcriptFromMessages(messages);
  assert.deepEqual(events.reduce(projectTranscriptEvent, [] as Entry[]), restored);
  assert.deepEqual(messages, before);
  assert.deepEqual(restored.filter(entry => entry.kind === 'tool').map(entry => entry.call?.id), [edit.id, shell.id, skipped.id]);
  assert.deepEqual(restored.filter(entry => entry.kind === 'tool').map(entry => entry.result), [edited, unknown, notExecuted]);
  assert.deepEqual(changedFiles(restored), ['note.txt']);
  assert.equal(restored[0].text, messages[0].content);
});

test('tool details show both the original result and diff, and interrupted statuses remain explicit', () => {
  const restored = transcriptFromMessages(messages);
  const text = restored.flatMap(entry => entryLines(entry, 160, true, true)).map(line => line.text).join('\n');
  assert.match(text, /先检查内容，再验证结果/);
  assert.match(text, /"oldText":"before"/);
  assert.match(text, /替换成功/); assert.match(text, /-before\n\+after/);
  assert.match(text, /执行结果未知 bash check note.txt/);
  assert.match(text, /未执行 read report.txt/);
  assert.doesNotMatch(text, /不应在界面显示/);
  const collapsed = restored.flatMap(entry => entryLines(entry, 160, false, false)).map(line => line.text).join('\n');
  assert.match(collapsed, /执行结果未知/); assert.match(collapsed, /未执行/);
  assert.doesNotMatch(collapsed, /先检查内容，再验证结果/);
});

test('projection binds out-of-order results by ID, deduplicates starts and retains unique changed files', () => {
  const second: ToolCall = { ...edit, id: 'edit-2' };
  const input: Message[] = [
    { role: 'assistant', content: '', calls: [edit, second] },
    { role: 'tool', id: second.id, content: JSON.stringify({ ...edited, content: 'second' }) },
    { role: 'tool', id: edit.id, content: JSON.stringify(edited) },
  ];
  const restored = transcriptFromMessages(input);
  assert.deepEqual(restored.filter(entry => entry.call).map(entry => entry.result?.content), [edited.content, 'second']);
  assert.deepEqual(changedFiles(restored), ['note.txt']);
  assert.equal(projectTranscriptEvent(restored, { type: 'tool_start', call: second }), restored);
  const fromEnd = projectTranscriptEvent([], { type: 'tool_end', call: skipped, result: notExecuted });
  assert.equal(fromEnd.length, 1); assert.deepEqual(fromEnd[0].result, notExecuted);
});

test('unrecognized legacy tool content is retained without inventing a success', () => {
  const raw = 'legacy output icy-output:abc.txt';
  const restored = transcriptFromMessages([
    { role: 'assistant', content: '', calls: [edit] }, { role: 'tool', id: edit.id, content: raw },
  ]);
  const result = restored.find(entry => entry.call)?.result;
  assert.equal(result?.ok, false); assert.equal(result?.error, 'unknown_tool_result');
  assert.ok(result?.content.includes(raw)); assert.deepEqual(changedFiles(restored), []);
  const text = restored.flatMap(entry => entryLines(entry, 160, false, false)).map(line => line.text).join('\n');
  assert.match(text, /结果无法识别/); assert.match(text, /icy-output:abc.txt/); assert.doesNotMatch(text, /✓/);
});

test('context events explain compaction and failure but leave unchanged contexts quiet', () => {
  const before: Entry[] = [{ kind: 'user', text: '继续任务' }];
  const stats = { beforeChars: 50_000, afterChars: 30_000, estimatedTokens: 15_000, compactedToolResults: 3, fallback: false };
  const compacted = projectTranscriptEvent(before, { type: 'context', stats });
  assert.match(compacted.at(-1)!.text, /50,000 → 30,000/);
  assert.match(compacted.at(-1)!.text, /3 条历史结果/);
  const failed = projectTranscriptEvent(before, { type: 'context', stats: { ...stats, fallback: true, compactedToolResults: 0, afterChars: 50_000 } });
  assert.match(failed.at(-1)!.text, /上下文压缩失败/); assert.match(failed.at(-1)!.text, /保留完整上下文/);
  assert.equal(projectTranscriptEvent(before, { type: 'context', stats: { ...stats, compactedToolResults: 0 } }), before);
});

test('Workbench restores tool details, unknown status, latest task and historical changed files', async () => {
  const agent = {
    config: { cwd: '/fixture', model: 'test', baseUrl: 'http://localhost', permissions: 'workspace-edit', thinkingExpanded: true },
    store: { data: { id: 'restored-session', messages } }, setListener: () => {},
  } as unknown as Agent;
  const ui = render(React.createElement(App, { agent, approval: {}, recovery: 2 }));
  try {
    Object.defineProperty(ui.stdout, 'columns', { configurable: true, value: 120 });
    Object.defineProperty(ui.stdout, 'rows', { configurable: true, value: 65 });
    const deadline = Date.now() + 3000;
    while (!ui.lastFrame()?.includes('会话变更')) {
      assert.ok(Date.now() < deadline, `Timed out waiting for resized Workbench:\n${ui.lastFrame()}`);
      // Mount effects can subscribe after the first synthetic resize event.
      ui.stdout.emit('resize'); await tick();
    }
    assert.match(ui.lastFrame()!, /会话变更/); assert.match(ui.lastFrame()!, /note.txt/);
    assert.match(ui.lastFrame()!, /执行结果未知/); assert.match(ui.lastFrame()!, /未执行/);
    assert.match(ui.lastFrame()!, /3 次工具调用/); assert.match(ui.lastFrame()!, /修改并验证 note.txt/);
    ui.stdin.write('\x0f'); await tick();
    const frame = ui.lastFrame()!;
    assert.match(frame, /替换成功/); assert.match(frame, /-before/); assert.match(frame, /\+after/);
    assert.match(frame, /"oldText":"before"/); assert.match(frame, /先检查内容，再验证结果/);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('Workbench displays context compaction and fallback events', async () => {
  let listener: (event: AgentEvent) => void = () => {};
  const agent = {
    config: { cwd: '/fixture', model: 'test', baseUrl: 'http://localhost', permissions: 'workspace-edit' },
    store: { data: { id: 'context-session', messages: [] } }, setListener: (next: typeof listener) => { listener = next; },
  } as unknown as Agent;
  const ui = render(React.createElement(App, { agent, approval: {} }));
  try {
    await tick();
    listener({ type: 'context', stats: { beforeChars: 50_000, afterChars: 30_000, estimatedTokens: 15_000, compactedToolResults: 3, fallback: false } });
    await tick(); assert.match(ui.lastFrame()!, /50,000 → 30,000/);
    listener({ type: 'context', stats: { beforeChars: 50_000, afterChars: 50_000, estimatedTokens: 25_000, compactedToolResults: 0, fallback: true } });
    await tick(); assert.match(ui.lastFrame()!, /上下文压缩失败/);
  } finally { ui.unmount(); ui.cleanup(); }
});
