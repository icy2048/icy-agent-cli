import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PermissionPolicy } from '../src/tools/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import type { Config } from '../src/config/load.js';
import type { ApprovalDecision, Approve } from '../src/core/types.js';

test('exact grants distinguish cwd/timeout/command and never leak into another session', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'icy-policy-'));
  try {
    await mkdir(path.join(cwd, 'sub'));
    let prompts = 0;
    const approve: Approve = async () => { prompts++; return 'session'; };
    const config = { cwd, permissions: 'workspace-edit' as const };
    const policy = new PermissionPolicy(config, approve), signal = new AbortController().signal;
    const input = { name: 'bash' as const, args: { command: 'true', cwd: null, timeoutMs: null } };
    await policy.authorize(input, signal); await policy.authorize(input, signal); assert.equal(prompts, 1);
    for (const args of [{ ...input.args, cwd: 'sub' }, { ...input.args, timeoutMs: 1000 }, { ...input.args, command: 'true ' }]) await policy.authorize({ name: 'bash', args }, signal);
    assert.equal(prompts, 4);
    await new PermissionPolicy(config, approve).authorize(input, signal); assert.equal(prompts, 5);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('cancelled approval balances listener state and cannot grant later execution', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'icy-policy-cancel-'));
  try {
    const controller = new AbortController(), waiting: boolean[] = []; let prompts = 0;
    const policy = new PermissionPolicy({ cwd, permissions: 'workspace-edit' }, async () => { prompts++; if (prompts === 1) controller.abort(); return 'session'; });
    policy.setApprovalListener(async state => { waiting.push(state); });
    const input = { name: 'bash' as const, args: { command: 'true', cwd: null, timeoutMs: null } };
    await assert.rejects(policy.authorize(input, controller.signal));
    await policy.authorize(input, new AbortController().signal);
    assert.equal(prompts, 2); assert.deepEqual(waiting, [true, false, true, false]);
    const invalid = new PermissionPolicy({ cwd, permissions: 'workspace-edit' }, async () => undefined as unknown as ApprovalDecision);
    await assert.rejects(invalid.authorize(input, new AbortController().signal), /invalid_approval_decision/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a bash directory changed to a symlink while approval is pending cannot execute', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-policy-path-'));
  const cwd = path.join(root, 'workspace'), home = path.join(root, 'home'), outside = path.join(root, 'outside');
  await mkdir(path.join(cwd, 'sub'), { recursive: true }); await mkdir(outside);
  const config: Config = { home, cwd, provider: 'responses', baseUrl: 'http://localhost', model: 'fixture', apiKey: '', apiKeyEnv: 'FIXTURE', permissions: 'workspace-edit', promptCompaction: 'local', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 120000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, config);
  try {
    const tools = new ToolRegistry(config, store, async () => {
      await rename(path.join(cwd, 'sub'), path.join(cwd, 'original'));
      await symlink(outside, path.join(cwd, 'sub'));
      return 'once';
    });
    const result = await tools.execute({ id: 'swap', name: 'bash', arguments: JSON.stringify({ command: 'touch escaped', cwd: 'sub', timeoutMs: null }) }, new AbortController().signal);
    assert.equal(result.ok, false); assert.match(result.content, /symlink_not_allowed/);
    await assert.rejects(readFile(path.join(outside, 'escaped')), { code: 'ENOENT' });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
