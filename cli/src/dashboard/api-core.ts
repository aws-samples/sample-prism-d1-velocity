/**
 * The dashboard's route table, built once and served by every host:
 *   - server.ts over HTTP on 127.0.0.1 (the browser page), and
 *   - stdio.ts over stdin/stdout (`dashboard --serve-stdio`: the VS Code
 *     webview and the Kiro Crew app page, through their own hosts).
 * Both look a request up by exact path in the same getApi/postApi records and
 * call the same handlers, so the action allowlist, its validation, the
 * confirm requirement and the AWS write gate (actions.ts) exist once.
 */
import { homedir } from 'node:os';
import { buildPayload, type DashboardPayload } from './payload.js';
import { ApiAnswer, cachedPayload } from './server.js';
import { renderReportHtml, renderReportMarkdown, reportFromRepos, type ScanReport } from './report.js';
import { ActionRunner, cliEntry, repoId, type ApiResult } from './actions.js';
import { setupApi } from './setup-api.js';
import { profileChoices } from './aws-identity.js';
import { connectionArgs } from './accountguard.js';
import { LookupCache, securityTargetIn, targetArgs, writeGateIn } from './security-agent.js';
import { repoRootOf } from '../aws/connection.js';
import { systemdUserAvailable } from '../utils/otel-sync-schedule.js';
import { emptyUsage } from './usage.js';
import type { UsageCache } from './usage-cache.js';
import type { UpdateCheck } from './update-check.js';
import { findOnPath } from '../utils/tool-check.js';
import { SecurityAutoCheck, spawnCheck } from './security-autocheck.js';

/** The ids /report/<id> accepts (server.ts REPORT_ROUTE). */
const REPORT_ID = /^[A-Za-z0-9_-]{1,120}$/;

export interface DashboardApi {
  getPayload: () => Promise<unknown>;
  getReport: (id: string) => Promise<ScanReport | null>;
  /** Read routes (GET over HTTP, op "get" over stdio), by exact path. Includes /api/data. */
  getApi: Record<string, (url: URL) => Promise<unknown>>;
  /** Action routes (POST over HTTP, op "act" over stdio), by exact path. */
  postApi: Record<string, (body: unknown) => Promise<ApiResult>>;
  /** Stops a running action (the stdio host is gone). */
  shutdown: () => void;
}

export interface DashboardApiOptions {
  cwd: string;
  root?: string;
  usageCache: UsageCache;
  updates: UpdateCheck;
}

