/**
 * The codewatch reviewer and model per scope (codewatch/reviewer-settings.ts):
 * writes and resets at clone, team and global; where the effective value comes
 * from; the team pin; refused values; a reviewer that is not installed; the
 * team-file diff; the dashboard route and actions; the repo page's card.
 * Real git in throwaway repos, with GIT_CONFIG_GLOBAL pointed at a temp file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySetting, clearOverrides, lineDiff, pinWarning, reviewerView, settingError, teamFiles } from '../src/codewatch/reviewer-settings.js';
import { codewatchReviewer } from '../src/dashboard/codewatch-reviewer.js';
import { ActionRunner, repoId, type ScanRepo } from '../src/dashboard/actions.js';
import { GIT_CONFIG_LIST, parseConfigList } from '../src/dashboard/setup.js';
import { run } from '../src/utils/exec.js';

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-cwrev-${p}-`)));

/** A repo plus a private global git config; restores the env afterwards. */
function withRepo(fn: (repo: string, git: (a: string[]) => ReturnType<typeof run>) => void | Promise<void>) {
  return async () => {
    const root = tmp('r'), repo = join(root, 'repo'), gcfg = join(root, 'gitconfig');
    writeFileSync(gcfg, '');
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = gcfg; process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', '-b', 'trunk', repo]);
      await fn(repo, (a) => run('git', a));
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved.g; process.env.GIT_CONFIG_NOSYSTEM = saved.s;
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      rmSync(root, { recursive: true, force: true });
    }
  };
}
const entries = (repo: string) => { const r = run('git', ['-C', repo, ...GIT_CONFIG_LIST]); return r.ok ? parseConfigList(r.stdout + '\0') : []; };
const view = (repo: string, available: ('kiro' | 'claude')[] = ['kiro', 'claude']) => reviewerView(repo, entries(repo), available);
const get = (repo: string, ...a: string[]) => { const r = run('git', ['-C', repo, 'config', ...a]); return r.ok ? r.stdout.trim() : null; };

test('clone scope: writes prism.reviewer and prism.<tool>Model locally; auto unsets the model; reset unsets both', withRepo((repo, git) => {
  applySetting(repo, git, { scope: 'clone', reviewer: 'claude', model: 'sonnet' }, null);
  assert.equal(get(repo, '--local', 'prism.reviewer'), 'claude');
  assert.equal(get(repo, '--local', 'prism.claudeModel'), 'sonnet');
  let v = view(repo);
  assert.deepEqual([v.reviewer, v.reviewerFrom, v.model, v.modelFrom], ['claude', 'clone', 'sonnet', 'clone']);
  applySetting(repo, git, { scope: 'clone', model: 'auto' }, v.reviewer);
  assert.equal(get(repo, '--local', 'prism.claudeModel'), null, 'auto: the tool default, key removed');
  assert.deepEqual([view(repo).model, view(repo).modelFrom], ['default', 'tool default']);
  applySetting(repo, git, { scope: 'clone', reset: true }, null);
  assert.equal(get(repo, '--local', 'prism.reviewer'), null);
  v = view(repo);
  assert.equal(v.reviewerFrom, 'detected');
  assert.equal(get(repo, '--global', 'prism.reviewer'), null, 'nothing written globally');
}));

test('global scope: the model for one tool in git config --global; the clone wins over it; reset removes it', withRepo((repo, git) => {
  applySetting(repo, git, { scope: 'global', reviewer: 'kiro', model: 'claude-sonnet-4.5' }, null);
  assert.equal(get(repo, '--global', 'prism.kiroModel'), 'claude-sonnet-4.5');
  assert.equal(get(repo, '--local', 'prism.kiroModel'), null);
  let v = view(repo);
  assert.deepEqual([v.reviewer, v.model, v.modelFrom], ['kiro', 'claude-sonnet-4.5', 'global']);
  applySetting(repo, git, { scope: 'clone', model: 'auto-x' }, 'kiro');
  assert.deepEqual([view(repo).model, view(repo).modelFrom], ['auto-x', 'clone'], 'this clone wins over the global default');
  applySetting(repo, git, { scope: 'global', reset: true }, null);
  assert.equal(get(repo, '--global', 'prism.kiroModel'), null);
  v = view(repo);
  assert.equal(v.global.models.kiro, null);
}));

