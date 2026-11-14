/**
 * The dashboard's update check: is a newer @prism-d1/cli on npm?
 *
 * One GET of the npm registry document, at most once a day, with a 3 s
 * timeout, cached in ~/.prism/cache/update-check.json (dir 0700, file 0600).
 * A failed check (offline, timeout, bad answer) is silent: it keeps the last
 * known answer and is not retried until the next day. PRISM_NO_UPDATE_CHECK=1
 * turns it off. It only reports; nothing here installs anything.
 */
import { join } from 'node:path';
import { prismCacheDir } from './usage-cache.js';
import { readJson, writePrivateJson } from '../utils/private-json.js';
import { compareVersions, PACKAGE_NAME } from '../commands/_top/version.js';

export const UPDATE_CACHE_SCHEMA = 'prism.update-check.v1';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const UPDATE_CHECK_TIMEOUT_MS = 3000;
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
/** The registry document lists every release; past this size the answer is not trusted. */
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;

/** `version` in the dashboard payload and `dashboard --json`. */
export interface VersionInfo {
  installed: string;
  /** Latest version on npm; null when never checked, offline on the first check, or turned off. */
  latest: string | null;
  /** When `latest` was published (ISO), from the registry; null when unknown. */
  publishedAt: string | null;
  /** True only when `latest` is newer than `installed`. */
  update: boolean;
  /** When the registry was last asked (ISO), whether or not it answered; null when never. */
  checkedAt: string | null;
}

export function updateCachePath(home: string): string {
  return join(prismCacheDir(home), 'update-check.json');
}

/** Registry answer: the latest version and its publish time. Injected in tests. */
export type RegistryFetch = () => Promise<{ latest: string; publishedAt: string | null }>;

export const realRegistryFetch: RegistryFetch = async () => {
  const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') || 0) > MAX_REGISTRY_BYTES) throw new Error('registry answer too large');
  const text = await res.text();
  if (text.length > MAX_REGISTRY_BYTES) throw new Error('registry answer too large');
  const doc = JSON.parse(text);
  const latest = doc?.['dist-tags']?.latest;
  if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+/.test(latest)) throw new Error('no latest version in the registry answer');
  const t = doc?.time?.[latest];
  return { latest, publishedAt: typeof t === 'string' ? t : null };
};

interface CacheFile { schema: string; checkedAt: number; latest: string | null; publishedAt: string | null }

function readCache(file: string): CacheFile | null {
  const c = readJson(file);
  if (!c || c.schema !== UPDATE_CACHE_SCHEMA || typeof c.checkedAt !== 'number') return null;
  return {
    schema: c.schema, checkedAt: c.checkedAt,
    latest: typeof c.latest === 'string' ? c.latest : null,
    publishedAt: typeof c.publishedAt === 'string' ? c.publishedAt : null,
  };
}

function info(installed: string, c: CacheFile | null): VersionInfo {
  const latest = c?.latest ?? null;
  return {
    installed,
    latest,
    publishedAt: latest ? c?.publishedAt ?? null : null,
    update: !!latest && installed !== 'unknown' && compareVersions(latest, installed) > 0,
    checkedAt: c ? new Date(c.checkedAt).toISOString() : null,
  };
}

export interface UpdateCheckDeps {
  installed: string;
  file: string;
  env?: NodeJS.ProcessEnv;
  fetch?: RegistryFetch;
  now?: () => Date;
}

export class UpdateCheck {
  private running: Promise<VersionInfo> | null = null;
  constructor(private readonly d: UpdateCheckDeps) {}

  private off(): boolean { return (this.d.env ?? process.env).PRISM_NO_UPDATE_CHECK === '1'; }
  private now(): number { return (this.d.now ?? (() => new Date()))().getTime(); }

  /** The cached answer; never touches the network. Turned off: installed version only. */
  current(): VersionInfo {
    return info(this.d.installed, this.off() ? null : readCache(this.d.file));
  }

  /** True when a check is due: on, and no attempt in the last day. */
  due(): boolean {
    if (this.off()) return false;
    const c = readCache(this.d.file);
    return !c || this.now() - c.checkedAt >= UPDATE_CHECK_INTERVAL_MS || this.now() < c.checkedAt;
  }

  /** Asks the registry when a check is due (or `force`, the Updates tab's Check now), else answers from the cache. Never throws. */
  get(opts: { force?: boolean } = {}): Promise<VersionInfo> {
    if (this.off()) return Promise.resolve(this.current());
    if (!opts.force && !this.due()) return Promise.resolve(this.current());
    if (!this.running) {
      this.running = (async () => {
        const prev = readCache(this.d.file);
        let next: CacheFile;
        try {
          const r = await (this.d.fetch ?? realRegistryFetch)();
          next = { schema: UPDATE_CACHE_SCHEMA, checkedAt: this.now(), latest: r.latest, publishedAt: r.publishedAt };
        } catch {
          // Offline or a bad answer: keep the last known version, and wait a day before asking again.
          next = { schema: UPDATE_CACHE_SCHEMA, checkedAt: this.now(), latest: prev?.latest ?? null, publishedAt: prev?.publishedAt ?? null };
        }
        try { writePrivateJson(this.d.file, next); } catch { /* an unwritable cache only means asking again next time */ }
        return info(this.d.installed, next);
      })().finally(() => { this.running = null; });
    }
    return this.running;
  }
}
