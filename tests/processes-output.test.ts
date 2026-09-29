import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, open as openFile, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import type { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/sessions/store.js';
import { killBashTree, runBash } from '../src/tools/bash.js';
import { parseSessionData } from '../src/sessions/schema.js';
import { Agent } from '../src/core/agent.js';
import type { AgentEvent, ProcessRecord, Provider } from '../src/core/types.js';
import { canVerifyTask, markMutation, recordVerification, registerVerification, startRun, type SessionExecutionState } from '../src/core/run-state.js';
import { promisify } from 'node:util';
import { bashArgs, fakeChild, fixture, identityToken, nodeCommand, outputChild, pollFor, posix, skipWindows, testProcessTiming, waitFor } from './helpers/processes.js';

const exec = promisify(execFile);

test('foreground and detached streams preserve split UTF-8 characters without replacement', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const foreground = await runBash(nodeCommand('process.stdout.write("中".repeat(72_000));'), f.cwd, 60_000, new AbortController().signal);
    assert.equal(foreground.ok, true); assert.equal((foreground.content.match(/�/g) ?? []).length, 0); assert.equal((foreground.content.match(/中/g) ?? []).length, 72_000);
    const detached = await f.call('detached-cjk-emoji', 'bash', bashArgs(nodeCommand('process.stdout.write("中".repeat(250_000) + "😀".repeat(200_000));'), { detach: true }));
    const id = detached.content.match(/icy-process:([0-9a-f-]+)/)![1];
    await f.store.getProcessManager().status(id, { waitMs: 10_000 });
    const log = await readFile(path.join(f.store.dir, 'processes', `${id}.log`), 'utf8');
    assert.equal((log.match(/�/g) ?? []).length, 0); assert.equal(log, '中'.repeat(250_000) + '😀'.repeat(200_000));
  } finally { await f.cleanup(); }
});

test('detached output is persisted and paged by Unicode characters', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const result = await f.call('detached', 'bash', bashArgs(nodeCommand('process.stdout.write("中🙂猫😀");'), { detach: true }));
    assert.equal(result.ok, true); const reference = result.content.match(/icy-process:[0-9a-f-]+/)![0], id = reference.slice('icy-process:'.length);
    await f.store.getProcessManager().status(id, { waitMs: 10_000 });
    const first = await f.call('read-1', 'read', { path: reference, offset: 1, limit: 2, depth: null, pattern: null, regex: null });
    assert.equal(first.ok, true); assert.match(first.content, /中🙂/); assert.match(first.content, /offset=3/);
    const second = await f.call('read-2', 'read', { path: reference, offset: 3, limit: 6000, depth: null, pattern: null, regex: null });
    assert.equal(second.ok, true); assert.match(second.content, /猫😀/); assert.match(second.content, /End of output/);
    const record = await f.store.getProcessManager().status(f.store.data.processes[0].id, { waitMs: 10_000 }); assert.equal(record.status, 'exited'); assert.equal(record.exitCode, 0);
    const log = await readFile(path.join(f.store.dir, 'processes', `${record.id}.log`), 'utf8'); assert.equal(log, '中🙂猫😀');
  } finally { await f.cleanup(); }
});

test('readOutput paging matches the old code-point reference at sparse-index boundaries', async () => {
  const f = await fixture();
  try {
    const id = '12121212-1212-4121-8121-121212121212', text = 'a中🙂😀'.repeat(250_000), bytes = Buffer.byteLength(text);
    await mkdir(path.join(f.store.dir, 'processes'), { recursive: true }); await writeFile(path.join(f.store.dir, 'processes', `${id}.log`), text);
    f.store.data.processes.push({ id, toolCallId: 'paging', command: 'fixture', cwd: f.cwd, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), timeoutMs: 1000, status: 'exited', exitCode: 0, bytes });
    const chars = Array.from(text), reference = (offset: number, limit: number | null) => {
      const start = offset - 1, size = Math.min(limit ?? 6000, 6000), end = Math.min(chars.length, start + size);
      if (start < 0 || start > chars.length) throw new Error('offset_out_of_range');
      return { text: chars.slice(start, end).join(''), end, total: chars.length, truncated: end < chars.length };
    };
    const offsets = [1, 65_536, 65_537, Math.floor(chars.length / 2), chars.length - 10, chars.length + 1];
    for (const offset of offsets) for (const limit of [1, 17, 6000, 9000]) assert.deepEqual(await f.store.getProcessManager().readOutput(id, offset, limit), reference(offset, limit));
    await assert.rejects(f.store.getProcessManager().readOutput(id, chars.length + 2, 10), { message: 'offset_out_of_range' });
  } finally { await f.cleanup(); }
});

