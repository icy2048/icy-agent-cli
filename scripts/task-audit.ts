import path from 'node:path';
import type { Message } from '../src/core/types.js';

export interface TaskContract { reads: string[]; writable: string[] }
const object = (text: string): Record<string, unknown> => {
  try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
};

/** Independently check performed steps, including writes later reverted to their original bytes. */
export function auditTaskExecution(messages: Message[], cwd: string, contract: TaskContract) {
  const outputs = new Map(messages.filter(m => m.role === 'tool').map(m => [m.id, object(m.content)]));
  const calls = messages.filter(m => m.role === 'assistant').flatMap(m => m.calls);
  const trace = calls.map((call, index) => {
    const args = object(call.arguments), result = outputs.get(call.id);
    return { ...call, index, ok: result?.ok === true, error: typeof result?.error === 'string' ? result.error : undefined,
      file: typeof args.path === 'string' ? path.resolve(cwd, args.path) : undefined,
      verification: call.name === 'bash' && typeof args.command === 'string' && args.command.trim() === 'node verify.cjs' && path.resolve(cwd, typeof args.cwd === 'string' ? args.cwd : '.') === cwd,
      verified: result?.ok === true && typeof result.content === 'string' && result.content.includes('fixture checks passed') };
  });
  const mutations = trace.filter(call => call.ok && ['write', 'edit'].includes(call.name));
  const check = trace.findLast(call => call.verification);
  const before = mutations[0]?.index ?? check?.index ?? Infinity;
  const unmetRequirements: string[] = [];
  for (const file of contract.reads) if (!trace.some(call => call.ok && call.name === 'read' && call.file === path.resolve(cwd, file) && call.index < before)) unmetRequirements.push(`read_before_changes:${file}`);
  const writable = new Set(contract.writable.map(file => path.resolve(cwd, file)));
  for (const call of mutations) if (!call.file || !writable.has(call.file)) unmetRequirements.push(`unexpected_mutation:${call.file ? path.relative(cwd, call.file) : call.id}`);
  const checked = check?.verified === true;
  if (!checked || mutations.some(call => call.index > check!.index)) unmetRequirements.push('successful_verification_after_changes');
  return { passed: unmetRequirements.length === 0, checked, unmetRequirements, toolTrace: trace.map(({ file: _file, verification: _verification, verified: _verified, ...call }) => call) };
}
