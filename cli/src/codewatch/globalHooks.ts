/**
 * Global codewatch hooks: `prism-cli enable codewatch --global`.
 *
 * The hooks live in ~/.prism/hooks/ and `git config --global core.hooksPath`
 * points there, so every existing and future repo is covered with no per-repo
 * step. A global core.hooksPath makes git ignore each repo's own .git/hooks,
 * so these hooks run that repo-local hook themselves, after codewatch, and pass
 * its exit code through.
 *
 * Every git call here goes through `git config --global`, which honours HOME
 * and GIT_CONFIG_GLOBAL: tests point both at a scratch directory.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { run } from '../utils/exec.js';
import { BACKUP_SUFFIX, HOOK_MARKER, MANAGED_HOOKS, OPT_OUT_KEY, type ManagedHook } from './hooks.js';

export const GLOBAL_MARKER = '# prism-codewatch-global';
/** Saved value of the global core.hooksPath that --global replaced. Absent when there was none. */
export const PREVIOUS_FILE = '.previous-hookspath';
/** With --force, the replaced hooks directory, whose hooks are chained after ours. */
export const CHAIN_FILE = '.chain-hookspath';
export { OPT_OUT_KEY, isOptedOut } from './hooks.js';

export function globalHooksDir(home: string = homedir()): string {
  return join(home, '.prism', 'hooks');
}

/** git expands a leading ~ in core.hooksPath; do the same so values compare. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return norm(a) === norm(b);
}

export function readGlobalHooksPath(): string | null {
  const r = run('git', ['config', '--global', '--get', 'core.hooksPath']);
  return r.ok && r.stdout ? r.stdout : null;
}

/** True when a core.hooksPath value points at our global hooks directory. */
export function isOurHooksPath(value: string | null, home: string = homedir()): boolean {
  if (!value) return false;
  const v = expandHome(value, home);
  return isAbsolute(v) && samePath(v, globalHooksDir(home));
}

/**
 * Shared shell for both global hooks. Prints, one per line, the hooks to run
 * after ours: the repo-local hook (unless it is a per-repo codewatch hook, in
 * which case the team hook it had backed up), then the hook in the directory
 * --force replaced. Never a file carrying our marker, so nothing runs twice.
 */
function chainPrelude(hook: ManagedHook): string {
  return `HOOK_NAME=${hook}
HOOK_DIR=$(cd "$(dirname "$0")" && pwd)
PRISM_MARKER='${HOOK_MARKER}'
prism_enabled() { [ "$(git config --bool --get ${OPT_OUT_KEY} 2>/dev/null)" != "false" ]; }
prism_chain_targets() {
  GD=$(git rev-parse --git-dir 2>/dev/null) || return 0
  L="$GD/hooks/$HOOK_NAME"
  if [ -f "$L" ] && [ -x "$L" ]; then
    if grep -qF "$PRISM_MARKER" "$L" 2>/dev/null; then
      if [ -x "$L${BACKUP_SUFFIX}" ]; then printf '%s\\n' "$L${BACKUP_SUFFIX}"; fi
    else
      printf '%s\\n' "$L"
    fi
  fi
  if [ -f "$HOOK_DIR/${CHAIN_FILE}" ]; then
    F="$(cat "$HOOK_DIR/${CHAIN_FILE}")/$HOOK_NAME"
    if [ -f "$F" ] && [ -x "$F" ] && ! grep -qF "$PRISM_MARKER" "$F" 2>/dev/null; then printf '%s\\n' "$F"; fi
  fi
}
`;
}

/** Runs each chained hook in turn; the first non-zero exit code is the hook's result. */
function chainRunner(feedStdin: boolean): string {
  const call = feedStdin ? 'prism_feed | "$t" "$@"' : '"$t" "$@"';
  return `TARGETS=$(prism_chain_targets)
set -f
OLDIFS=$IFS
IFS='
'
for t in $TARGETS; do
  IFS=$OLDIFS
  ${call}
  rc=$?
  if [ "$rc" -ne 0 ]; then exit "$rc"; fi
done
exit 0
`;
}

export const GLOBAL_PRE_COMMIT_SCRIPT = `#!/bin/sh
${HOOK_MARKER} -- global pre-commit: secret scan (blocks on a finding), then this repo's own pre-commit.
${GLOBAL_MARKER}
# Managed file. Remove with: prism-cli enable codewatch --global --uninstall
${chainPrelude('pre-commit')}
if prism_enabled; then
  if command -v prism-cli >/dev/null 2>&1 && prism-cli codewatch pre-commit --help 2>/dev/null | grep -q 'codewatch pre-commit'; then
    prism-cli codewatch pre-commit || exit $?
  elif command -v gitleaks >/dev/null 2>&1; then
    set -- protect --staged --redact --no-banner --exit-code=1
    [ -f .gitleaks.toml ] && set -- "$@" --config=.gitleaks.toml
    [ -f .prism/gitleaks-baseline.json ] && set -- "$@" --baseline-path=.prism/gitleaks-baseline.json
    if ! gitleaks "$@"; then
      echo "prism: gitleaks flagged the staged changes; commit blocked." >&2
      exit 1
    fi
    set --
  else
    echo "prism: neither prism-cli nor gitleaks is on PATH; secret scan skipped." >&2
  fi
fi
${chainRunner(false)}`;

