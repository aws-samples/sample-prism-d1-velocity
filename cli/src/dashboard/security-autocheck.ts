/**
 * Auto-check of pending Security Agent runs: while a code review, threat model
 * or pentest is recorded as pending in a repo's .prism/results/, the dashboard
 * asks AWS about that job by running the same command a user would, without
 * --wait, in that repo, with the profile and region the server resolves there
 * (the actions' awsArgs: AWS_PROFILE beats a saved aws connect). So the account
 * and setup checks, the result file it completes in place and its redaction
 * are exactly the command's own; this module only decides when to run it and
 * reads back what it wrote.
 *
 *   - code review: `security findings --job <job>` (read-only);
 *   - threat model: `security threats --job <job>` (read-only);
 *   - pentest: `security pentest --status --job <job>`. This one writes to AWS:
 *     once the job has finished it saves the findings and tears down the
 *     environment that run recorded (its own stack, by name; never another
 *     run's), unless the run was started with --keep. The command checks the
 *     account itself (sts get-caller-identity) and only finds a record made in
 *     the account and region it runs in; a job it cannot find there exits 1 and
 *     shows as a failed check. One pentest check at a time, every
 *     PENTEST_CHECK_EVERY_MS, stopped after PENTEST_CHECK_TIMEOUT_MS.
 *
 * Driven by the open page: GET /api/security-check (page.ts, after each load
 * of the data and while a check runs) calls kick(). Nothing runs when nothing
 * is pending, or in a static snapshot (no server). Bounded: one check in flight
 * per job, MAX_IN_FLIGHT overall, no check while a dashboard action holds the
 * lock, a job checked again its interval after AWS said it is still running,
 * and with a doubling backoff after a failed check.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readResultEntries, type ResultEntry } from '../codewatch/results.js';
import { EXIT_PENDING } from '../security/errors.js';
import { maskHome, redact } from '../utils/redact.js';
import { displayCommand, type ScanRepo, type SpawnFn } from './actions.js';
import { runEntries, runTypeOf, type RunType } from './security-runs.js';

/** What the last check of a pending job said. running: AWS reports it still running. error: the check could not run or failed (reason says why). */
export interface CheckState {
  state: 'checking' | 'running' | 'error';
  /** When the last check finished; null while the first one runs. */
  at: string | null;
  /** Why the check failed: redacted, no home path. null unless state is error. */
  reason: string | null;
  /** The fetch command to run by hand in the repo. */
  command: string;
}

/** A job is checked again this long after AWS said it is still running (the page loads its data every 60 s). */
export const CHECK_EVERY_MS = 55_000;
/** After a failed check: CHECK_EVERY_MS doubled per failure, at most this. */
export const MAX_BACKOFF_MS = 30 * 60_000;
/** Checks running at once, across all jobs. */
export const MAX_IN_FLIGHT = 2;
/** A check is stopped after this long (the fetch actions' own timeout). */
export const CHECK_TIMEOUT_MS = 3 * 60_000;
/** A pentest runs for hours (the reference runs took about 2 h 50 min): its job is checked every 5 min. */
export const PENTEST_CHECK_EVERY_MS = 5 * 60_000;
/**
 * A pentest check that finds the job finished tears the environment down: up to 10 min for the agent's network
 * interfaces, up to 30 min for the stack deletion, then both once more (pentest.ts). Stopping it earlier would leave
 * the stack half deleted with no teardown_failed marker.
 */
export const PENTEST_CHECK_TIMEOUT_MS = 90 * 60_000;
const everyMs = (t: RunType) => (t === 'pentest' ? PENTEST_CHECK_EVERY_MS : CHECK_EVERY_MS);
export const checkTimeoutMs = (t: RunType) => (t === 'pentest' ? PENTEST_CHECK_TIMEOUT_MS : CHECK_TIMEOUT_MS);
const MAX_OUTPUT = 64 * 1024;
const MAX_REASON = 300;
/** The fetch commands' own --job rule, with no leading "-" (it follows --job on the command line). */
const FETCH_JOB = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export interface PendingJob { key: string; type: RunType; jobId: string; repo: ScanRepo }

export const checkKey = (type: RunType, jobId: string) => `${type}:${jobId}`;

