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
  /**
   * Spend per day before this month, back to the start of the 12-week heatmap
   * (`from`..`to`, inclusive). A day in that range without a row had no usage;
   * a day outside it is unknown. null when that export failed; absent before 1.13.0.
   */
  prior?: PriorDays | null;
  /** This month's codeburn totals beyond cost; absent before 1.13.0. */
  codeburn?: CodeburnStats;
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

/** `day`: the local date it was exported, so a copy is reused for that day only (late-recorded usage shows up the next day). */
export interface PriorDays { from: string; to: string; day: string; daily: { date: string; cost: number }[] }

export interface CodeburnStats {
  calls: number;
  sessions: number;
  projects: number;
  /** Summed from the per-day rows. */
  tokens: { input: number; output: number; cacheRead: number };
  /** Cost by activity (codeburn's own task categories), most first. */
  activity: { name: string; cost: number }[];
  /** Tool calls, most first, at most TOP_TOOLS. */
  tools: { name: string; calls: number }[];
}

/** Weeks in the dashboard's spend heatmap. */
export const HEATMAP_WEEKS = 12;
export const TOP_TOOLS = 8;

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

export async function collectUsage(opts: { now?: Date; exporter?: CodeburnExport; pathEnv?: string; prior?: PriorDays | null } = {}): Promise<UsagePanel> {
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
  // The weeks before this month are exported at most once a day: a copy from today for the same range is reused.
  const range = priorRange(now);
  const reuse = range && opts.prior && opts.prior.from === range.from && opts.prior.to === range.to && opts.prior.day === to ? opts.prior : null;
  const priorP = range && !reuse ? collectPrior(exporter, range, to) : Promise.resolve(reuse);
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
    prior: await priorP,
    codeburn: codeburnStats(month),
  };
  if (panel.today!.calls === 0 && panel.month!.calls === 0) {
    return { ...panel, status: 'no-data', message: 'codeburn found no usage this month.' };
  }
  return panel;
}

/** First day of the heatmap: the Monday on or before the day HEATMAP_WEEKS weeks back (local dates). */
export function heatmapStart(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (HEATMAP_WEEKS * 7 - 1));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDate(d);
}

/** The heatmap days before this month: heatmapStart..last day of the previous month; null when there are none. */
export function priorRange(now: Date): { from: string; to: string } | null {
  const from = heatmapStart(now);
  const to = localDate(new Date(now.getFullYear(), now.getMonth(), 0));
  return from <= to ? { from, to } : null;
}

/** Spend per day in `range`; null when the export fails (the page then shows those days as unknown). */
async function collectPrior(exporter: CodeburnExport, range: { from: string; to: string }, day: string): Promise<PriorDays | null> {
  try {
    const j = await exporter(['--from', range.from, '--to', range.to]);
    if (!isExport(j) || !Array.isArray(j?.periods?.[0]?.daily)) return null;
    const daily = (j.periods[0].daily as any[])
      .filter((r) => typeof r?.Date === 'string' && r.Date >= range.from && r.Date <= range.to)
      .map((r) => ({ date: r.Date as string, cost: num(r['Cost (USD)']) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { ...range, day, daily };
  } catch {
    return null;
  }
}

/** Calls, sessions, projects, tokens, activity and tools from the month export (codeburn.export.v2). */
export function codeburnStats(month: any): CodeburnStats {
  const s = Array.isArray(month?.summary) ? month.summary[0] : null;
  const daily: any[] = Array.isArray(month?.periods?.[0]?.daily) ? month.periods[0].daily : [];
  const sum = (k: string) => daily.reduce((n, r) => n + num(r?.[k]), 0);
  const activity: any[] = Array.isArray(month?.periods?.[0]?.activity) ? month.periods[0].activity : [];
  const tools: any[] = Array.isArray(month?.tools) ? month.tools : [];
  return {
    calls: num(s?.['API Calls']), sessions: num(s?.Sessions), projects: num(s?.Projects),
    tokens: { input: sum('Input Tokens'), output: sum('Output Tokens'), cacheRead: sum('Cache Read Tokens') },
    activity: activity.map((a) => ({ name: String(a?.Activity || 'other'), cost: num(a?.['Cost (USD)']) })).sort((a, b) => b.cost - a.cost),
    tools: tools.map((t) => ({ name: String(t?.Tool || 'unknown'), calls: num(t?.Calls) })).sort((a, b) => b.calls - a.calls).slice(0, TOP_TOOLS),
  };
}
