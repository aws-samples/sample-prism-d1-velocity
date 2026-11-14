#!/usr/bin/env node
/**
 * A made-up machine for the local dashboard's docs screenshots and demo snapshots.
 *
 *   (cd cli && npm run build)
 *   node docs/screenshots/dashboard-demo.mjs <dir> [--update-available] [--old-plugin]
 *   HOME=<dir>/home PATH=<dir>/bin:$PATH PRISM_NO_UPDATE_CHECK=1 \
 *     node cli/dist/bin/prism-cli.js dashboard --snapshot demo.html --root <dir>/home/src
 *
 * Writes <dir>/home/src/<repo> git repos with codewatch hooks and results,
 * and <dir>/bin/codeburn, a stand-in that answers `codeburn export -f json`
 * with made-up spend. No real path, repo, account or figure is used. Dates are
 * relative to now, so the 30-day and 12-week views have data. The screenshots
 * made from it are in assets/images/prism-cli/dashboard-*.png.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'dist', 'src');
const { makeResult, writeResult } = await import(join(CLI, 'codewatch', 'results.js'));
const { installHooks } = await import(join(CLI, 'codewatch', 'hooks.js'));

mkdirSync(resolve(process.argv[2] || 'prism-dashboard-demo'), { recursive: true });
// The real path, so the page shows repos under ~ even when the directory is reached through a symlink.
const out = realpathSync(resolve(process.argv[2] || 'prism-dashboard-demo'));
const home = join(out, 'home');
const DAY = 86_400_000;
const now = Date.now();
const iso = (daysAgo, hour = 0) => new Date(now - daysAgo * DAY - (hour % 6) * 3_600_000).toISOString();

const git = (repo, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=Demo Dev', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Repos, their commits (subjects) and the findings of each pre-push review, oldest first. */
const REPOS = {
  'checkout-service': {
    commits: ['cart: totals with tax', 'lookup: sku search endpoint', 'files: receipt download', 'cart: currency rounding', 'deps: bump express'],
    reviews: [[0, 1, 2], 'skipped', [0, 0, 1], [1, 1, 2], 'skipped', [0, 0, 0], [0, 2, 1], [1, 1, 3], 'skipped', [0, 1, 1], [0, 0, 2], [1, 1, 2]],
    findings: [
      ['high', 'security', 'command-injection', 'src/lookup.ts', 3, 'User-supplied SKU is interpolated into a shell command passed to exec(). Use execFile with an argument array instead.'],
      ['medium', 'security', 'path-traversal', 'src/files/download.ts', 27, "The receipt file name from the query string is joined to the storage folder without rejecting '..' segments."],
      ['low', 'quality', 'magic-number', 'src/cart/totals.ts', 41, 'Tax rate 0.0825 is hard-coded; move it to configuration.'],
      ['low', 'quality', 'error-handling', 'src/cart/rounding.ts', 12, 'The rejected promise from loadRates() is not handled.'],
    ],
    blocks: 1,
  },
  'payments-api': {
    commits: ['refunds: partial refunds', 'webhooks: verify signatures', 'ledger: idempotency keys'],
    reviews: [[0, 0, 1], [0, 0, 0], 'skipped', [0, 1, 0], [0, 0, 0], [0, 0, 0], [0, 1, 0]],
    findings: [['medium', 'security', 'timing-safe-compare', 'src/webhooks/verify.ts', 18, 'The signature is compared with ===; use a constant-time comparison.']],
  },
  'web-frontend': {
    commits: ['nav: keyboard focus', 'checkout: address form'],
    reviews: [[0, 0, 2], 'skipped', [0, 0, 1], [0, 0, 0]],
    findings: [],
  },
};

