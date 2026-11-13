/**
 * Setup checklist. Local evidence only: no AWS, GitHub or GitLab calls, and no
 * credential file is opened (only its existence is checked).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkTool } from '../utils/tool-check.js';
import { ENABLE_CODEBURN_CMD, lastSync, scheduleExists, schedulerName, systemdUserAvailable } from '../utils/otel-sync-schedule.js';
import { type PrismResult } from '../codewatch/results.js';
import { HOOK_MARKER, MANAGED_HOOKS } from '../codewatch/hooks.js';
import { gitleaksInstallHint } from '../codewatch/gitleaks.js';
import { globalHooksDir, globalStatus, OPT_OUT_KEY, type GlobalStatus } from '../codewatch/globalHooks.js';
import { realpathSync } from 'node:fs';
import { modelLabel, readEvalConfig, resolveReviewModel, reviewModelGitKey, REVIEWER_GIT_CONFIG_KEY } from '../codewatch/config.js';
import { detectReviewers, resolveReviewer, REVIEWER_IDS, type ReviewerId } from '../codewatch/reviewers/index.js';
import { readSecurityMarker } from '../security/marker.js';
import { configuredSyncUrl } from '../utils/otel-sync-schedule.js';
import { ENABLE_KIROCREW_CMD, kirocrewAppState, type KirocrewAppState } from '../utils/kirocrew.js';
import { appOutdated } from '../commands/_top/version.js';
import { effectiveMode, LOCAL_MODE_HELP, PLATFORM_TEAM_HELP, TEAM_NO_URL_HELP, TEAM_URL_CMD, type CheckHelp } from '../utils/sync-mode.js';

/** info: nothing to fix (a choice, like local-only sync); counted as neither ok nor a warning. */
export type CheckStatus = 'ok' | 'info' | 'warn' | 'missing';
export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** One-line fix; empty when status is ok or info, except an optional item's copy-only command (kirocrew-app). */
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
  /** File that remembers tool versions by binary mtime and size (tool-check.ts cachedToolVersion); unset runs the probes. */
  versionCache?: string;
  /** Kiro Crew app versions; null when kirocrew is not on this machine (then there is no row). */
  kirocrewApp?: () => KirocrewAppState | null;
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
      // Optional, so info: it is not counted as a setup warning. The command stays in the detail.
      return item('codewatch-global', label, 'info', `not installed (optional: covers every repo at once with ${GLOBAL_INSTALL_CMD})`);
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

/** The optional Kiro Crew app row: info in every state, with the copy-only command when there is something to install. */
export function kirocrewAppCheck(s: KirocrewAppState): CheckItem {
  const label = 'Kiro Crew app';
  const row = (detail: string, fix = ''): CheckItem => ({ id: 'kirocrew-app', label, status: 'info', detail, fix });
  if (!s.installed) return row('not installed (optional: a PRISM page, the PRISM tools and a daily digest in Kiro Crew)', ENABLE_KIROCREW_CMD);
  if (appOutdated(s)) return row(`outdated: ${s.installed} installed, ${s.bundled} bundled with this prism-cli`, ENABLE_KIROCREW_CMD);
  if (s.bundled && s.installed === s.bundled) return row(`${s.installed} installed (current)`);
  return row(`${s.installed} installed`);
}

/** Checks that do not depend on a repository. */
export function machineChecks(deps: MachineDeps = {}): CheckItem[] {
  const env = deps.env || process.env;
  const home = deps.home || homedir();
  const out: CheckItem[] = [];

  const cb = checkTool('codeburn', { pathEnv: deps.pathEnv, versionCache: deps.versionCache });
  out.push(item('codeburn', 'codeburn installed', cb.installed ? 'ok' : 'missing',
    cb.installed ? (cb.version || 'version unknown') : 'not on PATH', ENABLE_CODEBURN_CMD));

  out.push(codeburnSyncCheck(home, deps));

  const gl = checkTool('gitleaks', { pathEnv: deps.pathEnv, versionArgs: ['version'], versionCache: deps.versionCache });
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
  const kc = (deps.kirocrewApp || (() => kirocrewAppState({ pathEnv: deps.pathEnv, home, env })))();
  if (kc) out.push(kirocrewAppCheck(kc));
  return out;
}