export const GLOBAL_PRE_PUSH_SCRIPT = `#!/bin/sh
${HOOK_MARKER} -- global pre-push: report-only review, then this repo's own pre-push (its exit code counts).
${GLOBAL_MARKER}
# Managed file. Remove with: prism-cli enable codewatch --global --uninstall
${chainPrelude('pre-push')}
PRISM_PUSH_INPUT=$(cat)
prism_feed() { if [ -n "$PRISM_PUSH_INPUT" ]; then printf '%s\\n' "$PRISM_PUSH_INPUT"; fi; }
if prism_enabled; then
  if command -v prism-cli >/dev/null 2>&1 && prism-cli codewatch pre-push --help 2>/dev/null | grep -q 'codewatch pre-push'; then
    prism_feed | prism-cli codewatch pre-push --remote "\${1:-}" || true
  else
    echo "prism: prism-cli (with 'codewatch pre-push') is not on PATH; local review skipped (report only)." >&2
  fi
fi
${chainRunner(true)}`;

export const GLOBAL_HOOK_SCRIPTS: Record<ManagedHook, string> = {
  'pre-commit': GLOBAL_PRE_COMMIT_SCRIPT,
  'pre-push': GLOBAL_PRE_PUSH_SCRIPT,
};

export type GlobalInstallResult =
  | { ok: true; dir: string; previous: string | null; chained: string | null; reinstalled: boolean }
  | { ok: false; refused: string; current: string };

export function installGlobal(opts: { force?: boolean; home?: string } = {}): GlobalInstallResult {
  const home = opts.home || homedir();
  const dir = globalHooksDir(home);
  const current = readGlobalHooksPath();
  const ours = isOurHooksPath(current, home);
  if (current && !ours && !opts.force) {
    return { ok: false, current, refused: `global core.hooksPath is already set to ${current}` };
  }
  mkdirSync(dir, { recursive: true });
  let chained: string | null = null;
  if (current && !ours) {
    // --force: remember the old value for uninstall, and chain its hooks.
    writeFileSync(join(dir, PREVIOUS_FILE), current + '\n');
    chained = expandHome(current, home);
    writeFileSync(join(dir, CHAIN_FILE), chained + '\n');
  }
  for (const hook of MANAGED_HOOKS) {
    const p = join(dir, hook);
    writeFileSync(p, GLOBAL_HOOK_SCRIPTS[hook]);
    chmodSync(p, 0o755);
  }
  if (!ours) {
    const set = run('git', ['config', '--global', 'core.hooksPath', dir]);
    if (!set.ok) throw new Error(`git config --global core.hooksPath failed: ${set.stderr}`);
  }
  const prev = readText(join(dir, PREVIOUS_FILE));
  return { ok: true, dir, previous: prev, chained: chained ?? readText(join(dir, CHAIN_FILE)), reinstalled: ours };
}

function readText(p: string): string | null {
  try { return readFileSync(p, 'utf8').trim() || null; } catch { return null; }
}

export interface GlobalUninstallResult {
  /** What happened to core.hooksPath. */
  config: 'restored' | 'unset' | 'left-alone' | 'not-set';
  restoredTo: string | null;
  removed: string[];
}

/** Restores the previous core.hooksPath (or unsets it) and removes our files. Never touches repo-local hooks. */
export function uninstallGlobal(opts: { home?: string } = {}): GlobalUninstallResult {
  const home = opts.home || homedir();
  const dir = globalHooksDir(home);
  const current = readGlobalHooksPath();
  const previous = readText(join(dir, PREVIOUS_FILE));
  let config: GlobalUninstallResult['config'] = 'not-set';
  if (isOurHooksPath(current, home)) {
    if (previous) {
      run('git', ['config', '--global', 'core.hooksPath', previous]);
      config = 'restored';
    } else {
      run('git', ['config', '--global', '--unset', 'core.hooksPath']);
      config = 'unset';
    }
  } else if (current) {
    config = 'left-alone'; // someone pointed it elsewhere since; not ours to change
  }
  const removed: string[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const text = readText(p) || '';
      if (f === PREVIOUS_FILE || f === CHAIN_FILE || text.includes(GLOBAL_MARKER)) {
        rmSync(p, { force: true });
        removed.push(f);
      }
    }
    try { rmdirSync(dir); } catch { /* not empty: leave other files */ }
  }
  return { config, restoredTo: config === 'restored' ? previous : null, removed };
}

export interface GlobalStatus {
  state: 'installed' | 'not-installed' | 'elsewhere' | 'incomplete';
  hooksPath: string | null;
  dir: string;
}

export function globalStatus(home: string = homedir()): GlobalStatus {
  const dir = globalHooksDir(home);
  const hooksPath = readGlobalHooksPath();
  if (!hooksPath) return { state: 'not-installed', hooksPath, dir };
  if (!isOurHooksPath(hooksPath, home)) return { state: 'elsewhere', hooksPath, dir };
  const complete = MANAGED_HOOKS.every((h) => (readText(join(dir, h)) || '').includes(GLOBAL_MARKER));
  return { state: complete ? 'installed' : 'incomplete', hooksPath, dir };
}

/** A repo's own core.hooksPath (husky and similar), set in its local config. */
export function repoLocalHooksPath(repo: string): string | null {
  const r = run('git', ['-C', repo, 'config', '--local', '--get', 'core.hooksPath']);
  return r.ok && r.stdout ? r.stdout : null;
}
