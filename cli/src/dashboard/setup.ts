/**
 * Setup checklist. Local evidence only: no AWS, GitHub or GitLab calls, and no
 * credential file is opened (only its existence is checked).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkTool } from '../utils/tool-check.js';
import { ENABLE_CODEBURN_CMD, lastSync, scheduleExists, schedulerName, systemdUserAvailable } from '../utils/otel-sync-schedule.js';
import { type PrismResult } from '../codewatch/results.js';
import { HOOK_MARKER, MANAGED_HOOKS } from '../codewatch/hooks.js';
import { gitleaksInstallHint } from '../codewatch/gitleaks.js';
import { globalHooksDir, globalStatus, isOptedOut, OPT_OUT_KEY, repoLocalHooksPath, type GlobalStatus } from '../codewatch/globalHooks.js';
import { realpathSync } from 'node:fs';
import { readEvalConfig, REVIEWER_GIT_CONFIG_KEY } from '../codewatch/config.js';
import { detectReviewers, resolveReviewer } from '../codewatch/reviewers/index.js';
import { readSecurityMarker } from '../security/marker.js';
import { configuredSyncUrl } from '../utils/otel-sync-schedule.js';
import { effectiveMode, LOCAL_MODE_HELP, PLATFORM_TEAM_HELP, TEAM_NO_URL_HELP, TEAM_URL_CMD, type CheckHelp } from '../utils/sync-mode.js';

/** info: nothing to fix (a choice, like local-only sync); counted as neither ok nor a warning. */
export type CheckStatus = 'ok' | 'info' | 'warn' | 'missing';
export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** One-line fix; empty when status is ok or info. */
  fix: string;
  /** Guidance with doc links: a fix that needs the platform team, or what a chosen mode means. */
  help?: CheckHelp;
}

export type { CheckHelp };

export interface MachineDeps {
  pathEnv?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  scheduleExists?: () => boolean;
  schedulerName?: () => string;
  /** `systemctl --user` works: an unreadable crontab's fix is then the systemd user timer. */
  systemdAvailable?: () => boolean;
  /** Global codewatch hooks state; computed once by the payload builder. */
  global?: GlobalStatus;
}

export const GLOBAL_INSTALL_CMD = 'prism-cli enable codewatch --global';
export const GLOBAL_FORCE_CMD = 'prism-cli enable codewatch --global --force';

/** The machine row for the global hooks (~/.prism/hooks via git config --global core.hooksPath). */
export function globalHooksCheck(g: GlobalStatus): CheckItem {
  const label = 'Codewatch global hooks';
  switch (g.state) {
    case 'installed':
      return item('codewatch-global', label, 'ok', 'core.hooksPath -> ~/.prism/hooks; every repo is covered');
    case 'elsewhere':
      return item('codewatch-global', label, 'warn', `global core.hooksPath points to ${g.hooksPath}`, `${GLOBAL_FORCE_CMD} (its hooks still run)`);
    case 'incomplete':
      return item('codewatch-global', label, 'warn', 'core.hooksPath points to ~/.prism/hooks but its hooks are missing', GLOBAL_INSTALL_CMD);
    default:
      return item('codewatch-global', label, 'missing', 'not installed (optional: covers every repo at once)', GLOBAL_INSTALL_CMD);
  }
}

// Shared with enable codewatch and the pre-commit warning so the three cannot drift.
export { gitleaksInstallHint };

const item = (id: string, label: string, status: CheckStatus, detail: string, fix = ''): CheckItem => ({ id, label, status, detail, fix: status === 'ok' || status === 'info' ? '' : fix });

const AWS_ENV_VARS = ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'];

const SYNC_LABEL = 'Scheduled codeburn sync push';

