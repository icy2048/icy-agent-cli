import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprintWorkspace } from '../src/core/workspace-fingerprint.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'icy-fingerprint-')), cwd = path.join(root, 'workspace');
  await fs.mkdir(cwd);
  return { root, cwd, clean: () => fs.rm(root, { recursive: true, force: true }) };
}

test('fingerprints are deterministic, content-sensitive and contain only a hash', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.cwd, 'nested'));
    await fs.writeFile(path.join(f.cwd, 'z.txt'), 'secret-content-must-not-leak');
    await fs.writeFile(path.join(f.cwd, 'nested', 'a.txt'), 'before');
    const before = await fingerprintWorkspace(f.cwd);
    assert.match(before!, /^[a-f0-9]{64}$/); assert.equal(await fingerprintWorkspace(f.cwd), before);
    await fs.writeFile(path.join(f.cwd, 'nested', 'a.txt'), 'after!');
    assert.notEqual(await fingerprintWorkspace(f.cwd), before);
    await fs.writeFile(path.join(f.cwd, 'nested', 'a.txt'), 'before');
    assert.equal(await fingerprintWorkspace(f.cwd), before);
    assert.ok(!before!.includes('secret-content'));
  } finally { await f.clean(); }
});

test('directory traversal is independent of file creation order', async () => {
  const f = await fixture(), second = path.join(f.root, 'other');
  try {
    await fs.mkdir(second);
    for (const name of ['b.txt', 'a.txt']) await fs.writeFile(path.join(f.cwd, name), name, { mode: 0o600 });
    for (const name of ['a.txt', 'b.txt']) await fs.writeFile(path.join(second, name), name, { mode: 0o600 });
    assert.equal(await fingerprintWorkspace(f.cwd), await fingerprintWorkspace(second));
  } finally { await f.clean(); }
});

test('file permissions, renames and empty directory changes alter the fingerprint', async () => {
  const f = await fixture(), file = path.join(f.cwd, 'original.txt');
  try {
    await fs.writeFile(file, 'same', { mode: 0o600 });
    const original = await fingerprintWorkspace(f.cwd);
    await fs.chmod(file, 0o700);
    const mode = await fingerprintWorkspace(f.cwd); assert.notEqual(mode, original);
    await fs.rename(file, path.join(f.cwd, 'renamed.txt'));
    const renamed = await fingerprintWorkspace(f.cwd); assert.notEqual(renamed, mode);
    await fs.mkdir(path.join(f.cwd, 'empty'));
    assert.notEqual(await fingerprintWorkspace(f.cwd), renamed);
  } finally { await f.clean(); }
});

test('symlink target text is hashed without reading or traversing its target', async () => {
  const f = await fixture(), external = path.join(f.root, 'external.txt'), link = path.join(f.cwd, 'link');
  try {
    await fs.writeFile(external, 'outside');
    await fs.symlink('../external.txt', link);
    await fs.symlink('.', path.join(f.cwd, 'directory-loop'));
    const before = await fingerprintWorkspace(f.cwd); assert.match(before!, /^[a-f0-9]{64}$/);
    await fs.writeFile(external, 'outside changed');
    assert.equal(await fingerprintWorkspace(f.cwd), before);
    await fs.unlink(link); await fs.symlink('../missing-target.txt', link);
    const changed = await fingerprintWorkspace(f.cwd);
    assert.match(changed!, /^[a-f0-9]{64}$/); assert.notEqual(changed, before);
    assert.equal(await fingerprintWorkspace(path.join(f.cwd, 'directory-loop')), undefined);
  } finally { await f.clean(); }
});

test('only explicit ignored session subtrees are excluded, with path-component boundaries', async () => {
  const f = await fixture(), session = path.join(f.cwd, '.icy', 'sessions', 'current');
  try {
    await fs.mkdir(session, { recursive: true });
    await fs.mkdir(session + '-other');
    await fs.writeFile(path.join(session, 'events.jsonl'), 'old');
    const options = { ignorePaths: [session] };
    const before = await fingerprintWorkspace(f.cwd, options);
    await fs.writeFile(path.join(session, 'events.jsonl'), 'new');
    await fs.writeFile(path.join(session, 'session.json'), 'new snapshot');
    assert.equal(await fingerprintWorkspace(f.cwd, options), before);
    assert.equal(await fingerprintWorkspace(f.cwd, { ignorePaths: ['.icy/sessions/current'] }), before);
    await fs.writeFile(path.join(session + '-other', 'change'), 'not excluded');
    assert.notEqual(await fingerprintWorkspace(f.cwd, options), before);
    assert.equal(await fingerprintWorkspace(f.cwd, { ignorePaths: [f.cwd] }), undefined);
  } finally { await f.clean(); }
});

