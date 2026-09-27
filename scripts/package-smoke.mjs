import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await access(path.join(root, 'dist', 'cli.js')); // Run npm run build first, as CI does.
const temporary = await mkdtemp(path.join(tmpdir(), 'icy-package-smoke-'));
try {
  const install = path.join(temporary, 'install'), home = path.join(temporary, 'home'), workspace = path.join(temporary, 'workspace');
  await Promise.all([mkdir(install), mkdir(home), mkdir(workspace)]);
  const userConfig = path.join(temporary, 'npm-user.config'), globalConfig = path.join(temporary, 'npm-global.config');
  await Promise.all([
    writeFile(userConfig, ''), writeFile(globalConfig, ''),
    writeFile(path.join(install, 'package.json'), JSON.stringify({ name: 'icy-package-smoke', private: true })),
    writeFile(path.join(workspace, 'README.md'), '# Installed package smoke fixture\n'),
  ]);
  // Use a fresh home, npm cache/config/prefix, and no inherited model credentials.
  // Both package installation and its executable stay inside the temporary tree.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    NO_COLOR: '1',
    ICY_HOME: path.join(temporary, 'empty-icy-home'),
    npm_config_cache: path.join(temporary, 'npm-cache'),
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_prefix: install,
    npm_config_update_notifier: 'false',
  };
  const npmPath = process.env.npm_execpath;
  const npm = args => exec(npmPath ? process.execPath : 'npm', npmPath ? [npmPath, ...args] : args, { cwd: root, env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  const packed = await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]);
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.length, 1);
  const tarball = path.join(temporary, metadata[0].filename);
  await npm(['install', '--prefix', install, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball]);
  const binary = path.join(install, 'node_modules', '.bin', 'icy');
  assert.ok((await stat(binary)).mode & 0o111, 'installed CLI must be executable');
  const run = args => exec(binary, args, { cwd: workspace, env, timeout: 15000, maxBuffer: 1024 * 1024 });
  const help = await run(['--help']);
  assert.match(help.stdout, /icy — AI agent CLI/); assert.equal(help.stderr, '');
  const version = await run(['--version']);
  assert.equal(version.stdout.trim(), pkg.version); assert.equal(version.stderr, '');
  await assert.rejects(access(env.ICY_HOME), { code: 'ENOENT' });
  const demo = await run(['--demo', '--json']);
  assert.equal(demo.stderr, ''); assert.ok(demo.stdout.endsWith('\n'));
  const events = demo.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'session'); assert.equal(events[0].demo, true);
  assert.deepEqual(events.at(-1), { type: 'done', reason: 'completed', ok: true });
  const results = events.filter(event => event.type === 'tool_end');
  assert.equal(results.length, 1); assert.equal(results[0].call.name, 'read'); assert.equal(results[0].result.ok, true);
  assert.match(results[0].result.content, /Installed package smoke fixture/);
  console.log(`Package smoke passed: ${pkg.name}@${pkg.version}, isolated installation, --help, --version, and offline --demo.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