test('readOutput uses bounded range reads after indexing and caches restart indexes', async () => {
  let bytesRead = 0, readerCalls = 0;
  const reader = async (file: string, offset: number, length: number) => {
    readerCalls++;
    const handle = await openFile(file, 'r');
    try { const buffer = Buffer.alloc(length), result = await handle.read(buffer, 0, length, offset); bytesRead += result.bytesRead; return buffer.subarray(0, result.bytesRead); }
    finally { await handle.close(); }
  };
  const f = await fixture({ processLogReader: reader }); let restored: SessionStore | undefined;
  try {
    const id = '34343434-3434-4343-8434-343434343434', text = 'a中🙂😀'.repeat(1_400_000), bytes = Buffer.byteLength(text);
    await mkdir(path.join(f.store.dir, 'processes'), { recursive: true }); await writeFile(path.join(f.store.dir, 'processes', `${id}.log`), text);
    f.store.data.processes.push({ id, toolCallId: 'bounded', command: 'fixture', cwd: f.cwd, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), timeoutMs: 1000, status: 'exited', exitCode: 0, bytes });
    const total = Array.from(text).length, manager = f.store.getProcessManager();
    await manager.readOutput(id, total - 10, 10); assert.ok(readerCalls > 0); readerCalls = 0; bytesRead = 0; await manager.readOutput(id, total - 20, 10); assert.ok(bytesRead <= 1.5 * 1024 * 1024, `${bytesRead} bytes read after cached index`);
    await f.store.save(); await f.store.close(); restored = (await SessionStore.resume(f.home, f.store.data.id, [], { processLogReader: reader })).store;
    await restored.getProcessManager().readOutput(id, total - 10, 10); assert.ok(readerCalls > 0); readerCalls = 0; bytesRead = 0; await restored.getProcessManager().readOutput(id, total - 20, 10); assert.ok(bytesRead <= 1.5 * 1024 * 1024, `${bytesRead} bytes read after restart index`);
  } finally { await restored?.close(); await f.store.close(); await f.cleanup(); }
});

test('detached output is capped at the configured limit and the process is terminated', { skip: !posix && skipWindows }, async () => {
  const outputLimit = 256 * 1024, f = await fixture({ processOutputLimit: outputLimit });
  try {
    const result = await f.call('cap', 'bash', bashArgs(nodeCommand('process.stdout.write("中".repeat(100 * 1024));'), { detach: true }));
    assert.equal(result.ok, true); const id = result.content.match(/icy-process:([0-9a-f-]+)/)![1];
    const record = await f.store.getProcessManager().status(id, { waitMs: 10_000 });
    assert.equal(record.status, 'output_limit'); assert.equal(record.truncated, true); assert.ok(record.bytes <= outputLimit); assert.ok(record.bytes >= outputLimit - 3);
    const log = await readFile(path.join(f.store.dir, 'processes', `${id}.log`)); assert.equal(log.byteLength, record.bytes); assert.doesNotMatch(log.toString(), /�/);
  } finally { await f.cleanup(); }
});

