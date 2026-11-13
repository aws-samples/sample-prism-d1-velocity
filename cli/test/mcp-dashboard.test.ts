/**
 * Tests for prism_dashboard / prism_dashboard_stop (src/mcp/dashboard-process.ts):
 * a real `prism-cli dashboard` child in a throwaway home, the one-instance
 * state file, stop, the opener rule, and the child ending with the MCP server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive, probeDashboard, runStatePath, startDashboard, stopDashboard, URL_LINE, type DashboardDeps } from '../src/mcp/dashboard-process.js';
import { callTool, type ToolContext } from '../src/mcp/tools.js';
import { openBrowser } from '../src/dashboard/snapshot.js';
import { writePrivateJson } from '../src/utils/private-json.js';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = ['--import', import.meta.resolve('tsx'), join(CLI_DIR, 'bin', 'prism-cli.ts')];
process.env.GIT_CONFIG_GLOBAL = join(mkdtempSync(join(tmpdir(), 'prism-dash-gcfg-')), 'gitconfig');

function home() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), 'prism-dash-home-')));
  mkdirSync(join(h, 'work'));
  return h;
}
const deps = (h: string, over: Partial<DashboardDeps> = {}): DashboardDeps => ({
  home: h, cwd: h, root: join(h, 'work'), env: { PATH: process.env.PATH, HOME: h, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL },
  command: { file: process.execPath, args: TSX }, timeoutMs: 30_000, ...over,
});
const status = (url: string) => new Promise<number>((done) => {
  get(url, (r) => { r.resume(); done(r.statusCode ?? 0); }).on('error', () => done(0));
});
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

test('start: a 127.0.0.1 URL with a token; second call reuses it; stop kills it; state file 0600', async () => {
  const h = home();
  const d = deps(h);
  const a = await startDashboard(d);
  try {
    assert.match(a.url, URL_LINE);
    assert.ok(a.url.startsWith(`http://127.0.0.1:${a.port}/?token=`));
    assert.equal(a.reused, false);
    assert.equal(await status(a.url), 303, 'token accepted');
    assert.equal(await status(`http://127.0.0.1:${a.port}/`), 401, 'no token, no page');
    const f = runStatePath(h);
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(f)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).pid, a.pid);

    const b = await startDashboard(d);
    assert.deepEqual({ url: b.url, pid: b.pid, reused: b.reused }, { url: a.url, pid: a.pid, reused: true });
  } finally {
    const s = await stopDashboard(d);
    assert.equal(s.stopped, true, s.note);
  }
  assert.equal(pidAlive(a.pid), false);
  assert.equal(await probeDashboard(a.port), false, 'port closed');
  assert.equal(existsSync(runStatePath(h)), false);
  assert.equal((await stopDashboard(d)).stopped, false, 'nothing left to stop');
});

test('a stale state file (dead pid) is ignored and a new instance starts', async () => {
  const h = home();
  writePrivateJson(runStatePath(h), { schema: 'prism.dashboard-run.v1', pid: 2 ** 22 + 7, port: 1, url: 'http://127.0.0.1:1/?token=' + 'a'.repeat(43), startedAt: 'x' });
  const d = deps(h);
  const r = await startDashboard(d);
  try { assert.equal(r.reused, false); assert.notEqual(r.port, 1); } finally { await stopDashboard(d); }
  // A live pid whose port is not a dashboard is not reused either, and stop leaves that pid alone.
  writePrivateJson(runStatePath(h), { schema: 'prism.dashboard-run.v1', pid: process.pid, port: 9, url: 'http://127.0.0.1:9/?token=' + 'a'.repeat(43), startedAt: 'x' });
  const s = await stopDashboard(d);
  assert.equal(s.stopped, false);
  assert.equal(pidAlive(process.pid), true);
});

test('prism_dashboard opener rule: SSH -> no opener and a forwarding note; display -> opener gets the URL as argv', async () => {
  const h = home();
  const calls: string[] = [];
  const base: ToolContext = { cwd: h, home: h, version: '9.9.9', root: join(h, 'work'), pathEnv: '', open: (u) => calls.push(u), dashboard: { command: { file: process.execPath, args: TSX }, timeoutMs: 30_000 } };
  try {
    const ssh = await callTool({ ...base, env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22', DISPLAY: ':0', PATH: process.env.PATH, HOME: h } }, 'prism_dashboard', {});
    assert.equal(ssh.isError, undefined, ssh.content[0].text);
    const j: any = ssh.structuredContent; // any: the tool's answer, checked below.
    assert.equal(j.opened, false);
    assert.equal(calls.length, 0);
    assert.match(j.note, /Remote-SSH/);
    assert.ok(j.note.includes(`ssh -L ${j.port}:127.0.0.1:${j.port} <host>`));
    assert.match(j.secret, /per-run token/);
    if (process.platform === 'linux') {
      const x: any = (await callTool({ ...base, env: { DISPLAY: ':0', PATH: process.env.PATH, HOME: h } }, 'prism_dashboard', {})).structuredContent;
      assert.equal(x.opened, true);
      assert.equal(x.reused, true);
      assert.deepEqual(calls, [j.url]);
    }
    assert.match((await callTool(base, 'prism_dashboard', { open: 'yes' })).content[0].text, /open must be true or false/);
  } finally {
    const s: any = (await callTool({ ...base, env: { HOME: h } }, 'prism_dashboard_stop', {})).structuredContent;
    assert.equal(s.stopped, true, s.note);
  }
  // openBrowser passes the URL as one argv element, no shell.
  const seen: [string, string[], any][] = [];
  openBrowser('http://127.0.0.1:1/?token=x', ((f: string, a: string[], o: any) => { seen.push([f, a, o]); return { on() {}, unref() {} }; }) as any, 'linux');
  assert.deepEqual(seen[0].slice(0, 2), ['xdg-open', ['http://127.0.0.1:1/?token=x']]);
  assert.equal(seen[0][2].shell, undefined);
});

test('the dashboard child dies when the MCP server stdin closes', async () => {
  const h = home();
  const built = join(CLI_DIR, 'dist', 'bin', 'prism-cli.js');
  const args = existsSync(built) ? [built, 'mcp'] : [...TSX, 'mcp'];
  const mcp: ChildProcess = spawn(process.execPath, args, { cwd: h, env: { PATH: process.env.PATH, HOME: h, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  mcp.stdout!.on('data', (c) => { out += c; });
  const reply = (id: number) => waitFor(() => out.split('\n').some((l) => l.includes(`"id":${id}`)), 40_000)
    .then(() => JSON.parse(out.split('\n').find((l) => l.includes(`"id":${id}`))!));
  const send = (m: object) => mcp.stdin!.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await reply(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'prism_dashboard', arguments: { open: false } } });
  const r = await reply(2);
  const body = JSON.parse(r.result.content[0].text);
  assert.match(body.url, URL_LINE, r.result.content[0].text);
  const { pid } = JSON.parse(readFileSync(runStatePath(h), 'utf8'));
  assert.equal(pidAlive(pid), true);
  const exited = new Promise((done) => mcp.on('exit', done));
  mcp.stdin!.end();
  await exited;
  assert.ok(await waitFor(() => !pidAlive(pid)), 'dashboard child stopped with the MCP server');
  assert.equal(await probeDashboard(body.port), false);
});
