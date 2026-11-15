/**
 * The Settings page's Run buttons: a fixed allowlist of action ids, each mapped
 * here (server side) to a fixed argv for this CLI's own binary, or for npm in
 * the one update action (`npm install -g @prism-d1/cli@latest`).
 *
 * Safety properties, enforced in start():
 *   - spawn(process.execPath, [cli entry, ...fixed args]) (or npm's path from
 *     PATH with fixed args) with shell:false and
 *     stdin closed, so prompts take their no-terminal path and nothing is parsed
 *     by a shell;
 *   - the request names an action id and nothing else free-form: a repo is an
 *     id resolved against the dashboard's own scan list (never a client path),
 *     the only text input is a collector URL for team mode, validated as
 *     https with a hostname, no userinfo, at most 2048 characters, and
 *     aws-connect's profile and region must each be one of the names the
 *     server lists itself (awsChoices: section names of ~/.aws/config and
 *     ~/.aws/credentials, read fresh; the fixed region list);
 *   - one action at a time, each with a timeout;
 *   - output is redacted before it leaves the server, and every run is
 *     appended to ~/.prism/logs/dashboard-actions.log (time, id, repo name,
 *     exit code; never output or URLs);
 *   - only two kinds of action write to AWS, both from the Security Agent
 *     page: security code-review --no-wait and security threat-model
 *     --no-wait (an S3 upload of the repo at HEAD and one started job). They
 *     need confirm: true and a current agent-space lookup for the repo's
 *     account and region (writeGate), and the page's dialog names the
 *     account, region and scan bucket. Every other AWS-writing command
 *     (enable security, security pentest) stays copy-only on the page;
 *   - AWS actions get --profile and --region from the server's own
 *     resolution for that repo (awsArgs), or from the connected account
 *     (connectionArgs, AccountGuard), never from the request; aws-connect is
 *     the one exception above.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_RE, REGION_RE } from '../aws/connection.js';

export type ActionId = 'codewatch-repo' | 'codewatch-global' | 'codeburn-local' | 'codeburn-systemd' | 'codeburn-team'
  | 'codeburn-remove' | 'codeburn-status' | 'team-info'
  | 'aws-connect' | 'aws-connect-status' | 'aws-disconnect' | 'accountguard-check' | 'accountguard-recommend'
  | 'agent-hooks-kiro' | 'agent-hooks-kiro-global' | 'agent-hooks-claude' | 'agent-hooks-claude-global'
  | 'agent-hooks-kiro-remove' | 'agent-hooks-kiro-global-remove' | 'agent-hooks-claude-remove' | 'agent-hooks-claude-global-remove'
  | 'kirocrew-app' | 'update-cli'
  | 'security-status' | 'security-dry-run' | 'security-findings' | 'security-threats' | 'security-pentest-findings'
  | 'security-code-review' | 'security-code-review-full' | 'security-threat-model';

export interface ActionDef {
  label: string;
  /** Fixed arguments: after this CLI's entry script, or after `npm` when program is npm. codeburn-team appends the validated URL. */
  args: readonly string[];
  /** Runs npm (found on PATH) instead of this CLI. Not offered on Windows, where npm is a .cmd that needs a shell. */
  program?: 'npm';
  /** Runs inside a repo picked from the scan list. */
  repo?: true;
  /** Takes the collector URL. */
  url?: true;
  /** Needs `confirm: true` in the request (a second confirmation on the page). */
  confirm?: true;
  /** Makes read-only AWS calls (describe/get/list) only. */
  readOnlyAws?: true;
  /** Linux with a working `systemctl --user` only. */
  systemd?: true;
  /** Installs software from the npm registry (shown in the confirm dialog). */
  installs?: true;
  /** Runs in the repo with --profile and --region appended from the server's resolution for that repo (RunnerDeps.awsArgs). */
  awsTarget?: true;
  /** Writes to AWS (an S3 upload and a started job). Needs confirm and a passing RunnerDeps.writeGate. */
  writesAws?: true;
  /** One line the confirm dialog adds (what else the run does on this machine). */
  note?: string;
  /** Takes `profile` and `region` from the request, each checked against the server's own lists (RunnerDeps.awsChoices). */
  choose?: true;
  /** Appends --profile/--region of the connected account (RunnerDeps.connectionArgs); refused when none is connected. */
  connected?: true;
  /** Runs in the home directory, so account-level results land in ~/.prism/results/. */
  inHome?: true;
  /** With confirm: the checkbox text in the page's dialog. */
  confirmLabel?: string;
  timeoutMs: number;
}

