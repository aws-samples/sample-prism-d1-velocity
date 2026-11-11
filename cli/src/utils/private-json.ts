/** Small JSON files only this user can read (the dashboard's caches under ~/.prism/cache). */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/** Writes `body` to `file` through a temp file and a rename, so a reader never sees half a file. Dir 0700, file 0600. */
export function writePrivateJson(file: string, body: unknown): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Parsed JSON, or null when the file is missing or not JSON. */
export function readJson(file: string): any {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