/** The check command's arguments for one job (after the CLI entry; the server appends --profile/--region). */
export function checkArgs(type: RunType, jobId: string): string[] {
  return type === 'code-review' ? ['security', 'findings', '--job', jobId]
    : type === 'threat-model' ? ['security', 'threats', '--job', jobId]
      : ['security', 'pentest', '--status', '--job', jobId];
}

/** The job id the fetch command takes; null when the record has none it accepts (a pentest that never started a job). */
function jobIdOf(e: ResultEntry): string | null {
  const r = e.result;
  const id = r.kind === 'security-pentest' ? r.pentest?.job_id : (r.security ?? r.threat_model)?.job_id;
  return id && FETCH_JOB.test(id) ? id : null;
}

/** Every pending job in these repos (one per job: a verdict for the same job elsewhere wins, as on the page). Local files only. */
export function pendingJobsIn(repos: ScanRepo[], read: (root: string) => ResultEntry[] = readResultEntries): PendingJob[] {
  const out: PendingJob[] = [];
  for (const repo of repos) {
    for (const e of runEntries(read(repo.path))) {
      const type = runTypeOf(e.result), jobId = jobIdOf(e);
      if (type && jobId && e.result.status === 'pending') out.push({ key: checkKey(type, jobId), type, jobId, repo });
    }
  }
  return out;
}

/** The reason a failed check gives: the command's last `Error:` line (else its last line), redacted, home as ~. */
export function checkReason(output: string, home: string, timedOut: boolean, type: RunType = 'code-review'): string {
  if (timedOut) return `the check did not finish in ${Math.round(checkTimeoutMs(type) / 60_000)} min`;
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith('Error: '));
  const line = (err ?? lines[lines.length - 1] ?? 'the check failed with no output').replace(/^Error:\s*/, '');
  const text = maskHome(redact(line), home);
  return text.length > MAX_REASON ? text.slice(0, MAX_REASON - 1) + '…' : text;
}

export interface CheckRun { code: number | null; output: string; timedOut: boolean }

export interface AutoCheckDeps {
  repos(): Promise<ScanRepo[]>;
  read?: (root: string) => ResultEntry[];
  /** Runs the fetch command for one job in its repo. Default: spawnCheck. */
  run(job: PendingJob, args: string[]): Promise<CheckRun>;
  /** Called when what the page shows changed (a run completed, a check failed or started saying "running"). */
  onChange(): void;
  /** True while a dashboard action holds the lock: no check starts then (it may be fetching the same job). */
  busy?: () => boolean;
  home: string;
  now?: () => number;
}

interface Entry { job: PendingJob; inFlight: boolean; nextAt: number; failures: number; state: CheckState }

/** pending: jobs pending; checking: checks in flight; due: checks due but held back (an action runs, or MAX_IN_FLIGHT): the page asks again soon. */
export interface KickAnswer { pending: number; checking: number; due: number; generation: number }

export class SecurityAutoCheck {
  private jobs = new Map<string, Entry>();
  /** Bumped on every change the page should redraw for; the payload carries it (security_check_gen). */
  generation = 0;
  constructor(private d: AutoCheckDeps) {}

  private now() { return (this.d.now ?? Date.now)(); }

  /** The last check of a job, or null when none ran (or it is no longer pending). */
  stateOf(type: RunType, jobId: string): CheckState | null {
    return this.jobs.get(checkKey(type, jobId))?.state ?? null;
  }

  private changed() { this.generation++; this.d.onChange(); }

  /** True while a pentest check runs: it may be tearing an environment down, so the pentest actions wait for it. */
  pentestRunning(): boolean {
    return [...this.jobs.values()].some((e) => e.inFlight && e.job.type === 'pentest');
  }

