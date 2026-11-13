/**
 * The live dashboard behind the MCP tools prism_dashboard and
 * prism_dashboard_stop.
 *
 * prism_dashboard starts `prism-cli dashboard` as a child of the MCP server:
 * argv with shell:false, not detached, with `--exit-on-stdin-close`. The
 * server keeps all its own protections (bound to 127.0.0.1, a constant; a
 * per-run token in the URL; Origin and CSRF checks on POST). This module adds
 * no bind option and no other way in.
 *
 * The child ends with the MCP server, three ways: the server kills it when
 * its stdin closes or it gets SIGINT/SIGTERM; a process 'exit' hook kills it;
 * and the child itself exits when its stdin pipe closes, which also covers
 * the MCP server being killed outright.
 *
 * One instance per user: ~/.prism/run/dashboard.json (dir 0700, file 0600)
 * holds the pid, port and URL. The URL holds the token, so it is written only
 * there and returned to the client; it is never logged. A state file whose
 * pid is dead, or whose port does not answer as a PRISM dashboard, is ignored.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { cliEntry } from '../dashboard/actions.js';
import { BIND_HOST } from '../dashboard/server.js';
import { readJson, writePrivateJson } from '../utils/private-json.js';

export const RUN_SCHEMA = 'prism.dashboard-run.v1';
export const START_TIMEOUT_MS = 15_000;
export const STOP_TIMEOUT_MS = 3_000;
export const PROBE_TIMEOUT_MS = 1_000;
/** The URL line `prism-cli dashboard` prints; only a 127.0.0.1 URL is accepted. */
export const URL_LINE = /^\s*(http:\/\/127\.0\.0\.1:(\d{1,5})\/\?token=[A-Za-z0-9_-]{20,})\s*$/m;

export const runStatePath = (home: string) => join(home, '.prism', 'run', 'dashboard.json');

export interface RunState { schema: string; pid: number; port: number; url: string; startedAt: string }

export type SpawnFn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface DashboardDeps {
  home: string;
  cwd: string;
  root?: string;
  env: NodeJS.ProcessEnv;
  /** The CLI to run: node and its entry script (defaultCommand()). */
  command?: { file: string; args: string[] };
  spawn?: SpawnFn;
  probe?: (port: number) => Promise<boolean>;
  alive?: (pid: number) => boolean;
  timeoutMs?: number;
}

/** node + dist/bin/prism-cli.js; from source (tsx), the .ts entry with this process's loader flags. */
export function defaultCommand(): { file: string; args: string[] } {
  const js = cliEntry();
  if (existsSync(js)) return { file: process.execPath, args: [js] };
  return { file: process.execPath, args: [...process.execArgv, js.replace(/\.js$/, '.ts')] };
}

/** True when `pid` is a process this user can signal. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** True when 127.0.0.1:<port> answers an untokened GET / with the dashboard's own 401. */
export function probeDashboard(port: number): Promise<boolean> {
  return new Promise((done) => {
    const req = request({ host: BIND_HOST, port, path: '/', method: 'GET', headers: { Host: `${BIND_HOST}:${port}` }, timeout: PROBE_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (body.length < 512) body += c; });
      res.on('end', () => done(res.statusCode === 401 && body.includes('prism-cli dashboard')));
      res.on('error', () => done(false));
    });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
    req.end();
  });
}

function readState(home: string): RunState | null {
  const s = readJson(runStatePath(home));
  if (!s || s.schema !== RUN_SCHEMA || !Number.isInteger(s.pid) || s.pid <= 0 || !Number.isInteger(s.port) || typeof s.url !== 'string') return null;
  const m = URL_LINE.exec(s.url);
  return m && Number(m[2]) === s.port ? s : null;
}

/** The recorded instance when its pid is alive and its port answers as a dashboard; else null. */
export async function liveInstance(d: DashboardDeps): Promise<RunState | null> {
  const s = readState(d.home);
  if (!s) return null;
  if (!(d.alive ?? pidAlive)(s.pid)) return null;
  return (await (d.probe ?? probeDashboard)(s.port)) ? s : null;
}

/** Children this process started; killed when it exits. */
const children = new Map<number, ChildProcess>();

function clearStateFor(home: string, pid: number): void {
  const s = readState(home);
  if (s && s.pid === pid) rmSync(runStatePath(home), { force: true });
}

