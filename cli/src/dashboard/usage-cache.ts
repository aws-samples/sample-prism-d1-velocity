/**
 * Cache for the usage panel: ~/.prism/cache/usage.json (dir 0700, file 0600).
 *
 * codeburn exports take seconds, so the dashboard serves the cached panel at
 * once and refreshes it in the background once it is older than the TTL. Only
 * real data (status ok or no-data) is written: a failed or missing codeburn is
 * never cached, so it cannot be shown later as if it were data. A cache from
 * an earlier local day is ignored, since its "today" is no longer today.
 */
import { join } from 'node:path';
import { localDate, type UsagePanel } from './usage.js';
import { readJson, writePrivateJson } from '../utils/private-json.js';

export const USAGE_CACHE_SCHEMA = 'prism.usage-cache.v1';
export const USAGE_TTL_MS = 5 * 60_000;

export function prismCacheDir(home: string): string {
  return join(home, '.prism', 'cache');
}

export function usageCachePath(home: string): string {
  return join(prismCacheDir(home), 'usage.json');
}

/** Tool versions by binary mtime and size (tool-check.ts cachedToolVersion). */
export function versionCachePath(home: string): string {
  return join(prismCacheDir(home), 'tool-versions.json');
}

const cacheable = (u: UsagePanel) => u.status === 'ok' || u.status === 'no-data';

export interface UsageCacheDeps {
  file: string;
  /** Runs the codeburn exports (collectUsage). */
  collect: () => Promise<UsagePanel>;
  now?: () => Date;
  ttlMs?: number;
}

export interface UsageResult {
  usage: UsagePanel;
  cacheHit: boolean;
  /** The background refresh started for a stale hit; null when none was needed. */
  refresh: Promise<UsagePanel> | null;
}

export class UsageCache {
  private refreshing: Promise<UsagePanel> | null = null;
  private lastError: string | null = null;
  /** The last refresh's result when it was a failure; kept in memory only, never written. */
  private lastFailure: UsagePanel | null = null;
  private readonly now: () => Date;
  private readonly ttl: number;

  constructor(private readonly d: UsageCacheDeps) {
    this.now = d.now || (() => new Date());
    this.ttl = d.ttlMs ?? USAGE_TTL_MS;
  }

  /** The cached panel for today, marked stale past the TTL, without running codeburn; null when there is none. */
  peek(): UsagePanel | null {
    const c = readJson(this.d.file);
    const now = this.now();
    if (!c || c.schema !== USAGE_CACHE_SCHEMA || c.day !== localDate(now) || typeof c.savedAt !== 'number' || !c.panel || !cacheable(c.panel)) return null;
    return { ...c.panel, stale: now.getTime() - c.savedAt >= this.ttl, refreshError: this.lastError };
  }

  /** What to show without running codeburn: the cached panel, else the last failure, else null (not loaded yet). */
  current(): UsagePanel | null {
    return this.peek() || this.lastFailure;
  }

  /** Runs the exports now; one at a time, so concurrent callers share the same run. Writes only real data. */
  refresh(): Promise<UsagePanel> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const u = await this.d.collect();
        if (cacheable(u)) {
          this.lastError = null;
          this.lastFailure = null;
          try {
            writePrivateJson(this.d.file, { schema: USAGE_CACHE_SCHEMA, savedAt: this.now().getTime(), day: localDate(this.now()), panel: u });
          } catch (e: any) {
            process.stderr.write(`prism dashboard: could not write the usage cache: ${e?.message || e}\n`);
          }
        } else {
          this.lastError = u.message || u.status;
          this.lastFailure = u;
        }
        return u;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /**
   * fresh: wait for new exports. Otherwise the cached panel at once (with a
   * background refresh when it is stale), or new exports when there is no cache.
   */
  async get(opts: { fresh?: boolean } = {}): Promise<UsageResult> {
    if (!opts.fresh) {
      const hit = this.peek();
      if (hit) {
        const refresh = hit.stale ? this.refresh().catch((e) => { this.lastError = String(e?.message || e); return hit; }) : null;
        return { usage: hit, cacheHit: true, refresh };
      }
    }
    return { usage: await this.refresh(), cacheHit: false, refresh: null };
  }
}