/** The codeburn sync row, by sync mode (utils/sync-mode.ts). */
export function codeburnSyncCheck(home: string, deps: MachineDeps = {}): CheckItem {
  // Same read as `aws check` and `enable codeburn`: null means no sync config at all ('' is an unreadable one).
  const url = configuredSyncUrl(home);
  const { mode } = effectiveMode(home, url);
  // An unreadable crontab (scheduleExists throws) is its own state, not "no entry".
  let hasSchedule: boolean | Error;
  try { hasSchedule = (deps.scheduleExists || scheduleExists)(); } catch (e) { hasSchedule = e instanceof Error ? e : new Error(String(e)); }
  const sched = (deps.schedulerName || schedulerName)();
  if (mode === 'admin') {
    return { ...item('codeburn-sync', SYNC_LABEL, 'info', 'platform team: set up PRISM for your developers'), help: PLATFORM_TEAM_HELP };
  }
  if (mode === 'local') {
    // Left in place by a move to local without --remove: say it still pushes rather than claim local only.
    const left = hasSchedule === true ? `; a ${sched} sync schedule is still installed and still pushes usage (remove it: ${ENABLE_CODEBURN_CMD} --local --remove)` : '';
    return { ...item('codeburn-sync', SYNC_LABEL, 'info', `local only: codeburn usage stays on this machine${left}`), help: LOCAL_MODE_HELP };
  }
  if (url === null) {
    return { ...item('codeburn-sync', SYNC_LABEL, 'missing', 'no codeburn sync endpoint configured on this machine', TEAM_URL_CMD), help: TEAM_NO_URL_HELP };
  }
  const last = lastSync(home);
  if (hasSchedule instanceof Error) {
    return item('codeburn-sync', SYNC_LABEL, 'warn', hasSchedule.message,
      (deps.systemdAvailable || systemdUserAvailable)()
        ? `${ENABLE_CODEBURN_CMD} --schedule systemd (a systemd user timer; your crontab is not touched)`
        : 'Fix crontab access (crontab -l must work), then re-check');
  }
  if (hasSchedule) {
    return item('codeburn-sync', SYNC_LABEL, last ? 'ok' : 'warn',
      last ? `${sched} entry installed; last sync log write ${last.at}` : `${sched} entry installed; no sync log yet in ~/.prism/logs`,
      'Wait for the next run, or check ~/.prism/logs/otel-sync.log');
  }
  return item('codeburn-sync', SYNC_LABEL, 'missing', `no ${sched} entry${last ? `; last sync log write ${last.at}` : ''}`, ENABLE_CODEBURN_CMD);
}

/** Checks that do not depend on a repository. */
export function machineChecks(deps: MachineDeps = {}): CheckItem[] {
  const env = deps.env || process.env;
  const home = deps.home || homedir();
  const out: CheckItem[] = [];

  const cb = checkTool('codeburn', { pathEnv: deps.pathEnv });
  out.push(item('codeburn', 'codeburn installed', cb.installed ? 'ok' : 'missing',
    cb.installed ? (cb.version || 'version unknown') : 'not on PATH', ENABLE_CODEBURN_CMD));

  out.push(codeburnSyncCheck(home, deps));

  const gl = checkTool('gitleaks', { pathEnv: deps.pathEnv, versionArgs: ['version'] });
  // warn, not missing: commits are still allowed, just not secret-scanned (decided).
  out.push(item('gitleaks', 'gitleaks available', gl.installed ? 'ok' : 'warn',
    gl.installed ? (gl.version || 'version unknown') : 'not on PATH; secret scanning is off and commits are not scanned',
    gitleaksInstallHint()));

  // Presence only. STS is never called and no credential or config file is read.
  const envVar = AWS_ENV_VARS.find((k) => env[k]);
  const configFile = env.AWS_CONFIG_FILE || join(home, '.aws', 'config');
  const credsFile = env.AWS_SHARED_CREDENTIALS_FILE || join(home, '.aws', 'credentials');
  const files = [configFile, credsFile].filter((f) => existsSync(f));
  const awsOk = Boolean(envVar) || files.length > 0;
  out.push(item('aws-credentials', 'AWS credentials configured', awsOk ? 'ok' : 'missing',
    envVar ? `${envVar} is set${envVar === 'AWS_PROFILE' ? ` (${env.AWS_PROFILE})` : ''} (not validated)`
      : files.length ? `AWS config present (${files.length === 2 ? 'config and credentials files' : 'one file'}; not validated)`
        : 'no AWS env var or ~/.aws config found',
    "aws configure (or aws sso login); then validate with 'aws sts get-caller-identity'"));
  out.push(globalHooksCheck(deps.global || globalStatus(home)));
  return out;
}

function git(repo: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : null;
}

