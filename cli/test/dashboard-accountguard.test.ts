/**
 * Tests for AccountGuard (#accountguard) and the Settings › AWS tab (prism-cli
 * aws connect): action ids and argv, the profile/region allowlist, that no
 * credential content is read or returned, baselines and the diff, the nav
 * badge, could-not-check causes from aws recommend, the not-connected state,
 * the routes, the Settings pointer and the Dashboard one-liner. No AWS call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Finding } from '../src/utils/audit.js';
import { makeResult, writeResult, type AwsCheckInfo } from '../src/codewatch/results.js';
import { SECTIONS } from '../src/aws/check.js';
import { writeConnectionFile } from '../src/aws/connection.js';
import { ACTIONS, ActionRunner, type ActionId } from '../src/dashboard/actions.js';
import { profileChoices, REGIONS } from '../src/dashboard/aws-identity.js';
import { accountGuardView, badgeCount, baselinePath, connectionArgs, diffChecks, setBaseline, type AccountGuardDeps, type AccountGuardView } from '../src/dashboard/accountguard.js';
import { setupApi } from '../src/dashboard/setup-api.js';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { renderPage } from '../src/dashboard/page.js';
import { FakeElement, runPage, SETUP_STUB } from './page-dom.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-ag-gcfg-')), 'gitconfig');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-ag-${p}-`)));
const ACCOUNT = '111122223333', REGION = 'us-west-2';
const FULL = SECTIONS.map((s) => s.name);

const f = (id: string, status: Finding['status'], severity: Finding['severity'] = 'MEDIUM', detail = `${id} detail`): Finding => ({
  id, category: id.split('.')[0], title: id, status, severity, detail, remediation: 'fix ' + id,
});
function saveRun(root: string, checks: Finding[], at: string, o: { account?: string; region?: string; sections?: string[] } = {}): string {
  const count = (s: string) => checks.filter((x) => x.status === s).length;
  const info: AwsCheckInfo = {
    account: o.account ?? ACCOUNT, alias: 'demo', region: o.region ?? REGION, profile: 'demo', profile_source: '--profile', sections: o.sections ?? FULL, section_counts: {},
    counts: { pass: count('PASS'), fail: count('FAIL'), indeterminate: count('INDETERMINATE') },
    fail_by_severity: Object.fromEntries(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((s) => [s, checks.filter((x) => x.status === 'FAIL' && x.severity === s).length])) as AwsCheckInfo['fail_by_severity'],
    checks,
  };
  return writeResult(root, makeResult({ kind: 'aws-check', hook: 'manual', status: 'findings', tool: 'prism-cli', started_at: at, finished_at: at, aws_check: info }));
}
function rig(connected = true) {
  const home = tmp('home');
  if (connected) writeConnectionFile(join(home, '.prism', 'aws.json'), { profile: 'demo', region: REGION, account: ACCOUNT, alias: 'demo', verifiedAt: '2026-11-14T10:00:00.000Z' });
  const d: AccountGuardDeps = { home, repoRoot: null, roots: async () => [home], exclusive: async (fn) => ({ status: 200, json: await fn() }), now: () => new Date('2026-11-14T12:00:00.000Z') };
  return { home, d };
}
const OLD = [f('baseline.guardduty', 'PASS', 'HIGH'), f('baseline.s3-account-bpa', 'FAIL', 'HIGH'), f('baseline.securityhub', 'FAIL'), f('baseline.budget', 'FAIL'), f('baseline.root-mfa', 'FAIL', 'CRITICAL')];
const NEW = [
  f('baseline.guardduty', 'FAIL', 'HIGH'), f('baseline.s3-account-bpa', 'PASS', 'HIGH'), f('baseline.securityhub', 'INDETERMINATE', 'MEDIUM', 'Could not check (AccessDeniedException: not authorized). Needs securityhub:DescribeHub.'),
  f('baseline.budget', 'FAIL'), f('bedrock.root-mfa', 'FAIL', 'CRITICAL'),
  f('bedrock.unused-credentials', 'INDETERMINATE', 'MEDIUM', 'Could not check (ReportNotPresent). Needs iam:GetCredentialReport.'),
  f('bedrock.budget-alerting', 'INDETERMINATE', 'MEDIUM', 'No Bedrock budget to check the alerts of.'),
];

// ---------------------------------------------------------------- data, baseline, badge

test('view: not connected; connected and never run; masked account, opaque run ids, no full account id', async () => {
  assert.equal((await accountGuardView(rig(false).d)).connection, null);
  const { d, home } = rig();
  const never = await accountGuardView(d);
  assert.equal(never.connection!.account4, '••••3333');
  assert.equal(never.latest, null);
  assert.equal(never.commands!.check, 'cd ~ && prism-cli aws check --profile demo --region us-west-2');
  assert.equal(never.commands!.recommend, 'cd ~ && prism-cli aws recommend --profile demo --region us-west-2');
  saveRun(home, OLD, '2026-11-05T08:00:00.000Z');
  saveRun(home, NEW, '2026-11-14T09:00:00.000Z');
  saveRun(home, [f('baseline.guardduty', 'PASS', 'HIGH')], '2026-11-14T11:00:00.000Z', { sections: ['baseline'] });
  saveRun(home, [f('baseline.guardduty', 'FAIL', 'HIGH')], '2026-11-14T11:30:00.000Z', { account: '444455556666' });
  const v = await accountGuardView(d);
  assert.equal(v.latest!.started_at, '2026-11-14T09:00:00.000Z', 'a --section run and another account are not the latest');
  assert.equal(v.runs.length, 2);
  for (const r of v.runs) assert.match(r.run, /^[a-f0-9]{16}$/);
  const json = JSON.stringify(v);
  assert.ok(!json.includes(ACCOUNT) && !json.includes('444455556666'), 'no full account id leaves the server');
  assert.ok(!json.includes(home), 'no home path');
});

test('baseline: the oldest full run until marked; the mark is a 0600 file; only listed runs are accepted', async () => {
  const { d, home } = rig();
  saveRun(home, OLD, '2026-11-05T08:00:00.000Z');
  saveRun(home, NEW, '2026-11-14T09:00:00.000Z');
  let v = await accountGuardView(d);
  assert.deepEqual([v.baseline!.how, v.baseline!.started_at], ['first run', '2026-11-05T08:00:00.000Z']);
  assert.ok(v.diff);
  assert.equal((await setBaseline(d, { run: 'zzzz' })).status, 400);
  assert.equal((await setBaseline(d, { run: 'ffffffffffffffff' })).status, 400, 'not in the list');
  assert.equal((await setBaseline(d, { run: v.latest!.run, extra: 1 })).status, 400);
  assert.equal((await setBaseline(rig(false).d, { run: v.latest!.run })).status, 409, 'not connected');
  assert.equal((await setBaseline(d, { run: v.latest!.run })).status, 200);
  assert.equal(statSync(baselinePath(home)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(baselinePath(home), 'utf8')).schema, 'prism.accountguard.v1');
  v = await accountGuardView(d);
  assert.deepEqual([v.baseline!.how, v.baseline!.run], ['marked', v.latest!.run]);
  assert.equal(v.diff, null, 'the latest run is the baseline: nothing to compare');
});

test('diff: new failures, fixed, no longer checked, still failing; a retired id maps to its successor', () => {
  const d = diffChecks(OLD, NEW);
  assert.deepEqual(d.newFailures.map((x) => [x.id, x.was]), [['baseline.guardduty', 'PASS']]);
  assert.deepEqual(d.fixed.map((x) => x.id), ['baseline.s3-account-bpa']);
  assert.deepEqual(d.noLongerChecked.map((x) => x.id), ['baseline.securityhub'], 'FAIL then INDETERMINATE is not fixed');
  assert.equal(d.stillFailing, 2, 'budget, and root-mfa under its new id');
  assert.deepEqual(diffChecks([], [f('baseline.budget', 'FAIL')]).newFailures.map((x) => x.was), ['NOT CHECKED']);
});

test('badge: failing HIGH and CRITICAL checks only', async () => {
  assert.equal(badgeCount(NEW), 2, 'guardduty HIGH and root-mfa CRITICAL; MEDIUM and INDETERMINATE do not count');
  const { d, home } = rig();
  saveRun(home, NEW, '2026-11-14T09:00:00.000Z');
  assert.equal((await accountGuardView(d)).badge, 2);
  assert.equal((await accountGuardView(rig(false).d)).badge, 0);
});

test('could-not-check: the cause comes from aws recommend; only access-denied says grant', async () => {
  const { d, home } = rig();
  saveRun(home, NEW, '2026-11-14T09:00:00.000Z');
  const v = await accountGuardView(d);
  const cause = (id: string) => v.latest!.checks.find((x) => x.id === id)!.cause;
  assert.equal(cause('baseline.securityhub'), 'access-denied');
  assert.equal(cause('bedrock.unused-credentials'), 'no-credential-report');
  assert.equal(cause('bedrock.budget-alerting'), 'prerequisite');
  assert.equal(v.latest!.checks.find((x) => x.status === 'FAIL')!.cause, null);
  const access = v.recommendations.flatMap((g) => g.access);
  assert.ok(access.find((x) => x.cause === 'prerequisite')!.steps[0].includes('first'), 'points at the fix it waits on');
  assert.ok(!access.find((x) => x.cause === 'no-credential-report')!.steps[0].startsWith('Grant'));
});

// ---------------------------------------------------------------- profiles and regions

test('profile choices: section names and a region only; key material is never read into the answer', () => {
  const home = tmp('aws');
  mkdirSync(join(home, '.aws'));
  writeFileSync(join(home, '.aws', 'config'), '[default]\nregion = us-east-1\n[profile demo]\nregion = ap-southeast-4\nsso_start_url = https://example.awsapps.com/start\n[sso-session corp]\nsso_region = us-east-1\n[profile bad name;x]\nregion = us-east-2\n');
  writeFileSync(join(home, '.aws', 'credentials'), '[legacy]\naws_access_key_id = AKIAEXAMPLEEXAMPLE00\naws_secret_access_key = SECRETVALUEDONOTSHOW\naws_session_token = TOKENVALUEDONOTSHOW\n');
  const c = profileChoices({ env: {}, home });
  assert.deepEqual(c.profiles.map((p) => [p.name, p.region, p.from]), [['default', 'us-east-1', 'config'], ['demo', 'ap-southeast-4', 'config'], ['legacy', null, 'credentials']]);
  assert.ok(c.regions.includes('ap-southeast-4') && c.regions.includes('us-west-2'), 'the fixed list plus a profile region');
  const json = JSON.stringify(c);
  for (const s of ['AKIAEXAMPLE', 'SECRETVALUE', 'TOKENVALUE', 'awsapps', 'aws_secret_access_key', 'sso-session']) assert.ok(!json.includes(s), s);
  // AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE, as aws configure list-profiles reads them.
  const other = join(home, 'cfg');
  writeFileSync(other, '[profile elsewhere]\n');
  assert.deepEqual(profileChoices({ env: { AWS_CONFIG_FILE: other, AWS_SHARED_CREDENTIALS_FILE: join(home, 'none') }, home }).profiles.map((p) => p.name), ['elsewhere']);
  assert.ok((REGIONS as readonly string[]).every((r) => /^[a-z]{2}(-[a-z]+)+-\d$/.test(r)));
});

interface Spawned { file: string; args: string[]; opts: any; child: any }
function runnerWith(calls: Spawned[], over: Partial<ConstructorParameters<typeof ActionRunner>[0]> = {}) {
  const spawn = (file: string, args: string[], opts: any) => { const child: any = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true; calls.push({ file, args, opts, child }); setTimeout(() => child.emit('close', 0), 1); return child; };
  return new ActionRunner({
    execPath: '/usr/bin/node', entry: '/opt/prism/dist/bin/prism-cli.js', cwd: '/work', home: '/home/demo', repos: async () => [], systemdAvailable: () => false, platform: 'linux', spawn: spawn as any,
    awsChoices: () => ({ profiles: ['demo', 'prism-readonly'], regions: ['us-west-2', 'eu-west-1'] }), connectionArgs: () => ['--profile', 'demo', '--region', 'us-west-2'], ...over,
  });
}
const until = async (r: ActionRunner) => { for (let i = 0; i < 200 && r.running; i++) await new Promise((x) => setTimeout(x, 5)); };

test('connect, re-verify, disconnect, status: fixed argv; the profile and region must be on the server\'s own lists', async () => {
  const calls: Spawned[] = [];
  const r = runnerWith(calls);
  const start = async (body: Record<string, unknown>) => { const res = await r.start(body); await until(r); return res; };
  assert.equal((await start({ action: 'aws-connect', profile: 'demo', region: 'us-west-2' })).status, 202);
  assert.deepEqual(calls.pop()!.args.slice(1), ['aws', 'connect', '--profile', 'demo', '--region', 'us-west-2']);
  // Re-verify is the same action with the saved pair.
  assert.equal((await start({ action: 'aws-connect', profile: 'prism-readonly', region: 'eu-west-1' })).status, 202);
  assert.equal(calls.pop()!.opts.cwd, '/work');
  for (const [p, rg] of [['other', 'us-west-2'], ['demo', 'us-east-9'], ['demo; rm -rf ~', 'us-west-2'], ['--endpoint-url=http://evil', 'us-west-2'], ['demo', '--region'], [1, 'us-west-2'], [undefined, 'us-west-2'], ['demo', undefined]]) {
    assert.equal((await start({ action: 'aws-connect', profile: p, region: rg })).status, 400, `${p} / ${rg}`);
  }
  assert.equal((await start({ action: 'aws-connect', profile: 'demo', region: 'us-west-2', path: '/x' })).status, 400, 'no other field');
  const listed = runnerWith(calls, { awsChoices: () => ({ profiles: ['-x'], regions: ['us-west-2'] }) });
  assert.equal((await listed.start({ action: 'aws-connect', profile: '-x', region: 'us-west-2' })).status, 400, 'a listed name that reads as a flag');
  assert.equal((await runnerWith(calls, { awsChoices: undefined }).start({ action: 'aws-connect', profile: 'demo', region: 'us-west-2' })).status, 400, 'no lists: refused');
  assert.equal((await start({ action: 'aws-connect-status' })).status, 202);
  assert.deepEqual(calls.pop()!.args.slice(1), ['aws', 'connect', '--status']);
  assert.equal((await start({ action: 'aws-disconnect' })).status, 400, 'needs confirm');
  assert.equal((await start({ action: 'aws-disconnect', confirm: true })).status, 202);
  assert.deepEqual(calls.pop()!.args.slice(1), ['aws', 'connect', '--clear']);
  assert.equal((await start({ action: 'aws-connect-status', profile: 'demo' })).status, 400, 'only aws-connect takes a profile');
  assert.equal(calls.length, 0);
});

test('AccountGuard actions: the connected profile and region, from ~; refused when nothing is connected', async () => {
  const calls: Spawned[] = [];
  const r = runnerWith(calls);
  for (const [id, args] of [['accountguard-check', ['aws', 'check']], ['accountguard-recommend', ['aws', 'recommend']]] as [ActionId, string[]][]) {
    assert.equal((await r.start({ action: id })).status, 202, id);
    await until(r);
    const c = calls.pop()!;
    assert.deepEqual(c.args.slice(1), [...args, '--profile', 'demo', '--region', 'us-west-2']);
    assert.equal(c.opts.cwd, '/home/demo', 'results land in ~/.prism/results/');
    assert.equal(c.opts.shell, false);
    assert.equal((await r.start({ action: id, profile: 'demo', region: 'us-west-2' })).status, 400, 'no profile from the page');
  }
  assert.equal((await runnerWith(calls, { connectionArgs: () => null }).start({ action: 'accountguard-check' })).status, 409);
  assert.equal(ACTIONS['accountguard-check'].readOnlyAws, true);
  assert.equal(ACTIONS['aws-connect'].readOnlyAws, true);
  assert.ok(!('aws-check' in ACTIONS), 'replaced by accountguard-check');
  const home = tmp('ca');
  assert.equal(connectionArgs(home, null), null);
  writeConnectionFile(join(home, '.prism', 'aws.json'), { profile: 'demo', region: REGION, account: ACCOUNT, alias: null, verifiedAt: '' });
  assert.deepEqual(connectionArgs(home, null), ['--profile', 'demo', '--region', REGION]);
});

test('setup-api: /api/setup carries the choices but no credential content; the AccountGuard routes; no /api/check-now', async () => {
  const home = tmp('api');
  mkdirSync(join(home, '.aws'));
  writeFileSync(join(home, '.aws', 'credentials'), '[legacy]\naws_secret_access_key = SECRETVALUEDONOTSHOW\n');
  const api = setupApi({ runner: runnerWith([]), cwd: '/work', repoPaths: async () => [], identity: { env: {}, home, repoRoot: null }, refresh: async () => ({}), accountGuard: rig().d });
  const s = (await api.getApi['/api/setup']()) as any;
  assert.deepEqual(s.aws.choices.profiles.map((p: any) => p.name), ['legacy']);
  assert.ok(!JSON.stringify(s).includes('SECRETVALUE'));
  assert.ok(s.actions.find((a: any) => a.id === 'aws-connect').choose);
  assert.ok(api.getApi['/api/accountguard'] && api.postApi['/api/accountguard/baseline']);
  assert.ok(!('/api/check-now' in api.postApi));
  const none = setupApi({ runner: runnerWith([]), cwd: '/work', repoPaths: async () => [], identity: { env: {}, home, repoRoot: null }, refresh: async () => ({}) });
  assert.equal((await none.postApi['/api/accountguard/baseline']({ run: 'x' })).status, 400);
});

// ---------------------------------------------------------------- the page

async function pagePayload(): Promise<DashboardPayload> {
  const home = tmp('ph');
  mkdirSync(join(home, 'demo', '.git'), { recursive: true });
  return buildPayload({
    cwd: tmp('nowhere'), home, pathEnv: tmp('path'),
    exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
    version: async () => ({ installed: '1.15.0', latest: '1.15.0', publishedAt: '2026-11-13T00:00:00.000Z', update: false, checkedAt: '2026-11-14T00:00:00.000Z' }),
    agentHooks: () => ({ rows: [], plugin: { active: false, version: null, outdated: false } }),
  });
}
const act = (id: ActionId) => ({ id, label: ACTIONS[id].label, command: 'prism-cli ' + ACTIONS[id].args.join(' '), repo: false, url: false, confirm: !!ACTIONS[id].confirm, readOnlyAws: !!ACTIONS[id].readOnlyAws,
  installs: false, writesAws: false, note: ACTIONS[id].note ?? null, choose: !!ACTIONS[id].choose, connected: !!ACTIONS[id].connected, inHome: !!ACTIONS[id].inHome, confirmLabel: ACTIONS[id].confirmLabel ?? null, timeoutSec: 60, available: true });
const SETUP = (saved: boolean) => ({
  ...SETUP_STUB, actions: (['aws-connect', 'aws-connect-status', 'aws-disconnect', 'accountguard-check', 'accountguard-recommend', 'team-info'] as ActionId[]).map(act),
  aws: { steps: [], warnings: [], source: 'aws connect, user', credentialLabel: 'IAM Identity Center (SSO)', profile: 'demo', files: { config: '~/.aws/config', credentials: '~/.aws/credentials' },
    saved: saved ? { account: '111122223333', alias: 'demo', profile: 'demo', inUse: true, region: 'us-west-2', verifiedAt: '2026-11-14T10:00:00.000Z', path: '~/.prism/aws.json', scope: 'user' } : null,
    choices: { profiles: [{ name: 'demo', region: 'us-west-2', from: 'config' }, { name: 'prism-readonly', region: 'eu-west-1', from: 'config' }], regions: ['us-west-2', 'eu-west-1'] } },
});
async function agAnswer(kind: 'results' | 'never' | 'none'): Promise<AccountGuardView> {
  const { d, home } = rig(kind !== 'none');
  if (kind === 'results') { saveRun(home, OLD, '2026-11-05T08:00:00.000Z'); saveRun(home, NEW, '2026-11-14T09:00:00.000Z'); }
  return accountGuardView(d);
}
const buttons = (root: FakeElement) => root.querySelectorAll('button');

test('page: Dashboard | Security Agent | AccountGuard | Settings; #accountguard; no AWS call on load; badge from the cached result', async () => {
  const html = renderPage('N');
  assert.match(html, /data-view="security">Security Agent <span[^>]*><\/span><\/a><a href="#accountguard" data-view="accountguard">AccountGuard <span class="badge warn" id="accountguard-badge" hidden><\/span><\/a><a href="#settings"/);
  const p = await pagePayload();
  const page = await runPage([p], '#accountguard', SETUP(true), { '/api/accountguard': await agAnswer('results') });
  const ag = page.dom.byId.accountguard;
  assert.equal(ag.hidden, false);
  assert.equal(page.dom.byId.main.hidden, true);
  assert.equal(page.requests.filter((r) => r.method === 'POST').length, 0, 'loading posts nothing');
  assert.equal(page.dom.byId['accountguard-badge'].textContent, '2');
  const t = ag.textContent;
  assert.match(t, /Account••••3333/);
  assert.match(t, /Account baseline/);
  assert.match(t, /Ranked fixes/);
  assert.match(t, /New failures \(1\)/);
  assert.match(t, /access denied/);
  assert.ok(!/Needs iam:GetCredentialReport/.test(t), 'the misleading "Needs" suffix is hidden for a missing report');
  page.go('');
  assert.equal(ag.hidden, true);
});

test('page: Run aws check shows the exact line; Cancel is focused; the request is the action id only', async () => {
  const p = await pagePayload();
  const page = await runPage([p], '#accountguard', SETUP(true), { '/api/accountguard': await agAnswer('never') });
  const ag = page.dom.byId.accountguard;
  assert.match(ag.textContent, /No aws check yet/);
  buttons(ag).find((b) => b.textContent === 'Run aws check')!.listeners.click();
  const dlg = page.dom.document.body.childNodes.find((n) => n instanceof FakeElement && n.nodeName === 'DIALOG') as FakeElement;
  assert.match(dlg.textContent, /cd ~ && prism-cli aws check --profile demo --region us-west-2/);
  assert.ok(buttons(dlg).find((b) => b.textContent === 'Cancel')!.focused);
  buttons(dlg).find((b) => b.textContent === 'Run')!.listeners.click();
  await page.settle();
  assert.deepEqual(page.requests.find((r) => r.url === '/api/action')!.body, { action: 'accountguard-check' });
});

test('page: not connected shows one state pointing at Settings › AWS; mark as baseline posts an opaque id', async () => {
  const p = await pagePayload();
  const none = await runPage([p], '#accountguard', SETUP(false), { '/api/accountguard': await agAnswer('none') });
  assert.match(none.dom.byId.accountguard.textContent, /^AccountGuardConnect an AWS account in Settings › AWS/);
  assert.equal(buttons(none.dom.byId.accountguard).length, 0);
  const v = await agAnswer('results');
  const page = await runPage([p], '#accountguard', SETUP(true), { '/api/accountguard': v, '/api/accountguard/baseline': { run: v.latest!.run } });
  buttons(page.dom.byId.accountguard).find((b) => b.textContent === 'Use the latest run as the baseline')!.listeners.click();
  await page.settle();
  assert.deepEqual(page.requests.find((r) => r.url === '/api/accountguard/baseline')!.body, { run: v.latest!.run });
});

test('Settings › AWS: account setup only; Connect / Re-verify post the picked names; Disconnect and status; pointers; team info on Usage sync', async () => {
  const p = await pagePayload();
  const page = await runPage([p], '#settings/aws', SETUP(true), { '/api/accountguard': await agAnswer('none') });
  const pane = page.dom.byId.settings.all().find((e) => e.getAttribute('data-pane') === 'aws')!;
  const t = pane.textContent;
  assert.match(t, /^AWS accountconnected/);
  assert.match(t, /Account••••3333/);
  assert.ok(!t.includes('111122223333'));
  assert.doesNotMatch(t, /Check now|Run aws check|Run team info/, 'checks and team info moved off the tab');
  assert.match(t, /Account checks moved to AccountGuard →/);
  assert.ok(pane.querySelectorAll('a').some((a) => a.getAttribute('href') === '#accountguard'));
  const labels = buttons(pane).map((b) => b.textContent);
  assert.ok(labels.includes('Re-verify') && labels.includes('Disconnect') && labels.includes('Show status'), labels.join(','));
  const prof = pane.all().find((e) => e.getAttribute('id') === 'aws-profile')!, reg = pane.all().find((e) => e.getAttribute('id') === 'aws-region')!;
  prof.value = 'prism-readonly'; prof.listeners.change();
  assert.equal(reg.value, 'eu-west-1', 'a profile brings its region');
  const go = buttons(pane).find((b) => b.textContent === 'Connect instead')!;
  go.listeners.click();
  const dlg = page.dom.document.body.childNodes.find((n) => n instanceof FakeElement && n.nodeName === 'DIALOG') as FakeElement;
  assert.match(dlg.textContent, /prism-cli aws connect --profile prism-readonly --region eu-west-1/);
  buttons(dlg).find((b) => b.textContent === 'Run')!.listeners.click();
  await page.settle();
  assert.deepEqual(page.requests.find((r) => r.url === '/api/action')!.body, { action: 'aws-connect', profile: 'prism-readonly', region: 'eu-west-1' });
  const sync = page.dom.byId.settings.all().find((e) => e.getAttribute('data-pane') === 'sync')!;
  assert.ok(buttons(sync).some((b) => b.textContent === 'Run team info'));
});

test('Dashboard: the AWS account section is one line per account, masked, linking to #accountguard', async () => {
  const p = await pagePayload();
  (p as any).aws = { accounts: [{ account: ACCOUNT, alias: 'demo', region: REGION, profile: 'demo', profile_source: 'aws connect, user', checked_at: '2026-11-14T09:00:00.000Z',
    counts: { pass: 20, fail: 3, indeterminate: 2 }, fail_by_severity: { CRITICAL: 0, HIGH: 2, MEDIUM: 1, LOW: 0, INFO: 0 }, top_failures: [], more: 0 }], hint: 'prism-cli aws check', recommend_hint: 'prism-cli aws recommend' };
  const page = await runPage([p]);
  const t = page.text();
  assert.match(t, /AWS accountlatest aws check••••3333demo · us-west-2 · checked .*2 high1 medium20 pass2 could not checkOpen AccountGuard →/);
  assert.ok(!t.includes(ACCOUNT));
  assert.ok(page.dom.byId.main.querySelectorAll('a').some((a) => a.getAttribute('href') === '#accountguard'));
});
