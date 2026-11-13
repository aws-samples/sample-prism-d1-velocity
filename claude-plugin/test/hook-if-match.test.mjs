// Every command form prism-cli's push tokenizer understands must reach the PreToolUse hook,
// which Claude Code only starts when a handler's `if` rule matches. Run: node --test claude-plugin/test/
//
// The matcher below follows Claude Code's documented semantics for Bash `if` rules
// (https://code.claude.com/docs/en/hooks#how-if-patterns-match-bash-commands and
// https://code.claude.com/docs/en/permissions#wildcard-patterns):
//  - the command is split into subcommands on && || ; | |& & and newlines, and each is checked;
//  - commands inside $() and backticks are checked too;
//  - leading VAR=value assignments are stripped, and the wrappers timeout, time, nice, nohup,
//    stdbuf, command, builtin, noglob and bare xargs;
//  - `*` matches any sequence of characters, anywhere in the rule; a trailing ` *` that is the
//    rule's only wildcard also matches the bare command.
// `env`, `sh -c` and a path such as /usr/bin/git are NOT stripped, which is why the rules start with `*`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
const bash = hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks;
const rulesFor = (event) => bash.filter((h) => h.args?.[1] === event).map((h) => h.if);

/** Quote-aware split into subcommands, plus the bodies of $() and backticks. */
export function subcommands(cmd) {
  const out = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = ''; else if (c === '\\' && q === '"') cur += cmd[++i] ?? ''; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '$' && cmd[i + 1] === '(') {
      let depth = 0; let j = i + 1;
      for (; j < cmd.length; j++) { if (cmd[j] === '(') depth++; else if (cmd[j] === ')' && --depth === 0) break; }
      out.push(...subcommands(cmd.slice(i + 2, j)));
      cur += cmd.slice(i, j + 1); i = j; continue;
    }
    if (c === '`') { const j = cmd.indexOf('`', i + 1); if (j > i) { out.push(...subcommands(cmd.slice(i + 1, j))); cur += cmd.slice(i, j + 1); i = j; continue; } }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '|&') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const WRAPPERS = new Set(['time', 'nohup', 'command', 'builtin', 'noglob']);

/** Leading assignments and the documented wrappers removed. */
export function stripped(sub) {
  const w = sub.split(/\s+/);
  for (;;) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] ?? '')) { w.shift(); continue; }
    if (WRAPPERS.has(w[0]) && !(w[0] === 'command' && w[1] === '-v')) { w.shift(); continue; }
    if (w[0] === 'timeout') { w.shift(); while (w[0]?.startsWith('-')) w.shift(); w.shift(); continue; }
    if (w[0] === 'nice') { w.shift(); if (w[0] === '-n') w.splice(0, 2); else if (/^-\d+$/.test(w[0] ?? '')) w.shift(); continue; }
    if (w[0] === 'stdbuf') { w.shift(); while (w[0]?.startsWith('-')) w.shift(); continue; }
    if (w[0] === 'xargs' && w[1] && !w[1].startsWith('-')) { w.shift(); continue; }
    break;
  }
  return w.join(' ');
}

