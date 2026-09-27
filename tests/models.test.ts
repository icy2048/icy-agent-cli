import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseCCProfile, listModels, saveModelProfile, profileConfig, type ModelProfile } from '../src/config/models.js';
import type { Config } from '../src/config/load.js';
import { Agent } from '../src/core/agent.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

const profile: ModelProfile = { name: 'Test', provider: 'responses', baseUrl: 'https://example.test/v1', model: 'new-model', apiKey: 'private-test-key' };

test('CC Switch import resolves the active TOML provider and rejects invalid endpoints', () => {
  const settings = JSON.stringify({ auth: { OPENAI_API_KEY: 'local-secret' }, config: 'model="test-model"\nmodel_provider="happy"\nmodel_reasoning_effort="high"\n[model_providers.unused]\nbase_url="https://unused.test"\n[model_providers.happy]\nbase_url="https://happy.test/v1" # comment\nwire_api="responses"' });
  const imported = parseCCProfile('Happy Code', settings)!;
  assert.equal(imported.baseUrl, 'https://happy.test/v1'); assert.equal(imported.provider, 'responses'); assert.equal(imported.model, 'test-model'); assert.equal(imported.apiKey, 'local-secret');
  assert.throws(() => parseCCProfile('Bad', settings.replace('https://happy.test/v1', 'http://remote.test')), /HTTPS/);
});

test('model discovery uses the configured prefix and refuses redirects', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++; assert.equal(req.headers.authorization, `Bearer ${profile.apiKey}`);
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] })); }
    else { res.writeHead(302, { Location: '/v1/models' }); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await listModels({ ...profile, baseUrl: base + '/v1' }, new AbortController().signal), ['a', 'b']);
    await assert.rejects(listModels({ ...profile, baseUrl: base + '/redirect' }, new AbortController().signal)); assert.equal(requests, 2);
  } finally { server.close(); }
});

test('model configuration saves a private credential file and preserves unrelated settings', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-model-save-'));
  try {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ permissions: 'read-only', maxToolCalls: 9, thinkingExpanded: true }));
    await saveModelProfile(home, profile);
    const json = await readFile(path.join(home, 'config.json'), 'utf8'), stored = JSON.parse(json);
    assert.doesNotMatch(json, /private-test-key/); assert.equal(stored.permissions, 'read-only'); assert.equal(stored.maxToolCalls, 9);
    assert.equal(await readFile(path.join(home, stored.apiKeyFile), 'utf8'), profile.apiKey);
    assert.equal((await stat(path.join(home, stored.apiKeyFile))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(home, 'config.json'))).mode & 0o777, 0o600);
    assert.throws(() => profileConfig({} as Config, { ...profile, model: '' }), /模型名/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('switching models opens a new session and keeps the previous session intact; failed save keeps current model', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-switch-'));
  const config: Config = { home, cwd: home, model: 'old-model', apiKey: 'old-key', apiKeyEnv: 'ICY_API_KEY', baseUrl: 'https://old.test/v1', provider: 'responses', permissions: 'read-only', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 2, maxToolCalls: 3, maxTokens: 10000, maxContextChars: 10000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, { cwd: home, model: config.model, provider: config.provider, baseUrl: config.baseUrl });
  store.data.messages.push({ role: 'user', content: 'old conversation' }); await store.save();
  const provider = { complete: async () => ({ text: 'new provider', calls: [] }) };
  const agent = new Agent(config, provider, new ToolRegistry(config, store), store);
  try {
    const next = profileConfig(config, profile);
    await assert.rejects(agent.configure(next, provider, async () => { throw new Error('write failed'); }), /write failed/);
    assert.equal(agent.config.model, 'old-model'); assert.equal(agent.store, store);
    await agent.configure(next, provider, async () => {});
    assert.equal(agent.config.model, 'new-model'); assert.notEqual(agent.store.data.id, store.data.id); assert.equal(agent.store.data.messages.length, 0);
    const previous = await SessionStore.resume(home, store.data.id); assert.equal(previous.store.data.messages[0].content, 'old conversation'); await previous.store.close();
    assert.deepEqual(agent.tools.definitions().map(t => t.name), ['read']);
    assert.equal((await agent.run('hello', new AbortController().signal)).text, 'new provider');
  } finally { await agent.store.close(); await rm(home, { recursive: true, force: true }); }
});

test('private HTTP profile opt-in survives save and is removed when switching back', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-private-profile-'));
  const local = { ...profile, baseUrl: 'http://192.168.1.10:8000/v1', allowPrivateHttp: true };
  try {
    assert.equal(profileConfig({} as Config, local).allowPrivateHttp, true);
    assert.throws(() => profileConfig({ allowPrivateHttp: true } as Config, { ...local, allowPrivateHttp: undefined }), /HTTPS/);
    await saveModelProfile(home, local);
    let saved = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
    assert.equal(saved.allowPrivateHttp, true); assert.equal(saved.baseUrl, local.baseUrl);
    await saveModelProfile(home, profile);
    saved = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
    assert.equal(saved.allowPrivateHttp, undefined); assert.equal(saved.baseUrl, profile.baseUrl);
  } finally { await rm(home, { recursive: true, force: true }); }
});
