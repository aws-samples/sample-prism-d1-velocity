/**
 * The AccountGuard page's server side (#accountguard): the cached
 * `prism-cli aws check` results for the AWS account connected with
 * `prism-cli aws connect`, ranked with aws recommend's own code, compared with
 * a baseline run. No AWS call: everything comes from result files.
 *
 *   GET  /api/accountguard           the page data
 *   POST /api/accountguard/baseline  {run}: mark a run as the baseline (a local file only)
 *
 * The baseline is the oldest full run for the account and region until the
 * user marks another; marks live in ~/.prism/accountguard.json (0600). Result
 * file names carry the full account id, so runs reach the page as opaque ids
 * (sha256 of the result's path) and account ids as their last 4 digits.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Finding, Severity } from '../utils/audit.js';
import { readResultEntries, RESULTS_DIR, type PrismResult, type ResultEntry } from '../codewatch/results.js';
import { loadConnection, type SavedConnection } from '../aws/connection.js';
import { SECTIONS } from '../aws/check.js';
import { buildRecommendations, indeterminateCause, RETIRED_IDS, skippedSections, type IndeterminateCause, type SectionAdvice } from '../aws/recommend.js';
import { readJson, writePrivateJson } from '../utils/private-json.js';
import { ACTIONS, displayCommand, type ApiResult } from './actions.js';
import { tildeHome } from './payload.js';

export const BASELINE_SCHEMA = 'prism.accountguard.v1';
export const baselinePath = (home: string) => join(home, '.prism', 'accountguard.json');
const masked = (account: string) => (account.length > 4 ? '••••' + account.slice(-4) : account);
const runKey = (root: string, id: string) => createHash('sha256').update(resolve(root, RESULTS_DIR, id)).digest('hex').slice(0, 16);
const targetKey = (account: string, region: string) => `${account}/${region}`;

export interface AccountGuardDeps {
  home: string;
  /** The repo the dashboard started in, or null: its .prism/aws.local.json wins over ~/.prism/aws.json, as on Settings › AWS. */
  repoRoot: string | null;
  /** Where results are read: the dashboard's repos and ~ (aws check from the page writes to ~). */
  roots(): Promise<string[]>;
  /** The runner's lock, for the baseline write. */
  exclusive<T>(fn: () => T | Promise<T>): Promise<ApiResult>;
  read?: (root: string) => ResultEntry[];
  now?: () => Date;
}

interface Run { key: string; root: string; entry: ResultEntry; result: PrismResult }

/** Full runs (no --section) for the account and region, newest first. A --section run is never read as "the rest passed". */
export function runsFor(roots: string[], account: string, region: string, read: (root: string) => ResultEntry[] = readResultEntries): Run[] {
  const out: Run[] = [];
  for (const root of new Set(roots)) {
    for (const entry of read(root)) {
      const c = entry.result.kind === 'aws-check' ? entry.result.aws_check : undefined;
      if (!c || c.account !== account || c.region !== region || skippedSections(entry.result).length) continue;
      out.push({ key: runKey(root, entry.id), root, entry, result: entry.result });
    }
  }
  return out.sort((a, b) => b.result.started_at.localeCompare(a.result.started_at));
}

/** The marked baseline's result path for the account and region, or null. */
function markedBaseline(home: string, account: string, region: string): string | null {
  const f = readJson(baselinePath(home));
  const v = f && f.schema === BASELINE_SCHEMA && f.baselines && typeof f.baselines === 'object' ? f.baselines[targetKey(account, region)] : null;
  return v && typeof v.result === 'string' ? v.result : null;
}

/** The baseline run: the marked one when it still exists, else the oldest full run. */
export function baselineRun(home: string, runs: Run[], account: string, region: string): { run: Run; how: 'first run' | 'marked' } | null {
  if (!runs.length) return null;
  const mark = markedBaseline(home, account, region);
  const marked = mark ? runs.find((r) => resolve(r.root, RESULTS_DIR, `${r.entry.id}.json`) === mark) : undefined;
  return marked ? { run: marked, how: 'marked' } : { run: runs[runs.length - 1], how: 'first run' };
}

const canonical = (id: string) => RETIRED_IDS[id] ?? id;

export interface CheckDiff {
  newFailures: { id: string; title: string; severity: Severity; was: string }[];
  fixed: { id: string; title: string; severity: Severity }[];
  /** FAIL at the baseline, INDETERMINATE now: not counted as fixed. */
  noLongerChecked: { id: string; title: string; severity: Severity }[];
  stillFailing: number;
}

/** Latest against baseline, by check id (older ids mapped as aws recommend maps them). */
export function diffChecks(base: Finding[], latest: Finding[]): CheckDiff {
  const was = new Map(base.map((f) => [canonical(f.id), f.status]));
  const pick = (f: Finding) => ({ id: f.id, title: f.title, severity: f.severity });
  const fails = latest.filter((f) => f.status === 'FAIL');
  const now = new Map(latest.map((f) => [canonical(f.id), f.status]));
  const baseFails = base.filter((f) => f.status === 'FAIL');
  return {
    newFailures: fails.filter((f) => was.get(canonical(f.id)) !== 'FAIL').map((f) => ({ ...pick(f), was: was.get(canonical(f.id)) ?? 'NOT CHECKED' })),
    fixed: baseFails.filter((f) => now.get(canonical(f.id)) === 'PASS').map(pick),
    noLongerChecked: baseFails.filter((f) => now.get(canonical(f.id)) === 'INDETERMINATE').map(pick),
    stillFailing: fails.filter((f) => was.get(canonical(f.id)) === 'FAIL').length,
  };
}

