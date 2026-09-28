import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/load.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

type Fixture = { root: string; cwd: string; tools: ToolRegistry; store: SessionStore; config: Config };
const makeFixture = async (permissions: Config['permissions'] = 'workspace-edit'): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icy-explore-'));
  const cwd = path.join(root, 'workspace'), home = path.join(root, 'home');
  await mkdir(cwd);
  const config = {
    home, cwd, provider: 'responses' as const, baseUrl: 'http://localhost', model: 'fixture', apiKey: '', apiKeyEnv: 'FIXTURE',
    permissions, promptCompaction: 'local' as const, compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50,
    maxTokens: 100000, maxContextChars: 120000, requestTimeoutMs: 1000,
  } satisfies Config;
  const store = await SessionStore.create(home, config);
  return { root, cwd, tools: new ToolRegistry(config, store), store, config };
};
let callNumber = 0;
const readCall = (pathName: string, extra: Record<string, unknown> = {}) => ({
  id: `read-${++callNumber}`, name: 'read' as const,
  arguments: JSON.stringify({ path: pathName, offset: null, limit: null, depth: null, pattern: null, regex: null, ...extra }),
});
const runRead = (tools: ToolRegistry, pathName: string, extra: Record<string, unknown> = {}) => tools.execute(readCall(pathName, extra), new AbortController().signal);

async function closeFixture(fixture: Fixture) {
  await fixture.store.close();
  await rm(fixture.root, { recursive: true, force: true });
}

test('directory listing is sorted, bounded, and skips protected entries while marking links', async () => {
  const f = await makeFixture();
  try {
    await mkdir(path.join(f.cwd, 'sub'));
    await writeFile(path.join(f.cwd, 'sub', 'a.ts'), 'abc');
    await writeFile(path.join(f.cwd, 'visible.ts'), '1234');
    for (const name of ['.git', 'node_modules', 'dist', '.icy']) await mkdir(path.join(f.cwd, name));
    await writeFile(path.join(f.cwd, '.env'), 'hidden');
    await symlink(path.join(f.root, 'outside'), path.join(f.cwd, 'z-link'));
    const result = await runRead(f.tools, '.', { depth: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.content, 'sub/\nsub/a.ts  3\nvisible.ts  4\nz-link@\n[4 entries]');
  } finally { await closeFixture(f); }
});

test('recursive listings page entries and never return more than 500 entries', async () => {
  const f = await makeFixture();
  try {
    await Promise.all(Array.from({ length: 510 }, (_, i) => writeFile(path.join(f.cwd, `f${String(i).padStart(3, '0')}`), 'x')));
    const first = await runRead(f.tools, '.');
    assert.equal(first.ok, true);
    assert.equal(first.content.split('\n').length, 501);
    assert.match(first.content, /\[500 entries shown of 510\]$/);
    const page = await runRead(f.tools, '.', { offset: 501, limit: 10 });
    assert.match(page.content, /^f500  1\n/);
    assert.match(page.content, /\[10 entries shown of 510\]$/);
  } finally { await closeFixture(f); }
});

test('fixed and regex searches skip binary, sensitive, and symlinked files', async () => {
  const f = await makeFixture();
  try {
    await mkdir(path.join(f.cwd, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(f.cwd, 'src', 'a.ts'), 'needle here\nnope\n');
    await writeFile(path.join(f.cwd, 'src', 'nested', 'b.ts'), 'value 42\n');
    await writeFile(path.join(f.cwd, 'src', 'binary.bin'), 'needle\0hidden');
    await writeFile(path.join(f.cwd, 'src', 'secret.pem'), 'needle');
    await mkdir(path.join(f.root, 'outside')); await writeFile(path.join(f.root, 'outside', 'escaped.ts'), 'needle');
    await symlink(path.join(f.root, 'outside'), path.join(f.cwd, 'src', 'linked'));
    const fixed = await runRead(f.tools, 'src', { pattern: 'needle' });
    assert.equal(fixed.ok, true);
    assert.match(fixed.content, /src\/a\.ts:1: needle here/);
    assert.doesNotMatch(fixed.content, /binary|secret|escaped/);
    const regex = await runRead(f.tools, 'src', { pattern: '^value (\\d+)$', regex: true });
    assert.match(regex.content, /src\/nested\/b\.ts:1: value 42/);
    const invalid = await runRead(f.tools, 'src', { pattern: '(', regex: true });
    assert.equal(invalid.ok, false); assert.match(invalid.content, /invalid_pattern/);
    const outside = await runRead(f.tools, path.join(f.root, 'outside'), { pattern: 'needle' });
    assert.equal(outside.ok, false); assert.match(outside.content, /path_outside_workspace/);
  } finally { await closeFixture(f); }
});

test('search caps matches and scanned files and supports match paging', async () => {
  const f = await makeFixture();
  try {
    await Promise.all(Array.from({ length: 201 }, (_, i) => writeFile(path.join(f.cwd, `m${String(i).padStart(3, '0')}.txt`), 'needle\n')));
    const capped = await runRead(f.tools, '.', { pattern: 'needle', offset: 101, limit: 2 });
    assert.equal(capped.ok, true); assert.match(capped.content, /\[200 matches in 200 files; 200 files scanned\]/); assert.match(capped.content, /\[truncated\]/);

    await rm(f.cwd, { recursive: true, force: true }); await mkdir(f.cwd);
    await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(path.join(f.cwd, `s${String(i).padStart(4, '0')}.txt`), 'no match\n')));
    const files = await runRead(f.tools, '.', { pattern: 'needle' });
    assert.match(files.content, /\[0 matches in 0 files; 2000 files scanned\]/); assert.match(files.content, /\[truncated\]/);
  } finally { await closeFixture(f); }
});

test('output references reject content patterns and read-only exploration needs no approval', async () => {
  const f = await makeFixture('read-only');
  try {
    await writeFile(path.join(f.cwd, 'note.txt'), 'needle\n');
    const definitions = f.tools.definitions();
    assert.deepEqual(definitions.map(definition => definition.name), ['read']);
    const readSchema = definitions[0]!.parameters as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    assert.deepEqual(readSchema.required, ['path', 'offset', 'limit', 'depth', 'pattern', 'regex']);
    assert.equal(readSchema.additionalProperties, false);
    for (const key of ['depth', 'pattern', 'regex']) assert.ok(key in readSchema.properties);
    const listed = await runRead(f.tools, '.');
    assert.match(listed.content, /note\.txt/);
    const searched = await runRead(f.tools, '.', { pattern: 'needle' });
    assert.match(searched.content, /note\.txt:1: needle/);
    const output = await runRead(f.tools, 'icy-output:missing', { pattern: 'needle' });
    assert.equal(output.ok, false); assert.match(output.content, /pattern_not_supported_for_output/);
  } finally { await closeFixture(f); }
});

test('the read schema is strict and identical for both advertised protocols', async () => {
  for (const provider of ['responses', 'chat-completions'] as const) {
    const f = await makeFixture();
    try {
      const config = { ...f.config, provider };
      const tools = new ToolRegistry(config, f.store);
      const readSchema = tools.definitions()[0]!.parameters as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
      assert.equal(readSchema.additionalProperties, false);
      assert.deepEqual(readSchema.required, ['path', 'offset', 'limit', 'depth', 'pattern', 'regex']);
      assert.ok(readSchema.properties.depth && readSchema.properties.pattern && readSchema.properties.regex);
    } finally { await closeFixture(f); }
  }
});
