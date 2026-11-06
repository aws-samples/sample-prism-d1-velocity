/**
 * Tests for the codewatch scan report (src/dashboard/report.ts): id
 * validation, report content from fixture results over a real git history,
 * the three formats, the server routes and the CLI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReport, findResultById, renderReportHtml, renderReportJson, renderReportMarkdown, reportFromRepos, reviewForCommit,
} from '../src/dashboard/report.js';
import { readLog } from '../src/dashboard/commits.js';
import { makeResult, readResultEntries, writeResult, REASON_GITLEAKS_MISSING, type Finding, type PrismResult } from '../src/codewatch/results.js';
import { cookieName, startServer, BIND_HOST } from '../src/dashboard/server.js';
import { renderPage } from '../src/dashboard/page.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-report-gcfg-')), 'gitconfig');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `prism-report-${p}-`));
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'prism-cli.ts');

let clock = 0;
function git(cwd: string, ...args: string[]): string {
  const date = `2026-11-05T10:${String(clock).padStart(2, '0')}:00Z`;
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(dir: string, files: Record<string, string>, msg: string): string {
  clock++;
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}
const f = (severity: Finding['severity'], category: Finding['category'], file: string, line: number | null, message = `${file}:${line}`): Finding =>
  ({ severity, category, rule: `rule-${severity}`, file, line, message });

/**
 * base, then a push of c1 (lookup.ts, bad line 2) and c2 (report.ts, bad line 1),
 * with pre-commit scans, one gitleaks block in the window, one outside it,
 * one on another branch, and an earlier review of the branch.
 */
function fixture(reviewExtra: Partial<PrismResult> = {}) {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'work', `--template=${tmp('tpl')}`);
  const base = commit(dir, { 'README.md': '# r\n' }, 'base');
  const c1 = commit(dir, { 'lookup.ts': 'const a = 1;\nexec("grep " + user);\n' }, 'add lookup');
  const c2 = commit(dir, { 'report.ts': 'readFileSync(dir + name);\n' }, 'add report reader');
  const tree = (c: string) => git(dir, 'rev-parse', `${c}^{tree}`);
  const sec = (at: string, status: PrismResult['status'], extra: Partial<PrismResult> = {}) =>
    makeResult({ kind: 'secrets', hook: 'pre-commit', tool: 'gitleaks', status, branch: 'work', started_at: at, finished_at: at, ...extra });
  writeResult(dir, makeResult({ kind: 'review', hook: 'pre-push', tool: 'kiro', status: 'ok', commit: base, base: null, branch: 'work', started_at: '2026-11-05T09:00:00.000Z', finished_at: '2026-11-05T09:00:05.000Z' }));
  writeResult(dir, sec('2026-11-05T08:30:00.000Z', 'findings', { tree: 'old', findings: [{ severity: 'high', category: 'security', rule: 'too-early', file: 'x', line: 1, message: 'm' }] }));
  writeResult(dir, sec('2026-11-05T10:01:00.000Z', 'ok', { tree: tree(c1) }));
  writeResult(dir, sec('2026-11-05T10:01:30.000Z', 'findings', { tree: 'blocked', findings: [{ severity: 'high', category: 'security', rule: 'aws-access-token', file: 'creds.ts', line: 3, message: 'Identified an AWS key (value redacted)' }] }));
  writeResult(dir, sec('2026-11-05T10:01:40.000Z', 'findings', { tree: 'other', branch: 'side', findings: [{ severity: 'high', category: 'security', rule: 'other-branch', file: 'y', line: 1, message: 'm' }] }));
  writeResult(dir, sec('2026-11-05T10:02:00.000Z', 'skipped', { tree: tree(c2), reason: REASON_GITLEAKS_MISSING }));
  const review = makeResult({
    kind: 'review', hook: 'pre-push', tool: 'kiro', tool_version: 'kiro-cli 3.0.0', model: 'auto', status: 'findings',
    commit: c2, base, branch: 'work', upstream: 'origin/work', score: 0.4, summary: 'Two problems <b>found</b>.',
    started_at: '2026-11-05T10:05:00.000Z', finished_at: '2026-11-05T10:05:42.000Z',
    findings: [f('low', 'quality', 'lookup.ts', 2), f('high', 'security', 'lookup.ts', 2, '<script>alert(1)</script> in exec'), f('medium', 'security', 'report.ts', 1), f('low', 'quality', 'lookup.ts', 99)],
    ...reviewExtra,
  });
  const path = writeResult(dir, review);
  const id = path.split('/').pop()!.replace(/\.json$/, '');
  return { dir, base, c1, c2, id };
}

