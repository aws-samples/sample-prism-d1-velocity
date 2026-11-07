/**
 * Usage panel data, from `codeburn export -f json` (schema codeburn.export.v2,
 * checked against codeburn 0.9.24).
 *
 * Two exports: the default one for "Today", and a `--from <1st of month>
 * --to <today>` one for this calendar month and its top models and projects.
 * codeburn's own charts are not rebuilt; the panel points at `codeburn web`.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { findOnPath } from '../utils/tool-check.js';

const execFileP = promisify(execFile);
export const TOP_N = 5;
const EXPORT_TIMEOUT_MS = 60_000;

export interface Totals { cost: number; calls: number; sessions: number }
export interface UsagePanel {
  status: 'ok' | 'not-installed' | 'no-data' | 'error';
  message: string | null;
  currency: string;
  today: Totals | null;
  month: (Totals & { from: string; to: string }) | null;
  topModels: { name: string; cost: number; calls: number }[];
  /** `name` is the folder name; `path` is codeburn's full project path, for a tooltip. */
  topProjects: { name: string; path: string; cost: number; sessions: number }[];
  generated: string | null;
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
  return { status, message, currency: 'USD', today: null, month: null, topModels: [], topProjects: [], generated: null, fullView: 'codeburn web' };
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
  let base: any, month: any;
  try {
    [base, month] = await Promise.all([exporter([]), exporter(['--from', from, '--to', to])]);
  } catch (e: any) {
    return emptyUsage('error', `codeburn export failed: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
  }
  if (!String(base?.schema || '').startsWith('codeburn.export.')) {
    return emptyUsage('error', `unrecognised codeburn export schema: ${String(base?.schema).slice(0, 40)}`);
  }

  const todayRow = (Array.isArray(base.summary) ? base.summary : []).find((r: any) => r?.Period === 'Today');
  const monthRow = Array.isArray(month?.summary) ? month.summary[0] : null;
  const monthModels: any[] = Array.isArray(month?.periods?.[0]?.models) ? month.periods[0].models : [];
  const monthProjects: any[] = Array.isArray(month?.projects) ? month.projects : [];

  const panel: UsagePanel = {
    status: 'ok',
    message: null,
    currency: String(base?.currency?.code || 'USD'),
    today: todayRow ? totalsFrom(todayRow) : { cost: 0, calls: 0, sessions: 0 },
    month: monthRow ? { ...totalsFrom(monthRow), from, to } : { cost: 0, calls: 0, sessions: 0, from, to },
    topModels: monthModels
      .map((m) => ({ name: String(m?.Model || 'unknown'), cost: num(m?.['Cost (USD)']), calls: num(m?.['API Calls']) }))
      .sort((a, b) => b.cost - a.cost).slice(0, TOP_N),
    topProjects: monthProjects
      .map((p) => { const path = String(p?.Project || 'unknown'); return { name: basename(path.replace(/[\\/]+$/, '')) || path, path, cost: num(p?.['Cost (USD)']), sessions: num(p?.Sessions) }; })
      .sort((a, b) => b.cost - a.cost).slice(0, TOP_N),
    generated: typeof base?.generated === 'string' ? base.generated : null,
    fullView: 'codeburn web',
  };
  if (panel.today!.calls === 0 && panel.month!.calls === 0) {
    return { ...panel, status: 'no-data', message: 'codeburn found no usage this month.' };
  }
  return panel;
}