test('terminal status waits for a delayed process log drain', { skip: !posix && skipWindows }, async () => {
  const outputLimit = 256 * 1024;
  let factoryCalls = 0, writeCalls = 0, endCalled = false, resolveSecondWrite!: () => void, resolveEndStarted!: () => void;
  const secondWriteStarted = new Promise<void>(resolve => { resolveSecondWrite = resolve; });
  const endStarted = new Promise<void>(resolve => { resolveEndStarted = resolve; });
  const f = await fixture({
    processOutputLimit: outputLimit,
    processLogWriterFactory: file => {
      factoryCalls++;
      return {
        write: async data => {
          writeCalls++;
          if (writeCalls === 2) {
            resolveSecondWrite();
            await new Promise(resolve => setTimeout(resolve, 30));
          }
          await appendFile(file, data);
        },
        end: async () => { resolveEndStarted(); await new Promise(resolve => setTimeout(resolve, 15)); endCalled = true; },
      };
    },
  });
  try {
    const result = await f.call('cap-drain-race', 'bash', bashArgs(nodeCommand('process.stdout.write("a".repeat(300 * 1024));'), { detach: true }));
    const id = result.content.match(/icy-process:([0-9a-f-]+)/)![1];
    await secondWriteStarted;
    const record = f.store.data.processes[0];
    await waitFor(() => record.status !== 'running');
    const terminalPending = f.store.getProcessManager().status(id);
    await endStarted; let statusResolved = false;
    void terminalPending.then(() => { statusResolved = true; });
    assert.equal(await pollFor(() => statusResolved, 10, 2), false);
    const terminal = await terminalPending;
    assert.equal(terminal.status, 'output_limit'); assert.equal(terminal.bytes, outputLimit); assert.equal(factoryCalls, 1); assert.ok(writeCalls >= 2); assert.equal(endCalled, true);
    const expected = 'a'.repeat(outputLimit);
    const log = await readFile(path.join(f.store.dir, 'processes', `${id}.log`)); assert.equal(log.toString(), expected);
    let offset = 1, output = '';
    while (true) {
      const page = await f.store.getProcessManager().readOutput(id, offset, 6000);
      output += page.text;
      if (!page.truncated) break;
      offset = page.end + 1;
    }
    assert.equal(output, expected);
  } finally { await f.cleanup(); }
});

test('detached redaction spans decoder chunks for secrets and sk tokens', async () => {
  const { child, stdout, stderr } = outputChild(4401);
  const processSpawn = (() => {
    setImmediate(() => {
      stdout.emit('data', Buffer.from('store-'));
      stdout.emit('data', Buffer.from('secret sk-1234'));
      stdout.emit('data', Buffer.from('567890123456')); stdout.emit('end'); stdout.emit('close');
      stderr.emit('end'); stderr.emit('close'); child.emit('close', 0, null);
    }); return child;
  }) as unknown as typeof spawn;
  const fakePlatform = process.platform === 'win32' ? 'win32' : process.platform;
  const f = await fixture({ platform: fakePlatform, shellPath: fakePlatform === 'win32' ? 'C:\\Git\\bin\\bash.exe' : '/bin/bash', processSpawn, processIdentity: () => 'fake', secrets: ['store-secret'] });
  try {
    const record = await f.store.getProcessManager().start({ toolCallId: 'chunk-redaction', command: 'fake', cwd: f.cwd, timeoutMs: 10_000 });
    await f.store.getProcessManager().status(record.id, { waitMs: 10_000 });
    const log = await readFile(path.join(f.store.dir, 'processes', `${record.id}.log`), 'utf8');
    assert.match(log, /\[REDACTED\]/); assert.doesNotMatch(log, /store-secret|sk-1234567890123456/);
  } finally { await f.cleanup(); }
});