  /** Starts the checks that are due (never more than one per job), and answers at once. */
  async kick(): Promise<KickAnswer> {
    let pending: PendingJob[];
    // A repo list or result file that cannot be read now: start nothing, answer what is known (the page asks again).
    try { pending = pendingJobsIn(await this.d.repos(), this.d.read); } catch {
      return { pending: this.jobs.size, checking: [...this.jobs.values()].filter((e) => e.inFlight).length, due: 0, generation: this.generation };
    }
    const keys = new Set(pending.map((j) => j.key));
    for (const k of [...this.jobs.keys()]) if (!keys.has(k) && !this.jobs.get(k)!.inFlight) this.jobs.delete(k);
    const now = this.now();
    let inFlight = [...this.jobs.values()].filter((e) => e.inFlight).length, due = 0;
    let pentests = this.pentestRunning();
    for (const job of pending) {
      let e = this.jobs.get(job.key);
      if (!e) {
        e = { job, inFlight: false, nextAt: 0, failures: 0, state: { state: 'checking', at: null, reason: null, command: displayCommand(checkArgs(job.type, job.jobId)) } };
        this.jobs.set(job.key, e);
      }
      e.job = job;
      if (e.inFlight || now < e.nextAt) continue;
      // A pentest check can write to AWS (a teardown): one at a time.
      if (inFlight >= MAX_IN_FLIGHT || this.d.busy?.() || (job.type === 'pentest' && pentests)) { due++; continue; }
      inFlight++;
      if (job.type === 'pentest') pentests = true;
      this.start(e);
    }
    return { pending: pending.length, checking: inFlight, due, generation: this.generation };
  }

  private start(e: Entry) {
    e.inFlight = true;
    const { job } = e;
    const done = (res: CheckRun) => {
      let r = res;
      e.inFlight = false;
      const now = this.now();
      // What the command wrote decides, not its exit code alone: a FAILED job exits 1 and still saves its verdict.
      let still: boolean;
      try { still = pendingJobsIn([job.repo], this.d.read).some((j) => j.key === job.key); } catch (err) {
        r = { code: 1, output: `Error: could not read the repo's results: ${(err as Error).message}`, timedOut: false };
        still = true;
      }
      if (!still) { this.jobs.delete(job.key); this.changed(); return; }
      const before = e.state.state, at = new Date(now).toISOString();
      // pentest --status exits 0 while the job runs (it prints "Still running"); the record still being pending says so.
      if (r.code === EXIT_PENDING || (job.type === 'pentest' && r.code === 0 && !r.timedOut)) {
        e.failures = 0;
        e.nextAt = now + everyMs(job.type);
        e.state = { ...e.state, state: 'running', at, reason: null };
        if (before !== 'running') this.changed();
        return;
      }
      e.failures++;
      e.nextAt = now + Math.min(everyMs(job.type) * 2 ** e.failures, MAX_BACKOFF_MS);
      const reason = checkReason(r.output, this.d.home, r.timedOut, job.type);
      const same = before === 'error' && e.state.reason === reason;
      e.state = { ...e.state, state: 'error', at, reason };
      if (!same) this.changed();
    };
    this.d.run(job, checkArgs(job.type, job.jobId)).then(done, (err) => done({ code: 1, output: `Error: could not run the check: ${(err as Error).message}`, timedOut: false }));
  }
}

/**
 * The default runner: this CLI's own binary with fixed arguments, the job id
 * (checked by FETCH_JOB) and the server's --profile/--region for the repo; in
 * the repo, no shell, stdin closed, stopped after checkTimeoutMs. `stop()`
 * ends every running check (the stdio host went away).
 */
export function spawnCheck(o: { execPath: string; entry: string; awsArgs: (repo: ScanRepo) => string[]; spawn?: SpawnFn }) {
  const children = new Set<ChildProcess>();
  const run = (job: PendingJob, args: string[]): Promise<CheckRun> => new Promise((resolve) => {
    let out = '', timedOut = false, settled = false;
    const finish = (code: number | null) => { if (settled) return; settled = true; clearTimeout(timer); children.delete(child); resolve({ code, output: out, timedOut }); };
    const child = (o.spawn ?? nodeSpawn)(o.execPath, [o.entry, ...args, ...o.awsArgs(job.repo)], {
      cwd: job.repo.path, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', PRISM_NO_UPDATE_CHECK: '1' },
    });
    children.add(child);
    const add = (b: Buffer | string) => { out += b.toString(); if (out.length > MAX_OUTPUT) out = out.slice(-MAX_OUTPUT); };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, checkTimeoutMs(job.type));
    timer.unref();
    child.on('error', (e) => { add(`Error: could not run the check: ${e.message}\n`); finish(1); });
    // 'close': after the output pipes have drained, so the last Error: line is read.
    child.on('close', (code) => finish(code));
  });
  return { run, stop: () => { for (const c of children) c.kill('SIGTERM'); } };
}
