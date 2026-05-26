import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finds the repository root by walking up from the current file
 * looking for prism-cli.sh (a known root marker).
 * Works from both source (cli/src/...) and compiled (cli/dist/src/...) paths.
 */
export function getRepoRoot(importMetaUrl: string): string {
  let dir = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'prism-cli.sh'))) {
      return dir;
    }
    dir = resolve(dir, '..');
  }
  throw new Error('Could not find repository root (looked for prism-cli.sh)');
}
