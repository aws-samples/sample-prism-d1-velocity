import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finds the repository root by walking up from the current file
 * looking for prism-cli.sh (a known root marker).
 * Works from both source (cli/src/...) and compiled (cli/dist/src/...) paths.
 * When installed globally via npm, falls back to walking up from cwd.
 */
export function getRepoRoot(importMetaUrl: string): string {
  // First try walking up from the script location (works in source checkout)
  let dir = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'prism-cli.sh'))) {
      return dir;
    }
    dir = resolve(dir, '..');
  }
  // When installed via npm, walk up from cwd instead
  dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'prism-cli.sh'))) {
      return dir;
    }
    dir = resolve(dir, '..');
  }
  // Final fallback: cwd itself (user should be in the repo)
  return process.cwd();
}

/**
 * Resolves a path relative to the bundled assets directory.
 * Always uses dist/assets/ from the npm package.
 */
export function getAssetPath(importMetaUrl: string, relativePath: string): string {
  // Strip leading directory prefix (e.g. 'bootstrapper/metric-hooks' -> 'metric-hooks')
  // because the build copies into dist/assets/ without parent dirs
  const candidates = [relativePath, relativePath.replace(/^[^/]+\//, '')];

  let dir = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 10; i++) {
    for (const candidate of candidates) {
      const assetsPath = resolve(dir, 'assets', candidate);
      if (existsSync(assetsPath)) return assetsPath;
      const distAssetsPath = resolve(dir, 'dist', 'assets', candidate);
      if (existsSync(distAssetsPath)) return distAssetsPath;
    }
    dir = resolve(dir, '..');
  }

  throw new Error(`Asset not found: ${relativePath}. Run 'npm run build' first.`);
}
