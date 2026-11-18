/**
 * Tests for `prism-cli enable agent-hooks`: every case runs in a throwaway
 * home and repo directory, never the real ~/.kiro or ~/.claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASH_GUARD_IFS, claudeHooks, enableAgentHooks, KIRO_FILE, kiroHookFile, mergeClaude, withoutPrism, type AgentHooksDeps, type AgentHooksOptions } from '../src/commands/enable/harness-hooks.js';
import { PLUGIN_ID } from '../src/commands/enable/claude-code.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
let clock = Date.parse('2026-11-13T10:00:00Z');

function rig(over: Partial<AgentHooksDeps> = {}) {
  const out: string[] = [], err: string[] = [];
  const home = tmp('prism-ah-home-');
  const repo = tmp('prism-ah-repo-');
  const d: AgentHooksDeps = {
    home, env: { CLAUDE_CONFIG_DIR: join(home, 'cfg') }, repoRoot: repo, cli: 'prism-cli',
    log: (l = '') => out.push(l), error: (l) => err.push(l), now: () => new Date(clock += 1000), ...over,
  };
  const run = (o: AgentHooksOptions) => enableAgentHooks(o, d);
  return { d, out, err, home, repo, run, text: () => out.join('\n') + err.join('\n') };
}

const kiroPath = (dir: string) => join(dir, '.kiro', 'hooks', KIRO_FILE);
const readJ = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const backups = (dir: string, name: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(`${name}.bak-`)) : []);
const OTHER_KIRO = { name: 'lint', trigger: 'PostFileSave', action: { type: 'command', command: 'npx eslint --fix' } };

test('kiro: dry run writes nothing; install writes the five hooks; a second run changes nothing', () => {
  const x = rig();
  assert.equal(x.run({ client: 'kiro', dryRun: true }), 0);
  assert.ok(!existsSync(kiroPath(x.repo)));
  assert.match(x.text(), /Dry run: nothing was written/);

  assert.equal(x.run({ client: 'kiro' }), 0);
  const f = readJ(kiroPath(x.repo));
  assert.equal(f.version, 'v1');
  assert.deepEqual(f.hooks.map((h: any) => h.trigger), ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
  const pre = f.hooks[1];
  assert.equal(pre.matcher, '*', 'every tool opens a tool window (D6); shell calls also get the push check');
  assert.equal(pre.action.command, 'prism-cli codewatch hook --client kiro --event pre-tool');
  assert.equal(f.hooks[2].matcher, '*');
  assert.equal(f.hooks[2].action.command, 'prism-cli codewatch hook --client kiro --event post-tool');
  assert.ok(f.hooks.every((h: any) => h.timeout > 0 && h.timeout <= 300), 'explicit timeouts (Kiro default is 60 s)');
  assert.ok(pre.timeout * 1000 > 270_000, 'above prism-cli\'s own 270 s budget, so Kiro never kills a push check mid-run');
  assert.match(x.text(), /--agent-engine v3/);

  x.out.length = 0;
  assert.equal(x.run({ client: 'kiro' }), 0);
  assert.match(x.text(), /Already installed; nothing to do/);
  assert.deepEqual(backups(join(x.repo, '.kiro', 'hooks'), KIRO_FILE), [], 'idempotent: no backup, no write');
});

test('kiro: an outdated file is updated with a backup; status says installed, outdated, missing', () => {
  const x = rig();
  x.run({ client: 'kiro' });
  const old = kiroHookFile('/old/node /old/prism-cli.js');
  writeFileSync(kiroPath(x.repo), JSON.stringify(old));
  x.out.length = 0;
  x.run({ status: true, client: 'kiro' });
  assert.match(x.text(), /kiro \(project\): outdated/);
  assert.match(x.text(), /kiro \(global\): missing/);
  x.run({ client: 'kiro' });
  assert.equal(backups(join(x.repo, '.kiro', 'hooks'), KIRO_FILE).length, 1);
  assert.deepEqual(readJ(kiroPath(x.repo)), kiroHookFile('prism-cli'));
  x.out.length = 0;
  x.run({ status: true });
  assert.match(x.text(), /kiro \(project\): installed/);
  assert.match(x.text(), /claude \(project\): missing/);
  assert.match(x.text(), /cursor, codex: planned/);
});

test('kiro: refuses a prism-harness.json that holds other hooks without --force; --force replaces it after a backup', () => {
  const x = rig();
  mkdirSync(join(x.repo, '.kiro', 'hooks'), { recursive: true });
  writeFileSync(kiroPath(x.repo), JSON.stringify({ version: 'v1', hooks: [OTHER_KIRO] }));
  assert.equal(x.run({ client: 'kiro' }), 1);
  assert.match(x.text(), /Refusing to change it/);
  assert.deepEqual(readJ(kiroPath(x.repo)).hooks, [OTHER_KIRO], 'untouched');
  assert.equal(x.run({ client: 'kiro', force: true }), 0);
  assert.deepEqual(readJ(kiroPath(x.repo)), kiroHookFile('prism-cli'));
  const b = backups(join(x.repo, '.kiro', 'hooks'), KIRO_FILE);
  assert.equal(b.length, 1);
  assert.deepEqual(readJ(join(x.repo, '.kiro', 'hooks', b[0])).hooks, [OTHER_KIRO], 'the other hooks stay in the backup');
  assert.ok(!b[0].endsWith('.json'), 'a backup is not loaded by Kiro as a hook file');
});

test('kiro: uninstall removes a PRISM-only file, or only the PRISM entries of a mixed one', () => {
  const x = rig();
  x.run({ client: 'kiro' });
  assert.equal(x.run({ client: 'kiro', uninstall: true, dryRun: true }), 0);
  assert.ok(existsSync(kiroPath(x.repo)), 'dry run keeps it');
  assert.equal(x.run({ client: 'kiro', uninstall: true }), 0);
  assert.ok(!existsSync(kiroPath(x.repo)));
  assert.equal(backups(join(x.repo, '.kiro', 'hooks'), KIRO_FILE).length, 1);

  const mixed = kiroHookFile('prism-cli') as any;
  writeFileSync(kiroPath(x.repo), JSON.stringify({ ...mixed, hooks: [OTHER_KIRO, ...mixed.hooks] }));
  x.run({ client: 'kiro', uninstall: true });
  assert.deepEqual(readJ(kiroPath(x.repo)).hooks, [OTHER_KIRO]);
  x.out.length = 0;
  assert.equal(x.run({ client: 'kiro', uninstall: true }), 0);
  assert.match(x.text(), /No PRISM Kiro hooks/);
});

test('kiro --global writes ~/.kiro/hooks and warns when the project has the file too (both would run)', () => {
  const x = rig();
  x.run({ client: 'kiro' });
  x.out.length = 0;
  assert.equal(x.run({ client: 'kiro', global: true }), 0);
  assert.ok(existsSync(kiroPath(x.home)));
  assert.match(x.text(), /each check would run twice/);
  const out = rig({ repoRoot: null });
  assert.equal(out.run({ client: 'kiro' }), 1, 'project scope needs a repo');
  assert.equal(out.run({ client: 'kiro', global: true }), 0);
});

test('claude: merges the plugin\'s hooks into settings.json, keeping other hooks and keys; idempotent; uninstall leaves the rest', () => {
  const x = rig();
  const settingsPath = join(x.repo, '.claude', 'settings.json');
  mkdirSync(join(x.repo, '.claude'));
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: './audit.sh' }] };
  writeFileSync(settingsPath, JSON.stringify({ model: 'opus', hooks: { PreToolUse: [mine], Notification: [{ hooks: [{ type: 'command', command: 'say hi' }] }] }, env: { A: '1' } }));
  assert.equal(x.run({ client: 'claude' }), 0);
  const s = readJ(settingsPath);
  assert.deepEqual(Object.keys(s), ['model', 'hooks', 'env'], 'key order kept');
  assert.deepEqual(s.hooks.PreToolUse[0], mine, 'the user\'s hook first, untouched');
  const ours = s.hooks.PreToolUse[1];
  assert.deepEqual(ours.hooks.map((h: any) => h.if), ['Bash(*git*push*)', ...BASH_GUARD_IFS], 'the plugin\'s if rules');
  assert.equal(ours.hooks[0].command, 'prism-cli codewatch hook --client claude --event pre-push');
  for (const ev of ['SessionStart', 'Stop', 'SubagentStop', 'SessionEnd']) assert.ok(s.hooks[ev], ev);
  assert.ok(s.hooks.Notification, 'other events kept');
  assert.equal(backups(join(x.repo, '.claude'), 'settings.json').length, 1);

  x.out.length = 0;
  x.run({ client: 'claude' });
  assert.match(x.text(), /Already installed/);
  assert.deepEqual(readJ(settingsPath), s);

  x.run({ client: 'claude', uninstall: true });
  assert.deepEqual(readJ(settingsPath), { model: 'opus', hooks: { PreToolUse: [mine], Notification: [{ hooks: [{ type: 'command', command: 'say hi' }] }] }, env: { A: '1' } });
});

test('claude: an installed PRISM plugin is detected and the install is skipped (no double hooks)', () => {
  for (const [version, msg] of [['0.3.0', /already runs these hooks/], ['0.1.0', /predates the harness hooks/]] as const) {
    const x = rig();
    const cfg = join(x.home, 'cfg');
    mkdirSync(join(cfg, 'plugins'), { recursive: true });
    writeFileSync(join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { [PLUGIN_ID]: [{ version }] } }));
    assert.equal(x.run({ client: 'claude', global: true }), 0);
    assert.match(x.text(), msg);
    assert.ok(!existsSync(join(cfg, 'settings.json')), 'nothing written');
    x.out.length = 0;
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }));
    x.run({ client: 'claude', global: true });
    assert.ok(readJ(join(cfg, 'settings.json')).hooks, 'a disabled plugin runs no hooks: install');
  }
});

test('merge helpers: PRISM entries found by command, an outdated PRISM entry is replaced, not duplicated', () => {
  const old = mergeClaude({}, claudeHooks('/old/prism-cli'));
  const next = mergeClaude(old, claudeHooks('prism-cli'));
  assert.deepEqual(next, mergeClaude({}, claudeHooks('prism-cli')));
  assert.deepEqual(withoutPrism(next), {});
  assert.deepEqual(withoutPrism({ Stop: [{ hooks: [] }] }), { Stop: [{ hooks: [] }] }, 'a group that was already empty is kept');
  assert.deepEqual(withoutPrism({ Stop: [] }), { Stop: [] }, 'an event that was already empty is kept');
  const chained = { Stop: [{ hooks: [{ type: 'command', command: './pre.sh && prism-cli codewatch hook --client claude --event stop' }] }] };
  assert.deepEqual(withoutPrism(chained), chained, 'a user hook that chains the PRISM command is the user\'s');
  const after = { Stop: [{ hooks: [{ type: 'command', command: 'prism-cli codewatch hook --client claude --event stop && ./post.sh' }] }] };
  assert.deepEqual(withoutPrism(after), after, 'also when it chains after it');
  const quoted = { Stop: [{ hooks: [{ type: 'command', command: "'/opt/n/node' '/opt/p/prism-cli.js' codewatch hook --client claude --event stop" }] }] };
  assert.deepEqual(withoutPrism(quoted), {}, 'the absolute node form is PRISM\'s');
});

test('cursor and codex are planned; an unknown client and a missing --client are errors', () => {
  const x = rig();
  assert.equal(x.run({ client: 'cursor' }), 1);
  assert.match(x.text(), /planned/);
  assert.equal(x.run({ client: 'codex', status: true }), 1);
  assert.equal(x.run({ client: 'vim' }), 1);
  assert.equal(x.run({}), 1);
  assert.equal(x.run({ status: true }), 0, '--status alone covers every client');
});

test('invalid JSON in a hook file is reported and nothing is changed', () => {
  const x = rig();
  mkdirSync(join(x.repo, '.kiro', 'hooks'), { recursive: true });
  writeFileSync(kiroPath(x.repo), '{ nope');
  assert.equal(x.run({ client: 'kiro' }), 1);
  assert.match(x.text(), /is not valid JSON/);
  assert.equal(readFileSync(kiroPath(x.repo), 'utf8'), '{ nope');
});

test('claude: a "hooks" value that is not an object is refused by install, uninstall and status alike', () => {
  const x = rig();
  const p = join(x.repo, '.claude', 'settings.json');
  mkdirSync(join(x.repo, '.claude'));
  writeFileSync(p, JSON.stringify({ hooks: [{ command: 'prism-cli codewatch hook --client claude --event stop' }] }));
  const before = readFileSync(p, 'utf8');
  assert.equal(x.run({ client: 'claude' }), 1);
  assert.equal(x.run({ client: 'claude', uninstall: true }), 1);
  assert.match(x.text(), /"hooks" is not an object/);
  assert.equal(readFileSync(p, 'utf8'), before, 'the file shape is never changed');
  x.run({ status: true, client: 'claude' });
  assert.match(x.text(), /claude \(project\): unreadable/);
});

test('a project file always calls prism-cli (it is committed and shared); --global writes this machine\'s path', () => {
  const abs = "'/opt/node/bin/node' '/opt/prism/dist/bin/prism-cli.js'";
  const x = rig({ cli: abs });
  x.run({ client: 'kiro' });
  assert.deepEqual(readJ(kiroPath(x.repo)), kiroHookFile('prism-cli'));
  assert.match(x.text(), /not on the system PATH/);
  x.run({ client: 'kiro', global: true });
  assert.deepEqual(readJ(kiroPath(x.home)), kiroHookFile(abs));
  x.out.length = 0;
  x.run({ status: true, client: 'kiro' });
  assert.match(x.text(), /kiro \(project\): installed/);
  assert.match(x.text(), /kiro \(global\): installed/);
});

test('claude: the settings hooks have the same events, if rules and handlers as the plugin ships', () => {
  const plugin = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'claude-plugin', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const ours = claudeHooks('prism-cli') as Record<string, any>;
  const shape = (groups: any[], ev: (h: any) => string) => groups.map((g) => ({ matcher: g.matcher, hooks: g.hooks.map((h: any) => [h.if ?? null, ev(h)]) }));
  for (const event of ['Stop', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'SessionEnd']) {
    assert.deepEqual(shape(ours[event], (h) => h.command.split(' ').pop()), shape(plugin[event], (h) => h.args[1]), event);
  }
  assert.ok(ours.PreToolUse[0].hooks.some((h: any) => h.if === 'Bash(*git*ref*)'), 'the ref-move guard reaches the hook');
});

test('the command is still `enable agent-hooks` although its file is harness-hooks.ts', () => {
  const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), join(cliDir, 'bin', 'prism-cli.ts'), ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const help = run('enable', 'agent-hooks', '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: prism-cli enable agent-hooks/);
  assert.match(help.stdout, /--client <client>/);
  // The group listing (`enable --help`) needs the built .js files, so it is checked against dist in the release build, not here.
  assert.doesNotMatch(run('enable', 'harness-hooks', '--help').stdout, /Usage: prism-cli enable harness-hooks/, 'the file name is not a command');
});

// ---- the steering note (~/.kiro/steering/prism-codewatch.md), written by --client kiro too ----

const MARK = '<!-- prism-codewatch steering: installed by prism-cli enable kirocrew -->';
const NOTE = `---\ninclusion: always\n---\n${MARK}\n\n# PRISM codewatch\n`;
const notePath = (home: string) => join(home, '.kiro', 'steering', 'prism-codewatch.md');
const putNote = (home: string, t: string) => { mkdirSync(dirname(notePath(home)), { recursive: true }); writeFileSync(notePath(home), t); };

test('kiro steering: dry run shows it; install writes it (also when the hooks are already current); claude does not', () => {
  const x = rig({ steeringNote: () => NOTE });
  assert.equal(x.run({ client: 'kiro', dryRun: true }), 0);
  assert.match(x.text(), /would write the steering note ~\/\.kiro\/steering\/prism-codewatch\.md/);
  assert.ok(!existsSync(notePath(x.home)));
  assert.equal(x.run({ client: 'kiro' }), 0);
  assert.equal(readFileSync(notePath(x.home), 'utf8'), NOTE);
  // Hooks already installed, our note older: re-running updates only the note.
  putNote(x.home, `${MARK}\nold\n`);
  x.out.length = 0;
  assert.equal(x.run({ client: 'kiro' }), 0);
  assert.match(x.text(), /Already installed; nothing to do[\s\S]*✓ Updated the steering note/);
  assert.equal(readFileSync(notePath(x.home), 'utf8'), NOTE);
  const c = rig({ steeringNote: () => NOTE });
  c.run({ client: 'claude' });
  assert.ok(!existsSync(notePath(c.home)), 'claude has no use for ~/.kiro steering');
});

test('kiro steering: a file without the marker is left alone; --uninstall --global removes ours only, project --uninstall keeps it', () => {
  const x = rig({ steeringNote: () => NOTE });
  putNote(x.home, 'my rules\n');
  assert.equal(x.run({ client: 'kiro' }), 0);
  assert.match(x.text(), /exists without the prism-cli marker; it is yours and is left as it is/);
  assert.equal(x.run({ client: 'kiro', uninstall: true, global: true }), 0);
  assert.equal(readFileSync(notePath(x.home), 'utf8'), 'my rules\n');

  const y = rig({ steeringNote: () => NOTE });
  y.run({ client: 'kiro' });
  y.out.length = 0;
  y.run({ client: 'kiro', uninstall: true });
  assert.ok(existsSync(notePath(y.home)));
  assert.match(y.text(), /is kept: it is global/);
  y.run({ client: 'kiro', uninstall: true, global: true, dryRun: true });
  assert.ok(existsSync(notePath(y.home)));
  // The PRISM Kiro Crew app is installed: it uses the same note, so it stays.
  mkdirSync(join(y.home, '.kiro', 'crew', 'apps', 'prism'), { recursive: true });
  writeFileSync(join(y.home, '.kiro', 'crew', 'apps', 'prism', 'installed.json'), JSON.stringify({ version: '0.4.1' }));
  y.out.length = 0;
  y.run({ client: 'kiro', uninstall: true, global: true });
  assert.ok(existsSync(notePath(y.home)));
  assert.match(y.text(), /the PRISM Kiro Crew app uses it too/);
  rmSync(join(y.home, '.kiro', 'crew'), { recursive: true });
  y.run({ client: 'kiro', uninstall: true, global: true });
  assert.ok(!existsSync(notePath(y.home)));
});

test('kiro steering: no bundled note: a missing note is reported, nothing is written', () => {
  const x = rig({ steeringNote: () => null });
  assert.equal(x.run({ client: 'kiro' }), 0);
  assert.match(x.text(), /Steering note ~\/\.kiro\/steering\/prism-codewatch\.md is missing: this prism-cli has no bundled note/);
  assert.ok(!existsSync(notePath(x.home)));
});

test('kiro steering: --status and the dashboard status report its state', async () => {
  const { agentHookStatus } = await import('../src/commands/enable/harness-hooks.js');
  const x = rig({ steeringNote: () => NOTE });
  assert.equal(agentHookStatus({ ...x.d }).steering, 'missing');
  x.run({ status: true, client: 'kiro' });
  assert.match(x.text(), /kiro steering note: missing \(~\/\.kiro\/steering\/prism-codewatch\.md\)/);
  putNote(x.home, NOTE);
  assert.equal(agentHookStatus({ ...x.d }).steering, 'installed');
  putNote(x.home, `${MARK}\nold\n`);
  assert.equal(agentHookStatus({ ...x.d }).steering, 'outdated');
  putNote(x.home, 'mine\n');
  assert.equal(agentHookStatus({ ...x.d }).steering, 'user-owned');
});

test('kiro steering: Needs you has one item for an outdated or missing note when the kiro hooks are installed (and the Kiro Crew app is not)', async () => {
  const { needsYou } = await import('../src/dashboard/needs-you.js');
  const base = { machine: [], setup: [], suggestions: [], version: { installed: '1.0.0', latest: null, update: false } };
  const hooks = (state: any, steering: any) => ({ rows: [{ client: 'kiro' as const, scope: 'global' as const, state, path: null, others: 0, error: null }], plugin: { active: false, version: null, outdated: false }, steering });
  const items = needsYou({ ...base, agentHooks: hooks('installed', 'missing') });
  assert.deepEqual(items.map((i) => [i.tab, i.fixes]), [['agents', ['prism-cli enable agent-hooks --client kiro --global']]]);
  assert.match(items[0].text, /Kiro steering note ~\/\.kiro\/steering\/prism-codewatch\.md is missing/);
  assert.equal(needsYou({ ...base, agentHooks: hooks('installed', 'user-owned') }).length, 0);
  assert.equal(needsYou({ ...base, agentHooks: hooks('missing', 'missing') }).length, 0, 'no kiro hooks: nothing points at the note');
  // With the Kiro Crew app row present, only its item shows (one item, not two).
  const row = { id: 'kirocrew-steering', label: 'Kiro Crew steering note', status: 'info' as const, detail: 'missing: x', fix: 'prism-cli enable kirocrew' };
  assert.deepEqual(needsYou({ ...base, machine: [row], agentHooks: hooks('installed', 'missing') }).map((i) => i.fixes[0]), ['prism-cli enable kirocrew']);
});
