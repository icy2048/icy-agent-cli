import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export function sensitive(file: string): boolean {
  return file.split(/[\\/]/).some(part => /^(?:\.git|\.icy|\.ssh|\.aws|\.gnupg|\.kube|credentials|id_rsa|id_ed25519)$/i.test(part)
    || /^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part)
    || /\.(?:pem|key|p12|pfx)$/i.test(part));
}
export async function workspacePath(cwd: string, input: string): Promise<string> {
  if (input.includes('\0')) throw new Error('invalid_path');
  const root = await realpath(cwd);
  const target = path.resolve(root, input);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('path_outside_workspace');
  if (sensitive(relative)) throw new Error('sensitive_path');
  let cursor = root;
  // Reject every symlink, even one that currently resolves inside the workspace.
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('symlink_not_allowed'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e; }
  }
  return target;
}
