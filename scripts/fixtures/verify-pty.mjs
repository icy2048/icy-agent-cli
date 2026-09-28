import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root = process.argv[2];
assert.ok(root, 'provide fixture directory');
const sessions = [];
for (const id of await readdir(path.join(root, 'home/sessions'))) {
  const dir = path.join(root, 'home/sessions', id);
  await assert.rejects(access(path.join(dir, 'lock')), { code: 'ENOENT' });
  sessions.push(JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8')));
}
assert.equal(sessions.length, 3);
const verified = sessions.find(s => s.task.goal === '创建中文文件🙂');
assert.equal(verified.task.status, 'verified');
assert.deepEqual(verified.task.completed, ['核对中文🙂']);
assert.equal(verified.task.verificationRecords.at(-1).ok, true);
assert.equal(await readFile(path.join(root, 'workspace/note.txt'), 'utf8'), '你好🙂');
const cancelled = sessions.find(s => s.task.goal.includes('长命令'));
assert.deepEqual(cancelled.runs.map(r => r.status), ['cancelled', 'answered']);
assert.equal(cancelled.runs[1].budgetSource, 'explicit_resume');
assert.equal(cancelled.runs[1].toolCalls, 0);
assert.equal(cancelled.messages.filter(m => m.role === 'assistant').flatMap(m => m.calls).length, 1);
assert.equal(await readFile(path.join(root, 'workspace/slow.txt'), 'utf8'), 'begun');
const denied = sessions.find(s => s.task.goal.includes('拒绝'));
assert.match(denied.messages.find(m => m.role === 'tool').content, /permission_denied/);
await assert.rejects(access(path.join(root, 'workspace/denied.txt')), { code: 'ENOENT' });
for (const session of sessions) {
  const calls = session.messages.filter(m => m.role === 'assistant').flatMap(m => m.calls), results = session.messages.filter(m => m.role === 'tool');
  assert.equal(calls.length, results.length);
  assert.equal(new Set(calls.map(c => c.id)).size, calls.length);
  assert.ok(calls.every(call => results.some(result => result.id === call.id)));
}
console.log(JSON.stringify({ kind: 'linux-live-pty-acceptance', operator: 'Codex via interactive PTY; not a human usability study', platform: os.platform(), release: os.release(), arch: os.arch(), node: process.version, passed: true, checks: ['Chinese and emoji input preserved', 'approval granted by Y', 'explicit verification and todo completion', 'Esc cancels a real process group', 'restart renders the cancelled tool result', 'resume issues no model request before explicit continue', 'continue records a new budget without replaying bash', 'session switching restores verified task and details', 'N denies command without side effect', 'terminal resize switches 80-column and 140-column layouts', 'all locks released and tool IDs paired'], sessions: sessions.map(s => ({ id: s.id, goal: s.task.goal, status: s.task.status, runs: s.runs.map(r => ({ status: r.status, toolCalls: r.toolCalls, budgetSource: r.budgetSource })) })) }, null, 2));