test('detached stderr prefixes complete lines rather than chunks', async () => {
  const { child, stdout, stderr } = outputChild(4402);
  const processSpawn = (() => {
    setImmediate(() => {
      stderr.emit('data', Buffer.from('a\nb')); stderr.emit('data', Buffer.from('c\n')); stderr.emit('end'); stderr.emit('close');
      stdout.emit('end'); stdout.emit('close'); child.emit('close', 0, null);
    }); return child;
  }) as unknown as typeof spawn;
  const fakePlatform = process.platform === 'win32' ? 'win32' : process.platform;
  const f = await fixture({ platform: fakePlatform, shellPath: fakePlatform === 'win32' ? 'C:\\Git\\bin\\bash.exe' : '/bin/bash', processSpawn, processIdentity: () => 'fake' });
  try {
    const record = await f.store.getProcessManager().start({ toolCallId: 'stderr-lines', command: 'fake', cwd: f.cwd, timeoutMs: 10_000 });
    await f.store.getProcessManager().status(record.id, { waitMs: 10_000 });
    const log = await readFile(path.join(f.store.dir, 'processes', `${record.id}.log`), 'utf8');
    assert.equal(log, '[stderr] a\n[stderr] bc\n');
  } finally { await f.cleanup(); }
});

test('detached burst coalesces a million short lines without changing log bytes', async () => {
  const { child, stdout, stderr } = outputChild(4403), expected = 'x\n'.repeat(1_000_000), chunks: Buffer[] = [];
  let writeCalls = 0;
  const processSpawn = (() => {
    setImmediate(() => {
      stdout.emit('data', Buffer.from(expected)); stdout.emit('end'); stdout.emit('close');
      stderr.emit('end'); stderr.emit('close'); child.emit('close', 0, null);
    }); return child;
  }) as unknown as typeof spawn;
  const writer = async () => ({
    write: async (data: Uint8Array) => { writeCalls++; chunks.push(Buffer.from(data)); await new Promise<void>(resolve => setImmediate(resolve)); },
    end: async () => {},
  });
  const fakePlatform = process.platform === 'win32' ? 'win32' : process.platform;
  const f = await fixture({ platform: fakePlatform, shellPath: fakePlatform === 'win32' ? 'C:\\Git\\bin\\bash.exe' : '/bin/bash', processSpawn, processIdentity: () => 'fake', processLogWriterFactory: writer });
  try {
    const record = await f.store.getProcessManager().start({ toolCallId: 'burst-coalesce', command: 'fake', cwd: f.cwd, timeoutMs: 10_000 });
    await f.store.getProcessManager().status(record.id, { waitMs: 10_000 });
    assert.ok(writeCalls <= 2_000, `writer calls: ${writeCalls}`);
    assert.equal(Buffer.concat(chunks).toString(), expected);
  } finally { await f.cleanup(); }
});

test('detached coalesced writes preserve interleaved stdout and stderr enqueue order', async () => {
  const { child, stdout, stderr } = outputChild(4404), chunks: Buffer[] = [];
  let writeCalls = 0;
  const processSpawn = (() => {
    setImmediate(() => {
      stdout.emit('data', Buffer.from('out-1\nout-2\n'));
      stderr.emit('data', Buffer.from('err-1\n'));
      stdout.emit('data', Buffer.from('out-3\n'));
      stderr.emit('data', Buffer.from('err-2\n'));
      stdout.emit('end'); stdout.emit('close'); stderr.emit('end'); stderr.emit('close'); child.emit('close', 0, null);
    }); return child;
  }) as unknown as typeof spawn;
  const writer = async () => ({
    write: async (data: Uint8Array) => { writeCalls++; chunks.push(Buffer.from(data)); await new Promise<void>(resolve => setTimeout(resolve, 20)); },
    end: async () => {},
  });
  const fakePlatform = process.platform === 'win32' ? 'win32' : process.platform;
  const f = await fixture({ platform: fakePlatform, shellPath: fakePlatform === 'win32' ? 'C:\\Git\\bin\\bash.exe' : '/bin/bash', processSpawn, processIdentity: () => 'fake', processLogWriterFactory: writer });
  try {
    const record = await f.store.getProcessManager().start({ toolCallId: 'interleaved-coalesce', command: 'fake', cwd: f.cwd, timeoutMs: 10_000 });
    await f.store.getProcessManager().status(record.id, { waitMs: 10_000 });
    assert.ok(writeCalls < 5);
    assert.equal(Buffer.concat(chunks).toString(), 'out-1\nout-2\n[stderr] err-1\nout-3\n[stderr] err-2\n');
  } finally { await f.cleanup(); }
});

