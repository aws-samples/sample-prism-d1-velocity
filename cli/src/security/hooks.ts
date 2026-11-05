/**
 * Git hook install/uninstall for `prism-cli enable security`.
 *
 * Backup convention matches the old install-git-hooks: a foreign hook at
 * `<hook>` is moved aside to `<hook>.pre-prism`. Unlike the old installer, the
 * PRISM hook then CALLS the backed-up hook first, so installing does not turn
 * off a team's existing hook, and uninstall moves the backup back.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { run } from '../utils/exec.js';

export const HOOK_MARKER = '# prism-cli enable security';
/** The retired trailer hook is identified the way install-git-hooks identified it. */
const LEGACY_MARKER = 'AI-Origin';
export const BACKUP_SUFFIX = '.pre-prism';
export const MANAGED_HOOKS = ['pre-commit', 'pre-push'] as const;
export type ManagedHook = typeof MANAGED_HOOKS[number];

/**
 * pre-commit: blocks on a gitleaks finding.
 *
 * Prefers `prism-cli git pre-commit` (writes a result file). Without prism-cli
 * on PATH it still runs gitleaks directly, so the block does not depend on the
 * CLI being installed globally.
 */
export const PRE_COMMIT_SCRIPT = `#!/bin/sh
${HOOK_MARKER} -- pre-commit secret scan (blocks on a finding).
# Managed file. Remove with: prism-cli enable security --uninstall
HOOK_DIR=$(dirname "$0")
if [ -x "$HOOK_DIR/pre-commit${BACKUP_SUFFIX}" ]; then
  "$HOOK_DIR/pre-commit${BACKUP_SUFFIX}" "$@" || exit $?
fi
# Probe first: an older prism-cli on PATH has no "git pre-commit" and would
# fail every commit with "unknown command".
if command -v prism-cli >/dev/null 2>&1 && prism-cli git pre-commit --help >/dev/null 2>&1; then
  exec prism-cli git pre-commit
fi
if command -v gitleaks >/dev/null 2>&1; then
  set -- protect --staged --redact --no-banner --exit-code=1
  [ -f .gitleaks.toml ] && set -- "$@" --config=.gitleaks.toml
  [ -f .prism/gitleaks-baseline.json ] && set -- "$@" --baseline-path=.prism/gitleaks-baseline.json
  if ! gitleaks "$@"; then
    echo "prism: gitleaks flagged the staged changes; commit blocked." >&2
    echo "prism: fix it, allowlist a false positive in .gitleaks.toml, or bypass once with --no-verify." >&2
    exit 1
  fi
  exit 0
fi
echo "prism: neither prism-cli nor gitleaks is on PATH; secret scan skipped." >&2
exit 0
`;

/**
 * pre-push: report-only review. Exits 0 no matter what the review does.
 * stdin (the pushed refs) is buffered so both a chained hook and prism-cli see it.
 */
export const PRE_PUSH_SCRIPT = `#!/bin/sh
${HOOK_MARKER} -- pre-push local eval review (report only, never blocks).
# Managed file. Remove with: prism-cli enable security --uninstall
HOOK_DIR=$(dirname "$0")
PRISM_PUSH_INPUT=$(cat)
if [ -x "$HOOK_DIR/pre-push${BACKUP_SUFFIX}" ]; then
  printf '%s\\n' "$PRISM_PUSH_INPUT" | "$HOOK_DIR/pre-push${BACKUP_SUFFIX}" "$@" || exit $?
fi
if command -v prism-cli >/dev/null 2>&1 && prism-cli git pre-push --help >/dev/null 2>&1; then
  printf '%s\\n' "$PRISM_PUSH_INPUT" | prism-cli git pre-push --remote "\${1:-}" || true
else
  echo "prism: prism-cli (with 'git pre-push') is not on PATH; local review skipped (report only)." >&2
fi
exit 0
`;

export const HOOK_SCRIPTS: Record<ManagedHook, string> = {
  'pre-commit': PRE_COMMIT_SCRIPT,
  'pre-push': PRE_PUSH_SCRIPT,
};