test('team scope: eval.reviewer / eval.model in .prism/config.json, other keys kept; a new tool drops the old model; reset removes both', withRepo((repo, git) => {
  mkdirSync(join(repo, '.prism'));
  writeFileSync(join(repo, '.prism', 'config.json'), JSON.stringify({ team_id: 't1', eval: { reviewer: 'kiro', model: 'm-kiro', timeout_seconds: 200 } }, null, 2) + '\n');
  const lines = applySetting(repo, git, { scope: 'team', reviewer: 'claude' }, null);
  const cfg = () => JSON.parse(readFileSync(join(repo, '.prism', 'config.json'), 'utf8'));
  assert.deepEqual(cfg(), { team_id: 't1', eval: { reviewer: 'claude', timeout_seconds: 200 } }, 'the kiro model does not carry over to claude');
  assert.match(lines.join('\n'), /is a repo file: commit it to share the change\. The CI eval gate reads it from the base branch\./);
  applySetting(repo, git, { scope: 'team', model: 'opus' }, null);
  assert.equal(cfg().eval.model, 'opus');
  const v = view(repo);
  assert.deepEqual([v.reviewer, v.reviewerFrom, v.model, v.modelFrom, v.teamPin], ['claude', 'team', 'opus', 'team', 'opus']);
  applySetting(repo, git, { scope: 'team', reset: true }, null);
  assert.deepEqual(cfg(), { team_id: 't1', eval: { timeout_seconds: 200 } });
  assert.equal(get(repo, '--local', 'prism.reviewer'), null, 'no git config written');
}));

test('the team pin wins over a personal model, and the warning says so and points at the team scope', withRepo((repo, git) => {
  mkdirSync(join(repo, '.prism'));
  writeFileSync(join(repo, '.prism', 'config.json'), JSON.stringify({ eval: { reviewer: 'kiro', model: 'pinned-1' } }));
  applySetting(repo, git, { scope: 'clone', model: 'mine' }, 'kiro');
  const v = view(repo);
  assert.deepEqual([v.model, v.modelFrom, v.teamPin], ['pinned-1', 'team', 'pinned-1'], 'the clone model is ignored');
  assert.match(pinWarning(v, 'clone', 'other', undefined)!, /^The team pins model pinned-1 for kiro in \.prism\/config\.json, and that wins over a personal model: this change will not affect pushes here\. Change the team default instead/);
  assert.ok(pinWarning(v, 'global', 'x', 'kiro'));
  assert.equal(pinWarning(v, 'team', 'x', undefined), null, 'the team scope is the fix, not the problem');
  assert.equal(pinWarning(v, 'clone', 'x', 'claude'), null, 'a model for another tool is not shadowed by a kiro pin');
  // A model set for another tool is no pin: claude runs here, and its clone model applies.
  applySetting(repo, git, { scope: 'clone', reviewer: 'claude', model: 'haiku' }, null);
  const w = view(repo);
  assert.deepEqual([w.reviewer, w.model, w.modelFrom, w.teamPin], ['claude', 'haiku', 'clone', null]);
}));

test('a chosen tool that is not installed: says so, and names what actually runs', withRepo((repo, git) => {
  applySetting(repo, git, { scope: 'clone', reviewer: 'kiro' }, null);
  const v = view(repo, ['claude']);
  assert.deepEqual([v.wanted.id, v.wanted.from, v.reviewer, v.reviewerFrom], ['kiro', 'clone', 'claude', 'detected']);
  assert.match(v.fallback!, /kiro-cli is not on PATH; used claude instead/);
  assert.deepEqual(v.installed, { kiro: false, claude: true });
  const none = view(repo, []);
  assert.equal(none.reviewer, null);
  assert.match(none.fallback!, /kiro-cli is not on PATH/);
}));

test('refused: an unknown reviewer, a bad model (a leading "-" included), an unknown scope, nothing to change', () => {
  assert.match(settingError({ scope: 'clone', reviewer: 'copilot' })!, /reviewer must be one of: kiro, claude/);
  for (const m of ['-x', '--endpoint=evil', 'a b', 'x;rm', '', 'a'.repeat(101)]) assert.match(settingError({ scope: 'clone', model: m })!, /model must match/, m);
  assert.match(settingError({ scope: 'everyone', model: 'x' })!, /scope must be one of/);
  assert.match(settingError({ scope: 'clone' })!, /nothing to change/);
  assert.match(settingError({ scope: 'global', model: 'x' })!, /pass the reviewer/);
  assert.equal(settingError({ scope: 'team', model: 'auto' }), null);
  assert.equal(settingError({ scope: 'clone', reset: true }), null);
});

