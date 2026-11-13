/**
 * Tests for `prism-cli dashboard --snapshot`: one static file, CSP by hash
 * with no network, embedded data that cannot close its element, no token,
 * copy-only commands, mode 0600, and the --open display rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshotHtml, canOpen, writeSnapshot } from '../src/dashboard/snapshot.js';
import { embedJson, renderPage, renderSnapshotPage } from '../src/dashboard/page.js';
import { emptyUsage } from '../src/dashboard/usage.js';
import { makeResult, writeResult } from '../src/codewatch/results.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-snap-gcfg-')), 'gitconfig');
const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function home(): { home: string; repo: string } {
  const h = realpathSync(mkdtempSync(join(tmpdir(), 'prism-snap-home-')));
  const repo = join(h, 'work', 'demo');
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  writeResult(repo, makeResult({
    kind: 'review', hook: 'pre-push', tool: 'kiro', status: 'findings', commit: 'a'.repeat(40), branch: 'main',
    started_at: '2026-11-12T10:00:00.000Z', finished_at: '2026-11-12T10:00:00.000Z',
    findings: [{ severity: 'high', category: 'security', rule: 'r', file: 'a.ts', line: 1, message: '</script><script>alert(1)</script> <!-- x' }],
  }));
  return { home: h, repo };
}

async function snapshot() {
  const { home: h, repo } = home();
  const html = await buildSnapshotHtml({
    cwd: repo, home: h, version: '9.9.9', pathEnv: '', env: {},
    machineDeps: { home: h, env: {}, scheduleExists: () => false, schedulerName: () => 'cron', systemdAvailable: () => false },
    usage: async () => ({ usage: emptyUsage('no-data', 'no usage'), cacheHit: false }),
    now: () => new Date('2026-11-12T15:00:00Z'),
  });
  return { html, home: h, repo };
}

const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

test('one self-contained file: no external resource, strict CSP whose hashes match the inline code', async () => {
  const { html } = await snapshot();
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  assert.ok(csp, 'CSP meta');
  assert.match(csp!, /^default-src 'none'; /);
  assert.doesNotMatch(csp!, /unsafe-inline|unsafe-eval|https?:|connect-src/);
  for (const s of scripts(html)) assert.ok(csp!.includes(hash(s)), 'script hash in CSP');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  assert.ok(csp!.includes(hash(style)), 'style hash in CSP');
  assert.equal(scripts(html).length, 2, 'theme boot + page script');
  assert.doesNotMatch(html, /<link|<iframe|<img|\ssrc=|@import|url\(\s*['"]?https?:/i);
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /https?:\/\//, 'no URL in the static markup');
});

test('embedded data cannot close its element; no dashboard token or CSRF token', async () => {
  const { html } = await snapshot();
  const block = /<script type="application\/json" id="prism-snapshot">([\s\S]*?)<\/script>/.exec(html)![1];
  assert.doesNotMatch(block, /</);
  const data = JSON.parse(block);
  assert.equal(data.version, '9.9.9');
  assert.equal(data.generatedAt, '2026-11-12T15:00:00.000Z');
  assert.ok(Array.isArray(data.setup.actions) && data.setup.actions.length > 0, 'setup catalog embedded');
  assert.ok(JSON.stringify(data.data).includes('alert(1)'), 'finding text kept as data');
  assert.doesNotMatch(html, /<meta name="prism-csrf"|\?token=|prism_dash_|nonce=/);
  assert.equal(embedJson({ a: '</script>\u2028' }), '{"a":"\\u003c/script>\\u2028"}');
});

test('generated time is shown, runs are copy only, Check now and Refresh are off', async () => {
  const { html } = await snapshot();
  assert.match(html, /Snapshot generated <time id="snapshot-at" datetime="2026-11-12T15:00:00.000Z">/);
  assert.doesNotMatch(html, /id="refresh"/);
  // The page script's snapshot branches (it is the same script as the live page).
  const page = scripts(html)[1];
  assert.match(page, /if \(SNAPSHOT\) \{\s*const cd = [^\n]+\n\s*return copyOnly\(/, 'Run buttons become copy-only');
  assert.match(page, /if \(SNAPSHOT\) btn\.disabled = true;/, 'Check now disabled');
  assert.match(page, /static snapshot: nothing runs from it/, 'POST refused without a fetch');
  // The live page keeps its nonce and CSRF token.
  assert.match(renderPage('abc', 'tok'), /<script nonce="abc">[\s\S]*name="prism-csrf" content="tok"|name="prism-csrf" content="tok"[\s\S]*<script nonce="abc">/);
});

test('writeSnapshot: mode 0600, also over an existing wider file', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'prism-snap-out-')), 'd.html');
  writeFileSync(f, 'old', { mode: 0o644 });
  const n = writeSnapshot(f, renderSnapshotPage({ data: {}, setup: {}, generatedAt: 'x', version: '1' }));
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(n, readFileSync(f).length);
});

test('canOpen: a display is needed on Linux; SSH blocks macOS and Windows', () => {
  assert.equal(canOpen({}, 'linux'), false);
  assert.equal(canOpen({ SSH_CONNECTION: 'x' }, 'linux'), false);
  assert.equal(canOpen({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(canOpen({ DISPLAY: 'localhost:10.0', SSH_TTY: '/dev/pts/1' }, 'linux'), false, 'X forwarding over SSH');
  assert.equal(canOpen({ WAYLAND_DISPLAY: 'w' }, 'linux'), true);
  assert.equal(canOpen({}, 'darwin'), true);
  assert.equal(canOpen({ SSH_CONNECTION: 'x' }, 'darwin'), false);
});

test('CLI: --snapshot writes the file, prints its path on stdout; --open over SSH only notes it', () => {
  const { home: h, repo } = home();
  const out = join(h, 'snap.html');
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(CLI_DIR, 'bin', 'prism-cli.ts'), 'dashboard', '--snapshot', out, '--open', '--root', join(h, 'work')], {
    cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, SSH_CONNECTION: '1 2 3 4', GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, out + '\n');
  assert.match(r.stderr, /not opened/);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.match(readFileSync(out, 'utf8'), /id="prism-snapshot"/);
});
