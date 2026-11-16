/**
 * The run drill-down's header and overview (security-runs-page.ts), and the
 * safe markdown renderer behind the overview (markdown-lite.ts): a threat
 * model shaped like a real one (a long markdown overview, 18 threats) keeps
 * its header fields at the top, shows the overview collapsed, and lists every
 * threat; hostile markdown comes out as text. No AWS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKDOWN_SCRIPT } from '../src/dashboard/markdown-lite.js';
import { buildPayload } from '../src/dashboard/payload.js';
import { toThreatModelResult } from '../src/security/threat-model.js';
import { FakeElement, FakeNode, FakeText, fakeDom, runPage } from './page-dom.js';

const md = () => {
  const { document } = fakeDom();
  return new Function('document', MARKDOWN_SCRIPT + '\nreturn { mdBlocks, mdInline };')(document) as { mdBlocks: (t: string, first?: boolean) => FakeElement[] };
};
const ALLOWED = new Set(['H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'CODE', 'STRONG', 'PRE']);
const walk = (n: FakeNode): FakeNode[] => [n, ...n.childNodes.flatMap(walk)];

test('markdown: hostile input leaves only text and the allowed tags, with no attributes', () => {
  const { mdBlocks } = md();
  const hostile = '# Title <script>alert(1)</script>\n\nSee <img src=x onerror=alert(1)> and [click](javascript:alert(1)) and ![pic](https://evil.example/x.png).\n\n- **bold** `<b>code</b>`\n- <a href="javascript:x">raw</a>\n\n```\n<script>fence</script>\n```\n\n| a | <iframe> |\n';
  const nodes = mdBlocks(hostile);
  const all = nodes.flatMap(walk);
  const els = all.filter((n): n is FakeElement => n instanceof FakeElement);
  assert.ok(els.every((e) => ALLOWED.has(e.nodeName)), els.map((e) => e.nodeName).join(','));
  assert.ok(els.every((e) => e.attrs.size === 0), 'no attributes on anything');
  const text = nodes.map((n) => n.textContent).join('\n');
  assert.match(text, /Title <script>alert\(1\)<\/script>/, 'tags stay visible as text');
  assert.match(text, /See <img src=x onerror=alert\(1\)> and click and pic\./, 'a link shows its text only, an image its alt text');
  assert.doesNotMatch(text, /javascript:alert|evil\.example/, 'no URL survives');
  assert.deepEqual(nodes.map((n) => n.nodeName), ['H3', 'P', 'UL', 'PRE', 'PRE']);
  assert.equal(nodes[3].textContent, '<script>fence</script>');
  assert.ok(all.some((n) => n instanceof FakeText && n.data === '<b>code</b>'), 'inline code is text inside <code>');
});

test('markdown: headings, numbered and bullet lists, paragraphs; the first paragraph alone for the collapsed view', () => {
  const { mdBlocks } = md();
  const doc = '# Name\n\nFirst para line one\nline two.\n\n## Purpose\n\n1. one\n2. two\n\n- a\n  - nested\n\nLast.';
  assert.deepEqual(mdBlocks(doc).map((n) => [n.nodeName, n.textContent]), [['H3', 'Name'], ['P', 'First para line one line two.'], ['H4', 'Purpose'], ['OL', 'onetwo'], ['UL', 'anested'], ['P', 'Last.']]);
  assert.deepEqual(mdBlocks(doc, true).map((n) => [n.nodeName, n.textContent]), [['P', 'First para line one line two.']]);
});

test('a threat model result saves the affected components and assets', () => {
  const r = toThreatModelResult({ space: 'as-1', region: 'us-west-2', threatModelId: 'tm-1', scopeDocs: [], now: new Date('2026-11-16T00:00:00Z'),
    job: { threatModelJobId: 'tj-1', threatModelId: 'tm-1', status: 'COMPLETED', createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T01:00:00Z', errorCode: null, reason: null, systemOverview: '# X' } as any,
    threats: [{ threatId: 't1', severity: 'HIGH', status: '', title: 'T', statement: 'S', stride: [], recommendation: 'R', evidence: [], impactedAssets: ['gate policy', 'OIDC role'] }] });
  assert.deepEqual(r.findings[0].assets, ['gate policy', 'OIDC role']);
});

/** A run detail like GET /api/security-run answers for a real threat model: 18 threats (7 critical, 10 high, 1 medium), a long overview. */
function tmDetail(repoId: string) {
  const sev = [...Array(7).fill('critical'), ...Array(10).fill('high'), 'medium'];
  const overview = '# PRISM D1 Velocity\n\nA developer-platform toolkit, a single `prism-cli` binary.\n\n## Purpose\n\n' + Array.from({ length: 300 }, (_, i) => `- point ${i} with **bold** text`).join('\n');
  return {
    found: true, account4: '••••6218', region: 'us-west-2', scope: null, target_host: null, overview, no_remediation: null,
    result_file: '~/src/x/.prism/results/r.json', cli: 'prism-cli security threats --job tj-1 --path ~/src/x',
    run: { repo_id: repoId, run_id: 'r1-20261116T014447446Z-manual-security-threat-model', repo: 'x', type: 'threat-model', status: 'complete', started_at: '2026-11-16T01:44:47.446Z', duration_s: 3869,
      branch: 'main', commit: '98ea2b695a00', counts: { critical: 7, high: 10, medium: 1, low: 0 }, total: 18, top_title: 't', reason: null, job_id: 'tj-1' },
    findings: sev.map((s, i) => ({ severity: s, title: 'Threat ' + i, location: null, cwe: null, stride: ['TAMPERING'], confidence: null, description: 'Statement ' + i, remediation: 'Fix ' + i, evidence: ['a.ts'], assets: i ? [] : ['gate policy'], finding_id: 't-' + i })),
  };
}