/** Does one `Bash(spec)` rule match one subcommand? */
export function ruleMatches(rule, sub) {
  const spec = /^Bash\((.*)\)$/s.exec(rule)?.[1];
  if (spec === undefined) return false;
  const parts = spec.split('*');
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${parts.map(esc).join('[\\s\\S]*')}$`).test(sub)) return true;
  // `Bash(ls *)` also matches `ls`, when the trailing ` *` is the only wildcard.
  return parts.length === 2 && spec.endsWith(' *') && sub === spec.slice(0, -2);
}

export const ifMatches = (rule, cmd) => subcommands(cmd).some((s) => ruleMatches(rule, stripped(s)));

// The push forms prism-cli's tokenizer recognises (cli/test/harness.test.ts), and the bypass forms.
const PUSHES = ['git push', 'git -C repo push origin x', 'cd a && git push', 'GIT_TRACE=1 git push', 'git --no-pager push', 'env git push',
  'env -u X A=1 git push', 'git --git-dir=/x push', 'git --git-dir /x --work-tree /y push', 'git -C dir push', '/usr/bin/git push',
  'sh -c "git push origin x"', "bash -lc 'cd a && git push'", 'git "push"', 'FOO=1 git push --no-verify', 'env git push --no-verify',
  'git -c core.hooksPath=/dev/null push', 'timeout 60 git push', 'echo $(git push)',
  '(git push)', '{ git push; }', 'if true; then git push; fi', 'git push>log 2>&1', 'exec git push', 'nohup git push &', '! git push'];
const BYPASSES = ['git config core.hooksPath x', 'git config --global prism.codewatch false', 'git -cCore.hooksPath=/x push',
  'bash -c "git config --local prism.reviewer none"', 'git -c core.hooksPath=/dev/null commit -m x', 'cd x && git push --no-verify origin main',
  'git push --no-verif', 'git --config-env core.hooksPath=HP push', 'git --config-env=core.hooksPath=HP commit'];
// Commands that move what the push range or the upstream base is read from (D4); the CLI tokenizer's list is in cli/test/harness-kiro.test.ts (REF_MOVES).
const REF_MOVES = ['git update-ref refs/remotes/origin/main HEAD', 'git update-ref -d refs/remotes/origin/main', 'git update-ref --stdin',
  'git branch -f origin/main HEAD', 'git branch origin/main', 'git branch -m old origin/main',
  'git fetch . HEAD:refs/remotes/origin/main', 'git fetch origin +HEAD:refs/remotes/origin/main', 'git fetch . HEAD:origin/main',
  'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/feat', 'git push . HEAD:refs/remotes/origin/main',
  'git tag origin/main', 'git checkout -b origin/main', 'git switch -c remotes/origin/main',
  'git branch -u main', 'git branch --set-upstream-to=origin/x', 'git config branch.feat.merge refs/heads/x', 'git config set branch.feat.remote .',
  'sh -c "git update-ref refs/remotes/origin/main HEAD"', 'cd x && git -C y update-ref refs/remotes/o/m HEAD', 'env git update-ref refs/remotes/o/m HEAD',
  '/usr/bin/git fetch . HEAD:refs/remotes/origin/main', 'FOO=1 git branch -f origin/main',
  'git update-ref refs/heads/origin/main HEAD', 'git tag -m msg origin/main', 'git push . HEAD:origin/main', 'git remote rename origin old',
  'git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*'];

test('every push form the tokenizer handles reaches the pre-push handler', () => {
  const rules = rulesFor('pre-push');
  assert.ok(rules.length >= 1);
  for (const c of PUSHES) assert.ok(rules.some((r) => ifMatches(r, c)), `no pre-push rule matches: ${c}`);
});

test('every bypass form reaches a handler that denies it', () => {
  const rules = [...rulesFor('pre-push'), ...rulesFor('bash-guard')];
  for (const c of BYPASSES) assert.ok(rules.some((r) => ifMatches(r, c)), `no rule matches: ${c}`);
});

test('every remote-tracking ref or upstream move reaches a handler that denies it', () => {
  const rules = [...rulesFor('pre-push'), ...rulesFor('bash-guard')];
  for (const c of REF_MOVES) assert.ok(rules.some((r) => ifMatches(r, c)), `no rule matches: ${c}`);
});

test('ordinary commands start no PRISM handler; a git push starts exactly one review', () => {
  const all = bash.map((h) => h.if);
  for (const c of ['git status', 'npm test', 'ls -la', 'git diff HEAD', 'cat README.md']) {
    assert.ok(!all.some((r) => ifMatches(r, c)), `a rule matches an unrelated command: ${c}`);
  }
  for (const c of PUSHES) assert.equal(rulesFor('pre-push').filter((r) => ifMatches(r, c)).length, 1, c);
});

test('the matcher itself follows the documented examples', () => {
  assert.ok(ifMatches('Bash(git *)', 'FOO=bar git push'));
  assert.ok(ifMatches('Bash(git *)', 'npm test && git push'));
  assert.ok(ifMatches('Bash(rm *)', 'echo $(rm -rf /)'));
  assert.ok(!ifMatches('Bash(rm *)', 'echo $(date)'));
  assert.ok(ifMatches('Bash(git * main)', 'git -c core.fsmonitor=x diff main'));
  assert.ok(ifMatches('Bash(ls *)', 'ls') && !ifMatches('Bash(ls *)', 'lsof') && ifMatches('Bash(ls*)', 'lsof'));
  assert.ok(ifMatches('Bash(npm test *)', 'timeout 30 npm test'));
  assert.ok(!ifMatches('Bash(curl *)', "sh -c 'curl https://example.com'"));
  assert.ok(!ifMatches('Bash(curl *)', '/usr/bin/curl https://example.com'));
});
