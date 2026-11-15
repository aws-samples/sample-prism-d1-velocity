/**
 * 1.18.0 Security runs: the collector over every security result in every repo,
 * the drill-down API (local files only), the run a dashboard action wrote, and
 * the page (Dashboard card, full table, drill-down, not found, escaping).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeResult, writeResult, type Finding, type PrismResult } from '../src/codewatch/results.js';
import { collectSecurityRuns, MAX_RUNS, NO_REMEDIATION, runWrittenSince, securityRunDetail, type RunRepo } from '../src/dashboard/security-runs.js';
import { ActionRunner, repoId, type ScanRepo } from '../src/dashboard/actions.js';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { runPage } from './page-dom.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const ACCOUNT = '111122223333';
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-runs-${p}-`)));

const crFinding = (risk: string, title: string, over: Partial<Finding> = {}): Finding => ({
  severity: risk === 'LOW' ? 'low' : risk === 'MEDIUM' ? 'medium' : 'high', category: 'security', rule: 'CWE-89', file: 'src/a.ts', line: 7,
  message: `${title}: short`, risk_level: risk, title, cwe: 'CWE-89', finding_id: 'f-' + title.length, ...over,
});

function review(job: string, started: string, o: { status?: PrismResult['status']; findings?: Finding[]; counts?: Record<string, number>; wall?: number; scope?: 'diff' | 'full' | 'unknown'; reason?: string } = {}): PrismResult {
  return makeResult({
    kind: 'security-review', hook: 'manual', tool: 'security-agent', status: o.status ?? (o.findings?.length ? 'findings' : 'ok'),
    commit: '9f3c2a1b7e04aaaabbbbccccddddeeeeffff0000', branch: 'main', started_at: started, finished_at: started,
    findings: o.findings ?? [], reason: o.reason ?? null,
    security: { job_id: job, code_review_id: 'cr-1', agent_space_id: 'as-1', region: 'us-west-2', account: ACCOUNT, scope: o.scope ?? 'diff', job_status: 'COMPLETED', counts: o.counts ?? {}, wall_s: o.wall ?? null },
  });
}
function threat(job: string, started: string, o: { status?: PrismResult['status']; findings?: Finding[]; counts?: Record<string, number> } = {}): PrismResult {
  return makeResult({
    kind: 'security-threat-model', hook: 'manual', tool: 'security-agent', status: o.status ?? 'findings', commit: 'abc123', branch: 'main',
    started_at: started, finished_at: started, findings: o.findings ?? [],
    threat_model: { job_id: job, threat_model_id: 'tm-1', agent_space_id: 'as-1', region: 'us-west-2', account: ACCOUNT, job_status: 'COMPLETED', counts: o.counts ?? {}, stride_counts: {}, scope_docs: [], system_overview: 'A web shop.',
      service_created_at: '2026-11-15T10:00:00Z', service_updated_at: '2026-11-15T10:30:00Z' },
  });
}
function pentest(job: string, started: string, status: PrismResult['status'] = 'pending'): PrismResult {
  return makeResult({
    kind: 'security-pentest', hook: 'manual', tool: 'security-agent', status, commit: null, branch: 'main', started_at: started, finished_at: started,
    pentest: { job_id: job, pentest_id: 'p-1', agent_space_id: 'as-p', agent_space_dedicated: true, region: 'us-west-2', account: ACCOUNT, target_host: 'app.demo.internal', job_status: 'IN_PROGRESS', counts: {} },
  });
}

function repos(): { list: RunRepo[]; cleanup: () => void } {
  const home = tmp('home');
  const list = ['shop', 'pay'].map((n) => { const path = join(home, 'src', n); mkdirSync(path, { recursive: true }); return { id: repoId(path), name: n, path }; });
  return { list, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('collector: every run in every repo, newest first, one row per job; status, chips counts and duration', () => {
  const { list, cleanup } = repos();
  try {
    const [shop, pay] = list;
    writeResult(shop.path, review('job-1', at(300), { findings: [crFinding('LOW', 'Weak hash'), crFinding('CRITICAL', 'SQL injection')], counts: { CRITICAL: 1, LOW: 1 }, wall: 840 }));
    // The same job written again by `security findings` (scope unknown, later): the scoped record wins.
    writeResult(shop.path, review('job-1', at(300), { scope: 'unknown', findings: [], counts: {} }), 'job-1-refetch');
    writeResult(shop.path, review('job-2', at(10), { status: 'pending' }));
    writeResult(shop.path, review('job-3', at(200), { status: 'pending' }));
    writeResult(shop.path, review('job-4', at(400), { status: 'error', reason: 'job FAILED: zip unreadable' }));
    writeResult(pay.path, threat('tmj-1', at(60), { counts: { HIGH: 2, INFO: 1 } }));
    writeResult(pay.path, pentest('ptj-1', at(5)));
    // Not a security run: ignored.
    writeResult(pay.path, makeResult({ kind: 'review', hook: 'pre-push', tool: 'kiro', status: 'ok', started_at: at(1), finished_at: at(1) }));
    const rows = collectSecurityRuns(list, undefined, NOW);
    assert.deepEqual(rows.map((r) => [r.repo, r.type, r.job_id, r.status]), [
      ['pay', 'pentest', 'ptj-1', 'running'],
      ['shop', 'code-review', 'job-2', 'running'],
      ['pay', 'threat-model', 'tmj-1', 'complete'],
      ['shop', 'code-review', 'job-3', 'noverdict'],
      ['shop', 'code-review', 'job-1', 'complete'],
      ['shop', 'code-review', 'job-4', 'failed'],
    ]);
    const done = rows.find((r) => r.job_id === 'job-1')!;
    assert.deepEqual(done.counts, { critical: 1, high: 0, medium: 0, low: 1 });
    assert.equal(done.total, 2);
    assert.equal(done.top_title, 'SQL injection');
    assert.equal(done.duration_s, 840);
    assert.notEqual(done.run_id, 'job-1-refetch');
    assert.equal(rows.find((r) => r.job_id === 'tmj-1')!.duration_s, 1800, 'threat model: derived from the service timestamps');
    assert.equal(rows.find((r) => r.job_id === 'job-2')!.duration_s, null, 'running: no duration');
    assert.equal(rows.find((r) => r.job_id === 'job-4')!.reason, 'job FAILED: zip unreadable');
    assert.ok(!JSON.stringify(rows).includes(ACCOUNT), 'no account id in the rows');
    assert.ok(MAX_RUNS >= 100);
  } finally { cleanup(); }
});

test('drill-down: the full findings; an old file without description falls back to its message; remediation per run type', () => {
  const { list, cleanup } = repos();
  try {
    const [shop, pay] = list;
    const full = 'x'.repeat(450);
    const p1 = writeResult(shop.path, review('job-1', at(30), { counts: { CRITICAL: 1, HIGH: 1 }, findings: [crFinding('HIGH', 'Old style'), crFinding('CRITICAL', 'New style', { description: full })] }));
    const p2 = writeResult(pay.path, threat('tmj-1', at(30), { counts: { HIGH: 1 }, findings: [{ severity: 'high', category: 'security', rule: 'SPOOFING', file: 'docs/ARCH.md', line: null, message: 'Spoofed webhook: The webhook accepts any POST.',
      risk_level: 'HIGH', title: 'Spoofed webhook', stride: ['SPOOFING'], recommendation: 'Verify the signature.', evidence: ['src/webhook.ts'], threat_id: 'T-1' }] }));
    const id = (p: string) => p.split('/').pop()!.replace(/\.json$/, '');
    const home = join(shop.path, '..', '..');
    const d = securityRunDetail(list, shop.id, id(p1), home, NOW);
    assert.ok(d.found);
    if (!d.found) return;
    assert.deepEqual(d.findings.map((f) => [f.severity, f.title, f.location]), [['critical', 'New style', 'src/a.ts:7'], ['high', 'Old style', 'src/a.ts:7']]);
    assert.equal(d.findings[0].description, full, 'the saved description is not cut');
    assert.equal(d.findings[1].description, 'short', 'an old file: the message without its title prefix');
    assert.equal(d.findings[0].remediation, null);
    assert.equal(d.no_remediation, NO_REMEDIATION);
    assert.equal(d.account4, '••••3333');
    assert.equal(d.result_file, `~/src/shop/.prism/results/${id(p1)}.json`);
    assert.equal(d.cli, 'prism-cli security findings --job job-1 --path ~/src/shop');
    assert.equal(d.scope, 'branch diff against its upstream');
    assert.ok(!JSON.stringify(d).includes(ACCOUNT));
    const t = securityRunDetail(list, pay.id, id(p2), home, NOW);
    assert.ok(t.found);
    if (!t.found) return;
    assert.deepEqual([t.findings[0].description, t.findings[0].remediation, t.no_remediation, t.cli], ['The webhook accepts any POST.', 'Verify the signature.', null, 'prism-cli security threats --job tmj-1 --path ~/src/pay']);
  } finally { cleanup(); }
});

test('drill-down not found: bad ids, a repo outside the scan list, a deleted run, a non-security result', () => {
  const { list, cleanup } = repos();
  try {
    const [shop] = list;
    const p = writeResult(shop.path, makeResult({ kind: 'review', hook: 'pre-push', tool: 'kiro', status: 'ok', started_at: at(1), finished_at: at(1) }));
    const id = p.split('/').pop()!.replace(/\.json$/, '');
    for (const [repo, run] of [[null, null], ['../../etc', 'x'], [shop.id, '../../passwd'], ['ffffffffffffffff', 'x'], [shop.id, 'gone-20261115T000000000Z-manual-security-review'], [shop.id, id]] as const) {
      const d = securityRunDetail(list, repo, run, '', NOW);
      assert.equal(d.found, false, `${repo} ${run}`);
    }
  } finally { cleanup(); }
});

test('runWrittenSince: the newest security result the command wrote, by file time; none when it wrote nothing', () => {
  const { list, cleanup } = repos();
  try {
    const [shop] = list;
    const old = writeResult(shop.path, review('job-old', at(100)));
    utimesSync(old, new Date(NOW.getTime() - 3600_000), new Date(NOW.getTime() - 3600_000));
    assert.equal(runWrittenSince(shop.path, NOW.getTime(), NOW), null);
    const p = writeResult(shop.path, review('job-new', at(1), { counts: { HIGH: 1 }, findings: [crFinding('HIGH', 'x')] }));
    utimesSync(p, new Date(NOW.getTime() + 2000), new Date(NOW.getTime() + 2000));
    assert.deepEqual(runWrittenSince(shop.path, NOW.getTime(), NOW), { run: p.split('/').pop()!.replace(/\.json$/, ''), status: 'complete' });
  } finally { cleanup(); }
});

test('runner: a finished Security Agent action carries the run it wrote (repo id, run id, status)', async () => {
  const home = tmp('runner');
  const path = join(home, 'src', 'demo');
  mkdirSync(path, { recursive: true });
  const REPO: ScanRepo = { id: repoId(path), name: 'demo', path };
  let written = '';
  const spawn = () => {
    const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true;
    setTimeout(() => { written = writeResult(path, review('job-9', new Date().toISOString(), { counts: { LOW: 1 }, findings: [crFinding('LOW', 'x')] })); c.emit('close', 0); }, 5);
    return c;
  };
  const r = new ActionRunner({ execPath: '/usr/bin/node', entry: '/x.js', cwd: home, home, repos: async () => [REPO], systemdAvailable: () => false, platform: 'linux', spawn: spawn as any, awsArgs: () => [], writeGate: () => null });
  try {
    assert.equal((await r.start({ action: 'security-findings', repo: REPO.id })).status, 202);
    for (let i = 0; i < 200 && r.status().state !== 'done'; i++) await new Promise((x) => setTimeout(x, 5));
    assert.deepEqual(r.status().result, { repo: REPO.id, run: written.split('/').pop()!.replace(/\.json$/, ''), status: 'complete' });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the page

async function pagePayload(): Promise<{ p: DashboardPayload; cleanup: () => void }> {
  const home = tmp('page');
  const p = await buildPayload({ cwd: tmp('nowhere'), home, pathEnv: tmp('path'), exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
    version: async () => ({ installed: '1.18.0', latest: '1.18.0', publishedAt: '2026-11-13T00:00:00.000Z', update: false, checkedAt: '2026-11-14T00:00:00.000Z' }),
    agentHooks: () => ({ rows: [], plugin: { active: false, version: null, outdated: false } }) } as any);
  return { p, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const REPO_ID = 'aaaaaaaaaaaaaaaa';
const row = (i: number, over: Record<string, unknown> = {}) => ({
  repo_id: REPO_ID, run_id: `r${i}-20261115T120000000Z-manual-security-review`, repo: 'demo-shop', type: 'code-review', status: 'complete', started_at: at(i * 10), duration_s: 600,
  branch: 'main', commit: 'abc123456789', counts: { critical: 1, high: 0, medium: 2, low: 0 }, total: 3, top_title: 'Top ' + i, reason: null, job_id: 'job-' + i, ...over,
});

test('page: the Dashboard shows the latest 5 runs with chips (zeros greyed), markers and a See all link; no findings list', async () => {
  const { p, cleanup } = await pagePayload();
  try {
    p.security_runs = [row(1, { status: 'running' }), row(2, { status: 'failed', reason: 'job FAILED' }), ...[3, 4, 5, 6, 7, 8].map((i) => row(i))] as any;
    const page = await runPage([p]);
    const card = page.dom.byId.main.all().find((e) => e.getAttribute('id') === 'security-runs')!;
    const trs = card.all().filter((e) => e.nodeName === 'TR' && e.getAttribute('data-run'));
    assert.equal(trs.length, 5);
    assert.deepEqual(trs.slice(0, 2).map((t) => t.getAttribute('class')), ['run-running', 'run-failed']);
    assert.match(card.textContent, /1 critical0 high2 medium0 low/);
    assert.ok(card.all().some((e) => e.getAttribute('class') === 'pill zero' && e.textContent === '0 high'), 'a zero chip is greyed');
    const all = card.all().find((e) => e.hasAttribute('data-all-runs'))!;
    assert.equal(all.getAttribute('href'), '#security');
    assert.equal(all.textContent, 'See all 8 runs →');
    assert.ok(!trs[0].all().some((e) => e.nodeName === 'A'), 'a running row has no link');
    assert.equal(trs[2].all().find((e) => e.nodeName === 'A')!.getAttribute('href'), `#security/run/${REPO_ID}/r3-20261115T120000000Z-manual-security-review`);
  } finally { cleanup(); }
});

test('page: the drill-down loads the run, escapes finding text, filters by severity; an unknown run is "not found" with a way back', async () => {
  const { p, cleanup } = await pagePayload();
  try {
    const evil = '<img src=x onerror="alert(1)">';
    const detail = { found: true, run: row(3), account4: '••••3333', region: 'us-west-2', scope: 'the whole repo at HEAD', target_host: null, overview: null,
      result_file: '~/src/demo-shop/.prism/results/r3.json', cli: 'prism-cli security findings --job job-3 --path ~/src/demo-shop', no_remediation: 'No remediation provided by this run type.',
      findings: [
        { severity: 'critical', title: evil, location: 'src/a.ts:7', cwe: 'CWE-89', stride: [], confidence: null, description: 'desc ' + evil, remediation: null, evidence: [], finding_id: 'f-1' },
        { severity: 'medium', title: 'Medium one', location: null, cwe: null, stride: [], confidence: 'HIGH', description: 'm', remediation: null, evidence: [], finding_id: 'f-2' }] };
    const url = `/api/security-run?repo=${REPO_ID}&run=r3-20261115T120000000Z-manual-security-review`;
    const page = await runPage([p], `#security/run/${REPO_ID}/r3-20261115T120000000Z-manual-security-review`, null, { [url]: detail, '/api/security-agent': { repos: [] } });
    await page.settle();
    const sec = page.dom.byId.security;
    assert.ok(page.requests.some((r) => r.url === url), 'fetched the run');
    assert.ok(sec.textContent.includes(evil), 'the text is shown as text');
    assert.ok(!sec.all().some((e) => e.nodeName === 'IMG'), 'no element came from finding text');
    assert.match(sec.textContent, /No remediation provided by this run type\./);
    assert.match(sec.textContent, /prism-cli security findings --job job-3 --path ~\/src\/demo-shop/);
    assert.match(sec.textContent, /~\/src\/demo-shop\/\.prism\/results\/r3\.json/);
    const findings = () => sec.all().filter((e) => e.nodeName === 'DETAILS');
    assert.equal(findings().length, 2);
    sec.all().find((e) => e.getAttribute('data-sev') === 'medium')!.listeners.click();
    assert.equal(findings().length, 1);
    const missing = await runPage([p], `#security/run/${REPO_ID}/gone-x`, null, { [`/api/security-run?repo=${REPO_ID}&run=gone-x`]: { found: false, error: 'no such run in this repo (it may have been deleted)' }, '/api/security-agent': { repos: [] } });
    await missing.settle();
    const ms = missing.dom.byId.security;
    assert.match(ms.textContent, /Run not found/);
    assert.ok(ms.all().some((e) => e.nodeName === 'A' && e.getAttribute('href') === '#security' && /Back to Security runs/.test(e.textContent)));
  } finally { cleanup(); }
});

test('page: the drawer shows "Complete. View findings" for a finished run, nothing while it runs', async () => {
  const { SETUP_SCRIPT } = await import('../src/dashboard/setup-page.js');
  assert.match(SETUP_SCRIPT, /s\.state === 'done' && typeof runDoneBar === 'function' \? runDoneBar\(s\.result\) : null\]\.filter\(Boolean\)/);
  const { SECURITY_RUNS_SCRIPT } = await import('../src/dashboard/security-runs-page.js');
  assert.match(SECURITY_RUNS_SCRIPT, /if \(!r \|\| r\.status === 'running' \|\| !r\.repo \|\| !r\.run\) return null;/);
  assert.match(SECURITY_RUNS_SCRIPT, /ok \? 'Complete\.' :/);
});

test('a job id outside the safe shape is never listed or opened; a valid one is quoted in the copy command', () => {
  const { list, cleanup } = repos();
  try {
    const [shop] = list;
    const hostile = 'job$(touch pwned);x';
    const p = writeResult(shop.path, review(hostile, at(5), { counts: { LOW: 1 }, findings: [crFinding('LOW', 'x')] }));
    const id = p.split('/').pop()!.replace(/\.json$/, '');
    assert.deepEqual(collectSecurityRuns(list, undefined, NOW), [], 'not in the list');
    const d = securityRunDetail(list, shop.id, id, '', NOW);
    assert.equal(d.found, false);
    assert.ok(!JSON.stringify(d).includes('touch'), 'the id never reaches a command');
    const ok = writeResult(shop.path, review('crj-1:a.b_c', at(4)));
    const g = securityRunDetail(list, shop.id, ok.split('/').pop()!.replace(/\.json$/, ''), '', NOW);
    assert.ok(g.found && g.cli.startsWith('prism-cli security findings --job crj-1:a.b_c --path '));
  } finally { cleanup(); }
});

test('runner: when the run lookup fails, the output says so and there is no link', async () => {
  const home = tmp('runner-fail');
  const path = join(home, 'src', 'demo');
  mkdirSync(path, { recursive: true });
  const REPO: ScanRepo = { id: repoId(path), name: 'demo', path };
  const spawn = () => {
    const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true;
    setTimeout(() => { c.stdout.emit('data', 'Saved it\n'); c.emit('close', 0); }, 5);
    return c;
  };
  const errs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: string) => { errs.push(String(s)); return true; };
  const r = new ActionRunner({ execPath: '/usr/bin/node', entry: '/x.js', cwd: home, home, repos: async () => [REPO], systemdAvailable: () => false, platform: 'linux', spawn: spawn as any, awsArgs: () => [], writeGate: () => null,
    runWritten: () => { throw new Error('EACCES: permission denied'); } });
  try {
    assert.equal((await r.start({ action: 'security-findings', repo: REPO.id })).status, 202);
    for (let i = 0; i < 200 && r.status().state !== 'done'; i++) await new Promise((x) => setTimeout(x, 5));
    const s = r.status();
    assert.equal(s.result, null);
    assert.match(s.output!, /\[Could not find the result file; open the Security Agent page to see the run\]/);
    assert.ok(errs.some((l) => /could not read the run security-findings wrote in demo: EACCES/.test(l)), errs.join(''));
  } finally { (process.stderr as any).write = orig; rmSync(home, { recursive: true, force: true }); }
});

test('page: a run opened while running is read again when the page comes back to it, and shows its findings', async () => {
  const { p, cleanup } = await pagePayload();
  try {
    const run = 'r9-20261115T120000000Z-manual-security-review';
    const url = `/api/security-run?repo=${REPO_ID}&run=${run}`;
    const base = { found: true, account4: '••••3333', region: 'us-west-2', scope: null, target_host: null, overview: null, result_file: '~/r9.json', cli: 'prism-cli security findings --job job-9 --path ~/src/x', no_remediation: 'No remediation provided by this run type.' };
    let calls = 0, finished = false;
    const answer = () => (++calls, !finished ? { ...base, run: row(9, { status: 'running', duration_s: null }), findings: [] }
      : { ...base, run: row(9), findings: [{ severity: 'critical', title: 'Now found', location: 'a.ts:1', cwe: null, stride: [], confidence: null, description: 'd', remediation: null, evidence: [], finding_id: 'f' }] });
    const page = await runPage([p], `#security/run/${REPO_ID}/${run}`, null, { [url]: answer, '/api/security-agent': { repos: [] } });
    await page.settle();
    assert.match(page.dom.byId.security.textContent, /Still running/);
    const before = calls;
    finished = true;
    page.go('#');
    page.go(`#security/run/${REPO_ID}/${run}`);
    await page.settle();
    assert.ok(calls > before, 'read again on the way back');
    assert.match(page.dom.byId.security.textContent, /Now found/);
    assert.doesNotMatch(page.dom.byId.security.textContent, /Still running/);
  } finally { cleanup(); }
});
