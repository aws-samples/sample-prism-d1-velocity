/**
 * 1.21.3 auto-check of pending Security Agent runs (security-autocheck.ts): the scheduler over
 * real result files with a fake runner (no process, no AWS), the payload rows it feeds, the stdio
 * transport, and the page's polling (pending only, not in a snapshot, redraw on a new generation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { makeResult, readResultEntries, writeResult, type PrismResult } from '../src/codewatch/results.js';
import { CHECK_EVERY_MS, checkArgs, checkReason, MAX_IN_FLIGHT, PENTEST_CHECK_EVERY_MS, SecurityAutoCheck, type CheckRun, type PendingJob } from '../src/dashboard/security-autocheck.js';
import { collectSecurityRuns } from '../src/dashboard/security-runs.js';
import { collectSecurity } from '../src/dashboard/security.js';
import { dispatch } from '../src/dashboard/stdio.js';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import type { DashboardApi } from '../src/dashboard/api-core.js';
import { EXIT_PENDING } from '../src/security/errors.js';
import { runPage } from './page-dom.js';

const ACCOUNT = '111122223333';
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-autocheck-${p}-`)));
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function review(job: string, started: string, status: PrismResult['status'] = 'pending'): PrismResult {
  return makeResult({
    kind: 'security-review', hook: 'manual', tool: 'security-agent', status, commit: 'abc123456789abc123456789', branch: 'main', started_at: started, finished_at: started,
    findings: status === 'findings' ? [{ severity: 'high', category: 'security', rule: 'CWE-89', file: 'src/a.ts', line: 3, message: 'SQLi', risk_level: 'HIGH', title: 'SQLi' }] : [],
    security: { job_id: job, code_review_id: 'cr-1', agent_space_id: 'as-1', region: 'us-west-2', account: ACCOUNT, scope: 'diff', job_status: status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED', counts: status === 'findings' ? { HIGH: 1 } : {} },
  });
}

/** A repo dir with result files, its scan-list entry, and a runner the test answers by hand. */
function rig(files: PrismResult[]) {
  const root = tmp('repo');
  const ids = files.map((r) => basename(writeResult(root, r), '.json'));
  const repo = { id: 'aaaaaaaaaaaaaaaa', name: 'demo-shop', path: root };
  const calls: { job: PendingJob; args: string[]; answer: (r: CheckRun) => void }[] = [];
  let now = Date.now();
  let changes = 0;
  let busy = false;
  const c = new SecurityAutoCheck({
    repos: async () => [repo], home: '/home/demo',
    run: (job, args) => new Promise((answer) => calls.push({ job, args, answer })),
    onChange: () => { changes++; }, busy: () => busy, now: () => now,
  });
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return {
    root, repo, ids, c, calls, settle,
    changes: () => changes, tick: (ms: number) => { now += ms; }, setBusy: (b: boolean) => { busy = b; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('pending -> complete: the fetch command for the job runs once, its verdict turns the row complete, with no manual step', async () => {
  const r = rig([review('job-1', hoursAgo(3))]);
  try {
    const rows = () => collectSecurityRuns([r.repo], undefined, new Date(), (t, j) => r.c.stateOf(t, j));
    assert.equal(rows()[0].status, 'noverdict', 'past the stale window, before any check');
    const a = await r.c.kick();
    assert.deepEqual(a, { pending: 1, checking: 1, due: 0, generation: 0 });
    assert.deepEqual(r.calls.map((x) => x.args), [['security', 'findings', '--job', 'job-1']]);
    assert.equal(rows()[0].check?.state, 'checking');
    // The command completes the pending record in place, as `security findings` does.
    writeResult(r.root, review('job-1', hoursAgo(3), 'findings'), r.ids[0]);
    r.calls[0].answer({ code: 0, output: 'Saved .prism/results/x.json', timedOut: false });
    await r.settle();
    assert.equal(r.changes(), 1);
    assert.equal(r.c.generation, 1);
    const row = rows()[0];
    assert.deepEqual([row.status, row.total, row.check], ['complete', 1, null]);
    assert.deepEqual(await r.c.kick(), { pending: 0, checking: 0, due: 0, generation: 1 }, 'nothing pending: nothing runs');
    assert.equal(r.calls.length, 1);
  } finally { r.cleanup(); }
});

test('still running: an old pending run shows running (no stale?), and is checked again only after CHECK_EVERY_MS', async () => {
  const r = rig([review('job-1', hoursAgo(3))]);
  try {
    await r.c.kick();
    r.calls[0].answer({ code: EXIT_PENDING, output: 'The job is still IN_PROGRESS.', timedOut: false });
    await r.settle();
    assert.equal(r.changes(), 1, 'checking -> running is a change the page shows');
    const lookup = (t: any, j: string) => r.c.stateOf(t, j);
    assert.equal(collectSecurityRuns([r.repo], undefined, new Date(), lookup)[0].status, 'running');
    const panel = collectSecurity([{ name: 'demo-shop', path: r.root, current: true }], undefined, new Date(), lookup).repos[0];
    assert.deepEqual([panel.pending, panel.stale, panel.check?.state], [true, false, 'running']);
    await r.c.kick();
    assert.equal(r.calls.length, 1, 'not due yet');
    r.tick(CHECK_EVERY_MS);
    await r.c.kick();
    assert.equal(r.calls.length, 2);
    r.calls[1].answer({ code: EXIT_PENDING, output: '', timedOut: false });
    await r.settle();
    assert.equal(r.changes(), 1, 'running -> running again: no redraw');
  } finally { r.cleanup(); }
});

test('a failed check: stale? and no verdict yet stay, with the reason (redacted, no home) and the manual command; it backs off', async () => {
  const r = rig([review('job-1', hoursAgo(3))]);
  try {
    await r.c.kick();
    r.calls[0].answer({ code: 1, output: `Read-only (security findings)\nError: Unable to locate credentials for account ${ACCOUNT} in /home/demo/.aws/config\n`, timedOut: false });
    await r.settle();
    const lookup = (t: any, j: string) => r.c.stateOf(t, j);
    const row = collectSecurityRuns([r.repo], undefined, new Date(), lookup)[0];
    assert.equal(row.status, 'noverdict');
    assert.equal(row.check?.state, 'error');
    assert.equal(row.check?.reason, 'Unable to locate credentials for account ••••3333 in ~/.aws/config');
    assert.equal(row.check?.command, 'prism-cli security findings --job job-1');
    const panel = collectSecurity([{ name: 'demo-shop', path: r.root, current: true }], undefined, new Date(), lookup).repos[0];
    assert.deepEqual([panel.stale, panel.check?.reason], [true, row.check?.reason]);
    // Backoff: CHECK_EVERY_MS doubled per failure.
    r.tick(CHECK_EVERY_MS);
    await r.c.kick();
    assert.equal(r.calls.length, 1, 'still backing off');
    r.tick(CHECK_EVERY_MS);
    await r.c.kick();
    assert.equal(r.calls.length, 2);
    r.calls[1].answer({ code: 1, output: `Error: Unable to locate credentials for account ${ACCOUNT} in /home/demo/.aws/config`, timedOut: false });
    await r.settle();
    assert.equal(r.changes(), 1, 'the same reason again: no redraw');
    r.tick(3 * CHECK_EVERY_MS);
    await r.c.kick();
    assert.equal(r.calls.length, 2, 'the second failure waits 4x');
  } finally { r.cleanup(); }
});

test('reasons: the last Error: line, else the last line; a timeout says so; long text is cut', () => {
  assert.equal(checkReason('a\nError: first\nb\nError: The SSO session has expired\n', '/h', false), 'The SSO session has expired');
  assert.equal(checkReason('only line\n', '/h', false), 'only line');
  assert.equal(checkReason('', '/h', false), 'the check failed with no output');
  assert.match(checkReason('Error: x', '/h', true), /did not finish in 3 min/);
  assert.equal(checkReason('Error: ' + 'x'.repeat(500), '/h', false).length, 300);
});

test('bounded: one check in flight per job, MAX_IN_FLIGHT overall, none while an action runs, none when nothing is pending', async () => {
  const none = rig([review('job-done', hoursAgo(1), 'findings')]);
  try {
    assert.deepEqual(await none.c.kick(), { pending: 0, checking: 0, due: 0, generation: 0 });
    assert.equal(none.calls.length, 0);
  } finally { none.cleanup(); }
  const r = rig([review('job-1', hoursAgo(3)), review('job-2', hoursAgo(2.5)), review('job-3', hoursAgo(2.2))]);
  try {
    r.setBusy(true);
    assert.equal((await r.c.kick()).due, 3, 'an action holds the lock: all three wait');
    assert.equal(r.calls.length, 0);
    r.setBusy(false);
    await r.c.kick();
    await r.c.kick();
    await r.c.kick();
    assert.equal(r.calls.length, MAX_IN_FLIGHT, 'repeated kicks start nothing more');
    assert.equal(new Set(r.calls.map((x) => x.job.key)).size, r.calls.length, 'never two for one job');
    r.calls[0].answer({ code: EXIT_PENDING, output: '', timedOut: false });
    await r.settle();
    await r.c.kick();
    assert.equal(r.calls.length, MAX_IN_FLIGHT + 1, 'a slot freed: the third job');
  } finally { r.cleanup(); }
});

test('the fetch command per run type; a pentest that never started a job is not checked', async () => {
  assert.deepEqual(checkArgs('threat-model', 'tm-1'), ['security', 'threats', '--job', 'tm-1']);
  assert.deepEqual(checkArgs('pentest', 'ptj-1'), ['security', 'pentest', '--status', '--job', 'ptj-1']);
  const pt = (job: string) => makeResult({ kind: 'security-pentest', hook: 'manual', tool: 'security-agent', status: 'pending', commit: 'abc', branch: 'main', started_at: hoursAgo(1), finished_at: hoursAgo(1),
    pentest: { job_id: job, stack: 'PrismPentest-demo', pentest_id: 'pt', agent_space_id: 'as', agent_space_dedicated: true, region: 'us-west-2', account: ACCOUNT, target_host: 'app.internal', job_status: 'RUNNING', counts: {} } } as any);
  const r = rig([pt(''), pt('ptj-1')]);
  try {
    await r.c.kick();
    assert.deepEqual(r.calls.map((x) => x.args), [['security', 'pentest', '--status', '--job', 'ptj-1']]);
  } finally { r.cleanup(); }
});

test('stdio transport: GET /api/security-check over `dashboard --serve-stdio` kicks the same checks', async () => {
  const r = rig([review('job-1', hoursAgo(3))]);
  try {
    const api: DashboardApi = {
      getPayload: async () => ({}), getReport: async () => null, postApi: {}, shutdown: () => {},
      getApi: { '/api/security-check': () => r.c.kick() },
    };
    const first = await dispatch(api, { id: 7, op: 'get', path: '/api/security-check' });
    assert.deepEqual(first, { id: 7, status: 200, json: { pending: 1, checking: 1, due: 0, generation: 0 } });
    writeResult(r.root, review('job-1', hoursAgo(3), 'findings'), r.ids[0]);
    r.calls[0].answer({ code: 0, output: '', timedOut: false });
    await r.settle();
    assert.deepEqual((await dispatch(api, { id: 8, op: 'get', path: '/api/security-check' })).json, { pending: 0, checking: 0, due: 0, generation: 1 });
    assert.equal(readResultEntries(r.root)[0].result.status, 'findings');
  } finally { r.cleanup(); }
});

// ---------------------------------------------------------------- the page

async function payload(): Promise<DashboardPayload> {
  const home = tmp('page');
  try {
    return await buildPayload({ cwd: tmp('nowhere'), home, pathEnv: tmp('path'), exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
      machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
      version: async () => ({ installed: '1.21.3', latest: '1.21.3', publishedAt: '2026-11-13T00:00:00.000Z', update: false, checkedAt: '2026-11-14T00:00:00.000Z' }),
      agentHooks: () => ({ rows: [], plugin: { active: false, version: null, outdated: false } }) } as any);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const runRow = (over: Record<string, unknown>) => ({
  repo_id: 'aaaaaaaaaaaaaaaa', run_id: 'r1-20261115T120000000Z-manual-security-review', repo: 'demo-shop', type: 'code-review', status: 'running', started_at: hoursAgo(0.3), duration_s: null,
  branch: 'main', commit: 'abc123456789', counts: { critical: 0, high: 0, medium: 0, low: 0 }, total: 0, top_title: null, reason: null, job_id: 'job-1', check: null, ...over,
});

test('page: asks for a check after loading only while a run is pending, and redraws (running -> complete) when the generation moves', async () => {
  const p = await payload();
  const pending = { ...p, security_runs: [runRow({})], security_check_gen: 0 };
  const done = { ...p, security_runs: [runRow({ status: 'complete', counts: { critical: 0, high: 1, medium: 0, low: 0 }, total: 1, top_title: 'SQLi' })], security_check_gen: 1 };
  const page = await runPage([pending, done], '', null, { '/api/security-check': { pending: 0, checking: 0, due: 0, generation: 1 } });
  await page.settle(); await page.settle();
  const asks = page.requests.filter((q) => q.url === '/api/security-check').length;
  assert.equal(asks >= 1, true, 'asked once the data loaded');
  assert.equal(page.requests.filter((q) => q.url === '/api/data').length, 2, 'a new generation: the data again, no reload');
  const card = page.dom.byId.main.all().find((e) => e.getAttribute('id') === 'security-runs')!;
  assert.match(card.textContent, /complete/);
  assert.match(card.textContent, /Top: SQLi/);

  const idle = await runPage([{ ...p, security_runs: [runRow({ status: 'complete' })], security_check_gen: 0 }], '', null, { '/api/security-check': { pending: 0, checking: 0, due: 0, generation: 0 } });
  await idle.settle();
  assert.equal(idle.requests.filter((q) => q.url === '/api/security-check').length, 0, 'nothing pending: no check');
});

test('page: a check in flight polls again (held 5 s timer); a failed check shows its reason and the manual command', async () => {
  const p = await payload();
  const err = { state: 'error', at: hoursAgo(0), reason: 'The SSO session has expired', command: 'prism-cli security findings --job job-1' };
  const page = await runPage([{ ...p, security_runs: [runRow({ status: 'noverdict', started_at: hoursAgo(3), check: err })], security_check_gen: 2 }], '', null,
    { '/api/security-check': { pending: 1, checking: 1, due: 0, generation: 2 } });
  await page.settle();
  assert.ok(page.pendingTimers().some((t) => t.ms === 5000), 'the next poll is scheduled');
  const card = page.dom.byId.main.all().find((e) => e.getAttribute('id') === 'security-runs')!;
  assert.match(card.textContent, /no verdict yet/);
  assert.match(card.textContent, /No verdict yet: could not check with AWSThe SSO session has expiredFetch by hand in the repo: prism-cli security findings --job job-1/);
});

test('payload cache: an invalidate() while a build runs is kept, so a check that lands mid-build is not hidden for the TTL', async () => {
  const { cachedPayload } = await import('../src/dashboard/server.js');
  let n = 0, release: () => void = () => {};
  const get = cachedPayload(() => new Promise((ok) => { n++; release = () => ok(n); }));
  const first = get();
  get.invalidate();
  release();
  assert.equal(await first, 1);
  const second = get();
  release();
  assert.equal(await second, 2, 'built again');
  assert.equal(await get(), 2, 'and cached once nothing invalidated it');
});

test('a result file that cannot be read after a check, or before one, is a failed check or an empty answer, never a crash', async () => {
  const root = tmp('readfail');
  try {
    writeResult(root, review('job-1', hoursAgo(3)));
    let fail = false;
    const calls: ((r: CheckRun) => void)[] = [];
    const read = (p: string) => { if (fail) throw new Error('EACCES: permission denied'); return readResultEntries(p); };
    const c = new SecurityAutoCheck({ repos: async () => [{ id: 'aaaaaaaaaaaaaaaa', name: 'x', path: root }], read, home: '/home/demo', onChange: () => {},
      run: () => new Promise((ok) => calls.push(ok)) });
    await c.kick();
    fail = true;
    calls[0]({ code: 0, output: '', timedOut: false });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(c.stateOf('code-review', 'job-1')?.state, 'error');
    assert.match(c.stateOf('code-review', 'job-1')!.reason!, /could not read the repo's results: EACCES/);
    assert.deepEqual(await c.kick(), { pending: 1, checking: 0, due: 0, generation: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 1.21.6: pentests through security pentest --status

function pentestRecord(job: string, status: PrismResult['status'] = 'pending', started = hoursAgo(1)): PrismResult {
  return makeResult({ kind: 'security-pentest', hook: 'manual', tool: 'security-agent', status, commit: 'abc', branch: 'main', started_at: started, finished_at: started,
    pentest: { job_id: job, stack: status === 'pending' ? `PrismPentest-${job}` : null, pentest_id: 'pt', agent_space_id: 'as', agent_space_dedicated: true, region: 'us-west-2', account: ACCOUNT, target_host: 'app.internal', job_status: status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED', counts: {} } } as any);
}

test('pentest: checked with pentest --status --job (an AWS write once finished), every 5 min; exit 0 while pending reads running; torn down once', async () => {
  const r = rig([pentestRecord('ptj-1')]);
  try {
    await r.c.kick();
    assert.deepEqual(r.calls.map((x) => x.args), [['security', 'pentest', '--status', '--job', 'ptj-1']]);
    assert.equal(r.c.pentestRunning(), true, 'Start and Clean up wait while it runs');
    // Still running: --status prints "Still running" and exits 0; the record stays pending.
    r.calls[0].answer({ code: 0, output: 'Now:         IN_PROGRESS (PENTEST)\nStill running; check back later.', timedOut: false });
    await r.settle();
    assert.equal(r.c.pentestRunning(), false);
    assert.equal(r.c.stateOf('pentest', 'ptj-1')?.state, 'running');
    assert.equal(r.c.stateOf('pentest', 'ptj-1')?.command, 'prism-cli security pentest --status --job ptj-1');
    r.tick(CHECK_EVERY_MS);
    await r.c.kick();
    assert.equal(r.calls.length, 1, 'a pentest is not checked every minute');
    r.tick(PENTEST_CHECK_EVERY_MS - CHECK_EVERY_MS);
    await r.c.kick();
    assert.equal(r.calls.length, 2, 'checked again after 5 min');
    // The job finished: --status saves the verdict (and tears the environment down) in place; the run leaves the queue.
    writeResult(r.root, pentestRecord('ptj-1', 'findings'), r.ids[0]);
    r.calls[1].answer({ code: 0, output: 'The job has finished; tearing the environment down:\nEnvironment torn down; the result record is kept.', timedOut: false });
    await r.settle();
    assert.equal(r.c.stateOf('pentest', 'ptj-1'), null);
    r.tick(PENTEST_CHECK_EVERY_MS * 10);
    assert.deepEqual(await r.c.kick(), { pending: 0, checking: 0, due: 0, generation: r.c.generation });
    assert.equal(r.calls.length, 2, 'never run again: the teardown happens once');
  } finally { r.cleanup(); }
});

test('pentest: one --status at a time; code reviews and threat models keep their read-only fetch and run beside it; none while an action runs', async () => {
  const tm = makeResult({ kind: 'security-threat-model', hook: 'manual', tool: 'security-agent', status: 'pending', commit: 'abc', branch: 'main', started_at: hoursAgo(1), finished_at: hoursAgo(1),
    threat_model: { job_id: 'tm-1', threat_model_id: 'tm', agent_space_id: 'as', region: 'us-west-2', account: ACCOUNT, job_status: 'IN_PROGRESS', counts: {}, stride_counts: {}, scope_docs: [], system_overview: '' } } as any);
  const r = rig([pentestRecord('ptj-1', 'pending', hoursAgo(2)), pentestRecord('ptj-2', 'pending', hoursAgo(1.5)), review('job-1', hoursAgo(1)), tm]);
  try {
    r.setBusy(true);
    assert.equal((await r.c.kick()).due, 4);
    assert.equal(r.calls.length, 0, 'an action holds the lock: nothing starts');
    r.setBusy(false);
    await r.c.kick();
    const args = r.calls.map((x) => x.args.join(' '));
    assert.equal(args.filter((a) => a.startsWith('security pentest --status')).length, 1, 'never two pentest checks at once');
    assert.ok(args.length <= MAX_IN_FLIGHT);
    // Whatever runs for a review or a threat model is its read-only fetch, never pentest --status.
    for (const k of ['code-review', 'threat-model'] as const) assert.ok(!checkArgs(k, 'x').includes('pentest'));
    r.calls[0].answer({ code: 0, output: 'Still running', timedOut: false });
    await r.settle();
    await r.c.kick();
    const later = r.calls.slice(1).map((x) => x.args.join(' '));
    assert.equal(later.filter((a) => a.startsWith('security pentest --status')).length <= 1, true);
  } finally { r.cleanup(); }
});

test('pentest: a check that cannot find the job in this account fails visibly (backoff), and a timeout names 90 min', async () => {
  const r = rig([pentestRecord('ptj-1')]);
  try {
    await r.c.kick();
    r.calls[0].answer({ code: 1, output: `Error: no pentest record for job ptj-1 in account ${ACCOUNT}, region us-west-2.`, timedOut: false });
    await r.settle();
    const st = r.c.stateOf('pentest', 'ptj-1')!;
    assert.equal(st.state, 'error');
    assert.equal(st.reason, 'no pentest record for job ptj-1 in account ••••3333, region us-west-2.');
    r.tick(PENTEST_CHECK_EVERY_MS);
    await r.c.kick();
    assert.equal(r.calls.length, 1, 'backing off: 5 min doubled');
    assert.match(checkReason('', '/h', true, 'pentest'), /did not finish in 90 min/);
  } finally { r.cleanup(); }
});
