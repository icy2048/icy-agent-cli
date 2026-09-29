import path from 'node:path';
import { realpath as nativeRealpathCallback } from 'node:fs';
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

function nativeRealpath(p: string): Promise<string> {
  return new Promise((resolve, reject) => nativeRealpathCallback.native(p, (error, resolved) => error ? reject(error) : resolve(resolved)));
}

async function realpathForPlatform(p: string, platform: string): Promise<string> {
  if (platform !== 'win32') return realpath(p);
  try { return await nativeRealpath(p); }
  catch { return realpath(p); }
}

/** Resolve a workspace path, expanding native Windows path aliases when available. */
export async function resolveWorkspacePath(p: string, platform = process.platform): Promise<string> {
  const pathModule = platform === 'win32' ? path.win32 : path;
  const resolved = pathModule.resolve(p);
  let target: string | undefined;
  const remainder: string[] = [];
  let ancestor = resolved;
  while (target === undefined) {
    try {
      const realAncestor = await realpathForPlatform(ancestor, platform);
      target = pathModule.join(realAncestor, ...remainder);
    } catch {
      const parent = pathModule.dirname(ancestor);
      if (parent === ancestor) {
        // A removed workspace is still a valid filter, even if no ancestor exists.
        target = resolved;
      } else {
        remainder.unshift(pathModule.basename(ancestor));
        ancestor = parent;
      }
    }
  }
  return canonicalPath(target, platform);
}

export function sensitive(file: string): boolean {
  return file.split(/[\\/]/).some(part => /^(?:\.git|\.icy|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.htpasswd|credentials|id_rsa|id_ed25519|id_dsa|id_ecdsa|id_ecdsa_sk|id_ed25519_sk|\.envrc)$/i.test(part)
    || /^\.env(?:\.|$)/i.test(part) && !/^\.env\.(?:example|sample|template)$/i.test(part)
    || /\.(?:pem|key|p12|pfx|token)$/i.test(part));
}
export interface WorkspacePathOptions {
  platform?: NodeJS.Platform;
  pathModule?: PathModule;
  mustExist?: boolean;
}

export async function workspacePath(cwd: string, input: string, options: WorkspacePathOptions = {}): Promise<string> {
  if (input.includes('\0')) throw new Error('invalid_path');
  const platform = options.platform ?? process.platform;
  const pathModule = options.pathModule ?? path;
  const root = await resolveWorkspacePath(cwd, platform);
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
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { if (options.mustExist) throw e; break; } throw e; }
  }
  return target;
}
