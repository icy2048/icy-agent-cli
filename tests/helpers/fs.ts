import { symlink } from 'node:fs/promises';
import path from 'node:path';

/** Create a link, falling back to a Windows junction only for directory links. */
export async function makeSymlink(target: string, link: string, kind: 'file' | 'dir'): Promise<void> {
  try {
    await symlink(target, link, kind);
  } catch (error) {
    if (process.platform !== 'win32' || kind !== 'dir') throw error;
    await symlink(path.resolve(path.dirname(link), target), link, 'junction');
  }
}
