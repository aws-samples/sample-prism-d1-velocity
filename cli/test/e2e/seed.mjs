// Seeds a throwaway HOME with DEMO data for the dashboard e2e run (cli/test/e2e). No credentials, no AWS;
// the account id is AWS's documentation example (111122223333) and every path is under the throwaway HOME.
// usage: node seed.mjs <home> <scenario>   scenario: full | partial | empty
//   full:    4 repos (one duplicate name), codewatch reviews + secret scans, Security Agent
//            code review + threat model, aws connect + two aws check runs, ~/.aws/config (names only)
//   partial: 2 repos, one review, no security results, no aws connection, no ~/.aws
//   empty:   no repos, no results, no ~/.aws
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { makeResult, writeResult } = await import(CLI + '/dist/src/codewatch/results.js');
const { writeConnectionFile } = await import(CLI + '/dist/src/aws/connection.js');
const { SECTIONS } = await import(CLI + '/dist/src/aws/check.js');

const [home, scenario = 'full'] = process.argv.slice(2);
if (!home) throw new Error('usage: seed.mjs <home> <scenario>');
const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo Dev', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo Dev', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim();
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const H = 3600e3, D = 24 * H;
mkdirSync(home, { recursive: true });

function repo(rel, commits = 3) {
  const dir = join(home, rel);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const shas = [];
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(dir, `file${i}.txt`), `demo ${i}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `demo commit ${i}`);
    shas.push(git(dir, 'rev-parse', 'HEAD'));
  }
  return { dir, shas };
}

const review = (r, sha, at, findings, status = findings.length ? 'findings' : 'ok') => writeResult(r.dir, makeResult({
  kind: 'review', hook: 'pre-push', tool: 'kiro', status, model: 'claude-sonnet-4.5', commit: sha, branch: 'main', base: r.shas[0],
  started_at: at, finished_at: at, summary: findings.length ? `${findings.length} findings` : 'No issues found', score: findings.length ? 0.78 : 1, findings,
}));
const secrets = (r, sha, at, status = 'ok', reason = null) => writeResult(r.dir, makeResult({
  kind: 'secrets', hook: 'pre-commit', tool: 'gitleaks', status, reason, tree: git(r.dir, 'rev-parse', `${sha}^{tree}`), started_at: at, finished_at: at,
}));
const f = (severity, category, rule, file, line, message) => ({ severity, category, rule, file, line, message });

if (scenario === 'full' || scenario === 'partial') {
  const shop = repo('src/demo-shop', 5);
  const pay = repo('src/payments-api', 3);
  review(shop, shop.shas[4], ago(2 * H), [
    f('high', 'security', 'sql-injection', 'src/orders.ts', 42, 'Order id is concatenated into a SQL string; use a parameterized query.'),
    f('medium', 'quality', 'error-handling', 'src/cart.ts', 88, 'The fetch promise has no catch; a network error becomes an unhandled rejection.'),
    f('low', 'quality', 'naming', 'src/util.ts', 7, 'Rename tmp2 to something that says what it holds.'),
  ]);
  if (scenario === 'full') {
    review(shop, shop.shas[3], ago(1 * D), [f('medium', 'quality', 'long-function', 'src/checkout.ts', 120, 'checkout() is 140 lines; split it.')]);
    review(shop, shop.shas[2], ago(3 * D), []);
    writeResult(shop.dir, makeResult({ kind: 'review', hook: 'pre-push', tool: 'kiro', status: 'skipped', reason: 'no-verify', commit: shop.shas[1], started_at: ago(4 * D), finished_at: ago(4 * D) }));
    for (const [i, s] of shop.shas.entries()) secrets(shop, s, ago((5 - i) * D));
    review(pay, pay.shas[2], ago(5 * H), []);
    secrets(pay, pay.shas[2], ago(5 * H), 'findings');
    // Security Agent results in demo-shop.
    writeFileSync(join(shop.dir, '.prism', 'security.local.json'), JSON.stringify({ agentSpaceId: 'as-0demo0000000001', applicationId: 'app-demo', codeReviewId: 'cr-demo-01', region: 'us-west-2', account: '111122223333', setupAt: ago(10 * D) }));
    const sf = (risk, title, file, line, cwe, id) => ({ severity: risk === 'CRITICAL' || risk === 'HIGH' ? 'high' : risk === 'MEDIUM' ? 'medium' : 'low', category: 'security', rule: cwe || 'sa', file, line, message: title + ': demo description of the issue.', risk_level: risk, title, cwe, finding_id: id });
    writeResult(shop.dir, makeResult({ kind: 'security-review', hook: 'manual', tool: 'aws-security-agent', status: 'findings', commit: shop.shas[4], branch: 'main', started_at: ago(6 * H), finished_at: ago(5 * H),
      findings: [sf('CRITICAL', 'Hard-coded API key', 'src/config.ts', 3, 'CWE-798', 'f-1'), sf('HIGH', 'SQL injection in order lookup', 'src/orders.ts', 42, 'CWE-89', 'f-2'), sf('MEDIUM', 'Missing CSRF protection', 'src/server.ts', 61, 'CWE-352', 'f-3'), sf('LOW', 'Verbose error message', 'src/errors.ts', 12, 'CWE-209', 'f-4')],
      security: { job_id: 'job-demo-1', code_review_id: 'cr-demo-01', agent_space_id: 'as-0demo0000000001', region: 'us-west-2', account: '111122223333', scope: 'diff', context_commit: shop.shas[3], job_status: 'COMPLETED', counts: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1 }, service_duration_s: 840, wall_s: 900 } }));
    writeResult(shop.dir, makeResult({ kind: 'security-review', hook: 'manual', tool: 'aws-security-agent', status: 'pending', commit: shop.shas[4], branch: 'main', started_at: ago(20 * 60e3), finished_at: ago(20 * 60e3),
      security: { job_id: 'job-demo-2', code_review_id: 'cr-demo-01', agent_space_id: 'as-0demo0000000001', region: 'us-west-2', account: '111122223333', scope: 'full', context_commit: shop.shas[4], job_status: 'IN_PROGRESS', counts: {} } }));
    writeResult(shop.dir, makeResult({ kind: 'security-threat-model', hook: 'manual', tool: 'aws-security-agent', status: 'findings', commit: shop.shas[4], started_at: ago(2 * D), finished_at: ago(2 * D - H),
      findings: [{ severity: 'high', category: 'security', rule: 'T-1', file: 'docs/ARCH.md', line: null, message: 'Spoofed webhook callbacks', title: 'Spoofed payment webhook', risk_level: 'HIGH', threat_id: 'T-1', stride: ['Spoofing'], recommendation: 'Verify the webhook signature.', evidence: ['src/webhook.ts'] }],
      threat_model: { job_id: 'tm-job-1', threat_model_id: 'tm-1', agent_space_id: 'as-0demo0000000001', region: 'us-west-2', account: '111122223333', job_status: 'COMPLETED', counts: { HIGH: 1 }, stride_counts: { Spoofing: 1 }, scope_docs: ['docs/ARCH.md'], system_overview: 'A demo web shop with a payments webhook.' } }));
    // A second repo with the same name (label disambiguation) and one with nothing.
    const dup = repo('work/clients/demo-shop', 2);
    review(dup, dup.shas[1], ago(8 * D), [f('low', 'quality', 'todo', 'README.md', 1, 'TODO left in the README.')]);
    repo('src/empty-repo', 1);
    // A long name, to check wrapping.
    repo('src/an-extremely-long-repository-name-for-testing-layout-wrapping-at-narrow-widths', 1);
    // ~/.aws: profile and region names only, no keys.
    mkdirSync(join(home, '.aws'), { recursive: true });
    writeFileSync(join(home, '.aws', 'config'), '[default]\nregion = us-east-1\n[profile prism-demo]\nregion = us-west-2\n[profile prism-readonly]\nregion = eu-west-1\n[profile prism-demo-sandbox-readonly-team-alpha-us-west-2]\nregion = us-west-2\n');
    // aws connect + two aws check runs (baseline 9 days ago, latest 2 h ago).
    const ACCOUNT = '111122223333', REGION = 'us-west-2';
    writeConnectionFile(join(home, '.prism', 'aws.json'), { profile: 'prism-demo', region: REGION, account: ACCOUNT, alias: 'demo-dev', verifiedAt: ago(25 * 60e3) });
    const demo = JSON.parse(readFileSync(new URL('./aws-demo-checks.json', import.meta.url), 'utf8'));
    const strip = (cs) => cs.map(({ cause, ...x }) => x);
    const save = (checks, at) => {
      const count = (s) => checks.filter((x) => x.status === s).length;
      writeResult(home, makeResult({ kind: 'aws-check', hook: 'manual', status: 'findings', tool: 'prism-cli', started_at: at, finished_at: at, aws_check: {
        account: ACCOUNT, alias: 'demo-dev', region: REGION, profile: 'prism-demo', profile_source: 'aws connect, user', sections: SECTIONS.map((s) => s.name), section_counts: {},
        counts: { pass: count('PASS'), fail: count('FAIL'), indeterminate: count('INDETERMINATE') },
        fail_by_severity: Object.fromEntries(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((s) => [s, checks.filter((x) => x.status === 'FAIL' && x.severity === s).length])), checks,
      } }));
    };
    const now = strip(demo.latest.checks);
    const flip = { 'baseline.s3-account-bpa': 'FAIL', 'baseline.cloudtrail-multiregion': 'FAIL', 'bedrock.model-invocation-logging': 'PASS' };
    save(now.map((x) => (flip[x.id] ? { ...x, status: flip[x.id], detail: 'At the baseline run.' } : x)), ago(9 * D));
    save(now, ago(2 * H));
  }
}
// The dashboard starts in this directory (the "current repo" for full/partial).
const start = scenario === 'empty' ? home : join(home, 'src', 'demo-shop');
writeFileSync(join(home, '.start-dir'), start);
console.log(start);
