import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export interface PathModule {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
  sep: string;
}

/** Normalize paths for comparisons without changing the POSIX on-disk format. */
export function canonicalPath(p: string, platform = process.platform): string {
  if (platform !== 'win32') return p;
  return p.replace(/[\\/]/g, '\\').replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

export function sensitive(file: string): boolean {
  return file.split(/[\\/]/).some(part => /^(?:\.git|\.icy|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.htpasswd|credentials|id_rsa|id_ed25519)$/i.test(part)
    || /^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part)
    || /\.(?:pem|key|p12|pfx|token)$/i.test(part));
}
export interface WorkspacePathOptions {
  platform?: NodeJS.Platform;
  pathModule?: PathModule;
}

export async function workspacePath(cwd: string, input: string, options: WorkspacePathOptions = {}): Promise<string> {
  if (input.includes('\0')) throw new Error('invalid_path');
  const platform = options.platform ?? process.platform;
  const pathModule = options.pathModule ?? path;
  const root = canonicalPath(await realpath(cwd), platform);
  const target = canonicalPath(pathModule.resolve(root, input), platform);
  const relative = pathModule.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative)) throw new Error('path_outside_workspace');
  if (sensitive(relative)) throw new Error('sensitive_path');
  let cursor = root;
  // Reject every symlink, even one that currently resolves inside the workspace.
  // On Windows, lstat reports directory junctions as symbolic links too.
  for (const part of relative.split(pathModule.sep).filter(Boolean)) {
    cursor = pathModule.join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('symlink_not_allowed'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e; }
  }
  return target;
}