/**
 * Hooks directory as git resolves it: honours core.hooksPath and works in a
 * linked worktree, where `.git` is a file and `.git/hooks` does not exist.
 */
export function resolveHooksDir(gitRoot: string): string {
  const abs = run('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  if (abs.ok && abs.stdout && isAbsolute(abs.stdout)) return abs.stdout;
  const rel = run('git', ['rev-parse', '--git-path', 'hooks']);
  return rel.ok && rel.stdout ? resolve(process.cwd(), rel.stdout) : resolve(gitRoot, '.git/hooks');
}

function isOurs(path: string, marker = HOOK_MARKER): boolean {
  try { return readFileSync(path, 'utf8').includes(marker); } catch { return false; }
}

export interface HookChange { hook: string; action: string }

export function installHooks(hooksDir: string): HookChange[] {
  mkdirSync(hooksDir, { recursive: true });
  const changes: HookChange[] = [];
  for (const hook of MANAGED_HOOKS) {
    const target = resolve(hooksDir, hook);
    const backup = target + BACKUP_SUFFIX;
    if (existsSync(target) && !isOurs(target)) {
      if (existsSync(backup)) {
        // Never overwrite an earlier backup: that would destroy the original.
        const stamped = `${backup}.${Date.now()}`;
        renameSync(target, stamped);
        changes.push({ hook, action: `existing hook moved to ${stamped} (a ${hook}${BACKUP_SUFFIX} backup already existed)` });
      } else {
        renameSync(target, backup);
        changes.push({ hook, action: `existing hook backed up to ${hook}${BACKUP_SUFFIX} and chained` });
      }
    }
    writeFileSync(target, HOOK_SCRIPTS[hook]);
    chmodSync(target, 0o755);
    changes.push({ hook, action: 'installed' });
  }
  return changes;
}

export function uninstallHooks(hooksDir: string): HookChange[] {
  const changes: HookChange[] = [];
  for (const hook of MANAGED_HOOKS) {
    const target = resolve(hooksDir, hook);
    const backup = target + BACKUP_SUFFIX;
    if (!existsSync(target) || !isOurs(target)) {
      changes.push({ hook, action: existsSync(target) ? 'left alone (not installed by prism-cli)' : 'not installed' });
      continue;
    }
    rmSync(target, { force: true });
    if (existsSync(backup)) {
      renameSync(backup, target);
      changes.push({ hook, action: `removed; restored previous hook from ${hook}${BACKUP_SUFFIX}` });
    } else {
      changes.push({ hook, action: 'removed' });
    }
  }
  return changes;
}

/**
 * Removes the retired prepare-commit-msg trailer hook (commit trailers and the
 * token tracker are no longer used) and restores whatever it had backed up.
 * Returns a description, or null when there was nothing to retire.
 */
export function retireLegacyCommitMsgHook(hooksDir: string): string | null {
  const target = resolve(hooksDir, 'prepare-commit-msg');
  if (!existsSync(target) || !isOurs(target, LEGACY_MARKER)) return null;
  const backup = target + BACKUP_SUFFIX;
  rmSync(target, { force: true });
  if (existsSync(backup)) {
    copyFileSync(backup, target);
    chmodSync(target, 0o755);
    rmSync(backup, { force: true });
    return 'removed retired prepare-commit-msg trailer hook; restored the hook it had backed up';
  }
  return 'removed retired prepare-commit-msg trailer hook';
}

/** Adds `.prism/results/` to .gitignore unless an entry already covers it. */
export function ensureResultsIgnored(gitRoot: string): boolean {
  const gi = resolve(gitRoot, '.gitignore');
  const content = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.some((l) => ['.prism', '.prism/', '/.prism', '/.prism/', '.prism/results', '.prism/results/', '/.prism/results/'].includes(l))) return false;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  writeFileSync(gi, `${content}${prefix}# prism-cli local gate results (per developer, not shared)\n.prism/results/\n`);
  return true;
}
