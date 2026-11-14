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
import { localDate, shortReason, type HistoryResult, type PriorDays, type UsagePanel } from './usage.js';
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
  /** Runs the codeburn exports (collectUsage); `prior` is the cached copy of the weeks before this month, for reuse. */
  collect: (prior?: PriorDays | null) => Promise<UsagePanel>;
  /**
   * Runs the earlier weeks' export (collectHistory). When set, a panel that
   * comes back with history pending is cached at once and this runs after it,
   * merging its result into the cached panel.
   */
  collectHistory?: () => Promise<HistoryResult>;
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
  /** The running earlier-weeks export, if any. */
  private history: Promise<void> | null = null;
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

  /** The weeks-before-this-month copy in the cache file, from any day; collectUsage reuses it only for the same range. */
  private cachedPrior(): PriorDays | null {
    const p = readJson(this.d.file)?.panel?.prior;
    return p && typeof p.from === 'string' && typeof p.to === 'string' && Array.isArray(p.daily) ? p : null;
  }

  private write(panel: UsagePanel, savedAt = this.now().getTime()): void {
    try {
      writePrivateJson(this.d.file, { schema: USAGE_CACHE_SCHEMA, savedAt, day: localDate(this.now()), panel });
    } catch (e: any) {
      process.stderr.write(`prism dashboard: could not write the usage cache: ${e?.message || e}\n`);
    }
  }

  /**
   * Starts the earlier weeks' export for a cached panel whose history is
   * pending; one at a time. Its result (ready or error) is merged into the
   * cached panel as it is then, so a month refresh in between is kept.
   */
  private startHistory(): void {
    if (this.history || !this.d.collectHistory) return;
    this.history = (async () => {
      let r: Pick<HistoryResult, 'prior'> & { history: Partial<HistoryResult['history']> };
      try { r = await this.d.collectHistory!(); } catch (e: any) {
        const error = shortReason(e);
        process.stderr.write(`prism dashboard: the earlier weeks' codeburn export failed: ${error}\n`);
        r = { prior: null, history: { status: 'error', error } };
      }
      try {
        const c = readJson(this.d.file);
        if (!c || c.schema !== USAGE_CACHE_SCHEMA || c.day !== localDate(this.now()) || !c.panel) return;
        // The panel keeps its range; the result sets the status (and the reason on an error).
        this.write({ ...c.panel, prior: r.prior, history: { ...c.panel.history, ...r.history } }, c.savedAt);
      } catch (e: any) {
        process.stderr.write(`prism dashboard: could not merge the earlier weeks into the usage cache: ${e?.message || e}\n`);
      }
    })().finally(() => { this.history = null; });
  }

  /** The running earlier-weeks export; null when none is running. */
  historyRun(): Promise<void> | null {
    return this.history;
  }

  /** The panel once the running refresh and earlier-weeks export have finished: what a one-shot output (--json, --snapshot) should show. */
  async settled(): Promise<UsagePanel | null> {
    if (this.refreshing) await this.refreshing.catch(() => null);
    await this.history;
    return this.current();
  }

  /** Runs the exports now; one at a time, so concurrent callers share the same run. Writes only real data. */
  refresh(): Promise<UsagePanel> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        let u = await this.d.collect(this.cachedPrior());
        // The earlier weeks may have landed while the month exported: keep them rather than flip back to pending.
        if (u.history?.status === 'pending') {
          const c = readJson(this.d.file)?.panel;
          const h = c?.history, p = c?.prior;
          if (h?.status === 'ready' && h.from === u.history.from && h.to === u.history.to && p?.day === localDate(this.now())) u = { ...u, prior: p, history: h };
        }
        if (cacheable(u)) {
          this.lastError = null;
          this.lastFailure = null;
          this.write(u);
          if (u.history?.status === 'pending') this.startHistory();
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
        // A pending history from another process or an earlier run: export it here.
        if (hit.history?.status === 'pending') this.startHistory();
        const refresh = hit.stale ? this.refresh().catch((e) => { this.lastError = String(e?.message || e); return hit; }) : null;
        return { usage: hit, cacheHit: true, refresh };
      }
    }
    return { usage: await this.refresh(), cacheHit: false, refresh: null };
  }
}
