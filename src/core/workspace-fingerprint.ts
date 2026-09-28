import fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface WorkspaceFingerprintOptions {
  ignorePaths?: string[];
  signal?: AbortSignal;
  /** Maximum entries, including directories and symlinks; the workspace root is excluded. */
  maxFiles?: number;
  /** Maximum regular-file and symlink-target bytes read. */
  maxBytes?: number;
  /** Filesystem platform, injectable for cross-platform tests. */
  platform?: NodeJS.Platform;
}

export function unchanged(before: BigIntStats, after: BigIntStats, platform = process.platform): boolean {
  return before.dev === after.dev && before.ino === after.ino && (platform === 'win32' || before.mode === after.mode)
    && before.nlink === after.nlink && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/**
 * Local-only change detection, not a filesystem snapshot or sandbox. No file names
 * or bytes leave this function. Unknown/unreadable/unstable trees return undefined.
 * Only explicitly named subtrees are ignored; secrets and dependencies are hashed.
 */
export async function fingerprintWorkspace(cwd: string, options: WorkspaceFingerprintOptions = {}): Promise<string | undefined> {
  const { signal, maxFiles = 10_000, maxBytes = 64 * 1024 * 1024, platform = process.platform } = options;
  signal?.throwIfAborted();
  if (![maxFiles, maxBytes].every(value => Number.isSafeInteger(value) && value >= 0)) return;
  const root = path.resolve(cwd), ignored = (options.ignorePaths ?? []).map(value => path.resolve(root, value));
  const isIgnored = (file: string) => ignored.some(base => file === base || file.startsWith(base + path.sep));
  const hash = createHash('sha256');
  const snapshots = new Map<string, BigIntStats>();
  let files = 0, bytes = 0;
  const uncertain = () => { throw new Error('Workspace fingerprint is unknown.'); };
  const check = () => signal?.throwIfAborted();
  const add = (relative: string, type: string, mode: bigint, content = '') => {
    // Windows mode values do not carry POSIX permission bits and must not affect the fingerprint.
    hash.update(JSON.stringify([relative, type, platform === 'win32' ? '' : mode.toString(), content]) + '\n');
  };
  const visit = async (file: string, relative: string): Promise<void> => {
    check();
    if (isIgnored(file)) return;
    if (relative && ++files > maxFiles) uncertain();
    const before = await fs.lstat(file, { bigint: true });
    check(); snapshots.set(file, before);
    if (before.isSymbolicLink()) {
      if (before.size > BigInt(maxBytes - bytes)) uncertain();
      const target = await fs.readlink(file, { encoding: 'buffer' });
      bytes += target.length;
      if (bytes > maxBytes) uncertain();
      add(relative, 'symlink', before.mode, target.toString('hex'));
    } else if (before.isDirectory()) {
      add(relative, 'directory', before.mode);
      const names: string[] = [];
      // Stop enumeration at the entry budget, rather than allocating an unbounded readdir array.
      const directory = await fs.opendir(file);
      for await (const entry of directory) {
        check();
        if (isIgnored(path.join(file, entry.name))) continue;
        if (files + names.length >= maxFiles) uncertain();
        names.push(entry.name);
      }
      check();
      if (!unchanged(before, await fs.lstat(file, { bigint: true }), platform)) uncertain();
      for (const name of names.sort()) await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (before.isFile()) {
      if (before.size > BigInt(maxBytes - bytes)) uncertain();
      // Do not follow a file swapped for a link, or block if it becomes a FIFO after lstat.
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!unchanged(before, await handle.stat({ bigint: true }), platform)) uncertain();
        const content = createHash('sha256'), buffer = Buffer.alloc(Math.min(64 * 1024, Number(before.size)));
        let read = 0;
        while (read < Number(before.size)) {
          check();
          const chunk = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - read), null);
          if (!chunk.bytesRead) uncertain();
          read += chunk.bytesRead; bytes += chunk.bytesRead;
          if (bytes > maxBytes) uncertain();
          content.update(buffer.subarray(0, chunk.bytesRead));
        }
        check();
        if (!unchanged(before, await handle.stat({ bigint: true }), platform)) uncertain();
        add(relative, 'file', before.mode, content.digest('hex'));
      } finally { await handle.close(); }
    } else uncertain();
    check();
    if (!unchanged(before, await fs.lstat(file, { bigint: true }), platform)) uncertain();
  };
  try {
    const rootStat = await fs.lstat(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || isIgnored(root)) return;
    await visit(root, '');
    // Catch changes to an earlier file while a later part of the tree was being read.
    for (const [file, before] of snapshots) {
      check();
      if (!unchanged(before, await fs.lstat(file, { bigint: true }), platform)) uncertain();
    }
    check();
    return hash.digest('hex');
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}