// ---------------------------------------------------------------- id validation

test('ids are matched against the listing only; traversal, malformed and unknown ids are rejected', () => {
  const fx = fixture();
  assert.equal(findResultById(fx.dir, fx.id)?.id, fx.id);
  for (const bad of ['', '..', '../../etc/passwd', '..%2F..%2Fetc', 'a/b', fx.id + '.json', fx.id + '/../x', 'x'.repeat(200), 'nope-not-a-result']) {
    assert.equal(findResultById(fx.dir, bad), null, bad);
  }
  assert.equal(reportFromRepos([fx.dir], '../' + fx.id), null);
  // a pre-commit result is not a review: no report
  const pc = readResultEntries(fx.dir).find((e) => e.result.hook === 'pre-commit')!;
  assert.equal(reportFromRepos([fx.dir], pc.id), null);
});

// ---------------------------------------------------------------- content

test('report: header, totals, findings grouped by file and attributed to commits', () => {
  const fx = fixture();
  const entries = readResultEntries(fx.dir);
  const r = buildReport(fx.dir, findResultById(fx.dir, fx.id, entries)!, entries);
  assert.deepEqual([r.branch, r.range.base, r.range.tip, r.range.commits], ['work', fx.base, fx.c2, 2]);
  assert.deepEqual([r.reviewer.tool, r.reviewer.model, r.reviewer.version], ['kiro', 'auto', 'kiro-cli 3.0.0']);
  assert.equal(r.durationSeconds, 42);
  assert.equal(r.state, 'findings');
  assert.equal(r.score, 0.4);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.totals, { severity: { high: 1, medium: 1, low: 2 }, category: { security: 2, quality: 2 }, findings: 4 });
  assert.deepEqual(r.files.map((g) => g.file), ['lookup.ts', 'report.ts'], 'file with the worst finding first');
  const lookup = r.files[0].findings;
  assert.deepEqual(lookup.map((x) => [x.severity, x.line]), [['high', 2], ['low', 2], ['low', 99]], 'sorted by severity');
  assert.equal(lookup[0].commit, fx.c1);
  assert.equal(lookup[0].commitSubject, 'add lookup');
  assert.equal(lookup[2].commit, fx.c2, 'out-of-range line falls back to the tip');
  assert.equal(lookup[2].inPushOf, fx.c2);
  assert.equal(r.files[1].findings[0].commit, fx.c2);
  assert.deepEqual(r.commits.map((c) => [c.sha, c.high, c.medium, c.low]), [[fx.c2, 0, 1, 1], [fx.c1, 1, 0, 1]]);
});

test('report: secret scan per commit and gitleaks blocks in the push window, without secret values', () => {
  const fx = fixture();
  const entries = readResultEntries(fx.dir);
  const r = buildReport(fx.dir, findResultById(fx.dir, fx.id, entries)!, entries);
  const by = Object.fromEntries(r.secretScans.map((c) => [c.sha, c.secretScan]));
  assert.deepEqual(by, { [fx.c1]: 'ok', [fx.c2]: 'not-scanned' });
  assert.deepEqual(r.gitleaksBlocks.map((b) => b.items), [[{ rule: 'aws-access-token', file: 'creds.ts', line: 3 }]],
    'only this branch, only after the previous review, and only rule + location');
  const json = renderReportJson(r);
  assert.ok(!/value redacted|Identified an AWS key|"Secret"|"Match"/.test(json), 'no secret text or gitleaks value fields');
});

test('report: truncated diff and error states', () => {
  const t = fixture({ status: 'ok', findings: [], reason: 'diff truncated to 200000 characters' });
  let entries = readResultEntries(t.dir);
  const rt = buildReport(t.dir, findResultById(t.dir, t.id, entries)!, entries);
  assert.equal(rt.truncated, true);
  assert.equal(rt.state, 'clean');
  assert.match(renderReportMarkdown(rt), /\*\*Warning:\*\* the diff was truncated/);
  assert.match(renderReportHtml(rt), /class="alert" role="alert">The diff was truncated/);

  const er = fixture({ status: 'error', findings: [], summary: null, reason: 'kiro-cli timed out after 300s' });
  entries = readResultEntries(er.dir);
  const re = buildReport(er.dir, findResultById(er.dir, er.id, entries)!, entries);
  assert.equal(re.state, 'error');
  assert.match(renderReportMarkdown(re), /Status:\*\* error \(kiro-cli timed out after 300s\)/);
  assert.match(renderReportMarkdown(re), /_No summary\._/);
});

