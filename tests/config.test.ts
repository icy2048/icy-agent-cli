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
