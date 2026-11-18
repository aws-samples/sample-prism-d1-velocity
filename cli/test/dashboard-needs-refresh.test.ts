/**
 * 1.21.9: one Needs you list on the server (needs-you.ts) behind the Settings
 * warnings card, the Settings badge, every section badge, the Needs you list
 * and --json summary.warnings; and the refresh after an action, which must show
 * the action's result at once even when another refresh is running. Local
 * files and fakes only: no codeburn, AWS or network calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentHookStatus } from '../src/commands/enable/harness-hooks.js';
import { installHooks } from '../src/codewatch/hooks.js';
import { needsYou } from '../src/dashboard/needs-you.js';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { cachedPayload } from '../src/dashboard/server.js';
import { FakeElement, runPage, SETUP_STUB } from './page-dom.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-nr-gcfg-')), 'gitconfig');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-nr-${p}-`)));

function gitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q', `--template=${tmp('tpl')}`], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return dir;
}

/** A PATH with codeburn and gitleaks that print a version, so every machine check is ok. */
function toolPath(): string {
  const bin = tmp('bin');
  for (const [n, out] of [['codeburn', 'codeburn 0.9.24'], ['gitleaks', '8.18.0']]) {
    writeFileSync(join(bin, n), `#!/bin/sh\necho '${out}'\n`);
    chmodSync(join(bin, n), 0o755);
  }
  return bin;
}

const hookRows = (state: 'installed' | 'missing' = 'installed'): AgentHookStatus['rows'] =>
  (['kiro', 'claude'] as const).flatMap((client) => (['project', 'global'] as const).map((scope) => ({ client, scope, state, path: null, others: 0, error: null })));

/** A home with `repos` fake repos (none with codewatch), an AWS config with names only, and every machine check ok. */
async function build(o: { repos: number; plugin: string | null; codewatch?: boolean }): Promise<{ home: string; p: DashboardPayload }> {
  const home = tmp('home');
  for (let i = 0; i < o.repos; i++) {
    const dir = gitRepo(join(home, 'src', `demo-${i}`));
    if (o.codewatch) installHooks(join(dir, '.git', 'hooks'));
  }
  mkdirSync(join(home, '.aws'), { recursive: true });
  writeFileSync(join(home, '.aws', 'config'), '[profile demo]\nregion = us-west-2\n');
  const p = await buildPayload({
    cwd: tmp('nowhere'), home, pathEnv: toolPath(),
    exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false, kirocrewApp: () => null },
    agentHooks: () => ({ rows: hookRows(), plugin: o.plugin ? { active: true, version: o.plugin, outdated: o.plugin < '0.3.0' } : { active: false, version: null, outdated: false } }),
  });
  return { home, p };
}

const SETUP = { ...SETUP_STUB, actions: [{ id: 'codewatch-repo', label: 'Enable codewatch in this repo', command: 'prism-cli enable codewatch', repo: true, url: false, confirm: false, readOnlyAws: false, installs: false, timeoutSec: 120, available: true }] };
const tab = (page: Awaited<ReturnType<typeof runPage>>, id: string) => page.dom.byId.settings.all().find((e) => e.getAttribute('data-tab') === id)!;
const badge = (page: Awaited<ReturnType<typeof runPage>>, id: string) => {
  const b = tab(page, id).childNodes[1] as FakeElement;
  return b.getAttribute('class') === 'okdot' ? 0 : Number(b.textContent);
};
const card = (page: Awaited<ReturnType<typeof runPage>>) => page.dom.byId.main.byClass('scard')[3];

// ---------------------------------------------------------------- one list

