/**
 * Private temporary files for handing payloads to external commands.
 *
 * Two reasons this exists rather than writing to a fixed path under /tmp:
 *
 * `writeFileSync` follows symlinks. A predictable name like
 * `/tmp/prism-request.json` can be pre-created by any local user as a symlink
 * to a file the caller owns, and the write lands there instead. The sticky bit
 * does not help — the attacker owns the symlink and we follow it. A fresh
 * `mkdtemp` directory has an unpredictable name and mode 0700, so nothing can
 * be planted inside it.
 *
 * The callback shape exists so the directory is reclaimed on every path. The
 * first version of this helper returned the path and left callers to unlink
 * only the file, which leaked one empty directory per invocation, and unlinked
 * before throwing on failure so error paths leaked the file as well.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function withPrivateTemp<T>(name: string, content: string, use: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'prism-'));
  try {
    const file = join(dir, name);
    writeFileSync(file, content, { mode: 0o600 });
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