/** Kills every dashboard this process started (sync: safe in an 'exit' handler). */
export function killStartedDashboards(home?: string): void {
  for (const [pid, c] of children) {
    try { c.kill('SIGTERM'); } catch { /* already gone */ }
    if (home) clearStateFor(home, pid);
  }
  children.clear();
}

export interface StartResult { url: string; port: number; pid: number; reused: boolean }

/** The running instance's URL, else starts one and waits for its URL line. */
export async function startDashboard(d: DashboardDeps): Promise<StartResult> {
  const cur = await liveInstance(d);
  if (cur) return { url: cur.url, port: cur.port, pid: cur.pid, reused: true };
  const cmd = d.command ?? defaultCommand();
  const args = [...cmd.args, 'dashboard', '--no-open', '--exit-on-stdin-close', ...(d.root ? ['--root', d.root] : [])];
  const child = (d.spawn ?? nodeSpawn)(cmd.file, args, { cwd: d.cwd, env: d.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: false });
  const pid = child.pid;
  if (!pid) throw new Error('could not start prism-cli dashboard');
  children.set(pid, child);
  child.on('exit', () => { children.delete(pid); clearStateFor(d.home, pid); });
  // The token is in stdout: it is read for the URL and never forwarded or logged.
  let out = '';
  let lastErr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c: string) => {
    for (const l of c.split('\n')) if (l.trim()) { lastErr = l.trim().slice(0, 300); process.stderr.write(`prism dashboard: ${lastErr}\n`); }
  });
  const url = await new Promise<{ url: string; port: number }>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`prism-cli dashboard printed no URL within ${Math.round((d.timeoutMs ?? START_TIMEOUT_MS) / 1000)} s`)), d.timeoutMs ?? START_TIMEOUT_MS);
    const fail = (e: Error) => { clearTimeout(timer); try { child.kill('SIGTERM'); } catch { /* gone */ } reject(e); };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      if (out.length > 64 * 1024) return;
      out += c;
      const m = URL_LINE.exec(out);
      if (m) { clearTimeout(timer); resolve({ url: m[1], port: Number(m[2]) }); }
    });
    child.on('exit', (code) => fail(new Error(`prism-cli dashboard exited (code ${code}) before printing its URL${lastErr ? `: ${lastErr}` : ''}`)));
    child.on('error', (e) => fail(new Error(`could not start prism-cli dashboard: ${e.message}`)));
  });
  child.stdout?.resume();
  writePrivateJson(runStatePath(d.home), { schema: RUN_SCHEMA, pid, port: url.port, url: url.url, startedAt: new Date().toISOString() } satisfies RunState);
  return { ...url, pid, reused: false };
}

export interface StopResult { stopped: boolean; note: string }

/** Stops the instance in the state file (one started by prism_dashboard), never any other dashboard. */
export async function stopDashboard(d: DashboardDeps): Promise<StopResult> {
  const s = readState(d.home);
  if (!s) return { stopped: false, note: 'no dashboard started by prism_dashboard is recorded' };
  const live = await liveInstance(d);
  if (!live) {
    rmSync(runStatePath(d.home), { force: true });
    return { stopped: false, note: 'the recorded dashboard was no longer running; its state file was removed' };
  }
  const own = children.get(live.pid);
  try { if (own) own.kill('SIGTERM'); else process.kill(live.pid, 'SIGTERM'); } catch { /* exited meanwhile */ }
  const alive = d.alive ?? pidAlive;
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && alive(live.pid)) await new Promise((r) => setTimeout(r, 50));
  rmSync(runStatePath(d.home), { force: true });
  return alive(live.pid)
    ? { stopped: false, note: `sent SIGTERM to pid ${live.pid}, but it is still running` }
    : { stopped: true, note: `stopped the dashboard on ${BIND_HOST}:${live.port}` };
}

/** What to tell the user when the browser is not opened here. */
export function remoteNote(port: number): string {
  return `Not opened: no display here (an SSH session). In a VS Code, Kiro or Cursor Remote-SSH terminal the editor usually forwards the port, so Ctrl/Cmd+click the URL (it is not guaranteed). From plain SSH, run on your own machine: ssh -L ${port}:127.0.0.1:${port} <host>, then open the URL there.`;
}
