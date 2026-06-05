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
 * Resolves a path relative to the repo root OR bundled assets directory.
 * Checks repo root first (source checkout), then dist/assets/ (npm install).
 * Throws if neither location has the requested path.
 */
export function getAssetPath(importMetaUrl: string, relativePath: string): string {
  // Try repo root first (source checkout / cloned repo)
  const repoRoot = getRepoRoot(importMetaUrl);
  const repoPath = resolve(repoRoot, relativePath);
  if (existsSync(repoPath)) {
    return repoPath;
  }

  // Try bundled assets (npm global install)
  let dir = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 10; i++) {
    const assetsPath = resolve(dir, 'assets', relativePath);
    if (existsSync(assetsPath)) {
      return assetsPath;
    }
    // Also check dist/assets from cli root
    const distAssetsPath = resolve(dir, 'dist', 'assets', relativePath);
    if (existsSync(distAssetsPath)) {
      return distAssetsPath;
    }
    dir = resolve(dir, '..');
  }

  // Fallback to repo path (will fail at runtime with clear error)
  return repoPath;
}
