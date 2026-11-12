/**
 * Usage panel data, from `codeburn export -f json` (schema codeburn.export.v2,
 * checked against codeburn 0.9.24).
 *
 * One `--from <1st of month> --to <today>` export gives this calendar month,
 * its top models and projects, and "Today" from its per-day breakdown
 * (periods[0].daily, one row per local date with usage). Only when an export
 * has no per-day breakdown is a second, today-only export run. The all-time
 * default export is not used: it is the slowest one and only gave "Today".
 * codeburn's own charts are not rebuilt; the panel points at `codeburn web`.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { findOnPath } from '../utils/tool-check.js';

const execFileP = promisify(execFile);
export const TOP_N = 5;
const EXPORT_TIMEOUT_MS = 60_000;

export interface Totals { cost: number; calls: number; sessions: number }
export interface UsagePanel {
  /** loading: the page's first paint, before /api/usage answers; never in `dashboard --json`. */
  status: 'ok' | 'not-installed' | 'no-data' | 'error' | 'loading';
  message: string | null;
  currency: string;
  today: Totals | null;
  month: (Totals & { from: string; to: string }) | null;
  topModels: { name: string; cost: number; calls: number }[];
  /** `name` is the folder name; `path` is codeburn's full project path, for a tooltip. */
  topProjects: { name: string; path: string; cost: number; sessions: number }[];
  /** Every project this month (symlinks resolved), for matching spend to repos. */
  projects: { path: string; cost: number; sessions: number }[];
  /** Days this month with usage, oldest first. Absent in caches written before 1.8.0. */
  daily?: (Totals & { date: string })[];
  generated: string | null;
  /** When this data was collected (ISO); null when nothing was collected. */
  updatedAt: string | null;
  /** Served from the cache past its TTL while a refresh runs (usage-cache.ts). */
  stale: boolean;
  /** The last background refresh failed; the data shown is the older cached copy. */
  refreshError: string | null;
  /** Shown as a note, never a link: codeburn web is a CLI command. */
  fullView: string;
}

/** Runs `codeburn export -f json` with extra args and returns the parsed JSON. Injected in tests. */
export type CodeburnExport = (args: string[]) => Promise<any>;

