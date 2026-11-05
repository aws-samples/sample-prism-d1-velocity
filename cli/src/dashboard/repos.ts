/**
 * Which repositories the dashboard shows.
 *
 * All discovery goes through discoverRepos() so a registry (for example
 * ~/.prism/repos.json written by `enable codewatch`) can be added later as one
 * more source without touching the collectors or the server.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface RepoRef {
  name: string;
  path: string;
}

/** Directories never descended into while scanning. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'cdk.out']);
export const DEFAULT_SCAN_DEPTH = 3;
export const MAX_REPOS = 200;

export function gitToplevel(cwd: string): string | null {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function isRepoWithPrism(dir: string): boolean {
  return existsSync(join(dir, '.git')) && existsSync(join(dir, '.prism'));
}

/**
 * Repos under `root` (to `depth` levels) that have both `.git` and `.prism/`.
 * A repo's own subdirectories are not scanned further. Symlinks are not followed.
 */
export function scanForRepos(root: string, depth = DEFAULT_SCAN_DEPTH): RepoRef[] {
  const out: RepoRef[] = [];
  const walk = (dir: string, level: number) => {
    if (out.length >= MAX_REPOS) return;
    if (isRepoWithPrism(dir)) {
      out.push({ name: basename(dir), path: dir });
      return;
    }
    if (level >= depth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries.sort()) {
      if (e.startsWith('.') || SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      try {
        const st = statSync(p, { throwIfNoEntry: false } as any);
        if (!st || !st.isDirectory()) continue;
      } catch { continue; }
      walk(p, level + 1);
    }
  };
  walk(resolve(root), 0);
  return out;
}

export interface DiscoverOptions {
  cwd: string;
  all?: boolean;
  root?: string;
}

export interface Discovery {
  repos: RepoRef[];
  /** Where --all scanned, when it did. */
  scannedRoot: string | null;
  /** Set when the scope could not be resolved. */
  error: string | null;
}

/**
 * Default: the git repo containing `cwd` (shown even without `.prism/`, so the
 * empty states can tell the user what to install). `--all`: repos with
 * `.prism/` under `root`, default the parent of the current repo.
 */
export function discoverRepos(opts: DiscoverOptions): Discovery {
  const current = gitToplevel(opts.cwd);
  if (!opts.all) {
    if (!current) return { repos: [], scannedRoot: null, error: 'not inside a git repository (use --all --root <dir> to scan)' };
    return { repos: [{ name: basename(current), path: current }], scannedRoot: null, error: null };
  }
  const root = resolve(opts.root || (current ? dirname(current) : opts.cwd));
  if (!existsSync(root)) return { repos: [], scannedRoot: root, error: `root does not exist: ${root}` };
  return { repos: scanForRepos(root), scannedRoot: root, error: null };
}