/** Failing HIGH or CRITICAL checks: the nav badge. */
export const badgeCount = (checks: Finding[]) => checks.filter((f) => f.status === 'FAIL' && (f.severity === 'HIGH' || f.severity === 'CRITICAL')).length;

export interface AccountGuardView {
  connection: null | { profile: string; region: string; account4: string; alias: string | null; verifiedAt: string; scope: 'repo' | 'user'; path: string };
  sections: { name: string; heading: string }[];
  latest: null | {
    run: string; started_at: string; profile: string | null; counts: { pass: number; fail: number; indeterminate: number };
    fail_by_severity: Record<string, number>; checks: (Finding & { cause: IndeterminateCause | null })[];
  };
  recommendations: SectionAdvice[];
  baseline: null | { run: string; started_at: string; how: 'first run' | 'marked' };
  diff: CheckDiff | null;
  runs: { run: string; started_at: string; counts: { pass: number; fail: number; indeterminate: number } }[];
  badge: number;
  /** The exact lines the Run buttons run (the server appends the same --profile/--region): the confirm dialog shows them. */
  commands: { check: string; recommend: string } | null;
}

const connectionOf = (d: AccountGuardDeps): SavedConnection | null => loadConnection(d.home, d.repoRoot);

/** GET /api/accountguard: no AWS call. */
export async function accountGuardView(d: AccountGuardDeps): Promise<AccountGuardView> {
  const sections = SECTIONS.map((s) => ({ name: s.name, heading: s.heading }));
  const c = connectionOf(d);
  const empty: AccountGuardView = { connection: null, sections, latest: null, recommendations: [], baseline: null, diff: null, runs: [], badge: 0, commands: null };
  if (!c) return empty;
  const connection = { profile: c.profile, region: c.region, account4: masked(c.account), alias: c.alias, verifiedAt: c.verifiedAt, scope: c.scope, path: tildeHome(c.path, d.home) };
  const flags = ['--profile', c.profile, '--region', c.region];
  const commands = { check: 'cd ~ && ' + displayCommand([...ACTIONS['accountguard-check'].args, ...flags]), recommend: 'cd ~ && ' + displayCommand([...ACTIONS['accountguard-recommend'].args, ...flags]) };
  const runs = runsFor(await d.roots(), c.account, c.region, d.read);
  if (!runs.length) return { ...empty, connection, commands };
  const L = runs[0], info = L.result.aws_check!;
  const b = baselineRun(d.home, runs, c.account, c.region)!;
  const checks = (info.checks || []).map((f) => ({ ...f, cause: f.status === 'INDETERMINATE' ? indeterminateCause(f) : null }));
  return {
    connection, sections, commands,
    latest: { run: L.key, started_at: L.result.started_at, profile: info.profile, counts: info.counts, fail_by_severity: info.fail_by_severity, checks },
    // aws recommend's own ranking; the account stays a placeholder in the fix text, as the page never shows the full id.
    recommendations: buildRecommendations(info.checks || [], { account: '<account>', region: info.region }),
    baseline: { run: b.run.key, started_at: b.run.result.started_at, how: b.how },
    diff: b.run.key === L.key ? null : diffChecks(b.run.result.aws_check!.checks || [], info.checks || []),
    runs: runs.map((r) => ({ run: r.key, started_at: r.result.started_at, counts: r.result.aws_check!.counts })),
    badge: badgeCount(info.checks || []),
  };
}

/** POST /api/accountguard/baseline {run}: `run` must be an opaque id from the server's own listing. A local write only. */
export async function setBaseline(d: AccountGuardDeps, body: unknown): Promise<ApiResult> {
  const bad = (error: string, status = 400): ApiResult => ({ status, json: { error } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('expected a JSON object');
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== 'run');
  if (extra.length) return bad(`unexpected field ${extra[0]}`);
  if (typeof b.run !== 'string' || !/^[a-f0-9]{16}$/.test(b.run)) return bad('run must be an id from the run list');
  const c = connectionOf(d);
  if (!c) return bad('no AWS account is connected', 409);
  const run = runsFor(await d.roots(), c.account, c.region, d.read).find((r) => r.key === b.run);
  if (!run) return bad('run is not in the run list');
  return d.exclusive(() => {
    const file = baselinePath(d.home);
    const prev = readJson(file);
    const baselines = prev && prev.schema === BASELINE_SCHEMA && prev.baselines && typeof prev.baselines === 'object' ? prev.baselines : {};
    baselines[targetKey(c.account, c.region)] = { result: resolve(run.root, RESULTS_DIR, `${run.entry.id}.json`), marked_at: (d.now ?? (() => new Date()))().toISOString() };
    writePrivateJson(file, { schema: BASELINE_SCHEMA, baselines });
    return { run: run.key };
  });
}

/** --profile/--region for AccountGuard's aws check and aws recommend: the connected pair, or null when nothing is connected. */
export function connectionArgs(home: string, repoRoot: string | null): string[] | null {
  const c = loadConnection(home, repoRoot);
  return c ? ['--profile', c.profile, '--region', c.region] : null;
}
