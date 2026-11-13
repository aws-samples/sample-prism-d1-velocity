/**
 * Tests for `prism-cli enable agent-hooks`: every case runs in a throwaway
 * home and repo directory, never the real ~/.kiro or ~/.claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeHooks, enableAgentHooks, KIRO_FILE, kiroHookFile, mergeClaude, withoutPrism, type AgentHooksDeps, type AgentHooksOptions } from '../src/commands/enable/agent-hooks.js';
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

test('kiro: dry run writes nothing; install writes the four hooks; a second run changes nothing', () => {
  const x = rig();
  assert.equal(x.run({ client: 'kiro', dryRun: true }), 0);
  assert.ok(!existsSync(kiroPath(x.repo)));
  assert.match(x.text(), /Dry run: nothing was written/);

  assert.equal(x.run({ client: 'kiro' }), 0);
  const f = readJ(kiroPath(x.repo));
  assert.equal(f.version, 'v1');
  assert.deepEqual(f.hooks.map((h: any) => h.trigger), ['SessionStart', 'PreToolUse', 'Stop', 'SessionEnd']);
  const pre = f.hooks[1];
  assert.equal(pre.matcher, 'shell', 'shell matches execute_bash');
  assert.equal(pre.action.command, 'prism-cli codewatch hook --client kiro --event pre-push');
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
  assert.deepEqual(ours.hooks.map((h: any) => h.if), ['Bash(*git*push*)', 'Bash(*git*config*)', 'Bash(*git*-c*)'], 'the plugin\'s if rules');
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