/**
 * What codewatchSetup needs from git, read with one `git config --list` per
 * repo instead of one git call per question. Each field gives the same answer
 * as the call named beside it.
 */
export interface GitFacts {
  /** `git rev-parse --path-format=absolute --git-path hooks`, else <repo>/.git/hooks. */
  hooksDir: string;
  /** `git config --get prism.reviewer` (the last value wins), or null. */
  reviewer: string | null;
  /** `git config --get prism.<tool>Model` per reviewer (the last value wins), or null. */
  reviewModels: Record<ReviewerId, string | null>;
  /** `git config --bool --get prism.codewatch` is false. */
  optedOut: boolean;
  /** `git config --local --get core.hooksPath` (this repo's own file, no includes), or null when unset or empty. */
  localHooksPath: string | null;
}

/** Runs `git -C <repo> <args>`; stdout, or null when git fails. Injected in tests. */
export type GitRunner = (repo: string, args: string[]) => Promise<string | null>;

export const gitRunner: GitRunner = (repo, args) => new Promise((done) => {
  execFile('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => done(err ? null : stdout));
});

export const GIT_CONFIG_LIST = ['config', '--list', '--show-origin', '--show-scope', '-z'];

export interface ConfigEntry { scope: string; origin: string; key: string; value: string | null }

/** `git config --list --show-origin --show-scope -z`: scope NUL origin NUL key[LF value] NUL; a key with no `=` has no value. */
export function parseConfigList(out: string): ConfigEntry[] {
  const parts = out.split('\0');
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const kv = parts[i + 2];
    const nl = kv.indexOf('\n');
    entries.push({ scope: parts[i], origin: parts[i + 1].replace(/^file:/, ''), key: (nl < 0 ? kv : kv.slice(0, nl)).toLowerCase(), value: nl < 0 ? null : kv.slice(nl + 1) });
  }
  return entries;
}

/**
 * `git config --bool`: true or false, or null where git would fail. A key with
 * no value is true; integers count as true unless zero (git also accepts k/m/g suffixes).
 */
export function gitBool(v: string | null): boolean | null {
  if (v === null) return true;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === 'no' || s === 'off' || s === '') return false;
  const n = /^([+-]?\d+)[kmg]?$/.exec(s);
  return n ? Number(n[1]) !== 0 : null;
}

/** The repo's common git directory (where hooks/ and config live), read from .git the way git does; null when it cannot be read. */
export function gitCommonDir(repo: string): string | null {
  const dotGit = join(repo, '.git');
  let gitDir: string;
  try {
    if (statSync(dotGit).isDirectory()) gitDir = dotGit;
    else {
      const m = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      gitDir = resolve(repo, m[1].trim());
    }
  } catch { return null; }
  const common = readText(join(gitDir, 'commondir'));
  return common === null ? gitDir : resolve(gitDir, common.trim());
}

const lastValue = (entries: ConfigEntry[], key: string) => {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].key === key) return entries[i];
  return undefined;
};

/**
 * GitFacts from a `git config --list` result (null when that call failed).
 * Returns hooksDir undefined when only git can say (a `~user` path, an
 * unreadable .git); the caller then asks rev-parse.
 */
