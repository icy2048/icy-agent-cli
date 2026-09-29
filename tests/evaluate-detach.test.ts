import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('evaluate-tasks detached-service self-test checks start, poll, verify and stop', { skip: process.platform === 'win32' && 'Windows process groups make detached cleanup flaky' }, async () => {
  const script = fileURLToPath(new URL('../scripts/evaluate-tasks.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, '--self-test'], { cwd: path.dirname(path.dirname(script)), env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`self-test timed out: ${stdout}\n${stderr}`)); }, 12000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  assert.match(stdout, /^self-test detached-service: ideal=ok detach_used=met service_stopped=met; no-kill=failed service_stopped=unmet\n$/);
});