test('team diff: the file as it is and as it would be, line by line; a missing file is all additions', withRepo((repo) => {
  const fresh = teamFiles(repo, { reviewer: 'claude', model: 'sonnet' });
  assert.equal(fresh.before, null);
  assert.ok(lineDiff('', fresh.after).every((l) => l.startsWith('+')));
  mkdirSync(join(repo, '.prism'));
  writeFileSync(join(repo, '.prism', 'config.json'), JSON.stringify({ team_id: 't1', eval: { reviewer: 'kiro' } }, null, 2) + '\n');
  const f = teamFiles(repo, { reviewer: 'claude', model: 'sonnet' });
  const d = lineDiff(f.before!, f.after);
  assert.deepEqual(d.filter((l) => l[0] !== ' '), ['-    "reviewer": "kiro"', '+    "reviewer": "claude",', '+    "model": "sonnet"']);
  assert.ok(d.includes('   "team_id": "t1",'), 'unchanged lines stay');
}));

test('GET /api/codewatch/reviewer: a scan-list id only; the view, tools and suggestions; a team proposal with its diff', withRepo(async (repo) => {
  const d = { repoPaths: async () => [repo], pathEnv: '' };
  assert.equal((await codewatchReviewer(d, new URLSearchParams('repo=../x'))).status, 400);
  assert.equal((await codewatchReviewer(d, new URLSearchParams('repo=ffffffffffffffff'))).status, 404);
  const id = repoId(repo);
  const r = await codewatchReviewer(d, new URLSearchParams('repo=' + id)) as { status: number; json: any };
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.tools.map((t: any) => [t.id, t.installed, t.suggestions.length > 0]), [['kiro', false, false], ['claude', false, true]], 'no kiro list offline; claude aliases');
  assert.ok(!JSON.stringify(r.json).includes(repo), 'no repo path in the answer');
  const p = await codewatchReviewer(d, new URLSearchParams(`repo=${id}&scope=team&reviewer=claude&model=sonnet`)) as { json: any };
  assert.ok(p.json.proposal.created);
  assert.ok(p.json.proposal.diff.some((l: string) => l === '+    "reviewer": "claude",'));
  assert.equal((await codewatchReviewer(d, new URLSearchParams(`repo=${id}&scope=clone&model=-evil`))).status, 400);
}));

