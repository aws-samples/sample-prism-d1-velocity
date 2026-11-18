/**
 * Tests for the Settings view (1.13.0): the agent-hooks status as data, the
 * #settings/<tab> routes and the #setup alias, tab badges and the Needs you
 * list, repos with and without codewatch, the masked AWS account, the Updates
 * tab and its Check now route, and the action drawer. No AWS, npm or network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentHookStatus, enableAgentHooks, pluginPredatesHooks, type AgentHooksDeps, type AgentHookStatus } from '../src/commands/enable/harness-hooks.js';
import { PLUGIN_ID } from '../src/commands/enable/claude-code.js';
import { buildPayload, type DashboardPayload } from '../src/dashboard/payload.js';
import { renderPage } from '../src/dashboard/page.js';
import { setupApi } from '../src/dashboard/setup-api.js';
import { ActionRunner } from '../src/dashboard/actions.js';
import { UpdateCheck } from '../src/dashboard/update-check.js';
import { FakeElement, runPage, SETUP_STUB } from './page-dom.js';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-st-gcfg-')), 'gitconfig');
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-st-${p}-`)));

// ---------------------------------------------------------------- agent hooks as data

function hookRig() {
  const home = tmp('home'), repo = tmp('repo');
  const d: AgentHooksDeps = { home, env: { CLAUDE_CONFIG_DIR: join(home, 'cfg') }, repoRoot: repo, cli: 'prism-cli', log: () => {}, error: () => {}, now: () => new Date() };
  return { home, repo, d };
}

test('agent hooks status: the same rows as enable agent-hooks --status, as data', () => {
  const { d } = hookRig();
  const before = agentHookStatus(d);
  assert.deepEqual(before.rows.map((r) => [r.client, r.scope, r.state]), [['kiro', 'project', 'missing'], ['kiro', 'global', 'missing'], ['claude', 'project', 'missing'], ['claude', 'global', 'missing']]);
  assert.deepEqual(before.plugin, { active: false, version: null, outdated: false });
  assert.equal(enableAgentHooks({ client: 'kiro' }, d), 0);
  const after = agentHookStatus(d);
  assert.equal(after.rows[0].state, 'installed');
  assert.match(after.rows[0].path || '', /\.kiro\/hooks\/prism-harness\.json$/);
  assert.deepEqual(agentHookStatus({ ...d, repoRoot: null }).rows.filter((r) => r.scope === 'project').map((r) => r.state), ['no-repo', 'no-repo']);
  // The CLI's own --status prints the same states.
  const lines: string[] = [];
  enableAgentHooks({ status: true }, { ...d, log: (l = '') => lines.push(l) });
  assert.match(lines.join('\n'), /kiro \(project\): installed/);
  assert.match(lines.join('\n'), /claude \(global\): missing/);
});

test('agent hooks status: a Claude plugin below 0.3.0 is outdated; an unreadable file is reported, not thrown', () => {
  const { d, home, repo } = hookRig();
  mkdirSync(join(home, 'cfg', 'plugins'), { recursive: true });
  writeFileSync(join(home, 'cfg', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { [PLUGIN_ID]: [{ version: '0.2.4' }] } }));
  assert.deepEqual(agentHookStatus(d).plugin, { active: true, version: '0.2.4', outdated: true });
  assert.equal(pluginPredatesHooks('0.3.0'), false);
  assert.equal(pluginPredatesHooks('1.0.0'), false);
  assert.equal(pluginPredatesHooks(null), false);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), '{ not json');
  const row = agentHookStatus(d).rows.find((r) => r.client === 'claude' && r.scope === 'project')!;
  assert.equal(row.state, 'unreadable');
  assert.match(row.error || '', /not valid JSON/);
});

// ---------------------------------------------------------------- page fixtures

const hooks = (o: Partial<AgentHookStatus['plugin']> = {}, outdated = false): AgentHookStatus => ({
  rows: [
    { client: 'kiro', scope: 'project', state: outdated ? 'outdated' : 'installed', path: '~/w/.kiro/hooks/prism-harness.json', others: 0, error: null },
    { client: 'kiro', scope: 'global', state: 'missing', path: '~/.kiro/hooks/prism-harness.json', others: 0, error: null },
    { client: 'claude', scope: 'project', state: 'missing', path: '~/w/.claude/settings.json', others: 0, error: null },
    { client: 'claude', scope: 'global', state: 'missing', path: '~/.claude/settings.json', others: 0, error: null },
  ],
  plugin: { active: false, version: null, outdated: false, ...o },
});

async function payload(over: { hooks?: AgentHookStatus; update?: boolean } = {}): Promise<DashboardPayload> {
  const home = tmp('ph');
  for (const n of ['with', 'without']) mkdirSync(join(home, n, '.git'), { recursive: true });
  const p = await buildPayload({
    cwd: tmp('nowhere'), home, pathEnv: tmp('path'),
    exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
    machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
    version: async () => ({ installed: '1.13.0', latest: over.update ? '1.13.1' : '1.13.0', publishedAt: '2026-11-13T00:00:00.000Z', update: !!over.update, checkedAt: '2026-11-14T00:00:00.000Z' }),
    agentHooks: () => over.hooks ?? hooks(),
  });
  return p;
}

const SETUP = {
  ...SETUP_STUB,
  actions: ['codewatch-global', 'codewatch-repo', 'update-cli', 'agent-hooks-kiro-remove', 'agent-hooks-kiro-global', 'agent-hooks-claude', 'agent-hooks-claude-global']
    .map((id) => ({ id, label: id, command: id === 'update-cli' ? 'npm i -g @prism-d1/cli@latest' : 'prism-cli ' + id, repo: id === 'codewatch-repo', url: false, confirm: false, readOnlyAws: false, installs: id === 'update-cli', timeoutSec: 60, available: true })),
  links: { releases: 'https://github.com/aws-samples/sample-prism-d1-velocity/releases' },
  aws: { steps: [], warnings: [], source: 'default chain', credentialLabel: 'none', saved: { account: '123456789012', alias: null, profile: 'dev', inUse: true, region: 'us-west-2', verifiedAt: null, path: '~/.prism/aws.json', scope: 'user' } },
};

const pane = (page: Awaited<ReturnType<typeof runPage>>, id: string) => page.dom.byId.settings.all().find((e) => e.getAttribute('data-pane') === id)!;
const tab = (page: Awaited<ReturnType<typeof runPage>>, id: string) => page.dom.byId.settings.all().find((e) => e.getAttribute('data-tab') === id)!;

// ---------------------------------------------------------------- routes, tabs and badges

test('settings: #settings/<tab> deep links; #setup and #setup/<tab> stay as aliases; an unknown tab is the Overview', async () => {
  const p = await payload();
  const page = await runPage([p], '#setup', SETUP);
  assert.equal(page.dom.byId.settings.hidden, false, '#setup opens Settings');
  assert.equal(page.dom.byId.main.hidden, true);
  assert.equal(pane(page, 'overview').hidden, false);
  assert.equal(pane(page, 'agents').hidden, true);
  page.go('#settings/agents');
  assert.equal(pane(page, 'agents').hidden, false);
  assert.equal(pane(page, 'overview').hidden, true);
  assert.equal(tab(page, 'agents').getAttribute('aria-selected'), 'true');
  assert.equal(tab(page, 'agents').getAttribute('href'), '#settings/agents');
  page.go('#setup/updates');
  assert.equal(pane(page, 'updates').hidden, false, 'old #setup/updates link');
  page.go('#settings/nope');
  assert.equal(pane(page, 'overview').hidden, false);
  page.go('');
  assert.equal(page.dom.byId.settings.hidden, true);
  assert.equal(page.dom.byId.main.hidden, false);
  assert.doesNotMatch(renderPage('N'), />Setup </, 'the tab is Settings');
});

test('settings: each tab has a count badge or a green dot; Needs you lists the items with fixes and tab links', async () => {
  const p = await payload({ hooks: hooks({ active: true, version: '0.2.0', outdated: true }, true), update: true });
  const page = await runPage([p], '#settings', SETUP);
  const badge = (id: string) => { const b = tab(page, id).childNodes[1] as FakeElement; return b.getAttribute('class') === 'okdot' ? 'dot' : b.textContent; };
  assert.equal(badge('agents'), '2', 'outdated kiro hooks and the old plugin');
  assert.equal(badge('updates'), '1');
  assert.equal(badge('repos'), '1', "repos without codewatch: one item");
  const total = Number(badge('overview'));
  assert.ok(total >= 4);
  assert.equal(page.dom.byId['settings-badge'].textContent, String(total), 'the Settings tab carries the same count');
  const t = pane(page, 'overview').textContent;
  assert.match(t, /Needs you\d+ items/);
  assert.match(t, /Claude Code plugin 0\.2\.0 is installed; the harness hooks need 0\.3\.0 or newer\./);
  assert.match(t, /claude plugin update prism@prism-d1-velocity/);
  assert.match(t, /prism-cli 1\.13\.1 is available \(you have 1\.13\.0\)\.npm i -g @prism-d1\/cli@latest/);
  assert.match(t, /kiro agent hooks \(project\) are outdatedprism-cli enable agent-hooks --client kiro/);
  assert.ok(pane(page, 'overview').querySelectorAll('a').some((a) => a.getAttribute('href') === '#settings/agents'));
  assert.match(t, /machine checks pass.*repos have codewatch.*agent hook installs/);
});

test('settings: badges recompute after Check now (a reload with new data)', async () => {
  const before = await payload({ update: true });
  // The list is built on the server: the reload's payload is a new build with no update.
  const after = await payload();
  const page = await runPage([before, after], '#settings/updates', SETUP);
  assert.equal((tab(page, 'updates').childNodes[1] as FakeElement).textContent, '1');
  await page.reload();
  assert.equal((tab(page, 'updates').childNodes[1] as FakeElement).getAttribute('class'), 'okdot');
  assert.equal(pane(page, 'updates').hidden, false, 'the selected tab stays selected');
});

// ---------------------------------------------------------------- panes

test('settings: repos with codewatch in a table, the rest behind one "enable for every repo" item', async () => {
  const p = await payload();
  p.overview.setup = p.overview.setup.map((r) => r.name === 'with' ? { ...r, status: 'ok' as const, reviewer: 'kiro' } : r);
  const page = await runPage([p], '#settings/repos', SETUP);
  const t = pane(page, 'repos').textContent;
  assert.match(t, /Repos with codewatch1 of 2 repos/);
  assert.match(t, /Repos without codewatch1 repo/);
  assert.match(t, /Enable for every repo/);
  const d = pane(page, 'repos').querySelectorAll('details').find((x) => x.getAttribute('data-key') === 'settings:repos-off')!;
  assert.match(d.textContent, /^Show the 1 repoRepoCodewatchSecurity Agentwithout/);
});

test('settings: Agent hooks tab: Install / Update / Remove per row (action ids only), the plugin version and Kiro Crew', async () => {
  const page = await runPage([await payload()], '#settings/agents', SETUP);
  const t = pane(page, 'agents').textContent;
  assert.match(t, /kiroprojectinstalled~\/w\/\.kiro\/hooks\/prism-harness\.jsonRemove/);
  assert.match(t, /kiroglobalnot installed~\/\.kiro\/hooks\/prism-harness\.jsonInstall/);
  assert.match(t, /Claude Code pluginInstallednot installed or disabled/);
  assert.match(t, /Kiro Crew is not on this machine\./);
  const html = renderPage('N');
  assert.match(html, /const id = 'agent-hooks-' \+ r\.client \+ \(r\.scope === 'global' \? '-global' : ''\)/, 'the button names a fixed action id');
});

test('settings: the AWS tab shows the saved account masked to its last 4 digits', async () => {
  const page = await runPage([await payload()], '#settings/aws', SETUP);
  const t = pane(page, 'aws').textContent;
  assert.match(t, /Account••••9012/);
  assert.doesNotMatch(page.dom.byId.settings.textContent, /123456789012/);
});

test('settings: Updates tab: versions, the Update button (a fixed action), Check now, release notes, components', async () => {
  const page = await runPage([await payload({ update: true })], '#settings/updates', SETUP);
  const u = pane(page, 'updates');
  const t = u.textContent;
  assert.match(t, /Installed1\.13\.0Latest on npm1\.13\.1 · published/);
  const buttons = u.querySelectorAll('button').map((b) => b.textContent);
  assert.ok(buttons.includes('Update prism-cli') && buttons.includes('Check now'), buttons.join(','));
  const rel = u.querySelectorAll('a').find((a) => a.textContent === 'Release notes')!;
  assert.equal(rel.getAttribute('href'), 'https://github.com/aws-samples/sample-prism-d1-velocity/releases');
  assert.equal(rel.getAttribute('rel'), 'noopener noreferrer');
  assert.match(t, /prism-cli enable kirocrew/, 'post-update reminder');
  assert.match(t, /ComponentsComponentInstalledNoteClaude Code plugin/);
  const html = renderPage('N');
  assert.doesNotMatch(html, /https:\/\/github\.com/, 'the release link comes from the server, not the page');
});

test('settings: action output is a bottom drawer outside the redrawn view, hidden until a run', async () => {
  const page = await runPage([await payload()], '#settings', SETUP);
  const drawer = page.dom.document.body.childNodes.find((n) => n instanceof FakeElement && n.getAttribute('id') === 'action-drawer') as FakeElement;
  assert.ok(drawer, 'in <body>, not inside #settings');
  assert.equal(drawer.getAttribute('class'), 'drawer');
  assert.equal(drawer.hidden, true);
  assert.match(renderPage('N'), /\.drawer \{ position:fixed; left:0; right:0; bottom:0;/);
});

// ---------------------------------------------------------------- server side

test('POST /api/update-check takes an empty object and asks the registry now, past the daily limit', async () => {
  let fetches = 0;
  const file = join(tmp('uc'), 'update-check.json');
  const u = new UpdateCheck({ installed: '1.13.0', file, env: {}, fetch: async () => { fetches++; return { latest: '1.13.2', publishedAt: null }; } });
  await u.get();
  assert.equal(fetches, 1);
  const runner = new ActionRunner({ execPath: 'node', entry: 'x', cwd: '/w', home: tmp('h'), platform: 'linux', repos: async () => [], systemdAvailable: () => false });
  const api = setupApi({ runner, cwd: '/w', repoPaths: async () => [], identity: { env: {}, home: tmp('h2'), repoRoot: null }, refresh: async () => ({}), checkUpdate: () => u.get({ force: true }) });
  assert.equal((await api.postApi['/api/update-check']({ x: 1 })).status, 400);
  const r = await api.postApi['/api/update-check']({});
  assert.equal(r.status, 200);
  assert.equal((r.json as any).latest, '1.13.2');
  assert.equal(fetches, 2, 'forced past the once-a-day cache');
  const off = new UpdateCheck({ installed: '1.13.0', file, env: { PRISM_NO_UPDATE_CHECK: '1' }, fetch: async () => { fetches++; return { latest: '9.9.9', publishedAt: null }; } });
  assert.equal((await off.get({ force: true })).latest, null, 'off stays off');
  assert.equal(fetches, 2);
  const setup = await api.getApi['/api/setup']();
  assert.equal(setup.links.releases, 'https://github.com/aws-samples/sample-prism-d1-velocity/releases');
  assert.equal(setup.actions.find((a) => a.id === 'update-cli')!.command, 'npm i -g @prism-d1/cli@latest');
});
