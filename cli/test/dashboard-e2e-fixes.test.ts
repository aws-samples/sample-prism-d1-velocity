/**
 * Fixes from the 1.15.0 Playwright pass (test/e2e/, REPORT ids B1-B12) that a
 * unit or fake-DOM test can hold: running code reviews, codeburn failure text,
 * repo labels in the Security Agent picker, the update check turned off, the
 * AWS CLI's trailing period, and the narrow-layout CSS. Contrast (B11) and the
 * masked account (B9) are in dashboard-summary and enable-security tests; the
 * real layout at 320-1280 px is the e2e run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeResult, type PrismResult } from '../src/codewatch/results.js';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { collectSecurity } from '../src/dashboard/security.js';
import { collectUsage, exportFailure, realCodeburnExport } from '../src/dashboard/usage.js';
import { UpdateCheck } from '../src/dashboard/update-check.js';
import { renderPage } from '../src/dashboard/page.js';
import { clause } from '../src/utils/aws.js';
import { FakeElement, runPage, SETUP_STUB } from './page-dom.js';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-fix-${p}-`)));
const NOW = new Date('2026-11-14T12:00:00Z');

function review(job: string, status: PrismResult['status'], at: string, counts: Record<string, number> = {}, scope: 'diff' | 'full' = 'diff'): PrismResult {
  return makeResult({
    kind: 'security-review', hook: 'manual', tool: 'aws-security-agent', status, started_at: at, finished_at: at,
    findings: status === 'pending' ? [] : Object.entries(counts).map(([lvl], i) => ({ severity: 'high', category: 'security', rule: 'r', file: `src/f${i}.ts`, line: 1, message: lvl, risk_level: lvl, title: lvl + ' issue' })),
    security: { job_id: job, code_review_id: 'cr-1', agent_space_id: 'as-1', region: 'us-west-2', scope, job_status: status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED', counts },
  });
}
const repoList = [{ name: 'shop', path: '/w/shop', current: true }];

// ---------------------------------------------------------------- B4: a running review does not hide the last completed one

test('security panel: a newer pending review keeps the last completed review on the page, with the running job beside it', () => {
  const done = review('job-old', 'findings', '2026-11-14T08:00:00Z', { CRITICAL: 1, HIGH: 1 });
  const run = review('job-new', 'pending', '2026-11-14T11:30:00Z', {}, 'full');
  const [row] = collectSecurity(repoList, () => [done, run], NOW).repos;
  assert.equal(row.job_id, 'job-old');
  assert.equal(row.pending, false);
  assert.deepEqual(row.counts, { CRITICAL: 1, HIGH: 1 });
  assert.equal(row.findings.length, 2);
  assert.deepEqual(row.running, { job_id: 'job-new', scope: 'full', started_at: '2026-11-14T11:30:00Z', stale: false, check: null });

  // Only a pending job: that is the row, as before. A completed newest job: nothing running.
  const [only] = collectSecurity(repoList, () => [run], NOW).repos;
  assert.equal(only.pending, true);
  assert.equal(only.running, null);
  const [fresh] = collectSecurity(repoList, () => [run, review('job-new', 'ok', '2026-11-14T11:30:00Z', {}, 'full')], NOW).repos;
  assert.equal(fresh.pending, false);
  assert.equal(fresh.running, null, 'the pending job got its verdict');
});

// ---------------------------------------------------------------- the page

async function payload(names = ['shop', 'pay']): Promise<DashboardPayload> {
  const home = tmp('ph');
  for (const n of names) mkdirSync(join(home, n, '.git'), { recursive: true });
  return buildPayload({
    cwd: tmp('nowhere'), home, pathEnv: tmp('path'),
    exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
    version: async () => ({ installed: '1.15.1', latest: '1.15.1', publishedAt: '2026-11-14T00:00:00.000Z', update: false, checkedAt: '2026-11-14T00:00:00.000Z' }),
    agentHooks: () => ({ rows: [], plugin: { active: false, version: null, outdated: false } }),
  });
}
const secRow = (path: string, over: Record<string, unknown> = {}) => ({
  name: 'shop', path, current: true, job_id: 'job-old', job_status: 'COMPLETED', status: 'findings', scope: 'diff', started_at: '2026-11-14T08:00:00Z', finished_at: '2026-11-14T08:20:00Z',
  counts: { CRITICAL: 1 }, findings: [{ risk_level: 'CRITICAL', title: 'Hard-coded key', file: 'src/a.ts', line: 3, cwe: null }], truncated: false, reason: null, pending: false, stale: false, running: null, ...over,
});
const withSecurity = (p: DashboardPayload, repos: unknown[]) => {
  const q = JSON.parse(JSON.stringify(p));
  q.security = { repos, pentests: [], threat_models: [], hint: 'prism-cli security code-review', pending_hint: 'prism-cli security findings', pentest_hint: '', threats_hint: '' };
  return q;
};

test('repo page (B1): a pending code review reads "running", never "no findings"', async () => {
  const p = await payload();
  const q = withSecurity(p, [secRow(p.repos[0].path, { status: 'pending', pending: true, counts: {}, findings: [], job_status: 'IN_PROGRESS' })]);
  const page = await runPage([q], '#repo/' + p.repos[0].id);
  const t = page.dom.byId.repo.textContent;
  assert.match(t, /Code reviewrunningstarted /);
  assert.doesNotMatch(t, /no findings/);
});

test('dashboard and repo page (B4): the last completed review keeps its findings with a "new review running" note', async () => {
  const p = await payload();
  const running = { job_id: 'job-new-123456789', scope: 'full', started_at: '2026-11-14T11:30:00Z', stale: false };
  const q = withSecurity(p, [secRow(p.repos[0].path, { running })]);
  const page = await runPage([q]);
  // 1.18.0: the Dashboard lists runs (security-runs.ts); a run's findings are a drill-down, not a list on the Dashboard.
  assert.doesNotMatch(page.text(), /Hard-coded key/);
  page.go('#repo/' + p.repos[0].id);
  assert.match(page.dom.byId.repo.textContent, /Code review1 critical.*new review running/);
});

test('Security Agent picker (B6): two repos with one name show the dashboard labels', async () => {
  const p = await payload(['a/demo-shop', 'b/demo-shop']);
  const sa = { ttlSec: 300, repos: p.repos.map((r, i) => ({ id: r.id, name: r.name, path: '~/' + r.name, current: i === 0, marker: null, target: { profile: null, region: 'us-west-2', source: 'default chain', credentialLabel: '' }, gate: { state: 'connect', step: 1, title: 'Connect an AWS account first', detail: [], copy: {}, using: null, info: [] }, commands: {}, copy: {}, notices: {}, lookup: null })) };
  const page = await runPage([p], '#security', SETUP_STUB, { '/api/security-agent': sa });
  const opts = page.dom.byId.security.all().filter((e) => e.nodeName === 'OPTION').map((o) => o.textContent);
  assert.deepEqual(opts.sort(), ['a/demo-shop (this repo)', 'b/demo-shop']);
});

test('codewatch counts (B7): the footer and the Codewatch card name the same two counts', async () => {
  const p = await payload();
  const page = await runPage([p]);
  assert.match(page.meta(), / · 0 with codewatch hooks installed/);
});

// ---------------------------------------------------------------- B5: codeburn's own reason, no paths

test('codeburn export failure (B5): codeburn\'s stderr line, never the argv, the binary path or the temp file', async () => {
  const dir = tmp('cb');
  const bin = join(dir, 'codeburn');
  writeFileSync(bin, '#!/bin/sh\necho "codeburn: no data directory found" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  await assert.rejects(realCodeburnExport(bin)(['--from', '2026-11-01']), (e: Error) => {
    assert.equal(e.message, 'codeburn: no data directory found');
    return true;
  });
  const u = await collectUsage({ exporter: realCodeburnExport(bin), now: NOW });
  assert.equal(u.status, 'error');
  assert.equal(u.message, 'codeburn export failed: codeburn: no data directory found');
  assert.doesNotMatch(u.message!, /Command failed|\//);

  // Silent non-zero exit, a home or temp path in codeburn's text, a timeout, a temp dir that cannot be made.
  assert.equal(exportFailure({ code: 3, stderr: '' }, null), 'codeburn exited with code 3');
  assert.equal(exportFailure({ code: 1, stderr: 'cannot read /home/demo/.config/codeburn/db: locked\n' }, null, '/home/demo'), 'cannot read ~/.config/codeburn/db: locked');
  assert.equal(exportFailure({ code: 1, stderr: 'cannot write /tmp/prism-dash-cb-x/export.json' }, '/tmp/prism-dash-cb-x'), 'cannot write <export file>/export.json');
  assert.equal(exportFailure({ killed: true, signal: 'SIGTERM' }, null), 'codeburn did not answer within 60 s');
  assert.equal(exportFailure(Object.assign(new Error("ENOENT: no such file or directory, mkdtemp '/home/demo/tmp/prism-dash-cb-XXXXXX'"), { code: 'ENOENT', syscall: 'mkdtemp' }), null), 'could not use a temp file for the export (ENOENT)');
  assert.equal(exportFailure(Object.assign(new Error('spawn /opt/bin/codeburn ENOENT'), { code: 'ENOENT', syscall: 'spawn /opt/bin/codeburn' }), null), 'codeburn could not be started');
});

// ---------------------------------------------------------------- B10: the update check turned off

test('update check off (B10): the version block says off; Check now is disabled with the reason', async () => {
  const off = new UpdateCheck({ installed: '1.15.1', file: join(tmp('up'), 'u.json'), env: { PRISM_NO_UPDATE_CHECK: '1' } });
  assert.equal(off.current().off, true);
  const on = new UpdateCheck({ installed: '1.15.1', file: join(tmp('up'), 'u.json'), env: {} });
  assert.equal(on.current().off, undefined);

  const p = await payload();
  (p as any).version = off.current();
  const page = await runPage([p], '#settings/updates', SETUP_STUB);
  const s = page.dom.byId.settings;
  const check = s.querySelectorAll('button').filter((b) => b.textContent === 'Check now').pop()!;
  assert.ok(check.hasAttribute('disabled'), 'Check now is disabled');
  assert.match(s.textContent, /check off/);
  assert.match(s.textContent, /The update check is off \(PRISM_NO_UPDATE_CHECK=1/);
  assert.match(s.textContent, /never: the check is off/);
  const pill = page.dom.byId.ver.childNodes[0] as FakeElement;
  assert.equal(pill.getAttribute('title'), 'update check: off (PRISM_NO_UPDATE_CHECK=1)');
});

// ---------------------------------------------------------------- B12 and the narrow-layout CSS (B2, B3, B8)

test('clause (B12): an AWS CLI message continues a sentence without its own period', () => {
  assert.equal(clause('Unable to locate credentials. You can configure credentials by running "aws configure".'), 'Unable to locate credentials. You can configure credentials by running "aws configure"');
  assert.equal(clause('ExpiredToken'), 'ExpiredToken');
  assert.equal(clause(' trailing.. \n'), 'trailing');
});

test('narrow layout CSS (B2, B3, B8): one-column grids may shrink below their tables; paths in controls wrap', () => {
  const html = renderPage('N');
  assert.match(html, /@media \(max-width: 860px\) \{ \.grid2 \{ grid-template-columns:minmax\(0,1fr\); \} \}/, 'repo page: a 1fr track would grow to the table\'s min-content');
  assert.match(html, /\.setup-layout \{ grid-template-columns:minmax\(0,1fr\); \}/, 'Settings panes');
  assert.match(html, /\.srow-ctl code \{ min-width:0; overflow-wrap:anywhere; \}/, 'Security Agent repo path');
  assert.match(html, /td code\.path \{ display:inline-block; min-width:16ch; \}/, 'Agent hooks file paths wrap at 16 characters, not 3');
  assert.match(html, /\.srow-ctl select \{ max-width:100%; min-width:0; \}/, 'Settings › AWS: a long profile name does not widen the page');
});