export function realCodeburnExport(binary: string): CodeburnExport {
  return async (args) => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-dash-cb-'));
    try {
      const out = join(dir, 'export.json');
      await execFileP(binary, ['export', '-f', 'json', '-o', out, ...args], { timeout: EXPORT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
      return JSON.parse(readFileSync(out, 'utf8'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function totalsFrom(row: any): Totals {
  return { cost: num(row?.['Cost (USD)']), calls: num(row?.['API Calls']), sessions: num(row?.['Sessions']) };
}

/** Local calendar date, YYYY-MM-DD. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function emptyUsage(status: UsagePanel['status'], message: string): UsagePanel {
  return { status, message, currency: 'USD', today: null, month: null, topModels: [], topProjects: [], projects: [], daily: [], generated: null, updatedAt: null, stale: false, refreshError: null, fullView: 'codeburn web' };
}

function real(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export interface RepoSpend { cost: number; sessions: number }

/**
 * This month's spend per repo path. Each codeburn project is counted once, for
 * the deepest repo whose path is the project's path or contains it; projects
 * outside every repo are not counted.
 */
export function spendByRepo(projects: UsagePanel['projects'], repoPaths: string[]): Map<string, RepoSpend> {
  const out = new Map<string, RepoSpend>();
  const deepestFirst = [...repoPaths].sort((a, b) => b.length - a.length);
  for (const p of projects) {
    const repo = deepestFirst.find((r) => p.path === r || p.path.startsWith(r + sep));
    if (!repo) continue;
    const s = out.get(repo) || { cost: 0, sessions: 0 };
    out.set(repo, { cost: s.cost + p.cost, sessions: s.sessions + p.sessions });
  }
  return out;
}

const isExport = (j: any) => String(j?.schema || '').startsWith('codeburn.export.');

/**
 * Today's totals from a month export's per-day rows; null when the export has
 * no per-day breakdown. No row for today means no usage today (codeburn lists
 * only days with usage).
 */
export function todayFromDaily(month: any, today: string): Totals | null {
  const daily = month?.periods?.[0]?.daily;
  if (!Array.isArray(daily)) return null;
  const row = daily.find((r: any) => r?.Date === today);
  return row ? totalsFrom(row) : { cost: 0, calls: 0, sessions: 0 };
}

export async function collectUsage(opts: { now?: Date; exporter?: CodeburnExport; pathEnv?: string } = {}): Promise<UsagePanel> {
  let exporter = opts.exporter;
  if (!exporter) {
    const bin = findOnPath('codeburn', opts.pathEnv);
    if (!bin) return emptyUsage('not-installed', 'codeburn is not installed. Set it up with: prism-cli enable codeburn');
    exporter = realCodeburnExport(bin);
  }
  const now = opts.now || new Date();
  const to = localDate(now);
  const from = `${to.slice(0, 8)}01`;
  const failed = (e: any) => emptyUsage('error', `codeburn export failed: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
  const badSchema = (j: any) => emptyUsage('error', `unrecognised codeburn export schema: ${String(j?.schema).slice(0, 40)}`);
  let month: any;
  try { month = await exporter(['--from', from, '--to', to]); } catch (e) { return failed(e); }
  if (!isExport(month)) return badSchema(month);

  let today = todayFromDaily(month, to);
  if (!today) {
    // An export without per-day rows: ask for today alone (a small range).
    let t: any;
    try { t = await exporter(['--from', to, '--to', to]); } catch (e) { return failed(e); }
    if (!isExport(t)) return badSchema(t);
    today = Array.isArray(t.summary) && t.summary[0] ? totalsFrom(t.summary[0]) : { cost: 0, calls: 0, sessions: 0 };
  }

  const monthRow = Array.isArray(month?.summary) ? month.summary[0] : null;
  const monthModels: any[] = Array.isArray(month?.periods?.[0]?.models) ? month.periods[0].models : [];
  const monthProjects: any[] = Array.isArray(month?.projects) ? month.projects : [];

  const panel: UsagePanel = {
    status: 'ok',
    message: null,
    currency: String(month?.currency?.code || 'USD'),
    today,
    month: monthRow ? { ...totalsFrom(monthRow), from, to } : { cost: 0, calls: 0, sessions: 0, from, to },
    topModels: monthModels
      .map((m) => ({ name: String(m?.Model || 'unknown'), cost: num(m?.['Cost (USD)']), calls: num(m?.['API Calls']) }))
      .sort((a, b) => b.cost - a.cost).slice(0, TOP_N),
    topProjects: monthProjects
      .map((p) => { const path = String(p?.Project || 'unknown'); return { name: basename(path.replace(/[\\/]+$/, '')) || path, path, cost: num(p?.['Cost (USD)']), sessions: num(p?.Sessions) }; })
      .sort((a, b) => b.cost - a.cost).slice(0, TOP_N),
    projects: monthProjects
      .filter((p) => typeof p?.Project === 'string' && p.Project)
      .map((p) => ({ path: real(String(p.Project).replace(/[\\/]+$/, '')), cost: num(p?.['Cost (USD)']), sessions: num(p?.Sessions) })),
    // any: codeburn export rows are untyped JSON; each field is checked or read through num().
    daily: (Array.isArray(month?.periods?.[0]?.daily) ? month.periods[0].daily : [])
      .filter((r: any) => typeof r?.Date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.Date))
      .map((r: any) => ({ date: r.Date as string, ...totalsFrom(r) }))
      .sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date)),
    generated: typeof month?.generated === 'string' ? month.generated : null,
    updatedAt: now.toISOString(),
    stale: false,
    refreshError: null,
    fullView: 'codeburn web',
  };
  if (panel.today!.calls === 0 && panel.month!.calls === 0) {
    return { ...panel, status: 'no-data', message: 'codeburn found no usage this month.' };
  }
  return panel;
}
