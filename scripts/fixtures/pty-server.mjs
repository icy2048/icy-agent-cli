// Local deterministic HTTP peer for operating the real CLI in a Linux PTY.
// Never contact an external service or load real credentials.
import { createServer } from 'node:http';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2];
const port = Number(process.env.ICY_PTY_PORT ?? 40087);
if (!root) throw new Error('Provide an isolated fixture directory.');
await mkdir(path.join(root, 'home'), { recursive: true });
await mkdir(path.join(root, 'workspace'), { recursive: true });
await writeFile(path.join(root, 'home/config.json'), JSON.stringify({ provider: 'chat-completions', model: 'linux-pty-fixture', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'ICY_PTY_KEY', promptCompaction: 'local', requestTimeoutMs: 30000 }));
let sequence = 0;
createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw), messages = body.messages;
  await appendFile(path.join(root, 'requests.jsonl'), JSON.stringify({ messages }) + '\n');
  const last = messages.findLastIndex(m => m.role === 'user' && !m.content.startsWith('[icy '));
  const prompt = messages[last]?.content ?? '', results = messages.slice(last + 1).filter(m => m.role === 'tool');
  let call;
  if (!results.length) {
    if (prompt.includes('长命令')) call = { name: 'bash', args: { command: "printf begun > slow.txt; sleep 20; printf finished >> slow.txt", cwd: null, timeoutMs: 60000 } };
    else if (prompt.includes('拒绝')) call = { name: 'bash', args: { command: 'touch denied.txt', cwd: null, timeoutMs: 60000 } };
    else call = { name: 'write', args: { path: 'note.txt', content: '你好🙂', expectedHash: null } };
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = call ? { tool_calls: [{ index: 0, id: `pty-${++sequence}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: '已根据实际工具结果结束本轮。请使用 /verify 登记验收。' };
  response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}).listen(port, '127.0.0.1', () => console.log('Linux PTY fixture ready.'));