mkdirSync(join(home, 'src'), { recursive: true });
for (const [name, spec] of Object.entries(REPOS)) {
  const repo = join(home, 'src', name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  installHooks(join(repo, '.git', 'hooks'));
  spec.commits.forEach((subject, i) => {
    writeFileSync(join(repo, `f${i}.txt`), subject + '\n');
    git(repo, 'add', '-A');
    const at = iso(spec.reviews.length + spec.commits.length - i);
    spawnSync('git', ['-c', 'user.name=Demo Dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '-m', subject], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    writeResult(repo, makeResult({ kind: 'secrets', hook: 'pre-commit', tool: 'gitleaks', status: 'ok', tree, branch: 'main', started_at: at, finished_at: at }));
  });
  const tip = git(repo, 'rev-parse', 'HEAD');
  const base = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
  const n = spec.reviews.length;
  spec.reviews.forEach((r, i) => {
    const at = iso((n - 1 - i) * 2.3 + 0.2, 9 + (i % 7));
    if (r === 'skipped') {
      writeResult(repo, makeResult({ kind: 'review', hook: 'pre-push', tool: 'kiro', status: 'skipped', commit: tip, branch: 'main', base, started_at: at, finished_at: at, reason: 'no changes against upstream' }));
      return;
    }
    const last = i === n - 1;
    const pool = [...spec.findings];
    const pick = (sev, k) => {
      const own = pool.filter((f) => f[0] === sev);
      return Array.from({ length: k }, (_, j) => own[j] || [sev, 'quality', 'review-note', `src/module${j}.ts`, 10 + j, `A ${sev} review note (demo).`]);
    };
    const fs = last && spec.findings.length ? spec.findings : [...pick('high', r[0]), ...pick('medium', r[1]), ...pick('low', r[2])];
    const findings = fs.map(([severity, category, rule, file, line, message]) => ({ severity, category, rule, file, line, message }));
    writeResult(repo, makeResult({
      kind: 'review', hook: 'pre-push', tool: 'kiro', model: 'auto', status: findings.length ? 'findings' : 'ok', commit: tip, branch: 'main', base,
      started_at: at, finished_at: at, findings, summary: findings.length ? `${findings.length} findings` : 'clean', score: findings.length ? 0.8 : 1,
    }));
  });
  for (let b = 0; b < (spec.blocks || 0); b++) {
    const at = iso(3 + b, 15);
    writeResult(repo, makeResult({ kind: 'secrets', hook: 'pre-commit', tool: 'gitleaks', status: 'findings', branch: 'main', started_at: at, finished_at: at,
      findings: [{ severity: 'high', category: 'security', rule: 'generic-api-key', file: 'config/dev.env', line: 4, message: 'Generic API key (demo).' }] }));
  }
}

// An update-check cache, so the version pill shows a state without asking npm.
const pkg = JSON.parse(spawnSync('node', ['-p', `JSON.stringify(require(${JSON.stringify(join(CLI, '..', '..', 'package.json'))}))`], { encoding: 'utf8' }).stdout);
const [maj, min, pat] = pkg.version.split('.').map(Number);
const latest = process.argv.includes('--update-available') ? `${maj}.${min}.${pat + 1}` : pkg.version;
mkdirSync(join(home, '.prism', 'cache'), { recursive: true, mode: 0o700 });
writeFileSync(join(home, '.prism', 'cache', 'update-check.json'), JSON.stringify({ schema: 'prism.update-check.v1', checkedAt: now - 3_600_000, latest, publishedAt: iso(2) }), { mode: 0o600 });

// The codeburn stand-in: a made-up export for whatever --from/--to it is asked.
const bin = join(out, 'bin');
mkdirSync(bin, { recursive: true });
const projects = [['checkout-service', 0.42], ['payments-api', 0.27], ['web-frontend', 0.12], ['workspace-member-reviewer', 0.11], ['notes', 0.08]];
const fake = `#!/usr/bin/env node
const a = process.argv.slice(2), arg = (k) => a[a.indexOf(k) + 1];
const from = arg('--from'), to = arg('--to'), file = arg('-o');
const SRC = ${JSON.stringify(join(home, 'src'))};
const P = ${JSON.stringify(projects)};
const daily = [];
for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
  const k = d.toISOString().slice(0, 10), n = Number(k.replace(/-/g, '')), wd = d.getUTCDay();
  if (wd === 0 || n % 9 === 4) continue;
  const cost = Math.round(((n * 37) % 23 + 4) * 1.37 * 100) / 100;
  daily.push({ Period: from + ' to ' + to, Date: k, 'Cost (USD)': cost, 'API Calls': Math.round(cost * 9), Sessions: 3 + (n % 5),
    'Input Tokens': Math.round(cost * 21000), 'Output Tokens': Math.round(cost * 1400), 'Cache Read Tokens': Math.round(cost * 52000), 'Cache Write Tokens': 0 });
}
const total = daily.reduce((s, r) => s + r['Cost (USD)'], 0), calls = daily.reduce((s, r) => s + r['API Calls'], 0), sessions = daily.reduce((s, r) => s + r.Sessions, 0);
const r2 = (x) => Math.round(x * 100) / 100;
const out = { schema: 'codeburn.export.v2', generated: new Date().toISOString(), currency: { code: 'USD', rate: 1, symbol: '$' },
  summary: [{ Period: from + ' to ' + to, 'Cost (USD)': r2(total), 'API Calls': calls, Sessions: sessions, Projects: P.length }],
  periods: [{ label: from + ' to ' + to, daily,
    models: [['Claude Sonnet', 0.61], ['Claude Opus', 0.27], ['Claude Haiku', 0.12]].map(([m, s]) => ({ Model: m, 'Cost (USD)': r2(total * s), 'API Calls': Math.round(calls * s) })),
    activity: [['Feature Dev', 0.38], ['Debugging', 0.22], ['Exploration', 0.18], ['Refactoring', 0.12], ['Testing', 0.1]].map(([x, s]) => ({ Activity: x, 'Cost (USD)': r2(total * s) })) }],
  projects: P.map(([p, s]) => ({ Project: p.startsWith('workspace-') ? '/home/dev/.kiro/crew/' + p : SRC + '/' + p, 'Cost (USD)': r2(total * s), Sessions: Math.round(sessions * s) })),
  tools: [['Read', 0.3], ['Edit', 0.22], ['Bash', 0.2], ['Grep', 0.12], ['Write', 0.09], ['WebFetch', 0.04]].map(([t, s]) => ({ Tool: t, Calls: Math.round(calls * s) })) };
require('fs').writeFileSync(file, JSON.stringify(out));
`;
writeFileSync(join(bin, 'codeburn'), fake, { mode: 0o755 });
writeFileSync(join(bin, 'package.json'), '{"type":"commonjs"}');
chmodSync(join(bin, 'codeburn'), 0o755);
// gitleaks and kiro-cli on PATH, so the page has no "secret scanning is off" banner and names the reviewer.
for (const tool of ['gitleaks', 'kiro-cli']) writeFileSync(join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// --old-plugin: a PRISM Claude Code plugin from before the harness hooks (0.2.0), for the Settings view's Agent hooks tab.
if (process.argv.includes('--old-plugin')) {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'prism@prism-d1-velocity': [{ scope: 'user', version: '0.2.0' }] } }));
}
console.log(home);
