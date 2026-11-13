/**
 * A throwaway repo with a fake `claude` reviewer and a fake gitleaks, for
 * harness adapter tests. The same rig as harness.test.ts (kept there as is):
 * a repo on `main` with upstream `origin/main` at the first commit. Nothing
 * reaches a model.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-hk-gcfg-')), 'gitconfig');
for (const k of ['CLAUDE_PLUGIN_OPTION_FINISH_GATE', 'CLAUDE_PLUGIN_OPTION_PUSH_GATE', 'PRISM_HARNESS_FINISH_GATE', 'PRISM_HARNESS_CHILD']) delete process.env[k];

/** A fake credential: never a real one. Built at runtime so this file holds no literal key. */
export const FAKE_SECRET = ['AKIA', 'Q4WM7RTZ', '2HJKV6XY'].join('');

export const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), `prism-hk-${p}-`)));

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function exe(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

export interface Rig {
  dir: string;
  bin: string;
  gitleaks: string;
  /** Next reviewer replies, in order; the last one repeats. */
  reply(...findings: object[][]): void;
  /** gitleaks report for the next working-tree scans; null = no leaks. */
  leaks(report: object[] | null, exit?: number): void;
  calls(): string[];
  write(file: string, body: string): void;
  commit(msg?: string): void;
}

export function rig(): Rig {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main', `--template=${tmp('tpl')}`);
  writeFileSync(join(dir, 'README.md'), '# x\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'old.ts'), 'export const old = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init', '--no-verify');
  git(dir, 'remote', 'add', 'origin', '/nonexistent');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'branch', '-q', '--set-upstream-to=origin/main');

  const tools = tmp('tools');
  const bin = join(tools, 'bin');
  const log = join(tools, 'calls.log');
  const replies = join(tools, 'replies');
  mkdirSync(replies);
  exe(join(bin, 'claude'), [
    `if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi`,
    `cat > /dev/null`,
    `echo reviewer >> '${log}'`,
    `n=$(cat '${tools}/n' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${tools}/n'`,
    `f='${replies}/'$n; [ -f "$f" ] || f=$(ls '${replies}' | sort -n | tail -1 | sed "s|^|${replies}/|")`,
    `cat "$f"`,
  ].join('\n'));
  const glReport = join(tools, 'gl-report.json');
  const glExit = join(tools, 'gl-exit');
  const gitleaks = exe(join(tools, 'gitleaks'), [
    `if [ "$1" = "version" ] || [ "$1" = "--version" ]; then echo "v8.28.0"; exit 0; fi`,
    `for a in "$@"; do case "$a" in --report-path=*) rp="\${a#--report-path=}";; esac; done`,
    `if [ "$1" = "git" ]; then echo '[]' > "$rp"; exit 0; fi`,
    `echo gitleaks >> '${log}'`,
    `if [ -f '${glReport}' ]; then cp '${glReport}' "$rp"; else echo '[]' > "$rp"; fi`,
    `exit $(cat '${glExit}' 2>/dev/null || echo 0)`,
  ].join('\n'));

  const envelope = (r: object[]) => JSON.stringify({
    type: 'result', is_error: false, total_cost_usd: 0, result: JSON.stringify({ findings: r, score: 0.5, summary: 'x' }),
  });
  const r: Rig = {
    dir, bin, gitleaks,
    reply(...rs) {
      spawnSync('rm', ['-f', ...readdirSync(replies).map((f) => join(replies, f)), join(tools, 'n')]);
      rs.forEach((x, i) => writeFileSync(join(replies, String(i + 1)), envelope(x)));
    },
    leaks(report, exit) {
      spawnSync('rm', ['-f', glReport, glExit]);
      if (report) writeFileSync(glReport, JSON.stringify(report));
      if (exit !== undefined) writeFileSync(glExit, String(exit));
      else if (report && report.length) writeFileSync(glExit, '1');
    },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    write(file, body) { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), body); },
    commit(msg = 'c') { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg, '--no-verify'); },
  };
  r.reply([]);
  return r;
}

export const finding = (file: string, line: number, severity = 'high', message = 'Query built from input.') =>
  ({ file, line, severity, category: 'security', rule: 'SQL injection', message });

/** A gitleaks JSON report line, including the Secret/Match fields PRISM must never read. */
export const leak = (file: string, line: number) => ({ RuleID: 'aws-access-token', Description: 'AWS access token', File: file, StartLine: line, Secret: FAKE_SECRET, Match: `key = "${FAKE_SECRET}"`, Fingerprint: `${file}:aws-access-token:${line}` });
