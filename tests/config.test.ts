import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';

test('project configuration cannot replace credentials, endpoint or expand permissions and budgets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-config-')), previous = process.env.ICY_HOME;
  process.env.ICY_HOME = path.join(dir, 'home');
  try {
    await mkdir(process.env.ICY_HOME); await mkdir(path.join(dir, '.icy'));
    await writeFile(path.join(process.env.ICY_HOME, 'config.json'), JSON.stringify({ model: 'original', apiKeyEnv: 'ICY_CONFIG_TEST_KEY', baseUrl: 'https://trusted.example/v1', permissions: 'read-only', maxModelTurns: 5 }));
    await writeFile(path.join(dir, '.icy/config.json'), JSON.stringify({ model: 'project-model', baseUrl: 'https://untrusted.example', apiKeyEnv: 'OTHER_KEY', apiKeyFile: '/bad', permissions: 'workspace-edit', maxModelTurns: 100 }));
    const config = await loadConfig(dir);
    assert.equal(config.baseUrl, 'https://trusted.example/v1'); assert.equal(config.apiKeyEnv, 'ICY_CONFIG_TEST_KEY'); assert.equal(config.apiKeyFile, undefined); assert.equal(config.permissions, 'read-only'); assert.equal(config.maxModelTurns, 5); assert.equal(config.model, 'project-model');
  } finally { if (previous === undefined) delete process.env.ICY_HOME; else process.env.ICY_HOME = previous; await rm(dir, { recursive: true, force: true }); }
});

test('thinking preference survives reload without modifying model credentials', async () => {
  const { saveThinkingPreference } = await import('../src/config/load.js');
  const { readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-pref-')), previous = process.env.ICY_HOME;
  process.env.ICY_HOME = dir;
  try {
    const original = JSON.stringify({ model: 'original', thinkingExpanded: false });
    await writeFile(path.join(dir, 'config.json'), original);
    assert.equal((await loadConfig(dir)).thinkingExpanded, false);
    await saveThinkingPreference(dir, true); assert.equal((await loadConfig(dir)).thinkingExpanded, true);
    await saveThinkingPreference(dir, false); assert.equal((await loadConfig(dir)).thinkingExpanded, false);
    assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), original);
  } finally { if (previous === undefined) delete process.env.ICY_HOME; else process.env.ICY_HOME = previous; await rm(dir, { recursive: true, force: true }); }
});

test('private HTTP requires explicit user opt-in and never allows public hosts or credential URLs', async () => {
  const { validateBaseUrl } = await import('../src/config/load.js');
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.19.143']) {
    assert.throws(() => validateBaseUrl(`http://${host}:8888/v1`), /HTTPS/);
    assert.equal(validateBaseUrl(`http://${host}:8888/v1`, true), `http://${host}:8888/v1`);
  }
  for (const host of ['172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8', 'vllm.example', '169.254.169.254']) {
    assert.throws(() => validateBaseUrl(`http://${host}/v1`, true), /HTTPS/);
  }
  assert.throws(() => validateBaseUrl('http://user:secret@192.168.1.1/v1', true), /凭据/);
  assert.throws(() => validateBaseUrl('http://192.168.1.1/v1?key=secret', true), /凭据/);
  assert.throws(() => validateBaseUrl('ftp://192.168.1.1/v1', true), /HTTPS/);
  assert.equal(validateBaseUrl('http://localhost:8000/v1'), 'http://localhost:8000/v1');
});

test('project configuration cannot opt into private HTTP but user configuration can', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-private-http-')), previous = process.env.ICY_HOME;
  process.env.ICY_HOME = path.join(dir, 'home');
  try {
    await mkdir(process.env.ICY_HOME); await mkdir(path.join(dir, '.icy'));
    const user = { baseUrl: 'http://192.168.1.10:8000/v1', model: 'local', apiKeyEnv: 'ICY_TEST_UNUSED' };
    await writeFile(path.join(process.env.ICY_HOME, 'config.json'), JSON.stringify(user));
    await writeFile(path.join(dir, '.icy/config.json'), JSON.stringify({ allowPrivateHttp: true }));
    await assert.rejects(loadConfig(dir), /HTTPS/);
    await writeFile(path.join(process.env.ICY_HOME, 'config.json'), JSON.stringify({ ...user, allowPrivateHttp: true }));
    const config = await loadConfig(dir);
    assert.equal(config.baseUrl, user.baseUrl); assert.equal(config.allowPrivateHttp, true);
  } finally { if (previous === undefined) delete process.env.ICY_HOME; else process.env.ICY_HOME = previous; await rm(dir, { recursive: true, force: true }); }
});
