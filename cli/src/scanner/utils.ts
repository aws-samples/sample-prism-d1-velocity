import { glob } from 'glob';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const IGNORE = ['node_modules/**', 'dist/**', '.git/**', 'package-lock.json', 'yarn.lock', 'vendor/**'];

/** Glob files in a repo, always ignoring common dirs. */
export async function findFiles(repoPath: string, patterns: string | string[], extraIgnore: string[] = []): Promise<string[]> {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  const results = new Set<string>();
  for (const p of pats) {
    const matches = await glob(p, { cwd: repoPath, dot: true, ignore: [...IGNORE, ...extraIgnore] }).catch(() => []);
    matches.forEach((m) => results.add(m));
  }
  return [...results];
}

/** Read file contents, returning empty string on failure. */
export function readSafe(repoPath: string, file: string): string {
  try { return readFileSync(join(repoPath, file), 'utf-8'); } catch { return ''; }
}

/** Build a content cache for up to `limit` files. */
export async function buildContentCache(repoPath: string, patterns: string | string[], limit = 200): Promise<Map<string, string>> {
  const files = await findFiles(repoPath, patterns);
  const cache = new Map<string, string>();
  for (const f of files.slice(0, limit)) {
    const content = readSafe(repoPath, f);
    if (content) cache.set(f, content);
  }
  return cache;
}

/** Check if any pattern matches any value in a content cache. Returns [matched file, matched pattern source] or null. */
export function searchCache(cache: Map<string, string>, patterns: RegExp[]): { file: string; pattern: string } | null {
  for (const [file, content] of cache) {
    for (const pat of patterns) {
      if (pat.test(content)) return { file, pattern: pat.source };
    }
  }
  return null;
}

/** Check if a path exists and is a directory. */
export function dirExists(repoPath: string, subPath: string): boolean {
  const full = join(repoPath, subPath);
  return existsSync(full) && statSync(full).isDirectory();
}

/** Check if a file exists. */
export function fileExists(repoPath: string, subPath: string): boolean {
  return existsSync(join(repoPath, subPath));
}
