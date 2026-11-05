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

/** The repo's CI eval workflow files, GitHub or GitLab. */
function ciWorkflows(repo: string): { github: string | null; gitlab: string | null } {
  const gh = resolve(repo, '.github/workflows/prism-eval-gate.yml');
  const glCi = resolve(repo, '.gitlab-ci.yml');
  const glText = readText(glCi);
  return { github: existsSync(gh) ? gh : null, gitlab: glText && glText.includes('prism-eval-gate') ? glCi : null };
}

export function repoChecks(repo: string, deps: { pathEnv?: string } = {}): CheckItem[] {
  const out: CheckItem[] = [];

  // Codewatch hooks
  const hooksDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']) || resolve(repo, '.git/hooks');
  const hookState = MANAGED_HOOKS.map((h) => {
    const t = readText(resolve(hooksDir, h));
    return { h, ours: !!t && t.includes(HOOK_MARKER), old: !!t && !t.includes(HOOK_MARKER) && t.includes('# prism-cli enable security') };
  });
  const cfg = readEvalConfig(repo);
  const choice = resolveReviewer({
    gitConfigValue: git(repo, ['config', '--get', REVIEWER_GIT_CONFIG_KEY]),
    prismConfigValue: cfg.reviewer,
    available: detectReviewers(deps.pathEnv),
  });
  const reviewerText = choice.id ? `reviewer ${choice.id} (${choice.source})` : 'no reviewer available';
  if (hookState.every((s) => s.ours)) {
    out.push(item('codewatch-hooks', 'Codewatch hooks installed', choice.id ? 'ok' : 'warn',
      `pre-commit and pre-push; ${reviewerText}`, 'Install kiro-cli or Claude Code for the pre-push review'));
  } else if (hookState.some((s) => s.old)) {
    out.push(item('codewatch-hooks', 'Codewatch hooks installed', 'warn', 'hooks from before the codewatch rename', 'prism-cli enable codewatch'));
  } else {
    const have = hookState.filter((s) => s.ours).map((s) => s.h);
    out.push(item('codewatch-hooks', 'Codewatch hooks installed', 'missing',
      have.length ? `only ${have.join(', ')}` : 'not installed', 'prism-cli enable codewatch'));
  }

  // CI eval workflow
  const ci = ciWorkflows(repo);
  const ciFile = ci.github || ci.gitlab;
  out.push(item('ci-eval', 'CI eval workflow present', ciFile ? 'ok' : 'missing',
    ciFile ? (ci.github ? '.github/workflows/prism-eval-gate.yml' : '.gitlab-ci.yml includes prism-eval-gate') : 'no prism-eval-gate workflow',
    'prism-cli bootstrapper install-eval-harness'));

  // OIDC: the role itself lives in AWS and the secret in GitHub/GitLab; locally
  // we can only see whether the workflow is wired to assume a role.
  const wfText = [ci.github, ci.gitlab].filter(Boolean).map((p) => readText(p as string) || '').join('\n');
  const wired = /PRISM_METRICS_ROLE_ARN|role-to-assume/.test(wfText);
  out.push(item('oidc', 'GitHub/GitLab OIDC role', wired ? 'warn' : 'missing',
    wired ? 'workflow assumes PRISM_METRICS_ROLE_ARN; role and secret not verifiable locally' : 'no workflow references a CI role',
    wired ? 'Confirm the PRISM_METRICS_ROLE_ARN secret exists (setup-github-oidc / setup-gitlab-oidc)' : 'prism-cli bootstrapper setup-github-oidc (or setup-gitlab-oidc)'));

  // Security Agent: setup writes nothing locally; the CI Continuum step is the only local trace.
  const continuum = /securityagent/.test(wfText);
  out.push(item('security-agent', 'Security Agent set up', continuum ? 'warn' : 'missing',
    continuum ? 'CI workflow has the Continuum scan step; agent space not verifiable locally' : 'no Security Agent step in CI',
    continuum ? 'Confirm with: prism-cli securityagent setup' : 'prism-cli securityagent setup, then install-eval-harness'));

  return out;
}