/** The package the update action installs. A fixed string: the page sends only the action id. */
export const UPDATE_PACKAGE = '@prism-d1/cli@latest';

const MIN = 60_000;
/** enable agent-hooks for one client and scope; project scope runs in the repo the dashboard started in. */
const hooks = (client: 'kiro' | 'claude', global: boolean, remove: boolean): ActionDef => ({
  label: `${remove ? 'Remove' : 'Install'} the ${client} agent hooks (${global ? 'global' : 'this project'})`,
  args: ['enable', 'agent-hooks', '--client', client, ...(global ? ['--global'] : []), ...(remove ? ['--uninstall'] : [])],
  timeoutMs: MIN,
});
export const ACTIONS: Record<ActionId, ActionDef> = {
  'codewatch-repo': { label: 'Enable codewatch in this repo', args: ['enable', 'codewatch'], repo: true, timeoutMs: 2 * MIN },
  'codewatch-global': { label: 'Enable codewatch for every repo', args: ['enable', 'codewatch', '--global'], timeoutMs: 2 * MIN },
  'codeburn-local': { label: 'Keep usage local', args: ['enable', 'codeburn', '--local'], timeoutMs: 2 * MIN },
  'codeburn-systemd': { label: 'Schedule with a systemd user timer', args: ['enable', 'codeburn', '--schedule', 'systemd'], systemd: true, timeoutMs: 5 * MIN },
  // codeburn sync setup opens a browser to sign in, so this one gets longer.
  'codeburn-team': { label: "Sync to my team's PRISM", args: ['enable', 'codeburn', '--url'], url: true, timeoutMs: 10 * MIN },
  'codeburn-remove': { label: 'Remove the sync schedule', args: ['enable', 'codeburn', '--remove'], confirm: true, confirmLabel: 'Yes, remove the scheduled codeburn sync push from this machine', timeoutMs: 2 * MIN },
  'codeburn-status': { label: 'codeburn status', args: ['enable', 'codeburn', '--status'], timeoutMs: MIN },
  'team-info': { label: 'Team stack info (read-only)', args: ['team', 'info'], readOnlyAws: true, timeoutMs: 2 * MIN },
  // Settings › AWS: prism-cli aws connect. Read-only in AWS; writes only ~/.prism/aws.json (no credentials).
  'aws-connect': { label: 'Connect the AWS account', args: ['aws', 'connect'], choose: true, readOnlyAws: true, timeoutMs: 2 * MIN,
    note: 'It checks the profile with sts get-caller-identity and reads the account alias, Organizations and the attached IAM policies, then saves the profile name, region, account id and alias in ~/.prism/aws.json. No credentials are stored.' },
  'aws-connect-status': { label: 'Show the saved AWS connection', args: ['aws', 'connect', '--status'], readOnlyAws: true, timeoutMs: MIN },
  'aws-disconnect': { label: 'Disconnect the AWS account', args: ['aws', 'connect', '--clear'], confirm: true, confirmLabel: 'Yes, remove the saved AWS connection from this machine', timeoutMs: MIN,
    note: 'Removes ~/.prism/aws.json. Nothing in AWS is changed; AWS commands then use the default credential chain.' },
  // AccountGuard: the connected account, from ~, so the results land in ~/.prism/results/.
  'accountguard-check': { label: 'Run aws check', args: ['aws', 'check'], connected: true, inHome: true, readOnlyAws: true, timeoutMs: 10 * MIN,
    note: 'Every call is a describe, get or list across IAM, Budgets, Cost Explorer, CloudWatch, GuardDuty, Security Hub, CloudTrail, S3, EC2, CloudFormation, SSM and Bedrock. The result is saved to ~/.prism/results/.' },
  'accountguard-recommend': { label: 'Run aws recommend', args: ['aws', 'recommend'], connected: true, inHome: true, timeoutMs: MIN,
    note: 'No AWS call: it reads the latest aws check result and prints the ranked fixes (the list on this page).' },
  'agent-hooks-kiro': hooks('kiro', false, false),
  'agent-hooks-kiro-global': hooks('kiro', true, false),
  'agent-hooks-claude': hooks('claude', false, false),
  'agent-hooks-claude-global': hooks('claude', true, false),
  'agent-hooks-kiro-remove': hooks('kiro', false, true),
  'agent-hooks-kiro-global-remove': hooks('kiro', true, true),
  'agent-hooks-claude-remove': hooks('claude', false, true),
  'agent-hooks-claude-global-remove': hooks('claude', true, true),
  // --yes: there is no terminal to answer its prompt; the page's confirm dialog is the confirmation.
  'kirocrew-app': { label: 'Install or update the PRISM Kiro Crew app', args: ['enable', 'kirocrew', '--yes'], timeoutMs: 5 * MIN },
  'update-cli': { label: 'Update prism-cli from npm', args: ['i', '-g', UPDATE_PACKAGE], program: 'npm', installs: true, timeoutMs: 10 * MIN },
  // The Security Agent page. Each runs in the picked repo, as a user would run it there.
  'security-status': { label: 'Security Agent status (read-only)', args: ['enable', 'security', '--status'], repo: true, awsTarget: true, readOnlyAws: true, timeoutMs: 3 * MIN },
  'security-dry-run': { label: 'Security Agent setup plan (dry run)', args: ['enable', 'security', '--dry-run'], repo: true, awsTarget: true, readOnlyAws: true, timeoutMs: 10 * MIN,
    note: 'Runs cdk synth and cdk diff on this machine. The first run installs the CDK app\'s npm packages into prism-cli\'s own infra folder.' },
  'security-findings': { label: 'Fetch code review findings', args: ['security', 'findings'], repo: true, awsTarget: true, readOnlyAws: true, timeoutMs: 3 * MIN, note: 'Saves the findings to .prism/results/ in the repo.' },
  'security-threats': { label: 'Fetch threat model threats', args: ['security', 'threats'], repo: true, awsTarget: true, readOnlyAws: true, timeoutMs: 3 * MIN, note: 'Saves the threats to .prism/results/ in the repo.' },
  'security-pentest-findings': { label: 'Fetch pentest findings', args: ['security', 'findings', '--pentest'], repo: true, awsTarget: true, readOnlyAws: true, timeoutMs: 3 * MIN, note: 'Saves the findings to .prism/results/ in the repo.' },
  'security-code-review': { label: 'Start a code review of this branch', args: ['security', 'code-review', '--no-wait'], repo: true, awsTarget: true, writesAws: true, confirm: true, timeoutMs: 5 * MIN },
  'security-code-review-full': { label: 'Start a code review of the whole repo', args: ['security', 'code-review', '--full', '--no-wait'], repo: true, awsTarget: true, writesAws: true, confirm: true, timeoutMs: 5 * MIN },
  'security-threat-model': { label: 'Start a threat model', args: ['security', 'threat-model', '--no-wait'], repo: true, awsTarget: true, writesAws: true, confirm: true, timeoutMs: 5 * MIN },
};