test('dependency, git and secret files are not silently excluded', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.cwd, 'node_modules')); await fs.mkdir(path.join(f.cwd, '.git'));
    let before = await fingerprintWorkspace(f.cwd);
    for (const name of ['node_modules/dep.js', '.git/config', '.env']) {
      await fs.writeFile(path.join(f.cwd, name), 'private bytes');
      const after = await fingerprintWorkspace(f.cwd);
      assert.match(after!, /^[a-f0-9]{64}$/); assert.notEqual(after, before); before = after;
    }
  } finally { await f.clean(); }
});

test('entry and byte budgets return unknown at the boundary without skipping files', async () => {
  const f = await fixture();
  try {
    assert.match((await fingerprintWorkspace(f.cwd, { maxFiles: 0, maxBytes: 0 }))!, /^[a-f0-9]{64}$/);
    await fs.writeFile(path.join(f.cwd, 'a.txt'), '你');
    assert.match((await fingerprintWorkspace(f.cwd, { maxFiles: 1, maxBytes: 3 }))!, /^[a-f0-9]{64}$/);
    assert.equal(await fingerprintWorkspace(f.cwd, { maxFiles: 0 }), undefined);
    assert.equal(await fingerprintWorkspace(f.cwd, { maxBytes: 2 }), undefined);
    await fs.mkdir(path.join(f.cwd, 'empty'));
    assert.equal(await fingerprintWorkspace(f.cwd, { maxFiles: 1 }), undefined);
    assert.equal(await fingerprintWorkspace(f.cwd, { maxFiles: -1 }), undefined);
    assert.equal(await fingerprintWorkspace(f.cwd, { maxBytes: Infinity }), undefined);
  } finally { await f.clean(); }
});

test('filesystem and file-read errors return unknown without exposing their messages', async t => {
  const f = await fixture();
  try {
    assert.equal(await fingerprintWorkspace(path.join(f.cwd, 'missing')), undefined);
    await fs.writeFile(path.join(f.cwd, 'a.txt'), 'content');
    const mocked = t.mock.method(fs, 'open', async () => { throw new Error('sensitive path / private read failure'); });
    try { assert.equal(await fingerprintWorkspace(f.cwd), undefined); }
    finally { mocked.mock.restore(); }
  } finally { await f.clean(); }
});

test('the default byte budget rejects a large file before reading its contents', async t => {
  const f = await fixture(), file = path.join(f.cwd, 'large.bin');
  try {
    await fs.writeFile(file, ''); await fs.truncate(file, 64 * 1024 * 1024 + 1);
    const mocked = t.mock.method(fs, 'open', async () => { assert.fail('an oversized file must not be opened'); });
    try { assert.equal(await fingerprintWorkspace(f.cwd), undefined); assert.equal(mocked.mock.callCount(), 0); }
    finally { mocked.mock.restore(); }
  } finally { await f.clean(); }
});

test('a file changing between lstat and open yields an unknown fingerprint', async t => {
  const f = await fixture(), file = path.join(f.cwd, 'a.txt');
  try {
    await fs.writeFile(file, 'original');
    const originalOpen = fs.open;
    const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === file) await fs.writeFile(file, 'changed');
      return originalOpen(...args);
    });
    try { assert.equal(await fingerprintWorkspace(f.cwd), undefined); }
    finally { mocked.mock.restore(); }
  } finally { await f.clean(); }
});

test('the final stat sweep detects changes to a previously hashed file', async t => {
  const f = await fixture(), first = path.join(f.cwd, 'a.txt'), second = path.join(f.cwd, 'b.txt');
  try {
    await fs.writeFile(first, 'first'); await fs.writeFile(second, 'second');
    const originalOpen = fs.open;
    const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === second) await fs.writeFile(first, 'modified after its own read');
      return originalOpen(...args);
    });
    try { assert.equal(await fingerprintWorkspace(f.cwd), undefined); }
    finally { mocked.mock.restore(); }
  } finally { await f.clean(); }
});

test('abort propagates the exact reason instead of becoming unknown', async t => {
  const f = await fixture(), controller = new AbortController(), reason = new Error('stop fingerprinting');
  try {
    controller.abort(reason);
    await assert.rejects(fingerprintWorkspace(f.cwd, { signal: controller.signal }), error => error === reason);
    const during = new AbortController(); await fs.writeFile(path.join(f.cwd, 'a.txt'), 'content');
    const originalOpen = fs.open;
    const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args); during.abort(reason); return handle;
    });
    try { await assert.rejects(fingerprintWorkspace(f.cwd, { signal: during.signal }), error => error === reason); }
    finally { mocked.mock.restore(); }
  } finally { await f.clean(); }
});
