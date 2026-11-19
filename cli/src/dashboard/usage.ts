/**
 * Usage panel data, from `codeburn export -f json`: schema codeburn.export.v2
 * (codeburn 0.9.24 to 0.9.27, CSV-style keys such as 'Cost (USD)') or
 * codeburn.export.v3 (0.9.28, camelCase keys such as `cost`), checked against
 * codeburn's source and real exports. Any other schema is refused with an
 * error that names it, never read as zeros (EXPORT_KEYS).
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
import { homedir, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { findOnPath, toolVersion } from '../utils/tool-check.js';

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
  /**
   * Whether `prior` is loaded: ready (or there are no earlier weeks), pending
   * while its export runs after the month painted, error when it failed or
   * timed out. The page draws pending and error weeks as "no data", never $0.
   */
  history?: UsageHistory;
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

/** The earlier weeks of the heatmap (`from`..`to`) and whether they are loaded; `error` is a short reason. */
export interface UsageHistory { status: 'ready' | 'pending' | 'error'; from: string; to: string; error?: string }

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
    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'prism-dash-cb-'));
      const out = join(dir, 'export.json');
      await execFileP(binary, ['export', '-f', 'json', '-o', out, ...args], { timeout: EXPORT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
      return JSON.parse(readFileSync(out, 'utf8'));
    } catch (e) {
      throw new Error(exportFailure(e, dir));
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Why an export failed, as one short line for the page: codeburn's own stderr
 * line, never execFile's "Command failed: <argv>" (the binary's absolute path
 * and the temp file). Paths under the temp dir and the home directory are
 * replaced, in case codeburn names one.
 */
export function exportFailure(e: any, dir: string | null, home: string = homedir()): string {
  if (e?.killed || e?.signal) return `codeburn did not answer within ${EXPORT_TIMEOUT_MS / 1000} s`;
  let line: string;
  if (e?.code === 'ENOENT' && e?.syscall?.startsWith('spawn')) line = 'codeburn could not be started';
  else if (typeof e?.code === 'number' || e?.stderr !== undefined) {
    line = String(e?.stderr || '').split('\n').map((l) => l.trim()).find(Boolean) || `codeburn exited with code ${e?.code ?? 'unknown'}`;
  } else if (e?.code === 'ENOENT' && e?.syscall === 'open') line = 'codeburn wrote no export file';
  else if (e instanceof SyntaxError) line = 'codeburn wrote an export that is not valid JSON';
  else if (typeof e?.code === 'string') line = `could not use a temp file for the export (${e.code})`;
  else line = String(e?.message || e).split('\n')[0];
  if (dir) line = line.split(dir).join('<export file>');
  if (home && home !== '/') line = line.split(home).join('~');
  return line.slice(0, MAX_REASON);
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The keys prism-cli reads from an export's rows, by schema. */
export interface ExportKeys {
  /** summary, daily, models, projects and activity rows */
  cost: string; calls: string; sessions: string;
  /** summary row */
  projects: string;
  /** daily rows */
  date: string; input: string; output: string; cacheRead: string;
  /** models[].model, projects[].project, activity[].activity, tools[].tool and tools[].calls */
  model: string; project: string; activity: string; tool: string; toolCalls: string;
}

export const EXPORT_V2 = 'codeburn.export.v2';
export const EXPORT_V3 = 'codeburn.export.v3';

/** v3 (codeburn 0.9.28): fixed camelCase keys; the currency is stated once, in currency.code. */
const V3_KEYS: ExportKeys = {
  cost: 'cost', calls: 'apiCalls', sessions: 'sessions', projects: 'projects',
  date: 'date', input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens',
  model: 'model', project: 'project', activity: 'activity', tool: 'tool', toolCalls: 'calls',
};

/** v2 (codeburn 0.9.24 to 0.9.27): the CSV headers; cost columns carry the currency code, e.g. 'Cost (EUR)'. */
const v2Keys = (code: string): ExportKeys => ({
  cost: `Cost (${code})`, calls: 'API Calls', sessions: 'Sessions', projects: 'Projects',
  date: 'Date', input: 'Input Tokens', output: 'Output Tokens', cacheRead: 'Cache Read Tokens',
  model: 'Model', project: 'Project', activity: 'Activity', tool: 'Tool', toolCalls: 'Calls',
});

const currencyOf = (j: any) => String(j?.currency?.code || 'USD');

/** The keys for this export's schema; null for a schema prism-cli does not read. */
export function exportKeys(j: any): ExportKeys | null {
  if (j?.schema === EXPORT_V3) return V3_KEYS;
  if (j?.schema === EXPORT_V2) return v2Keys(currencyOf(j));
  return null;
}

/** For the exported helpers, called on exports collectUsage has already checked: v2 keys when the schema is not known. */
const keysOf = (j: any): ExportKeys => exportKeys(j) ?? v2Keys(currencyOf(j));

function totalsFrom(row: any, k: ExportKeys): Totals {
  return { cost: num(row?.[k.cost]), calls: num(row?.[k.calls]), sessions: num(row?.[k.sessions]) };
}

/** Longest schema or codeburn version quoted in an error. */
const MAX_LABEL = 40;

/** "codeburn 0.9.28", or "codeburn" when the version is not known. */
const codeburnName = (version: string | null) => (version ? `codeburn ${version.replace(/^codeburn\s+/i, '').slice(0, MAX_LABEL)}` : 'codeburn');

/**
 * Why prism-cli cannot read this export, or null when it can: a schema it does
 * not know, or a known schema whose summary or first per-day row has none of
 * the keys it reads. Either would otherwise show as "no usage".
 */
export function unreadableExport(j: any, version: () => string | null): string | null {
  const k = exportKeys(j);
  const cb = () => codeburnName(version());
  if (!k) {
    const schema = typeof j?.schema === 'string' ? `"${j.schema.slice(0, MAX_LABEL)}"` : 'no schema';
    return `${cb()} wrote an export with ${schema}; prism-cli reads ${EXPORT_V2} and ${EXPORT_V3}. Update prism-cli: npm i -g @prism-d1/cli`;
  }
  const lacks = (row: any, keys: string[]) => row && typeof row === 'object' && !keys.some((key) => key in row);
  const summary = Array.isArray(j?.summary) ? j.summary[0] : null;
  const day = Array.isArray(j?.periods?.[0]?.daily) ? j.periods[0].daily[0] : null;
  if (lacks(summary, [k.cost, k.calls, k.sessions]) || lacks(day, [k.date])) {
    return `${cb()} wrote a ${j.schema} export without the fields prism-cli reads (${k.cost}, ${k.calls}, ${k.sessions}, ${k.date}). Update prism-cli: npm i -g @prism-d1/cli`;
  }
  return null;
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

/**
 * Today's totals from a month export's per-day rows; null when the export has
 * no per-day breakdown. No row for today means no usage today (codeburn lists
 * only days with usage).
 */
export function todayFromDaily(month: any, today: string): Totals | null {
  const daily = month?.periods?.[0]?.daily;
  if (!Array.isArray(daily)) return null;
  const k = keysOf(month);
  const row = daily.find((r: any) => r?.[k.date] === today);
  return row ? totalsFrom(row, k) : { cost: 0, calls: 0, sessions: 0 };
}

/** Options shared by collectUsage and collectHistory. */
interface ExporterOpts {
  exporter?: CodeburnExport;
  pathEnv?: string;
  /** codeburn's version, for an error about its export; only asked for then. Defaults to `codeburn --version` when codeburn is found on PATH. */
  codeburnVersion?: () => string | null;
}

/** The given exporter, else codeburn on PATH; null when there is none. */
function resolveExporter(opts: ExporterOpts): { exporter: CodeburnExport; version: () => string | null } | null {
  if (opts.exporter) return { exporter: opts.exporter, version: opts.codeburnVersion || (() => null) };
  const bin = findOnPath('codeburn', opts.pathEnv);
  return bin ? { exporter: realCodeburnExport(bin), version: opts.codeburnVersion || (() => toolVersion(bin)) } : null;
}

/**
 * history 'wait' (default): the earlier weeks' export runs alongside the month's
 * and the panel carries both. 'defer': the panel comes back after the month
 * export alone, with history pending unless today's copy is reused; the caller
 * runs collectHistory and merges it in (usage-cache.ts).
 */
export async function collectUsage(opts: ExporterOpts & { now?: Date; prior?: PriorDays | null; history?: 'wait' | 'defer' } = {}): Promise<UsagePanel> {
  const resolved = resolveExporter(opts);
  if (!resolved) return emptyUsage('not-installed', 'codeburn is not installed.');
  const { exporter } = resolved;
  const now = opts.now || new Date();
  const to = localDate(now);
  const from = `${to.slice(0, 8)}01`;
  const failed = (e: any) => emptyUsage('error', `codeburn export failed: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
  const unreadable = (j: any) => { const why = unreadableExport(j, resolved.version); return why ? emptyUsage('error', why) : null; };
  // The weeks before this month are exported at most once a day: a copy from today for the same range is reused.
  const range = priorRange(now);
  const reuse = range && opts.prior && opts.prior.from === range.from && opts.prior.to === range.to && opts.prior.day === to ? opts.prior : null;
  const defer = opts.history === 'defer';
  const priorP: Promise<HistoryResult> = !range || reuse ? Promise.resolve(readyHistory(now, reuse))
    : defer ? Promise.resolve({ prior: null, history: { status: 'pending', ...range } })
      : collectPrior(exporter, range, to);
  let month: any;
  try { month = await exporter(['--from', from, '--to', to]); } catch (e) { return failed(e); }
  const bad = unreadable(month);
  if (bad) return bad;
  const k = exportKeys(month)!;

  let today = todayFromDaily(month, to);
  if (!today) {
    // An export without per-day rows: ask for today alone (a small range).
    let t: any;
    try { t = await exporter(['--from', to, '--to', to]); } catch (e) { return failed(e); }
    const badT = unreadable(t);
    if (badT) return badT;
    today = Array.isArray(t.summary) && t.summary[0] ? totalsFrom(t.summary[0], exportKeys(t)!) : { cost: 0, calls: 0, sessions: 0 };
  }

  const monthRow = Array.isArray(month?.summary) ? month.summary[0] : null;
  const monthModels: any[] = Array.isArray(month?.periods?.[0]?.models) ? month.periods[0].models : [];
  const monthProjects: any[] = Array.isArray(month?.projects) ? month.projects : [];

  const panel: UsagePanel = {
    status: 'ok',
    message: null,
    currency: currencyOf(month),
    today,
    month: monthRow ? { ...totalsFrom(monthRow, k), from, to } : { cost: 0, calls: 0, sessions: 0, from, to },
    topModels: monthModels
      .map((m) => ({ name: String(m?.[k.model] || 'unknown'), cost: num(m?.[k.cost]), calls: num(m?.[k.calls]) }))
      .sort((a, b) => b.cost - a.cost).slice(0, TOP_N),
    topProjects: monthProjects
      .map((p) => { const path = String(p?.[k.project] || 'unknown'); return { name: basename(path.replace(/[\\/]+$/, '')) || path, path, cost: num(p?.[k.cost]), sessions: num(p?.[k.sessions]) }; })
      .sort((a, b) => b.cost - a.cost).slice(0, TOP_N),
    projects: monthProjects
      .filter((p) => typeof p?.[k.project] === 'string' && p[k.project])
      .map((p) => ({ path: real(String(p[k.project]).replace(/[\\/]+$/, '')), cost: num(p?.[k.cost]), sessions: num(p?.[k.sessions]) })),
    // any: codeburn export rows are untyped JSON; each field is checked or read through num().
    daily: (Array.isArray(month?.periods?.[0]?.daily) ? month.periods[0].daily : [])
      .filter((r: any) => typeof r?.[k.date] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r[k.date]))
      .map((r: any) => ({ date: r[k.date] as string, ...totalsFrom(r, k) }))
      .sort((a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date)),
    generated: typeof month?.generated === 'string' ? month.generated : null,
    updatedAt: now.toISOString(),
    stale: false,
    refreshError: null,
    fullView: 'codeburn web',
    ...(await priorP),
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

/** The earlier weeks and their state, as merged into a panel. */
export interface HistoryResult { prior: PriorDays | null; history: UsageHistory }

/** History for a panel that needs no export: the reused copy, or no earlier weeks at all. */
function readyHistory(now: Date, reuse: PriorDays | null): HistoryResult {
  const range = priorRange(now) ?? { from: heatmapStart(now), to: heatmapStart(now) };
  return { prior: reuse, history: { status: 'ready', ...range } };
}

/** Longest failure reason shown under the heatmap. */
const MAX_REASON = 120;

/** A failure as a short reason for the page: one line, no export output. */
export function shortReason(e: any): string {
  if (e?.killed || e?.signal) return `codeburn did not answer within ${EXPORT_TIMEOUT_MS / 1000} s`;
  return String(e?.message || e).split('\n')[0].slice(0, MAX_REASON);
}

/** Spend per day in `range`; on a failure, history is error with its reason (the page shows those days as unknown, never zero). */
async function collectPrior(exporter: CodeburnExport, range: { from: string; to: string }, day: string): Promise<HistoryResult> {
  const fail = (error: string): HistoryResult => ({ prior: null, history: { status: 'error', ...range, error } });
  try {
    const j = await exporter(['--from', range.from, '--to', range.to]);
    const k = exportKeys(j);
    if (!k || unreadableExport(j, () => null) || !Array.isArray(j?.periods?.[0]?.daily)) return fail(`unrecognised codeburn export (${String(j?.schema).slice(0, MAX_LABEL)})`);
    const daily = (j.periods[0].daily as any[])
      .filter((r) => typeof r?.[k.date] === 'string' && r[k.date] >= range.from && r[k.date] <= range.to)
      .map((r) => ({ date: r[k.date] as string, cost: num(r[k.cost]) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { prior: { ...range, day, daily }, history: { status: 'ready', ...range } };
  } catch (e) {
    return fail(shortReason(e));
  }
}

/** The earlier weeks' export on its own: what a deferred panel (collectUsage history 'defer') is missing. */
export async function collectHistory(opts: ExporterOpts & { now?: Date } = {}): Promise<HistoryResult> {
  const now = opts.now || new Date();
  const range = priorRange(now);
  if (!range) return readyHistory(now, null);
  const resolved = resolveExporter(opts);
  if (!resolved) return { prior: null, history: { status: 'error', ...range, error: 'codeburn is not installed' } };
  return collectPrior(resolved.exporter, range, localDate(now));
}

/** Calls, sessions, projects, tokens, activity and tools from the month export (v2 or v3). */
export function codeburnStats(month: any): CodeburnStats {
  const k = keysOf(month);
  const s = Array.isArray(month?.summary) ? month.summary[0] : null;
  const daily: any[] = Array.isArray(month?.periods?.[0]?.daily) ? month.periods[0].daily : [];
  const sum = (key: string) => daily.reduce((n, r) => n + num(r?.[key]), 0);
  const activity: any[] = Array.isArray(month?.periods?.[0]?.activity) ? month.periods[0].activity : [];
  const tools: any[] = Array.isArray(month?.tools) ? month.tools : [];
  return {
    calls: num(s?.[k.calls]), sessions: num(s?.[k.sessions]), projects: num(s?.[k.projects]),
    tokens: { input: sum(k.input), output: sum(k.output), cacheRead: sum(k.cacheRead) },
    activity: activity.map((a) => ({ name: String(a?.[k.activity] || 'other'), cost: num(a?.[k.cost]) })).sort((a, b) => b.cost - a.cost),
    tools: tools.map((t) => ({ name: String(t?.[k.tool] || 'unknown'), calls: num(t?.[k.toolCalls]) })).sort((a, b) => b.calls - a.calls).slice(0, TOP_TOOLS),
  };
}