export function buildDashboardApi(o: DashboardApiOptions): DashboardApi {
  const { usageCache, updates } = o;
  // Pending Security Agent runs: checked read-only while the page asks (GET /api/security-check). Set up below, once repos exist.
  let checks: SecurityAutoCheck | null = null;
  // The page's first paint never waits for codeburn: it shows the cached usage, or "loading" until /api/usage answers.
  const build = () => buildPayload({
    cwd: o.cwd, root: o.root,
    usage: async () => {
      const u = usageCache.current();
      return u ? { usage: u, cacheHit: true } : { usage: emptyUsage('loading', 'Loading usage from codeburn...'), cacheHit: false };
    },
    // Never waits for npm: the cached answer now; a due check runs in the background and the next load shows it.
    version: async () => updates.current(),
    securityCheck: { lookup: (type, job) => checks?.stateOf(type, job) ?? null, generation: () => checks?.generation ?? 0 },
  });
  const payload = cachedPayload(build);
  if (updates.due()) updates.get().then(() => payload.invalidate(), () => {});
  const repos = async () => ((await payload()) as DashboardPayload).repos;
  // Reports are looked up only in the repos the dashboard itself discovered.
  const getReport = async (id: string) => reportFromRepos((await repos()).map((r) => r.path), id);
  let systemd: boolean | undefined;
  // The Security Agent page: commands run in the picked repo with the account and region prism-cli resolves there.
  const lookups = new LookupCache();
  const saIdentity = { identity: { env: process.env, home: homedir() } };
  const targetIn = (path: string) => securityTargetIn(saIdentity, path);
  // Settings › AWS and AccountGuard: the connection as Settings shows it (the dashboard repo's file wins over ~/.prism/aws.json).
  const identity = { env: process.env, home: homedir(), repoRoot: repoRootOf(o.cwd) };
  const runner = new ActionRunner({
    execPath: process.execPath, entry: cliEntry(), cwd: o.cwd, home: homedir(), platform: process.platform,
    repos: async () => (await repos()).map((r) => ({ id: repoId(r.path), name: r.name, path: r.path })),
    systemdAvailable: () => (systemd ??= systemdUserAvailable()),
    npmPath: () => findOnPath('npm'),
    onDone: () => payload.invalidate(),
    awsArgs: (repo) => targetArgs(targetIn(repo.path)),
    // The setup gate passes in the repo, the lookup named the space and the bucket, and the account is the same right now.
    writeGate: (id, repo) => writeGateIn({ ...saIdentity, cache: lookups }, id, repo),
    // aws-connect accepts only names read fresh from the section headers of the two AWS files, and the region list.
    awsChoices: () => { const c = profileChoices(identity); return { profiles: c.profiles.map((p) => p.name), regions: c.regions }; },
    connectionArgs: () => connectionArgs(identity.home, identity.repoRoot),
  });
  // The fetch command itself, in the repo, with the same --profile/--region a Fetch button's run gets.
  const checkRunner = spawnCheck({ execPath: process.execPath, entry: cliEntry(), awsArgs: (repo) => targetArgs(targetIn(repo.path)) });
  checks = new SecurityAutoCheck({
    repos: async () => (await repos()).map((r) => ({ id: repoId(r.path), name: r.name, path: r.path })),
    run: checkRunner.run, onChange: () => payload.invalidate(), busy: () => runner.running, home: homedir(),
  });
  const autoCheck = checks;
  const api = setupApi({
    runner, cwd: o.cwd, securityCheck: (type, job) => autoCheck.stateOf(type, job),
    repoPaths: async () => (await repos()).map((r) => r.path),
    identity,
    refresh: () => { payload.invalidate(); return payload(); },
    checkUpdate: async () => { const v = await updates.get({ force: true }); payload.invalidate(); return v; },
    securityAgent: {
      ...saIdentity, cache: lookups,
      repos: async () => (await repos()).map((r) => ({ id: repoId(r.path), name: r.name, path: r.path, current: r.current })),
      exclusive: (fn) => runner.exclusive(fn),
    },
    accountGuard: {
      home: identity.home, repoRoot: identity.repoRoot,
      roots: async () => [...(await repos()).map((r) => r.path), identity.home],
      exclusive: (fn) => runner.exclusive(fn),
    },
  });
  // fresh=1 (the Refresh button) waits for new exports; otherwise the cache, refreshed in the background when stale.
  const getUsage = async (url: URL) => {
    const r = await usageCache.get({ fresh: url.searchParams.get('fresh') === '1' });
    if (!r.cacheHit) payload.invalidate();
    // The earlier weeks land after the month: redraw when they do (the page polls while they are pending).
    // Only when one is running: otherwise every poll would drop the cached payload.
    const later = () => usageCache.historyRun()?.then(() => payload.invalidate(), () => {});
    later();
    r.refresh?.then(() => { payload.invalidate(); later(); }, () => {});
    return { usage: r.usage, cacheHit: r.cacheHit };
  };
  // A report as JSON, for hosts with no /report/<id> page (the VS Code view, the Kiro Crew page). The id is
  // matched against result files only (reportFromRepos), never turned into a path. The HTML has no script and
  // no links; the host shows it with its own CSP (no script, inline style only).
  const getReportJson = async (url: URL) => {
    const id = url.searchParams.get('id') ?? '';
    if (!REPORT_ID.test(id)) return new ApiAnswer(400, { error: 'id must be a result id' });
    const r = await getReport(id);
    return r ? { id, html: renderReportHtml(r), markdown: renderReportMarkdown(r) } : new ApiAnswer(404, { error: 'report not found' });
  };
  return {
    getPayload: payload,
    getReport,
    // Starts the due checks of pending runs and answers at once; the page redraws when `generation` moves past its payload's.
    getApi: { '/api/data': () => payload(), ...api.getApi, '/api/usage': getUsage, '/api/report': getReportJson, '/api/security-check': () => autoCheck.kick() },
    postApi: api.postApi,
    shutdown: () => { runner.stop(); checkRunner.stop(); },
  };
}
