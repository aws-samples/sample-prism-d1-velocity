/**
 * Which repositories the dashboard shows.
 *
 * Default: every repo under the user's home directory (3 levels deep) that has
 * both `.git` and `.prism/`, wherever the dashboard is started from. The repo
 * containing the working directory, if any, is listed first even without
 * `.prism/`, so its empty state can say what to install. `--root` moves the
 * scan. Everything goes through discoverRepos() so a registry could be added
 * later as one more source.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface RepoRef {
  name: string;
  /** Real path (symlinks resolved), so the current repo and a scanned one compare equal. */
  path: string;
  /** Contains the working directory the dashboard was started in. */
  current: boolean;
  hasPrism: boolean;
}

/**
 * Directory names never descended into. Hidden names (leading `.`) are skipped
 * separately, which covers `.git`, `.cache`, `.venv` and the like.
 */
export const SKIP_DIRS = new Set(['node_modules', 'Library', 'build', 'dist', 'target', 'venv', '__pycache__', 'cdk.out']);
export const DEFAULT_SCAN_DEPTH = 3;
export const MAX_REPOS = 200;
/** Hard cap on directories listed, so an unusually wide home cannot stall the page. */
export const MAX_DIRS_VISITED = 20_000;

export function gitToplevel(cwd: string): string | null {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function real(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export interface ScanResult {
  repos: RepoRef[];
  /** Directories listed. */
  visited: number;
  /** A cap (MAX_REPOS or MAX_DIRS_VISITED) stopped the scan early. */
  truncated: boolean;
}

/**
 * Repos under `root`, at most `depth` levels below it, that have both `.git`
 * and `.prism/`.
 *
 * - The walk stops at any git repo: nothing inside a repo is scanned, so
 *   nested repos and big working trees are skipped.
 * - Hidden directories and SKIP_DIRS are never entered.
 * - Symlinks are not followed (Dirent.isDirectory() is false for a link).
 * - An unreadable directory is skipped, not an error.
 * - `root` itself is never treated as a repo, so a home directory kept under
 *   git (dotfiles) does not end the scan before it starts.
 */
export function scanForRepos(root: string, depth = DEFAULT_SCAN_DEPTH): ScanResult {
  const repos: RepoRef[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (dir: string, level: number) => {
    if (truncated) return;
    if (level > 0 && existsSync(join(dir, '.git'))) {
      if (isDir(join(dir, '.prism'))) {
        repos.push({ name: basename(dir), path: real(dir), current: false, hasPrism: true });
        if (repos.length >= MAX_REPOS) truncated = true;
      }
      return;
    }
    if (level >= depth) return;
    if (++visited > MAX_DIRS_VISITED) { truncated = true; return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), level + 1);
    }
  };
  walk(resolve(root), 0);
  return { repos, visited, truncated };
}

export interface DiscoverOptions {
  cwd: string;
  /** Scan root; default the home directory. */
  root?: string;
  /** Injected in tests instead of os.homedir(). */
  home?: string;
}

export interface Discovery {
  repos: RepoRef[];
  scannedRoot: string;
  /** Path of the repo containing cwd, or null. */
  currentRepo: string | null;
  scanMs: number;
  truncated: boolean;
  /** Set when the scan root could not be used. */
  error: string | null;
}

export function discoverRepos(opts: DiscoverOptions): Discovery {
  const t0 = Date.now();
  const top = gitToplevel(opts.cwd);
  const currentRepo = top ? real(top) : null;
  const scannedRoot = resolve(opts.root || opts.home || homedir());
  const out: RepoRef[] = [];
  if (currentRepo) {
    out.push({ name: basename(currentRepo), path: currentRepo, current: true, hasPrism: isDir(join(currentRepo, '.prism')) });
  }
  if (!isDir(scannedRoot)) {
    return { repos: out, scannedRoot, currentRepo, scanMs: Date.now() - t0, truncated: false, error: `scan root is not a directory: ${scannedRoot}` };
  }
  const scan = scanForRepos(scannedRoot);
  for (const r of scan.repos) if (r.path !== currentRepo) out.push(r);
  return { repos: out, scannedRoot, currentRepo, scanMs: Date.now() - t0, truncated: scan.truncated, error: null };
}