export function gitFactsFromConfig(repo: string, out: string | null, home: string = homedir()): Omit<GitFacts, 'hooksDir'> & { hooksDir: string | undefined } {
  const fallback = resolve(repo, '.git/hooks');
  const entries = out === null ? null : parseConfigList(out);
  const noModels = { kiro: null, claude: null };
  if (!entries) return { hooksDir: fallback, reviewer: null, reviewModels: noModels, optedOut: false, localHooksPath: null };
  const reviewer = lastValue(entries, REVIEWER_GIT_CONFIG_KEY.toLowerCase());
  const reviewModels: Record<ReviewerId, string | null> = { ...noModels };
  for (const id of REVIEWER_IDS) {
    const e = lastValue(entries, reviewModelGitKey(id).toLowerCase());
    reviewModels[id] = e ? (e.value ?? '').trim() || null : null;
  }
  const optOut = lastValue(entries, OPT_OUT_KEY.toLowerCase());
  const local = entries.filter((e) => e.scope === 'local');
  const common = gitCommonDir(repo);
  // --local reads only <common dir>/config; an include from it has scope local too but another origin.
  const localFile = common && join(common, 'config');
  const ownLocal = localFile ? local.filter((e) => e.key === 'core.hookspath' && samePath(resolve(repo, e.origin), localFile)) : [];
  const localHooksPath = (ownLocal.length ? (ownLocal[ownLocal.length - 1].value ?? '').trim() : '') || null;

  let hooksDir: string | undefined;
  const hp = lastValue(entries, 'core.hookspath');
  // rev-parse fails, and the old code used the fallback, when git ignored the repo (not a repo, or not
  // trusted) or when any core.hooksPath has no value ("missing value for 'core.hookspath'").
  if (!local.length || entries.some((e) => e.key === 'core.hookspath' && e.value === null)) hooksDir = fallback;
  else if (hp) {
    const v = hp.value!;
    if (v === '') hooksDir = fallback; // git: "The empty string is not a valid path"
    else if (v === '~' || v.startsWith('~/')) hooksDir = join(home, v.slice(1));
    else if (v.startsWith('~')) hooksDir = undefined;
    else hooksDir = resolve(repo, v);
  } else hooksDir = common ? join(common, 'hooks') : undefined;

  return {
    hooksDir,
    reviewer: reviewer ? (reviewer.value ?? '').trim() : null,
    reviewModels,
    optedOut: optOut ? gitBool(optOut.value) === false : false,
    localHooksPath,
  };
}

/** GitFacts for a repo: one `git config --list`, plus a rev-parse only in the rare case gitFactsFromConfig cannot decide. */
export async function readGitFacts(repo: string, run: GitRunner = gitRunner, home: string = homedir()): Promise<GitFacts> {
  const f = gitFactsFromConfig(repo, await run(repo, GIT_CONFIG_LIST), home);
  if (f.hooksDir !== undefined) return f as GitFacts;
  const r = await run(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  return { ...f, hooksDir: (r && r.trim()) || resolve(repo, '.git/hooks') };
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
  /** Review model label the pre-push review would use: an id, `auto` (kiro) or `default` (Claude Code). */
  model: string;
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
export async function codewatchSetup(repo: string, deps: { pathEnv?: string; global?: GlobalStatus; git?: GitRunner; home?: string } = {}): Promise<CodewatchSetup> {
  const g = deps.global || globalStatus();
  const facts = await readGitFacts(repo, deps.git, deps.home);
  return codewatchSetupFrom(repo, facts, g, deps.pathEnv);
}

/** codewatchSetup from facts already read. */
export function codewatchSetupFrom(repo: string, facts: GitFacts, g: GlobalStatus, pathEnv?: string): CodewatchSetup {
  const hooksDir = facts.hooksDir;
  const viaGlobal = g.state === 'installed' && samePath(hooksDir, globalHooksDir());
  const state = MANAGED_HOOKS.map((h) => {
    const t = readText(resolve(hooksDir, h));
    return { h, ours: !!t && t.includes(HOOK_MARKER), old: !!t && !t.includes(HOOK_MARKER) && t.includes('# prism-cli enable security') };
  });
  const choice = resolveReviewer({
    gitConfigValue: facts.reviewer,
    prismConfigValue: readEvalConfig(repo).reviewer,
    available: detectReviewers(pathEnv),
  });
  const reviewer = choice.id;
  const evalCfg = readEvalConfig(repo);
  const model = modelLabel(reviewer, resolveReviewModel({
    reviewer, prismConfigValue: evalCfg.model, prismConfigReviewer: evalCfg.reviewer, gitConfigValue: reviewer ? facts.reviewModels[reviewer] : null,
  }).model);
  const base = { reviewer, reviewerSource: choice.source, model, global: viaGlobal };
  if (facts.optedOut) {
    return { ...base, status: 'opted-out', fix: '', detail: `opted out (git config ${OPT_OUT_KEY} false)` };
  }
  if (state.every((x) => x.ours)) {
    const where = viaGlobal ? 'covered by the global hooks (global)' : 'pre-commit and pre-push installed';
    return { ...base, status: 'ok', fix: '', detail: reviewer ? where : `${where}; no reviewer on PATH (install kiro-cli or Claude Code)` };
  }
  const local = facts.localHooksPath;
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