const isActionId = (x: unknown): x is ActionId => typeof x === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, x);

export const MAX_URL_LENGTH = 2048;

/** null when `s` is an acceptable collector URL, else why not. */
export function collectorUrlError(s: unknown): string | null {
  if (typeof s !== 'string' || !s) return 'a collector URL is required';
  if (s.length > MAX_URL_LENGTH) return `the URL is longer than ${MAX_URL_LENGTH} characters`;
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return 'the URL contains spaces or control characters';
  let u: URL;
  try { u = new URL(s); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'https:') return 'the URL must start with https://';
  if (!u.hostname) return 'the URL has no hostname';
  if (u.username || u.password || /^https:\/\/[^/?#]*@/i.test(s)) return 'the URL must not contain a user name or password';
  return null;
}

/** Stable id for a scanned repo: never a path the client could choose. */
export function repoId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * Masks secrets in command output: AWS key ids, key=value secrets, bearer
 * tokens, JWTs, URL userinfo and token-like query parameters.
 * shortcut: pattern-based, so an unusual secret format can slip through; add its pattern when one is seen.
 */
export function redact(s: string): string {
  return s
    .replace(ANSI_RE, '')
    .replace(/\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b((?:aws_)?(?:secret_access_key|session_token|security_token|secret|password|passwd|api[_-]?key|access_token|refresh_token|id_token|client_secret)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&#](?:token|access_token|id_token|code|signature|sig|key|x-amz-[a-z-]+)=)[^&\s#"']+/gi, '$1[REDACTED]');
}

/** This CLI's own entry script: dist/bin/prism-cli.js beside dist/src/dashboard/. */
export function cliEntry(): string {
  return fileURLToPath(new URL('../../bin/prism-cli.js', import.meta.url));
}

export interface ScanRepo { id: string; name: string; path: string }

export type SpawnFn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface RunnerDeps {
  execPath: string;
  entry: string;
  /** Where repo-less actions run (the dashboard's working directory). */
  cwd: string;
  home: string;
  repos(): Promise<ScanRepo[]>;
  systemdAvailable(): boolean;
  /** npm on PATH, for the update action; null (or absent) when there is none. */
  npmPath?: () => string | null;
  platform: NodeJS.Platform;
  spawn?: SpawnFn;
  now?: () => Date;
  /** Called after each action finishes (the dashboard drops its cached payload). */
  onDone?: () => void;
  /** --profile/--region for an awsTarget action in `repo`, resolved by the server. Absent: none appended. */
  awsArgs?: (repo: ScanRepo) => string[];
  /** For a writesAws action: null to allow it, else why not (no current lookup, no space, no bucket, another account). Absent: refused. */
  writeGate?: (id: ActionId, repo: ScanRepo) => string | null | Promise<string | null>;
  /** For aws-connect: the profile names and regions the server lists itself, read fresh on each call. Absent: aws-connect is refused. */
  awsChoices?: () => { profiles: string[]; regions: string[] };
  /** For AccountGuard: --profile/--region of the connected account, or null when none is connected. */
  connectionArgs?: () => string[] | null;
  /** Kill grace after SIGTERM. */
  killGraceMs?: number;
}

export interface ApiResult { status: number; json: unknown }

export interface ActionStatus {
  state: 'idle' | 'running' | 'done';
  runId?: number;
  action?: ActionId;
  repo?: string | null;
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  startedAt?: string;
  finishedAt?: string | null;
}

const MAX_OUTPUT = 256 * 1024;
const ALLOWED_KEYS = new Set(['action', 'repo', 'url', 'confirm', 'profile', 'region']);
/** A value the CLI accepts as a profile or region name (aws/connection.ts) that cannot be read as a flag. */
const argValue = (v: string, re: RegExp) => re.test(v) && !v.startsWith('-');

/** The command as shown on the page: `prism-cli <args>`, or `npm <args>`. Arguments are fixed words or the validated https URL. */
export function displayCommand(args: readonly string[], program: ActionDef['program'] = undefined): string {
  return [program ?? 'prism-cli', ...args.map((a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))].join(' ');
}

export function actionLogPath(home: string): string {
  return join(home, '.prism', 'logs', 'dashboard-actions.log');
}

/** Repo names go into a one-line log: anything but name characters becomes _. */
const logSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

export class ActionRunner {
  private cur: (ActionStatus & { buf: string }) | null = null;
  private busy = false;
  private seq = 0;
  constructor(private d: RunnerDeps) {}

  /** True while an action (or Check now) holds the lock. */
  get running(): boolean { return this.busy; }

  /** Runs `fn` under the same one-at-a-time lock as the actions. */
  async exclusive<T>(fn: () => T | Promise<T>): Promise<ApiResult> {
    if (this.busy) return { status: 409, json: { error: 'another action is running; wait for it to finish' } };
    this.busy = true;
    try { return { status: 200, json: await fn() }; } finally { this.busy = false; }
  }

  available(id: ActionId): boolean {
    const a = ACTIONS[id];
    if (a.program === 'npm') return this.d.platform !== 'win32' && !!this.d.npmPath?.();
    return !a.systemd || (this.d.platform === 'linux' && this.d.systemdAvailable());
  }

  /** Validates the request, then starts the action. 202 with the command, else 4xx with the reason. */
  async start(body: unknown): Promise<ApiResult> {
    const bad = (error: string, status = 400): ApiResult => ({ status, json: { error } });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('expected a JSON object');
    const b = body as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => !ALLOWED_KEYS.has(k));
    if (extra.length) return bad(`unexpected field ${extra[0]}`);
    if (!isActionId(b.action)) return bad('unknown action');
    const id = b.action, def = ACTIONS[id];
    if (!this.available(id)) return bad('this action is not available on this machine');
    let repo: ScanRepo | null = null;
    if (def.repo) {
      if (typeof b.repo !== 'string' || !/^[a-f0-9]{16}$/.test(b.repo)) return bad('repo must be an id from the scan list');
      repo = (await this.d.repos()).find((r) => r.id === b.repo) ?? null;
      if (!repo) return bad('repo is not in the scan list');
    } else if (b.repo !== undefined) return bad('this action does not take a repo');
    if (def.url) {
      const e = collectorUrlError(b.url);
      if (e) return bad(`collector URL: ${e}`);
    } else if (b.url !== undefined) return bad('this action does not take a URL');
    // aws-connect: a profile and a region, each one of the names the server lists itself right now. Nothing else is accepted.
    let chosen: string[] = [];
    if (def.choose) {
      const lists = this.d.awsChoices?.();
      if (!lists) return bad('choosing a profile is not available here');
      if (typeof b.profile !== 'string' || !lists.profiles.includes(b.profile) || !argValue(b.profile, PROFILE_RE)) return bad('profile must be one of the profiles listed on the page');
      if (typeof b.region !== 'string' || !lists.regions.includes(b.region) || !argValue(b.region, REGION_RE)) return bad('region must be one of the regions listed on the page');
      chosen = ['--profile', b.profile, '--region', b.region];
    } else if (b.profile !== undefined || b.region !== undefined) return bad('this action does not take a profile or region');
    if (def.confirm && b.confirm !== true) return bad('this action needs confirm: true');
    if (b.confirm !== undefined && typeof b.confirm !== 'boolean') return bad('confirm must be true or false');
    if (this.busy) return bad('another action is running; wait for it to finish', 409);
    if (def.writesAws) {
      if (!repo) return bad('an AWS-writing action needs a repo');
      // Hold the lock while the gate makes its one read-only call, so nothing else starts in between.
      this.busy = true;
      let why: string | null;
      try { why = this.d.writeGate ? await this.d.writeGate(id, repo) : 'AWS-writing actions are not enabled here'; }
      catch (e) { why = `the write check failed: ${redact((e as Error).message)}`; }
      finally { this.busy = false; }
      if (why) return bad(why, 409);
    }
    const connection = def.connected ? this.d.connectionArgs?.() ?? null : [];
    if (!connection) return bad('no AWS account is connected: connect one in Settings › AWS', 409);
    const target = [...(def.awsTarget && repo && this.d.awsArgs ? this.d.awsArgs(repo) : []), ...connection];
    // Only the two flag names, and values that cannot be read as a flag (no leading '-').
    if (![...target, ...chosen].every((a) => a === '--profile' || a === '--region' || argValue(a, PROFILE_RE))) return bad('the resolved AWS profile or region is not valid');

    const args = [...def.args, ...chosen, ...target, ...(def.url ? [b.url as string] : [])];
    const cwd = repo ? repo.path : def.inHome ? this.d.home : this.d.cwd;
    const now = this.d.now ?? (() => new Date());
    this.busy = true;
    const runId = ++this.seq;
    const st = this.cur = {
      state: 'running' as const, runId, action: id, repo: repo?.name ?? null, command: displayCommand(args, def.program), cwd,
      buf: '', exitCode: null, timedOut: false, startedAt: now().toISOString(), finishedAt: null,
    } as ActionStatus & { buf: string };
    const add = (chunk: Buffer | string) => {
      st.buf += chunk.toString();
      if (st.buf.length > MAX_OUTPUT) st.buf = '[earlier output trimmed]\n' + st.buf.slice(-MAX_OUTPUT);
    };
    let child: ChildProcess;
    try {
      // npm: its own path from PATH, argv only (no shell). Everything else: this CLI's binary.
      const [file, argv] = def.program === 'npm' ? [this.d.npmPath!()!, args] : [this.d.execPath, [this.d.entry, ...args]];
      child = (this.d.spawn ?? nodeSpawn)(file, argv, {
        cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
    } catch (e) {
      add(`could not start: ${(e as Error).message}\n`);
      this.finish(st, 1);
      return { status: 202, json: this.status() };
    }
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    let killer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      st.timedOut = true;
      add(`\n[timed out after ${Math.round(def.timeoutMs / 1000)} s; stopping it]\n`);
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), this.d.killGraceMs ?? 5000);
      killer.unref();
    }, def.timeoutMs);
    timer.unref();
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      this.finish(st, st.timedOut ? 124 : code ?? 1);
    };
    child.on('error', (e) => { add(`could not start: ${e.message}\n`); done(1); });
    child.on('close', (code) => done(code));
    return { status: 202, json: this.status() };
  }

  private finish(st: ActionStatus & { buf: string }, code: number) {
    st.exitCode = code;
    st.state = 'done';
    st.finishedAt = (this.d.now ?? (() => new Date()))().toISOString();
    this.busy = false;
    this.log(st);
    try { this.d.onDone?.(); } catch { /* a refresh hook must not break the runner */ }
  }

  private log(st: ActionStatus) {
    const line = JSON.stringify({ time: st.finishedAt, action: st.action, repo: st.repo ? logSafe(st.repo) : null, exit: st.exitCode }) + '\n';
    const p = actionLogPath(this.d.home);
    try {
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      appendFileSync(p, line, { mode: 0o600 });
    } catch (e) {
      process.stderr.write(`prism dashboard: could not write ${p}: ${(e as Error).message}\n`);
    }
  }

  /** The current or last action, output redacted. */
  status(): ActionStatus {
    const c = this.cur;
    if (!c) return { state: 'idle' };
    const { buf, ...rest } = c;
    return { ...rest, output: redact(buf) };
  }
}