test('drill-down: header fields, the overview collapsed then full, 18 threats with a working filter', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'prism-tmdd-')));
  mkdirSync(join(home, 'x', '.git'), { recursive: true });
  try {
    const p = await buildPayload({ cwd: home, home, pathEnv: home, exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
      machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
      version: async () => ({ installed: '1.20.1', latest: '1.20.1', publishedAt: '2026-11-13T00:00:00.000Z', update: false, checkedAt: '2026-11-14T00:00:00.000Z' }),
      agentHooks: () => ({ rows: [], plugin: { active: false, version: null, outdated: false } }) } as any);
    const id = 'aaaaaaaaaaaaaaaa', run = 'r1-20261116T014447446Z-manual-security-threat-model';
    const page = await runPage([p], `#security/run/${id}/${run}`, null, { [`/api/security-run?repo=${id}&run=${run}`]: tmDetail(id), '/api/security-agent': { repos: [] } });
    await page.settle();
    const sec = page.dom.byId.security;
    const dts = sec.all().filter((e) => e.nodeName === 'DT').map((e) => e.textContent);
    assert.deepEqual(dts, ['Repo', 'Branch, commit', 'Account, region', 'Started', 'Duration', 'Job']);
    assert.match(sec.textContent, /main @ 98ea2b695a00.*account ••••6218 \/ us-west-2.*1 h 4 min.*tj-1Copy/);
    const head = sec.all().find((e) => e.hasAttribute('data-run-detail'))!;
    assert.doesNotMatch(head.textContent, /Purpose|point 1/, 'the overview is not in the header');
    const ov = () => sec.all().find((e) => e.hasAttribute('data-run-overview'))!;
    assert.equal(ov().getAttribute('data-run-overview'), 'short');
    assert.equal(ov().textContent, 'A developer-platform toolkit, a single prism-cli binary.');
    const toggle = sec.all().find((e) => e.hasAttribute('data-overview-toggle'))!;
    assert.equal(toggle.textContent, 'Show full overview');
    toggle.listeners.click();
    assert.equal(ov().getAttribute('data-run-overview'), 'full');
    assert.equal(ov().all().filter((e) => e.nodeName === 'LI').length, 300);
    assert.equal(toggle.textContent, 'Show less');
    const findings = () => sec.all().filter((e) => e.hasAttribute('data-fid'));
    assert.equal(findings().length, 18);
    assert.match(sec.textContent, /All 18Critical 7High 10Medium 1/);
    sec.all().find((e) => e.getAttribute('data-sev') === 'critical')!.listeners.click();
    assert.equal(findings().length, 7);
    sec.all().find((e) => e.getAttribute('data-sev') === '')!.listeners.click();
    const first = findings()[0];
    assert.match(first.textContent, /ThreatStatement 0RecommendationFix 0Affected components and assetsgate policyEvidencea\.ts/);
    assert.match(findings()[1].textContent, /Not saved for this run/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
