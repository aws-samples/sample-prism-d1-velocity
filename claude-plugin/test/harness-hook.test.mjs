// Unit tests for the harness hook pass-through and the hook wiring. Run: node --test claude-plugin/test/
// The engine and the Claude Code adapter are tested in cli/test/harness.test.ts; here prism-cli is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, runHook } from '../scripts/harness-hook.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

/** A fake prism-cli that records its argv and stdin, and prints `out`. */
function fakeCli(out, exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-plugin-cli-'));
  const p = join(dir, 'prism-cli');
  writeFileSync(p, `#!/bin/sh\necho "$@" > '${dir}/argv'\ncat > '${dir}/stdin'\nprintf '%s' '${out}'\nexit ${exit}\n`);
  chmodSync(p, 0o755);
  return { p, dir };
}

test('passes stdin and the event to prism-cli codewatch hook and returns its JSON', { skip: isWin }, () => {
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } });
  const { p, dir } = fakeCli(deny);
  const out = runHook('pre-push', '{"session_id":"s"}', { ...process.env, PRISM_CLI: p });
  assert.deepEqual(JSON.parse(out), JSON.parse(deny));
  assert.equal(readFileSync(join(dir, 'argv'), 'utf8').trim(), 'codewatch hook --client claude --event pre-push');
  assert.equal(readFileSync(join(dir, 'stdin'), 'utf8'), '{"session_id":"s"}');
});

test('no decision on a failing, missing or chatty prism-cli', { skip: isWin }, () => {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'prism-plugin-data-')) };
  assert.ok(!runHook('stop', '{}', { ...env, PRISM_CLI: fakeCli('{"decision":"block","reason":"x"}', 1).p }).includes('decision'));
  assert.ok(!runHook('stop', '{}', { ...env, PRISM_CLI: join(tmpdir(), 'no-such-prism-cli') }).includes('decision'));
  assert.equal(runHook('stop', '{}', { ...env, PRISM_CLI: fakeCli('not json').p }), '');
  assert.equal(runHook('stop', '{}', { ...env, PRISM_CLI: fakeCli('[1]').p }), '');
});

/** A fake prism-cli of a given version that has no `codewatch hook` (commander's unknown-command exit 1). */
function oldCli(version) {
  const dir = mkdtempSync(join(tmpdir(), 'prism-plugin-old-'));
  const p = join(dir, 'prism-cli');
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\ncat >/dev/null\necho "error: unknown command 'hook'" >&2\nexit 1\n`);
  chmodSync(p, 0o755);
  return p;
}

const sessionEnv = (cli) => ({ ...process.env, PRISM_CLI: cli, CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'prism-plugin-data-')) });
const input = (sid) => JSON.stringify({ session_id: sid, cwd: tmpdir() });

test('an old prism-cli: one systemMessage per session naming both versions, never a decision', { skip: isWin }, () => {
  const env = sessionEnv(oldCli('1.10.1'));
  const first = JSON.parse(runHook('pre-push', input('s-1'), env));
  assert.deepEqual(Object.keys(first), ['systemMessage']);
  assert.equal(first.systemMessage, 'PRISM push check is off: prism-cli 1.11.0 or later is needed (found 1.10.1). Run npm i -g @prism-d1/cli@latest.');
  assert.equal(runHook('pre-push', input('s-1'), env), '', 'second push in the session: silent');
  assert.equal(runHook('stop', input('s-1'), env), '', 'other events in the session: silent');
  assert.match(JSON.parse(runHook('session-start', input('s-2'), env)).systemMessage, /found 1\.10\.1/, 'a new session warns again');
});

test('SessionStart with an old prism-cli says so once', { skip: isWin }, () => {
  const env = sessionEnv(oldCli('1.9.0'));
  assert.match(JSON.parse(runHook('session-start', input('s'), env)).systemMessage, /^PRISM push and finish checks are off: prism-cli 1\.11\.0 or later is needed \(found 1\.9\.0\)/);
  assert.equal(runHook('pre-push', input('s'), env), '');
});

test('a missing prism-cli: one systemMessage per session', { skip: isWin }, () => {
  const env = sessionEnv(join(tmpdir(), 'no-such-prism-cli'));
  assert.match(JSON.parse(runHook('pre-push', input('m'), env)).systemMessage, /^PRISM push check is off: prism-cli is not on the PATH/);
  assert.equal(runHook('pre-push', input('m'), env), '');
});

test('a working prism-cli: no warning, and no version probe', { skip: isWin }, () => {
  const { p, dir } = fakeCli('');
  const env = sessionEnv(p);
  assert.equal(runHook('pre-push', input('ok'), env), '');
  assert.equal(readFileSync(join(dir, 'argv'), 'utf8').trim(), 'codewatch hook --client claude --event pre-push');
  assert.throws(() => readdirSync(join(env.CLAUDE_PLUGIN_DATA, 'harness-notices')), 'no notice state written');
});

test('a current prism-cli whose hook fails says it failed, not that it is old', { skip: isWin }, () => {
  const env = sessionEnv(oldCli('1.11.0'));
  assert.equal(JSON.parse(runHook('stop', input('f'), env)).systemMessage, 'PRISM finish check is off: prism-cli codewatch hook failed (exit 1), so no decision was made.');
});

test('session-start.mjs reports the manifest version', async () => {
  const { PLUGIN_VERSION } = await import('../scripts/session-start.mjs');
  assert.equal(PLUGIN_VERSION, JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version);
});

test('unknown events and reviewer children do nothing', () => {
  const { p, dir } = fakeCli('{"decision":"block","reason":"x"}');
  assert.equal(runHook('pre-commit', '{}', { ...process.env, PRISM_CLI: p }), '');
  assert.equal(runHook('stop', '{}', { ...process.env, PRISM_CLI: p, PRISM_HARNESS_CHILD: '1' }), '');
  assert.throws(() => readFileSync(join(dir, 'argv')), 'prism-cli was not started');
});

test('hooks.json wires every harness event through harness-hook.mjs with enough time', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const harness = (group) => group.flatMap((g) => g.hooks).filter((h) => h.args?.[0]?.endsWith('/scripts/harness-hook.mjs'));
  const ev = (name) => harness(hooks[name]).map((h) => h.args[1]);
  assert.deepEqual(ev('SessionStart'), ['session-start']);
  assert.deepEqual(ev('Stop'), ['stop']);
  assert.deepEqual(ev('SubagentStop'), ['stop']);
  assert.deepEqual(ev('SessionEnd'), ['session-end']);
  const pre = hooks.PreToolUse.find((g) => g.matcher === 'Bash');
  assert.ok(pre.hooks.some((h) => h.if === 'Bash(git push*)' && h.args[1] === 'pre-push'));
  for (const h of [...harness(hooks.Stop), ...pre.hooks.filter((x) => x.if === 'Bash(git push*)')]) assert.ok(h.timeout >= 300, 'above the engine worst case');
  for (const name of Object.keys(hooks)) for (const h of harness(hooks[name])) assert.ok(EVENTS.has(h.args[1]), h.args[1]);
  // The original SessionStart summary hook stays.
  assert.ok(hooks.SessionStart[0].hooks.some((h) => h.args[0].endsWith('/scripts/session-start.mjs')));
});

test('plugin options: finish gate off and push gate on by default', () => {
  const m = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(m.version, '0.3.0');
  assert.deepEqual([m.userConfig.finish_gate.type, m.userConfig.finish_gate.default], ['boolean', false]);
  assert.deepEqual([m.userConfig.push_gate.type, m.userConfig.push_gate.default], ['boolean', true]);
});