test('needs you: repos without codewatch and an old Claude Code plugin are 2 on the card, the badges, Needs you and --json', async () => {
  const { p } = await build({ repos: 3, plugin: '0.1.0' });
  assert.deepEqual(p.machine.setup.filter((i) => i.status === 'missing' || i.status === 'warn'), [], 'every machine check is ok here');
  assert.deepEqual(p.needsYou.map((i) => [i.tab, i.text]), [
    ['repos', "3 repos don't have codewatch yet."],
    ['agents', 'Claude Code plugin 0.1.0 is installed; the harness hooks need 0.3.0 or newer.'],
  ]);
  assert.deepEqual(p.needsYou[0].fixes, ['prism-cli enable codewatch --global'], 'the global install, suggested at 2+ repos');
  const json = JSON.parse(JSON.stringify(p));
  assert.deepEqual(json.summary.warnings, { count: 2, first: "3 repos don't have codewatch yet." }, '--json summary.warnings is the same list');

  const page = await runPage([p], '#settings', SETUP);
  assert.equal(card(page).childNodes[1].textContent, '2', 'the Dashboard card');
  assert.match(card(page).textContent, /3 repos don't have codewatch yet\. Open Settings →$/, 'and its first item');
  assert.equal(page.dom.byId['settings-badge'].textContent, '2', 'the Settings tab');
  assert.equal(page.dom.byId['settings-badge'].hidden, false);
  assert.deepEqual(['overview', 'machine', 'repos', 'agents', 'sync', 'aws', 'updates'].map((t) => badge(page, t)), [2, 0, 1, 1, 0, 0, 0], 'the section badges');
  assert.match(page.settingsText(), /Needs you2 items/);
});

test('needs you: nothing needed is 0 everywhere', async () => {
  const { p } = await build({ repos: 2, plugin: '0.3.0', codewatch: true });
  assert.deepEqual(p.overview.setup.map((r) => r.status), ['ok', 'ok']);
  assert.deepEqual(p.needsYou, []);
  assert.deepEqual(JSON.parse(JSON.stringify(p)).summary.warnings, { count: 0, first: null });
  const page = await runPage([p], '#settings', SETUP);
  assert.equal(card(page).childNodes[1].textContent, '0');
  assert.match(card(page).textContent, /Nothing needs attention\. Open Settings →$/);
  assert.equal(page.dom.byId['settings-badge'].hidden, true);
  assert.deepEqual(['overview', 'machine', 'repos', 'agents', 'sync', 'aws', 'updates'].map((t) => badge(page, t)), [0, 0, 0, 0, 0, 0, 0]);
  assert.match(page.settingsText(), /Needs younothingEverything is set up\./);
});

test('needs you: one function, so a machine warn, a bypassed repo, outdated hooks, the Kiro Crew app and an update each count once, in tab order', () => {
  const items = needsYou({
    machine: [
      { id: 'gitleaks', label: 'gitleaks available', status: 'warn', detail: 'not on PATH', fix: 'install gitleaks' },
      { id: 'codewatch-global', label: 'Codewatch global hooks', status: 'info', detail: 'optional', fix: '' },
      { id: 'kirocrew-app', label: 'Kiro Crew app', status: 'info', detail: 'outdated: 0.3.0 installed, 0.4.0 bundled with this prism-cli', fix: 'prism-cli enable kirocrew' },
    ],
    setup: [{ status: 'warn', label: 'demo-a', detail: "this repo's core.hooksPath (.husky) bypasses the global hooks", fix: 'cd demo-a && prism-cli enable codewatch' }, { status: 'missing', label: 'demo-b', detail: 'not installed', fix: 'x' }],
    suggestions: [],
    agentHooks: { rows: [{ client: 'kiro', scope: 'global', state: 'outdated', path: null, others: 0, error: null }], plugin: { active: false, version: null, outdated: false } },
    version: { installed: '1.21.8', latest: '1.21.9', update: true },
  });
  assert.deepEqual(items.map((i) => [i.tab, i.text, i.fixes]), [
    ['machine', 'gitleaks available: not on PATH', ['install gitleaks']],
    ['repos', "demo-a: this repo's core.hooksPath (.husky) bypasses the global hooks", ['cd demo-a && prism-cli enable codewatch']],
    ['repos', "1 repo doesn't have codewatch yet.", ['prism-cli enable codewatch']],
    ['agents', 'kiro agent hooks (global) are outdated', ['prism-cli enable agent-hooks --client kiro --global']],
    ['agents', 'Kiro Crew app: outdated: 0.3.0 installed, 0.4.0 bundled with this prism-cli', ['prism-cli enable kirocrew']],
    ['updates', 'prism-cli 1.21.9 is available (you have 1.21.8).', ['npm i -g @prism-d1/cli@latest']],
  ]);
});

// ---------------------------------------------------------------- the refresh after an action

test('payload cache: a request after invalidate() never shares a build that started before it, and an older build never replaces a newer one', async () => {
  const releases: (() => void)[] = [];
  let n = 0;
  const get = cachedPayload(() => new Promise((ok) => { const k = ++n; releases.push(() => ok(k)); }));
  const before = get(); // a refresh in flight while the action runs: it read the files before the change
  get.invalidate(); // the action finished
  const after = get();
  assert.notEqual(after, before, 'a new build, not the one in flight');
  assert.equal(n, 2);
  releases[1]();
  assert.equal(await after, 2);
  releases[0]();
  assert.equal(await before, 1, 'the first caller still gets its answer');
  assert.equal(await get(), 2, 'the cached value is the newer build');
  assert.equal(n, 2, 'and nothing was built again');
});

test('refresh: an action that finishes while another refresh is running shows its result at once (the row turns ok)', async () => {
  const { home, p: before } = await build({ repos: 1, plugin: null });
  const repo = before.repos[0];
  assert.equal(repo.setup.status, 'missing');
  // What `prism-cli enable codewatch` does in the repo; the next build reads it.
  installHooks(join(repo.path, '.git', 'hooks'));
  const after = await buildPayload({
    cwd: tmp('nowhere2'), home, pathEnv: toolPath(), exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [], periods: [], projects: [] }),
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false, kirocrewApp: () => null },
    agentHooks: () => ({ rows: hookRows(), plugin: { active: false, version: null, outdated: false } }),
  });
  assert.equal(after.repos[0].setup.status, 'ok');
  // /api/usage of the first load is held: that load is still running when the action ends.
  let releaseUsage: () => void = () => {};
  let usageCalls = 0;
  const usage = () => (++usageCalls === 1 ? new Promise((ok) => { releaseUsage = () => ok({ usage: before.usage, cacheHit: true }); }) : { usage: before.usage, cacheHit: true });
  let status = 'running';
  const page = await runPage([before, after], '#settings/repos', { ...SETUP, repoIds: { [repo.path]: repo.id } }, {
    '/api/usage': usage, '/api/action': { state: 'running', action: 'codewatch-repo' }, '/api/action/status': () => ({ state: status, action: 'codewatch-repo', exitCode: status === 'done' ? 0 : null, outcome: status === 'done' ? 'ok' : null }),
  });
  const reposPane = () => page.dom.byId.settings.all().find((e) => e.getAttribute('data-pane') === 'repos')!;
  assert.match(reposPane().textContent, /Repos with codewatch0 of 1/);
  const enable = reposPane().querySelectorAll('button').find((b) => b.textContent === 'Enable codewatch')!;
  enable.listeners.click();
  const dlg = page.dom.document.body.childNodes.find((n) => n instanceof FakeElement && n.nodeName === 'DIALOG') as FakeElement;
  dlg.querySelectorAll('button').find((b) => b.textContent === 'Run')!.listeners.click();
  await page.settle();
  assert.deepEqual(page.requests.find((r) => r.url === '/api/action')!.body, { action: 'codewatch-repo', repo: repo.id });
  status = 'done';
  await new Promise((r) => setTimeout(r, 1200)); // the drawer polls once a second
  await page.settle();
  assert.match(reposPane().textContent, /Repos with codewatch1 of 1/, 'the row is ok right after the action, while the first load still waits for usage');
  assert.equal(reposPane().querySelectorAll('button').filter((b) => b.textContent === 'Enable codewatch').length, 0, 'no Enable button left');
  assert.equal(page.requests.filter((r) => r.url === '/api/data').length, 2);
  releaseUsage();
  await page.settle();
  assert.match(reposPane().textContent, /Repos with codewatch1 of 1/, 'the held load ending later does not draw the old state back');
});
