import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTaskExecution } from '../scripts/task-audit.js';
import type { Message } from '../src/core/types.js';

function history(steps: Array<[string, Record<string, unknown>, boolean?]>): Message[] {
  return steps.flatMap(([name, args, ok = true], index): Message[] => [
    { role: 'assistant', content: '', calls: [{ id: String(index), name, arguments: JSON.stringify(args) }] },
    { role: 'tool', id: String(index), content: JSON.stringify({ ok, content: name === 'bash' && ok ? 'fixture checks passed' : 'result' }) },
  ]);
}
const read = (file: string): [string, Record<string, unknown>] => ['read', { path: file }];
const edit = (file: string): [string, Record<string, unknown>] => ['edit', { path: file, oldText: 'before', newText: 'after' }];
const verify: [string, Record<string, unknown>] = ['bash', { command: 'node verify.cjs', cwd: null }];

test('task audit rejects skipped reads, early verification, and reverted out-of-scope writes', () => {
  const cwd = '/fixture', contract = { reads: ['README.md', 'input.txt'], writable: ['input.txt'] };
  assert.equal(auditTaskExecution(history([read('README.md'), read('input.txt'), edit('input.txt'), verify]), cwd, contract).passed, true);
  const lateRead = auditTaskExecution(history([read('input.txt'), edit('input.txt'), read('README.md'), verify]), cwd, contract);
  assert.deepEqual(lateRead.unmetRequirements, ['read_before_changes:README.md']);
  assert.ok(auditTaskExecution(history([read('README.md'), read('input.txt'), verify, edit('input.txt')]), cwd, contract).unmetRequirements.includes('successful_verification_after_changes'));
  assert.ok(auditTaskExecution(history([read('README.md'), read('input.txt'), edit('verify.cjs'), edit('verify.cjs'), edit('input.txt'), verify]), cwd, contract).unmetRequirements.includes('unexpected_mutation:verify.cjs'));
});

test('no-change branch prohibits rewriting and only the latest root-workspace verification counts', () => {
  const cwd = '/fixture', contract = { reads: ['config.json'], writable: [] };
  assert.equal(auditTaskExecution(history([read('config.json'), verify]), cwd, contract).passed, true);
  assert.ok(auditTaskExecution(history([read('config.json'), ['write', { path: 'config.json', content: 'same bytes' }], verify]), cwd, contract).unmetRequirements.includes('unexpected_mutation:config.json'));
  assert.equal(auditTaskExecution(history([['read', { path: 'config.json' }, false], verify]), cwd, contract).passed, false);
  assert.equal(auditTaskExecution(history([read('config.json'), verify, ['bash', verify[1], false]]), cwd, contract).checked, false);
  assert.equal(auditTaskExecution(history([read('config.json'), ['bash', { command: 'node verify.cjs', cwd: 'different' }]]), cwd, contract).checked, false);
});
