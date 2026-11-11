/**
 * The Setup page's Run buttons: a fixed allowlist of action ids, each mapped
 * here (server side) to a fixed argv for this CLI's own binary.
 *
 * Safety properties, enforced in start():
 *   - spawn(process.execPath, [cli entry, ...fixed args]) with shell:false and
 *     stdin closed, so prompts take their no-terminal path and nothing is parsed
 *     by a shell;
 *   - the request names an action id and nothing else free-form: a repo is an
 *     id resolved against the dashboard's own scan list (never a client path),
 *     and the only text input is a collector URL for team mode, validated as
 *     https with a hostname, no userinfo, at most 2048 characters;
 *   - one action at a time, each with a timeout;
 *   - output is redacted before it leaves the server, and every run is
 *     appended to ~/.prism/logs/dashboard-actions.log (time, id, repo name,
 *     exit code; never output or URLs);
 *   - no action writes to AWS. aws check and team info are read-only;
 *     AWS-writing commands are copy-only on the page.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ActionId = 'codewatch-repo' | 'codewatch-global' | 'codeburn-local' | 'codeburn-systemd' | 'codeburn-team'
  | 'codeburn-remove' | 'codeburn-status' | 'aws-check' | 'team-info';

export interface ActionDef {
  label: string;
  /** Fixed CLI arguments after the entry script. codeburn-team appends the validated URL. */
  args: readonly string[];
  /** Runs inside a repo picked from the scan list. */
  repo?: true;
  /** Takes the collector URL. */
  url?: true;
  /** Needs `confirm: true` in the request (a second confirmation on the page). */
  confirm?: true;
  /** Makes read-only AWS calls (describe/get/list). No action writes to AWS. */
  readOnlyAws?: true;
  /** Linux with a working `systemctl --user` only. */
  systemd?: true;
  timeoutMs: number;
}

const MIN = 60_000;
export const ACTIONS: Record<ActionId, ActionDef> = {
  'codewatch-repo': { label: 'Enable codewatch in this repo', args: ['enable', 'codewatch'], repo: true, timeoutMs: 2 * MIN },
  'codewatch-global': { label: 'Enable codewatch for every repo', args: ['enable', 'codewatch', '--global'], timeoutMs: 2 * MIN },
  'codeburn-local': { label: 'Keep usage local', args: ['enable', 'codeburn', '--local'], timeoutMs: 2 * MIN },
  'codeburn-systemd': { label: 'Schedule with a systemd user timer', args: ['enable', 'codeburn', '--schedule', 'systemd'], systemd: true, timeoutMs: 5 * MIN },
  // codeburn sync setup opens a browser to sign in, so this one gets longer.
  'codeburn-team': { label: "Sync to my team's PRISM", args: ['enable', 'codeburn', '--url'], url: true, timeoutMs: 10 * MIN },
  'codeburn-remove': { label: 'Remove the sync schedule', args: ['enable', 'codeburn', '--remove'], confirm: true, timeoutMs: 2 * MIN },
  'codeburn-status': { label: 'codeburn status', args: ['enable', 'codeburn', '--status'], timeoutMs: MIN },
  'aws-check': { label: 'AWS account check (read-only)', args: ['aws', 'check'], readOnlyAws: true, timeoutMs: 10 * MIN },
  'team-info': { label: 'Team stack info (read-only)', args: ['team', 'info'], readOnlyAws: true, timeoutMs: 2 * MIN },
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
  platform: NodeJS.Platform;
  spawn?: SpawnFn;
  now?: () => Date;
  /** Called after each action finishes (the dashboard drops its cached payload). */
  onDone?: () => void;
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
const ALLOWED_KEYS = new Set(['action', 'repo', 'url', 'confirm']);

/** `prism-cli <args>` as shown on the page. Arguments are fixed words or the validated https URL. */
export function displayCommand(args: readonly string[]): string {
  return ['prism-cli', ...args.map((a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))].join(' ');
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
    return !ACTIONS[id].systemd || (this.d.platform === 'linux' && this.d.systemdAvailable());
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
    if (def.confirm && b.confirm !== true) return bad('this action needs confirm: true');
    if (b.confirm !== undefined && typeof b.confirm !== 'boolean') return bad('confirm must be true or false');
    if (this.busy) return bad('another action is running; wait for it to finish', 409);

    const args = [...def.args, ...(def.url ? [b.url as string] : [])];
    const cwd = repo ? repo.path : this.d.cwd;
    const now = this.d.now ?? (() => new Date());
    this.busy = true;
    const runId = ++this.seq;
    const st = this.cur = {
      state: 'running' as const, runId, action: id, repo: repo?.name ?? null, command: displayCommand(args), cwd,
      buf: '', exitCode: null, timedOut: false, startedAt: now().toISOString(), finishedAt: null,
    } as ActionStatus & { buf: string };
    const add = (chunk: Buffer | string) => {
      st.buf += chunk.toString();
      if (st.buf.length > MAX_OUTPUT) st.buf = '[earlier output trimmed]\n' + st.buf.slice(-MAX_OUTPUT);
    };
    let child: ChildProcess;
    try {
      child = (this.d.spawn ?? nodeSpawn)(this.d.execPath, [this.d.entry, ...args], {
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