test('reviewForCommit finds the newest review covering a commit, by full or short sha', () => {
  const fx = fixture();
  const entries = readResultEntries(fx.dir);
  const log = readLog(fx.dir);
  assert.equal(reviewForCommit(entries, fx.c1, log)?.id, fx.id);
  assert.equal(reviewForCommit(entries, fx.c2.slice(0, 8), log)?.id, fx.id);
  assert.equal(reviewForCommit(entries, 'deadbeef', log), null);
});

// ---------------------------------------------------------------- formats

test('formats: markdown, self-contained html with everything escaped, json', () => {
  const fx = fixture();
  const r = reportFromRepos([fx.dir], fx.id)!;
  const md = renderReportMarkdown(r);
  for (const h of ['# Codewatch scan report:', '## Summary', '## Totals', '## Findings by file', '### lookup.ts', '## Secret scan', '### Gitleaks blocks during this push', '## Commits']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('\\<script\\>'), 'markdown escapes angle brackets');

  const html = renderReportHtml(r);
  assert.ok(!/<script/i.test(html), 'no script element, and the message is escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Two problems &lt;b&gt;found&lt;/b&gt;.'));
  assert.ok(/@media print/.test(html));
  assert.ok(!/https?:\/\//.test(html), 'no external resources');
  assert.ok(!/innerHTML/.test(html));

  const j = JSON.parse(renderReportJson(r));
  assert.equal(j.schema, 'prism.codewatch.report.v1');
  assert.equal(j.id, fx.id);
});

test('the dashboard page script uses no innerHTML', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(renderPage('N')));
});

// ---------------------------------------------------------------- routes

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: BIND_HOST, port, path, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('report routes need the token and serve html and markdown', async () => {
  const fx = fixture();
  const srv = await startServer({ getPayload: async () => ({}), getReport: async (id) => reportFromRepos([fx.dir], id) });
  try {
    const p = srv.port;
    assert.equal((await get(p, `/report/${fx.id}`)).status, 401);
    assert.equal((await get(p, `/report/${fx.id}.md`)).status, 401);
    assert.equal((await get(p, `/report/${fx.id}?token=${srv.token}`)).status, 401, 'the URL token is only exchanged on /');
    const cookie = { Cookie: `${cookieName(p)}=${srv.token}` };
    const page = await get(p, `/report/${fx.id}`, cookie);
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /style-src 'nonce-/);
    assert.ok(page.body.includes(`href="/report/${fx.id}.md"`), 'Download Markdown link');
    const md = await get(p, `/report/${fx.id}.md`, cookie);
    assert.equal(md.status, 200);
    assert.match(String(md.headers['content-type']), /text\/markdown/);
    assert.match(String(md.headers['content-disposition']), /attachment/);
    assert.equal(md.body, renderReportMarkdown(reportFromRepos([fx.dir], fx.id)!));
    for (const bad of ['/report/nope', '/report/..%2F..%2Fetc%2Fpasswd', '/report/x/../../etc/passwd', `/report/${fx.id}.json`, '/report/a.b']) {
      assert.equal((await get(p, bad, cookie)).status, 404, bad);
    }
    // Dot segments are resolved by URL parsing before routing, so this is just /api/data.
    assert.equal((await get(p, '/report/../api/data', cookie)).body, '{}');
    assert.equal((await get(p, `/report/${fx.id}`, { ...cookie, Host: 'evil.example.com' })).status, 403);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------- CLI

test('prism-cli codewatch report: md by default, html and json to a file, by commit, unknown id fails', () => {
  const fx = fixture();
  const tsx = import.meta.resolve('tsx');
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', tsx, CLI, 'codewatch', 'report', '--repo', fx.dir, ...args], { encoding: 'utf8' });
  const md = cli();
  assert.equal(md.status, 0, md.stderr);
  assert.ok(md.stdout.startsWith(`# Codewatch scan report: `));
  assert.ok(md.stdout.includes(fx.id), 'latest review by default');
  const out = join(tmp('out'), 'r.html');
  assert.equal(cli('--commit', fx.c1.slice(0, 8), '--format', 'html', '--output', out).status, 0);
  assert.ok(readFileSync(out, 'utf8').startsWith('<!DOCTYPE html>'));
  const j = cli('--id', fx.id, '--format', 'json');
  assert.equal(JSON.parse(j.stdout).range.commits, 2);
  const bad = cli('--id', '../../etc/passwd');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no result/);
});
