import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directories that together identify the repository root.
 *
 * This was previously a single marker file, `prism-cli.sh`. That made an
 * unrelated cleanup — deleting a launcher script no longer needed once the CLI
 * shipped on npm — silently change where four commands resolved their paths,
 * with no failing build or test to catch it. A marker whose only job is to be a
 * marker is invisible to the person deleting it.
 *
 * These three are not arbitrary: they are exactly the directories the callers
 * resolve against the returned root (`cli`, `infra`, `sample-app`, and
 * `sample-app/agent`). Requiring all three means a positive match already
 * guarantees those paths exist, and no single file rename or doc cleanup can
 * invalidate the marker — removing any of them would be a repo restructure that
 * breaks the commands regardless.
 */
const ROOT_MARKERS = ['cli', 'infra', 'sample-app'];

function isRepoRoot(dir: string): boolean {
  return ROOT_MARKERS.every((marker) => existsSync(resolve(dir, marker)));
}

/** Walks up at most 10 levels from `start`, returning the first repo root found. */
function walkUpForRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (isRepoRoot(dir)) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * Finds the repository root by looking for the ROOT_MARKERS directories,
 * first walking up from this module (a source or built checkout), then from the
 * current working directory (globally installed via npm, user inside a checkout).
 *
 * Falls back to `process.cwd()` when neither walk finds a root. That case only
 * arises when the CLI is installed globally and run outside a checkout, where
 * there is no repository to point at; the caller then fails on the missing
 * subdirectory it tried to use.
 */
export function getRepoRoot(importMetaUrl: string): string {
  return (
    walkUpForRoot(dirname(fileURLToPath(importMetaUrl))) ??
    walkUpForRoot(process.cwd()) ??
    process.cwd()
  );
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
