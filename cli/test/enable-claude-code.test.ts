/**
 * Tests for `prism-cli enable claude-code`: every case runs against a
 * throwaway CLAUDE_CONFIG_DIR or home, never the real ~/.claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_PREFIX, configDir, enableClaudeCode, globalConfigFile, isPrismStatusLine, lineDiff, mcpServers, pluginState, shQuote, statuslineCommand, withStatusLine,
  type ClaudeCodeDeps, type ClaudeCodeOptions,
} from '../src/commands/enable/claude-code.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const CMD = 'prism-cli statusline';
const OURS = { type: 'command', command: CMD, refreshInterval: 60 };
const OTHER = { type: 'command', command: '~/.claude/my-line.sh', padding: 1 };

let clock = Date.parse('2026-11-12T10:00:00Z');

function deps(over: Partial<ClaudeCodeDeps> = {}) {
  const out: string[] = [], err: string[] = [];
  const home = over.home ?? tmp('prism-cc-home-');
  const d: ClaudeCodeDeps = {
    home, env: { CLAUDE_CONFIG_DIR: join(home, 'cfg') }, cwd: home, command: CMD, isTTY: false,
    ask: async () => 'n', log: (l = '') => out.push(l), error: (l) => err.push(l), now: () => new Date(clock += 1000), ...over,
  };
  return { d, out, err, dir: configDir(d.env, d.home) };
}

function settings(dir: string, obj: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(obj, null, 2) + '\n');
  chmodSync(join(dir, 'settings.json'), 0o644);
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
const backups = (dir: string) => readdirSync(dir).filter((n) => n.startsWith(BACKUP_PREFIX)).sort();
const run = (o: ClaudeCodeOptions, x: ReturnType<typeof deps>) => enableClaudeCode(o, x.d);

test('config dir: CLAUDE_CONFIG_DIR, else ~/.claude; global config beside it', () => {
  assert.equal(configDir({}, '/h'), '/h/.claude');
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/c');
  assert.equal(globalConfigFile({}, '/h'), '/h/.claude.json');
  assert.equal(globalConfigFile({ CLAUDE_CONFIG_DIR: '/c' }, '/h'), '/c/.claude.json');
});

test('fresh: creates settings.json (0600) with the statusLine; no backup needed', async () => {
  const x = deps();
  assert.equal(await run({ yes: true }, x), 0);
  assert.deepEqual(read(x.dir), { statusLine: OURS });
  assert.equal(statSync(join(x.dir, 'settings.json')).mode & 0o777, 0o600);
  assert.deepEqual(backups(x.dir), []);
  assert.ok(x.out.some((l) => l.includes('/plugin install prism@prism-d1-velocity')), 'plugin hint');
});

test('existing file: other keys kept in order, backup written, mode kept', async () => {
  const x = deps();
  const before = { model: 'opus', hooks: { SessionStart: [] }, enabledPlugins: { 'a@b': true }, env: { A: '1' } };
  settings(x.dir, before);
  assert.equal(await run({ yes: true }, x), 0);
  const after = read(x.dir);
  assert.deepEqual(Object.keys(after), ['model', 'hooks', 'enabledPlugins', 'env', 'statusLine']);
  assert.deepEqual({ ...after, statusLine: undefined }, { ...before, statusLine: undefined });
  const b = backups(x.dir);
  assert.equal(b.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(x.dir, b[0]), 'utf8')), before);
  assert.equal(statSync(join(x.dir, b[0])).mode & 0o777, 0o600);
  assert.equal(statSync(join(x.dir, 'settings.json')).mode & 0o777, 0o644);
  assert.ok(x.out.some((l) => l.includes('+ ') && l.includes('"statusLine"')), 'diff shown');
  // Re-running is a no-op.
  assert.equal(await run({ yes: true }, x), 0);
  assert.equal(backups(x.dir).length, 1);
  assert.ok(x.out.some((l) => l.includes('already set')));
});

test('another statusLine: shown and refused without --replace; nothing written', async () => {
  const x = deps();
  settings(x.dir, { statusLine: OTHER });
  assert.equal(await run({ yes: true }, x), 1);
  assert.deepEqual(read(x.dir), { statusLine: OTHER });
  assert.deepEqual(backups(x.dir), []);
  assert.ok(x.out.some((l) => l.includes('my-line.sh')), 'existing one shown');
  assert.ok(x.err.some((l) => l.includes('--replace')));
});

test('--replace backs the other one up; --uninstall restores it', async () => {
  const x = deps();
  settings(x.dir, { model: 'opus', statusLine: OTHER });
  assert.equal(await run({ yes: true, replace: true }, x), 0);
  assert.deepEqual(read(x.dir), { model: 'opus', statusLine: OURS });
  const b = backups(x.dir);
  assert.equal(b.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(x.dir, b[0]), 'utf8')).statusLine, OTHER);
  assert.equal(await run({ yes: true, uninstall: true }, x), 0);
  assert.deepEqual(read(x.dir), { model: 'opus', statusLine: OTHER });
  // Uninstall again: not ours, left alone.
  assert.equal(await run({ yes: true, uninstall: true }, x), 0);
  assert.deepEqual(read(x.dir), { model: 'opus', statusLine: OTHER });
});

test('--uninstall with nothing replaced removes only statusLine', async () => {
  const x = deps();
  settings(x.dir, { model: 'opus' });
  await run({ yes: true }, x);
  // An update of our own line in between must not hide the original state.
  x.d.command = '/usr/bin/node /opt/prism/dist/bin/prism-cli.js statusline';
  await run({ yes: true }, x);
  assert.equal(await run({ yes: true, uninstall: true }, x), 0);
  assert.deepEqual(read(x.dir), { model: 'opus' });
});

test('--dry-run writes nothing, for install and uninstall', async () => {
  const x = deps();
  assert.equal(await run({ dryRun: true }, x), 0);
  assert.equal(existsSync(join(x.dir, 'settings.json')), false);
  settings(x.dir, { statusLine: OURS });
  const before = readFileSync(join(x.dir, 'settings.json'), 'utf8');
  assert.equal(await run({ dryRun: true, uninstall: true }, x), 0);
  assert.equal(readFileSync(join(x.dir, 'settings.json'), 'utf8'), before);
  assert.deepEqual(backups(x.dir), []);
});

test('no terminal and no --yes: refuses; a "no" answer on a terminal changes nothing', async () => {
  const x = deps();
  assert.equal(await run({}, x), 1);
  assert.ok(x.err.some((l) => l.includes('--yes')));
  assert.equal(existsSync(join(x.dir, 'settings.json')), false);
  const y = deps({ isTTY: true, ask: async () => 'n' });
  assert.equal(await run({}, y), 1);
  assert.equal(existsSync(join(y.dir, 'settings.json')), false);
  const z = deps({ isTTY: true, ask: async () => 'y' });
  assert.equal(await run({}, z), 0);
  assert.deepEqual(read(z.dir).statusLine, OURS);
});

test('without CLAUDE_CONFIG_DIR it writes ~/.claude/settings.json under the given home', async () => {
  const home = tmp('prism-cc-home-');
  const x = deps({ home, env: {} });
  assert.equal(await run({ yes: true }, x), 0);
  assert.deepEqual(read(join(home, '.claude')).statusLine, OURS);
});

test('invalid settings JSON: error, nothing written', async () => {
  const x = deps();
  mkdirSync(x.dir, { recursive: true });
  writeFileSync(join(x.dir, 'settings.json'), '{ "a": 1, // comment\n}');
  assert.equal(await run({ yes: true }, x), 1);
  assert.match(x.err.join('\n'), /not valid JSON/);
  assert.equal(readFileSync(join(x.dir, 'settings.json'), 'utf8'), '{ "a": 1, // comment\n}');
});

test('--status: status line, plugin and MCP server, read-only', async () => {
  const x = deps();
  settings(x.dir, { statusLine: OURS, enabledPlugins: { 'prism@prism-d1-velocity': true } });
  mkdirSync(join(x.dir, 'plugins'));
  writeFileSync(join(x.dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'prism@prism-d1-velocity': [{ scope: 'user', version: '0.2.0' }] } }));
  writeFileSync(join(x.dir, '.claude.json'), JSON.stringify({ mcpServers: { prism: { command: 'prism-cli', args: ['mcp'] } } }));
  const before = readFileSync(join(x.dir, 'settings.json'), 'utf8');
  assert.equal(await run({ status: true }, x), 0);
  const out = x.out.join('\n');
  assert.match(out, /Status line:\s+PRISM: prism-cli statusline/);
  assert.match(out, /Plugin:\s+prism@prism-d1-velocity 0\.2\.0/);
  assert.match(out, /user scope: prism/);
  assert.match(out, /listed twice/);
  assert.doesNotMatch(out, /\/plugin install/);
  assert.equal(readFileSync(join(x.dir, 'settings.json'), 'utf8'), before);
  assert.deepEqual(backups(x.dir), []);
});

test('helpers: prism detection, key placement, diff, quoting, plugin and MCP readers', () => {
  assert.ok(isPrismStatusLine(OURS));
  assert.ok(isPrismStatusLine({ command: "'/a b/node' '/x/dist/bin/prism-cli.js' statusline --no-session" }));
  assert.ok(!isPrismStatusLine(OTHER));
  assert.deepEqual(Object.keys(withStatusLine({ a: 1, statusLine: OTHER, b: 2 }, OURS)), ['a', 'statusLine', 'b']);
  assert.deepEqual(withStatusLine({ a: 1, statusLine: OTHER }, null), { a: 1 });
  assert.deepEqual(lineDiff('a\nb\n', 'a\nc\n', 'f').slice(2), ['  a', '- b', '+ c']);
  assert.equal(shQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(shQuote("/a b/it's"), `'/a b/it'\\''s'`);
  assert.deepEqual(pluginState(tmp('x-'), {}), { installed: false, enabled: null, version: null });
  assert.deepEqual(mcpServers('/nonexistent', '/nonexistent'), []);
});

test('statuslineCommand: absolute node and entry when prism-cli is not on the system PATH', () => {
  const c = statuslineCommand({ ownPackageDir: tmp('pkg-'), execPath: '/home/u/.nvm/versions/node/v22/bin/node', entry: '/home/u/.nvm/x/dist/bin/prism-cli.js', systemPath: tmp('empty-') });
  assert.equal(c, '/home/u/.nvm/versions/node/v22/bin/node /home/u/.nvm/x/dist/bin/prism-cli.js statusline');
});
