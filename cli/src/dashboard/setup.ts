/**
 * Setup checklist. Local evidence only: no AWS, GitHub or GitLab calls, and no
 * credential file is opened (only its existence is checked).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkTool } from '../utils/tool-check.js';
import { lastSync, scheduleExists, schedulerName } from '../utils/otel-sync-schedule.js';
import { HOOK_MARKER, MANAGED_HOOKS } from '../codewatch/hooks.js';
import { gitleaksInstallHint } from '../codewatch/gitleaks.js';
import { readEvalConfig, REVIEWER_GIT_CONFIG_KEY } from '../codewatch/config.js';
import { detectReviewers, resolveReviewer } from '../codewatch/reviewers/index.js';

export type CheckStatus = 'ok' | 'warn' | 'missing';
export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** One-line fix; empty when status is ok. */
  fix: string;
}

export interface MachineDeps {
  pathEnv?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  scheduleExists?: () => boolean;
  schedulerName?: () => string;
}

// Shared with enable codewatch and the pre-commit warning so the three cannot drift.
export { gitleaksInstallHint };

const item = (id: string, label: string, status: CheckStatus, detail: string, fix = ''): CheckItem => ({ id, label, status, detail, fix: status === 'ok' ? '' : fix });

const AWS_ENV_VARS = ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'];

/** Checks that do not depend on a repository. */
export function machineChecks(deps: MachineDeps = {}): CheckItem[] {
  const env = deps.env || process.env;
  const home = deps.home || homedir();
  const out: CheckItem[] = [];

  const cb = checkTool('codeburn', { pathEnv: deps.pathEnv });
  out.push(item('codeburn', 'codeburn installed', cb.installed ? 'ok' : 'missing',
    cb.installed ? (cb.version || 'version unknown') : 'not on PATH', 'npm install -g codeburn'));

  const hasSchedule = (deps.scheduleExists || scheduleExists)();
  const sched = (deps.schedulerName || schedulerName)();
  const last = lastSync(home);
  if (hasSchedule) {
    out.push(item('codeburn-sync', 'Scheduled codeburn sync push', last ? 'ok' : 'warn',
      last ? `${sched} entry installed; last sync log write ${last.at}` : `${sched} entry installed; no sync log yet in ~/.prism/logs`,
      'Wait for the next run, or check ~/.prism/logs/otel-sync.log'));
  } else {
    out.push(item('codeburn-sync', 'Scheduled codeburn sync push', 'missing',
      `no ${sched} entry${last ? `; last sync log write ${last.at}` : ''}`, 'prism-cli bootstrapper setup-otel-sync'));
  }

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
  /** ok: both PRISM hooks are installed. missing: anything else (including hooks from before the rename). */
  status: 'ok' | 'missing';
  /** Reviewer the pre-push review would use here, or null when none is available. */
  reviewer: string | null;
  /** Where that choice came from: git-config, prism-config, detected, fallback or none. */
  reviewerSource: string;
  detail: string;
  /** Empty when ok. */
  fix: string;
}

/** Shell-quotes a path for the copy-paste fix line. */
function shellPath(p: string): string {
  return /^[A-Za-z0-9_./~+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function enableCodewatchFix(repo: string): string {
  return `cd ${shellPath(repo)} && prism-cli enable codewatch`;
}

/** The only per-repo check: are the codewatch hooks installed, and which reviewer would run. */
export function codewatchSetup(repo: string, deps: { pathEnv?: string } = {}): CodewatchSetup {
  const hooksDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']) || resolve(repo, '.git/hooks');
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
  if (state.every((x) => x.ours)) {
    return { status: 'ok', reviewer, reviewerSource: choice.source, fix: '',
      detail: reviewer ? 'pre-commit and pre-push installed' : 'hooks installed; no reviewer on PATH (install kiro-cli or Claude Code)' };
  }
  const have = state.filter((x) => x.ours).map((x) => x.h);
  const detail = state.some((x) => x.old) ? 'hooks from before the codewatch rename'
    : have.length ? `only ${have.join(', ')} installed` : 'not installed';
  return { status: 'missing', reviewer, reviewerSource: choice.source, detail, fix: enableCodewatchFix(repo) };
}