function readText(p: string): string | null {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

export interface CodewatchSetup {
  /**
   * ok: codewatch runs here (per-repo hooks, or the global hooks).
   * warn: the global hooks are installed but this repo's own core.hooksPath bypasses them.
   * opted-out: git config prism.codewatch false.
   * missing: anything else (including hooks from before the rename).
   */
  status: 'ok' | 'warn' | 'missing' | 'opted-out';
  /** Covered by the global hooks rather than per-repo hooks. */
  global: boolean;
  /** Reviewer the pre-push review would use here, or null when none is available. */
  reviewer: string | null;
  /** Where that choice came from: git-config, prism-config, detected, fallback or none. */
  reviewerSource: string;
  detail: string;
  /** Empty when ok. */
  fix: string;
}

/** Shell-quotes a path for the copy-paste fix line. */
export function shellPath(p: string): string {
  return /^[A-Za-z0-9_./~+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function enableCodewatchFix(repo: string): string {
  return `cd ${shellPath(repo)} && prism-cli enable codewatch`;
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return n(a) === n(b);
}

/** The only per-repo check: does codewatch run here (per repo or globally), and which reviewer would run. */
export function codewatchSetup(repo: string, deps: { pathEnv?: string; global?: GlobalStatus } = {}): CodewatchSetup {
  const g = deps.global || globalStatus();
  const hooksDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']) || resolve(repo, '.git/hooks');
  const viaGlobal = g.state === 'installed' && samePath(hooksDir, globalHooksDir());
  const state = MANAGED_HOOKS.map((h) => {
    const t = readText(resolve(hooksDir, h));
    return { h, ours: !!t && t.includes(HOOK_MARKER), old: !!t && !t.includes(HOOK_MARKER) && t.includes('# prism-cli enable security') };
  });
  const choice = resolveReviewer({
    gitConfigValue: git(repo, ['config', '--get', REVIEWER_GIT_CONFIG_KEY]),
    prismConfigValue: readEvalConfig(repo).reviewer,
    available: detectReviewers(deps.pathEnv),
  });
  const reviewer = choice.id;
  const base = { reviewer, reviewerSource: choice.source, global: viaGlobal };
  if (isOptedOut(repo)) {
    return { ...base, status: 'opted-out', fix: '', detail: `opted out (git config ${OPT_OUT_KEY} false)` };
  }
  if (state.every((x) => x.ours)) {
    const where = viaGlobal ? 'covered by the global hooks (global)' : 'pre-commit and pre-push installed';
    return { ...base, status: 'ok', fix: '', detail: reviewer ? where : `${where}; no reviewer on PATH (install kiro-cli or Claude Code)` };
  }
  const local = repoLocalHooksPath(repo);
  if (local && g.state === 'installed') {
    return { ...base, status: 'warn', fix: enableCodewatchFix(repo),
      detail: `this repo's core.hooksPath (${local}) bypasses the global hooks; install codewatch into it` };
  }
  const have = state.filter((x) => x.ours).map((x) => x.h);
  const detail = state.some((x) => x.old) ? 'hooks from before the codewatch rename'
    : have.length ? `only ${have.join(', ')} installed` : 'not installed';
  return { ...base, status: 'missing', detail, fix: enableCodewatchFix(repo) };
}

export interface SecuritySetup {
  /**
   * ok: `prism-cli enable security` finished here (.prism/security.local.json, or a legacy .prism/config.json block).
   * in-use: no marker, but saved Security Agent results (code review, threat model or pentest) are in .prism/results/.
   * missing: neither.
   */
  status: 'ok' | 'in-use' | 'missing';
  detail: string;
  /** Empty when ok. */
  fix: string;
}

/** Result kinds the Security Agent commands save, with their label. */
export const SECURITY_RESULT_KINDS: [PrismResult['kind'], string][] = [
  ['security-review', 'code review'], ['security-threat-model', 'threat model'], ['security-pentest', 'pentest'],
];

export function enableSecurityFix(repo: string): string {
  return `cd ${shellPath(repo)} && prism-cli enable security`;
}

/**
 * Security Agent per repo, from the marker `enable security` writes
 * (.prism/security.local.json, else a legacy block in .prism/config.json). Local
 * evidence only: the dashboard makes no AWS calls, so this says the setup ran
 * here, not that the AWS resources still exist (`enable security --status` checks those).
 */
export function securitySetup(repo: string, results: PrismResult[] = []): SecuritySetup {
  const m = readSecurityMarker(repo);
  if (!m) {
    // Saved results prove the Security Agent was used for this repo (from another checkout, or before the marker existed).
    const kinds = SECURITY_RESULT_KINDS.filter(([k]) => results.some((r) => r.kind === k)).map(([, label]) => label);
    if (kinds.length) return { status: 'in-use', detail: `in use (${kinds.join(', ')} results found; no local marker)`, fix: '' };
    return { status: 'missing', detail: 'not set up', fix: enableSecurityFix(repo) };
  }
  const when = m.setupAt ? `, set up ${m.setupAt.slice(0, 10)}` : '';
  return { status: 'ok', detail: `code review ${m.codeReviewId} in account ${m.account} (${m.region})${when}`, fix: '' };
}