test('runner: the reviewer actions take only a checked reviewer and model; team needs confirm', async () => {
  const home = tmp('runner'), path = join(home, 'demo');
  mkdirSync(path);
  const REPO: ScanRepo = { id: repoId(path), name: 'demo', path };
  const calls: string[][] = [];
  const spawn = (_f: string, a: string[]) => { calls.push(a); const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true; setTimeout(() => c.emit('close', 0), 1); return c; };
  const r = new ActionRunner({ execPath: '/usr/bin/node', entry: '/x.js', cwd: home, home, repos: async () => [REPO], systemdAvailable: () => false, platform: 'linux', spawn: spawn as any });
  const bad = async (body: object, re: RegExp) => { const x = await r.start(body); assert.equal(x.status, 400, JSON.stringify(body)); assert.match((x.json as any).error, re); };
  try {
    await bad({ action: 'codewatch-reviewer-clone', repo: REPO.id, reviewer: 'copilot' }, /reviewer must be one of/);
    await bad({ action: 'codewatch-reviewer-clone', repo: REPO.id, model: '--global' }, /model must match/);
    await bad({ action: 'codewatch-reviewer-clone', repo: REPO.id, model: 'x', path: '/etc' }, /unexpected field path/);
    await bad({ action: 'codewatch-reviewer-team', repo: REPO.id, model: 'x' }, /needs confirm/);
    await bad({ action: 'codewatch-reviewer-clone-reset', repo: REPO.id, model: 'x' }, /does not take a reviewer or model/);
    await bad({ action: 'codewatch-repo', repo: REPO.id, reviewer: 'kiro' }, /does not take a reviewer or model/);
    assert.equal(calls.length, 0);
    assert.equal((await r.start({ action: 'codewatch-reviewer-clone', repo: REPO.id, reviewer: 'claude', model: ' sonnet ' })).status, 202);
    assert.deepEqual(calls[0], ['/x.js', 'codewatch', 'reviewer', '--scope', 'clone', '--reviewer', 'claude', '--model', 'sonnet']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('repo page: the card names the reviewer, model and their scopes; Change, the team diff, the pin warning, Save and Reset', async () => {
  const { buildPayload } = await import('../src/dashboard/payload.js');
  const { ACTIONS } = await import('../src/dashboard/actions.js');
  const { FakeElement, runPage, SETUP_STUB } = await import('./page-dom.js');
  const home = tmp('ph');
  mkdirSync(join(home, 'demo-shop', '.git'), { recursive: true });
  try {
    const p = await buildPayload({
      cwd: tmp('nowhere'), home, pathEnv: tmp('path'),
      exporter: async () => ({ schema: 'codeburn.export.v2', currency: { code: 'USD' }, summary: [{ 'Cost (USD)': 0, 'API Calls': 0, Sessions: 0 }], periods: [], projects: [] }),
      machineDeps: { home, env: {}, scheduleExists: () => false, schedulerName: () => 'crontab', systemdAvailable: () => false },
      version: async () => ({ installed: '1.20.0', latest: '1.20.0', publishedAt: '2026-11-13T00:00:00.000Z', update: false, checkedAt: '2026-11-14T00:00:00.000Z' }),
      agentHooks: () => ({ rows: [], plugin: { active: false, version: null, outdated: false } }),
    });
    const id = p.repos[0].id;
    const ids = Object.keys(ACTIONS).filter((k) => k.startsWith('codewatch-reviewer'));
    const SETUP = { ...SETUP_STUB, actions: ids.map((k) => { const a = (ACTIONS as any)[k]; return { id: k, label: a.label, command: 'prism-cli ' + a.args.join(' '), repo: true, url: false, confirm: !!a.confirm, pick: a.pick ?? null, note: a.note ?? null, confirmLabel: a.confirmLabel ?? null, timeoutSec: 60, available: true }; }) };
    const labels = { team: 'team file (.prism/config.json)', clone: 'overridden for this repo (git config --local)', global: 'your default (git config --global)', 'tool default': 'tool default', detected: 'the installed tool' };
    const tools = [{ id: 'kiro', name: 'Kiro CLI', binary: 'kiro-cli', installed: false, modelKey: 'prism.kiroModel', suggestions: [] }, { id: 'claude', name: 'Claude Code', binary: 'claude', installed: true, modelKey: 'prism.claudeModel', suggestions: ['sonnet', 'opus', 'haiku'] }];
    const view = { team: { reviewer: 'kiro', model: null }, clone: { reviewer: null, models: {} }, global: { reviewer: null, models: {} }, installed: { kiro: false, claude: true },
      wanted: { id: 'kiro', from: 'team' }, reviewer: 'claude', reviewerFrom: 'detected', fallback: 'kiro-cli is not on PATH; used claude instead', model: 'default', modelFrom: 'tool default', modelNote: null, teamPin: null };
    const base = { repo: id, view, labels, tools, teamFile: '.prism/config.json', modelPattern: '^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,99}$' };
    const asked: string[] = [];
    const url = '/api/codewatch/reviewer?repo=' + id;
    const routes: Record<string, unknown> = {
      [url]: base,
      [url + '&scope=clone&reviewer=claude']: () => (asked.push('clone'), { ...base, proposal: { warning: null } }),
      [url + '&scope=team&reviewer=claude']: () => (asked.push('team'), { ...base, proposal: { warning: null, created: false, diff: ['   "eval": {', '-    "reviewer": "kiro"', '+    "reviewer": "claude"', '   }'] } }),
      [url + '&scope=clone&reviewer=claude&model=opus']: () => (asked.push('pin'), { ...base, proposal: { warning: 'The team pins model x for claude in .prism/config.json, and that wins over a personal model' } }),
    };
    const page = await runPage([p], '#repo/' + id, SETUP, routes);
    await page.settle();
    const box = () => page.dom.byId.repo.all().find((e) => e.hasAttribute('data-cwrev'))!;
    const t = box().textContent;
    assert.match(t, /ReviewerClaude Code claude installedFromthe installed toolModeldefaultFromtool default/);
    assert.match(t, /This repo follows your default\. Your default reviewer and model →/);
    assert.match(t, /Kiro CLI was chosen \(team file \(\.prism\/config\.json\)\), but kiro-cli is not on PATH; used claude instead\. Pushes here use Claude Code instead\./);
    box().all().find((e) => e.hasAttribute('data-cw-change'))!.listeners.click();
    await page.settle();
    assert.deepEqual(asked, ['clone']);
    const radios = () => box().all().filter((e) => e.getAttribute('name') === 'cw-scope');
    assert.deepEqual(radios().map((r) => [r.getAttribute('value'), r.hasAttribute('checked')]), [['clone', true], ['default', false], ['team', false]], 'default: override for this repo');
    radios()[2].listeners.change();
    await page.settle();
    assert.match(box().textContent, /\.prism\/config\.json is a repo file\. Commit it to share the change; the CI eval gate reads it from the base branch too\./);
    const diff = box().all().find((e) => e.hasAttribute('data-diff'))!;
    assert.deepEqual(diff.childNodes.map((n: any) => n.getAttribute('class')), [null, 'del', 'add', null]);
    box().all().find((e) => e.hasAttribute('data-cw-save'))!.listeners.click();
    const dlg = page.dom.document.body.childNodes.find((n: any) => n instanceof FakeElement && n.nodeName === 'DIALOG') as InstanceType<typeof FakeElement>;
    assert.match(dlg.textContent, /cd ~\/demo-shop && prism-cli codewatch reviewer --scope team --reviewer claude --model auto/);
    assert.ok(dlg.all().some((e) => e.hasAttribute('data-diff')), 'the diff again, before saving');
    const run = dlg.querySelectorAll('button').find((b) => b.textContent === 'Run')!;
    assert.equal(run.disabled, true, 'the team scope needs the checkbox');
    const cb = dlg.querySelectorAll('input')[0] as any;
    cb.checked = true; cb.listeners.change();
    assert.equal(run.disabled, false);
    run.listeners.click();
    await page.settle();
    assert.deepEqual(page.requests.find((r) => r.url === '/api/action')!.body, { action: 'codewatch-reviewer-team', repo: id, reviewer: 'claude', model: 'auto', confirm: true });

    // A personal model under a team pin: said plainly, with the team scope offered.
    const p2 = await runPage([p], '#repo/' + id, SETUP, routes);
    await p2.settle();
    const box2 = () => p2.dom.byId.repo.all().find((e) => e.hasAttribute('data-cwrev'))!;
    box2().all().find((e) => e.hasAttribute('data-cw-change'))!.listeners.click();
    await p2.settle();
    const model = box2().all().find((e) => e.getAttribute('id') === 'cw-model')!;
    model.value = 'opus'; model.listeners.input(); model.listeners.change();
    await p2.settle();
    const warn = box2().all().find((e) => e.hasAttribute('data-pin-warning'))!;
    assert.match(warn.textContent, /that wins over a personal model/);
    warn.querySelectorAll('button')[0].listeners.click();
    await p2.settle();
    assert.equal(box2().all().filter((e) => e.getAttribute('name') === 'cw-scope').find((r) => r.hasAttribute('checked'))!.getAttribute('value'), 'team');
    // A bad model id disables Save; Reset is per scope.
    const m2 = box2().all().find((e) => e.getAttribute('id') === 'cw-model')!;
    m2.value = '-bad'; m2.listeners.input(); m2.listeners.change();
    await p2.settle();
    assert.ok(box2().all().find((e) => e.hasAttribute('data-cw-save'))!.hasAttribute('disabled'));
    assert.match(box2().all().find((e) => e.hasAttribute('data-cw-reset'))!.textContent, /^Reset the team default$/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('precedence table: every combination of global, local and team reviewer, and the model rule', withRepo((repo, git) => {
  mkdirSync(join(repo, '.prism'));
  const team = (r: string | null, m: string | null = null) => writeFileSync(join(repo, '.prism', 'config.json'), JSON.stringify({ eval: { ...(r ? { reviewer: r } : {}), ...(m ? { model: m } : {}) } }));
  const set = (scope: string, k: string, v: string | null) => { git(['-C', repo, 'config', scope, '--unset-all', k]); if (v) git(['-C', repo, 'config', scope, k, v]); };
  // [global, local, team] -> the reviewer that runs and where it came from. Both tools installed.
  const rows: [string | null, string | null, string | null, string, string][] = [
    [null, null, null, 'kiro', 'detected'],
    [null, null, 'claude', 'claude', 'team'],
    ['claude', null, null, 'claude', 'global'],
    ['claude', null, 'kiro', 'claude', 'global'],
    [null, 'claude', null, 'claude', 'clone'],
    [null, 'claude', 'kiro', 'claude', 'clone'],
    ['kiro', 'claude', null, 'claude', 'clone'],
    ['kiro', 'claude', 'kiro', 'claude', 'clone'],
  ];
  for (const [g, l, t, want, from] of rows) {
    set('--global', 'prism.reviewer', g); set('--local', 'prism.reviewer', l); team(t);
    const v = view(repo);
    assert.deepEqual([v.reviewer, v.reviewerFrom], [want, from], JSON.stringify({ g, l, t }));
  }
  // Model: the team pin for the tool that runs beats local and global; then local, then global, then the tool default.
  set('--global', 'prism.reviewer', null); set('--local', 'prism.reviewer', null);
  team('claude', 'opus'); set('--local', 'prism.claudeModel', 'haiku'); set('--global', 'prism.claudeModel', 'sonnet');
  assert.deepEqual([view(repo).model, view(repo).modelFrom], ['opus', 'team']);
  team('claude'); assert.deepEqual([view(repo).model, view(repo).modelFrom], ['haiku', 'clone']);
  set('--local', 'prism.claudeModel', null); assert.deepEqual([view(repo).model, view(repo).modelFrom], ['sonnet', 'global']);
  set('--global', 'prism.claudeModel', null); assert.deepEqual([view(repo).model, view(repo).modelFrom], ['default', 'tool default']);
  team('kiro', 'k-pin'); set('--local', 'prism.reviewer', 'claude'); set('--global', 'prism.claudeModel', 'sonnet');
  assert.deepEqual([view(repo).reviewer, view(repo).model, view(repo).modelFrom], ['claude', 'sonnet', 'global'], 'a pin for kiro does not apply when claude runs');
}));

test('global scope writes prism.reviewer too; Apply to all clears only local keys of the listed repos; the team file is untouched', withRepo((repo, git) => {
  applySetting(repo, git, { scope: 'global', reviewer: 'claude', model: 'sonnet' }, null);
  assert.deepEqual([get(repo, '--global', 'prism.reviewer'), get(repo, '--global', 'prism.claudeModel')], ['claude', 'sonnet']);
  const other = join(repo, '..', 'other'), skipped = join(repo, '..', 'skipped');
  for (const r of [other, skipped]) { mkdirSync(r); execFileSync('git', ['init', '-q', '-b', 'trunk', r]); }
  mkdirSync(join(repo, '.prism'));
  const teamText = JSON.stringify({ eval: { reviewer: 'kiro', model: 'k1' } });
  writeFileSync(join(repo, '.prism', 'config.json'), teamText);
  applySetting(repo, git, { scope: 'clone', reviewer: 'kiro', model: 'x1' }, null);
  applySetting(skipped, git, { scope: 'clone', reviewer: 'kiro' }, null);
  const changed = clearOverrides([repo, other], git);
  assert.deepEqual(changed, [repo], 'only a repo that had an override changed');
  assert.deepEqual([get(repo, '--local', 'prism.reviewer'), get(repo, '--local', 'prism.kiroModel')], [null, null]);
  assert.equal(get(skipped, '--local', 'prism.reviewer'), 'kiro', 'a repo not listed keeps its override');
  assert.equal(readFileSync(join(repo, '.prism', 'config.json'), 'utf8'), teamText, 'the team file is untouched');
  assert.deepEqual([get(repo, '--global', 'prism.reviewer'), get(repo, '--global', 'prism.claudeModel')], ['claude', 'sonnet'], 'your default stays');
  applySetting(repo, git, { scope: 'global', reset: true }, null);
  assert.deepEqual([get(repo, '--global', 'prism.reviewer'), get(repo, '--global', 'prism.claudeModel')], [null, null]);
}));

test('GET /api/codewatch/defaults: your default and the repos that override it, by id and ~ path', withRepo(async (repo, git) => {
  const { codewatchDefaults } = await import('../src/dashboard/codewatch-reviewer.js');
  applySetting(repo, git, { scope: 'global', reviewer: 'kiro', model: 'm1' }, null);
  const plain = join(repo, '..', 'plain');
  mkdirSync(plain); execFileSync('git', ['init', '-q', '-b', 'trunk', plain]);
  applySetting(repo, git, { scope: 'clone', model: 'own' }, 'kiro');
  const home = join(repo, '..');
  const d = await codewatchDefaults({ repoPaths: async () => [repo, plain], home, pathEnv: '' }) as any;
  assert.deepEqual(d.global, { reviewer: 'kiro', models: { kiro: 'm1', claude: null } });
  assert.deepEqual(d.overrides.map((o: any) => [o.id, o.path, o.reviewer, o.models.kiro]), [[repoId(repo), '~/repo', null, 'own']]);
  assert.equal(d.repoCount, 2);
  assert.match(d.precedence.reviewer, /^this repo's override .* then your default .* then the team file/);
}));
