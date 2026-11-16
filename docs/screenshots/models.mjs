// Builds what the Kiro Crew app would show for the demo fixture (fixtures/dashboard.json)
// and prints it as JSON for render.py. Needs prism-cli on PATH (for the codewatch report
// renderer). All data is made up. The editor extension's panel is the dashboard's own UI;
// its screenshot comes from its webview harness (editor-extension: npm run test:e2e).
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const fixture = JSON.parse(readFileSync(join(here, 'fixtures/dashboard.json'), 'utf8'));
const NOW = Date.parse(fixture.generated_at) + 2 * 60_000;

// Last commits the extension would read with git log, one per repo.
const COMMITS = {
  'checkout-service': { sha: 'a1b2c3d', at: '2026-11-12T16:50:00.000Z', subject: 'Add order lookup by SKU' },
  'web-storefront': { sha: 'e4f5a6b', at: '2026-11-12T15:20:00.000Z', subject: 'Lazy-load product images' },
  'payments-api': { sha: '9c8d7e6', at: '2026-11-11T21:35:00.000Z', subject: 'Retry idempotent refunds' },
  'infra-cdk': { sha: '1f2e3d4', at: '2026-11-10T18:00:00.000Z', subject: 'Tighten bucket policy' },
};
const commits = new Map(fixture.repos.map((r) => [r.path, COMMITS[r.name] ?? null]));

const repoPath = '/home/dev/src/checkout-service';

// The codewatch report for checkout-service, drawn by prism-cli's own HTML renderer.
const cliRoot = join(dirname(realpathSync(execFileSync('sh', ['-c', 'command -v prism-cli'], { encoding: 'utf8' }).trim())), '..');
const { renderReportHtml } = await import(pathToFileURL(join(cliRoot, 'src/dashboard/report.js')).href);
const cw = fixture.repos[0].codewatch;
const tip = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const base = '7e6f5d4c3b2a19080706050403020100ffeeddcc';
const byFile = new Map();
for (const f of cw.findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push({ ...f, attributed: 'blame', inPushOf: null, commit: tip, commitSubject: 'Add order lookup by SKU' });
}
const rank = { high: 0, medium: 1, low: 2 };
const files = [...byFile].map(([file, fs]) => ({ file, findings: fs.sort((a, b) => rank[a.severity] - rank[b.severity]) }))
  .sort((a, b) => rank[a.findings[0].severity] - rank[b.findings[0].severity]);
const commitRows = [
  { sha: tip, short: tip.slice(0, 8), subject: 'Add order lookup by SKU', authorDate: '2026-11-12T16:50:00.000Z', secretScan: 'ok', secretScanReason: null, high: 1, medium: 1, low: 2 },
  { sha: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567', short: '0a1b2c3d', subject: 'Store receipts per order', authorDate: '2026-11-12T15:05:00.000Z', secretScan: 'ok', secretScanReason: null, high: 0, medium: 0, low: 0 },
];
const reportHtml = renderReportHtml({
  schema: 'prism.codewatch.report.v1',
  id: cw.lastReviewId,
  repo: { name: 'checkout-service', path: repoPath },
  branch: 'main', upstream: 'origin/main',
  range: { base, tip, commits: 2 },
  reviewer: { tool: 'kiro', version: '1.21.0', model: 'Claude Sonnet 4.5' },
  startedAt: '2026-11-12T16:55:00.000Z', finishedAt: '2026-11-12T16:56:12.000Z', durationSeconds: 72,
  status: 'findings', state: 'findings', reason: null, score: 0.68, truncated: false,
  summary: 'The new SKU lookup builds a shell command from request input, and receipt downloads accept a file name with path segments. Fix both before this ships.',
  totals: { severity: { high: 1, medium: 1, low: 2 }, category: { security: 2, quality: 2 }, findings: 4 },
  files, secretScans: commitRows, gitleaksBlocks: [], commits: commitRows,
});

process.stdout.write(JSON.stringify({ now: NOW, reportHtml, fixture, commits: Object.fromEntries(commits) }));
