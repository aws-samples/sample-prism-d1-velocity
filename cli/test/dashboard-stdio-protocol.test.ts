/**
 * `prism-cli dashboard --serve-stdio` as a real child process, fed hostile input: oversized
 * lines, invalid JSON, unknown routes and ops, actions not on the allowlist, extra fields,
 * a confirm action without confirm, an AWS write without the gate. Every answer must be a
 * refusal by id, the process must keep serving after each one, and stdout must carry only
 * protocol lines. HOME is an empty temp dir; aws on PATH is the test guard's blocking stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_LINE, STDIO_API, STDIO_PROTOCOL } from '../src/dashboard/stdio.js';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = ['--import', import.meta.resolve('tsx'), join(CLI_DIR, 'bin', 'prism-cli.ts')];
/** An action runs this CLI's own built entry (actions.ts cliEntry), so the action test needs dist/. */
const DIST = join(CLI_DIR, 'dist', 'bin', 'prism-cli.js');

function child(home: string, entry: string[] = TSX) {
  const p = spawn(process.execPath, [...entry, 'dashboard', '--serve-stdio', '--root', join(home, 'work')], {
    cwd: home, env: { PATH: process.env.PATH, HOME: home, AWS_EC2_METADATA_DISABLED: 'true', PRISM_NO_UPDATE_CHECK: '1', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const raw: string[] = [];
  const waiting = new Map<number | string, (o: any) => void>();
  const got: any[] = [];
  p.stdout.on('data', (b) => {
    buf += b;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      raw.push(line);
      const o = JSON.parse(line); // throws, failing the test, on any non-protocol stdout line
      got.push(o);
      const k = o.hello ? 'hello' : o.id === null ? 'null' : o.id;
      waiting.get(k)?.(o); waiting.delete(k);
    }
  });
  const next = (k: number | string) => new Promise<any>((ok) => {
    const seen = got.find((o) => (o.hello ? 'hello' : o.id === null ? 'null' : o.id) === k);
    if (seen) { got.splice(got.indexOf(seen), 1); ok(seen); } else waiting.set(k, (o) => { got.splice(got.indexOf(o), 1); ok(o); });
  });
  const send = (s: string) => p.stdin.write(s);
  const ask = (o: { id: number; [k: string]: unknown }) => { send(JSON.stringify(o) + '\n'); return next(o.id); };
  return { p, raw, next, send, ask };
}

test('serve-stdio refuses hostile input by id and keeps serving', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-stdio-'));
  mkdirSync(join(home, 'work'));
  // A saved AWS connection, so the confirm action has something to (not) remove.
  mkdirSync(join(home, '.prism'));
  writeFileSync(join(home, '.prism', 'aws.json'), JSON.stringify({ profile: 'demo', region: 'us-west-2' }));
  const c = child(home);
  try {
    const hello = await c.next('hello');
    assert.equal(hello.hello, STDIO_PROTOCOL);
    assert.equal(hello.api, STDIO_API);
    assert.match(hello.version, /^\d+\.\d+\.\d+/);
    assert.ok(hello.routes.get.includes('/api/data') && hello.routes.get.includes('/api/report'));
    assert.deepEqual(hello.routes.act.sort(), ['/api/accountguard/baseline', '/api/action', '/api/security-agent/spaces', '/api/update-check']);

    // An oversized line is dropped as it streams (one 413), and the next request is still answered.
    c.send('{"id":1,"op":"get","path":"/api/data","query":{"x":"' + 'a'.repeat(MAX_LINE + 10) + '"}}\n');
    assert.equal((await c.next('null')).status, 413);
    c.send('not json at all\n');
    assert.deepEqual(await c.next('null'), { id: null, status: 400, json: { error: 'invalid JSON' } });
    c.send('[1,2,3]\n');
    assert.equal((await c.next('null')).status, 400);

    assert.equal((await c.ask({ id: 2, op: 'get', path: '/api/nope' })).status, 404);
    assert.equal((await c.ask({ id: 3, op: 'get', path: '/report/abc' })).status, 400);
    assert.equal((await c.ask({ id: 4, op: 'delete', path: '/api/data' } as any)).status, 400);
    assert.equal((await c.ask({ id: 5, op: 'act', path: '/api/setup', body: {} })).status, 404);
    assert.equal((await c.ask({ id: 6, op: 'get', path: '/api/action/status', body: {} } as any)).status, 400);
    assert.equal((await c.ask({ id: 7, op: 'get', path: '/api/hasOwnProperty' })).status, 404);
    assert.equal((await c.ask({ id: 8, op: 'get', path: '/api/data', cmd: 'rm -rf ~' } as any)).status, 400);
    assert.equal((await c.ask({ id: 9, op: 'get', path: '/api/report', query: { id: '../../etc/passwd' } })).status, 400);
    assert.equal((await c.ask({ id: 10, op: 'get', path: '/api/report', query: { id: 'deadbeef' } })).status, 404);

    // Actions: the same ActionRunner checks as over HTTP.
    const act = (id: number, body: unknown) => c.ask({ id, op: 'act', path: '/api/action', body } as any);
    assert.deepEqual((await act(11, { action: 'rm-rf' })).json, { error: 'unknown action' });
    assert.deepEqual((await act(12, { action: '__proto__' })).json, { error: 'unknown action' });
    assert.deepEqual((await act(13, ['aws-disconnect'])).json, { error: 'expected a JSON object' });
    assert.deepEqual((await act(14, { action: 'aws-disconnect', argv: ['--evil'] })).json, { error: 'unexpected field argv' });
    assert.deepEqual((await act(15, { action: 'aws-disconnect' })).json, { error: 'this action needs confirm: true' });
    assert.equal((await act(16, { action: 'security-code-review', repo: '0000000000000000', confirm: true })).status, 400);
    assert.equal((await act(17, { action: 'codeburn-team', url: 'http://user:pw@evil.example' })).status, 400);
    c.send('{"id":18,"op":"act","path":"/api/action","body":{"__proto__":{"confirm":true},"action":"aws-disconnect"}}\n');
    assert.equal((await c.next(18)).status, 400);
    assert.ok(existsSync(join(home, '.prism', 'aws.json')), 'no refused action ran');

    // Still serving: a real read.
    const data = await c.ask({ id: 19, op: 'get', path: '/api/data' });
    assert.equal(data.status, 200);
    assert.equal(data.json.schema, 'prism.dashboard.v2');
    assert.ok(c.raw.every((l) => l.startsWith('{')), 'stdout carries protocol lines only');
  } finally {
    c.p.stdin.end();
    await new Promise((ok) => { c.p.on('exit', ok); setTimeout(ok, 5000); });
    assert.notEqual(c.p.exitCode, null, 'exits when stdin closes');
    rmSync(home, { recursive: true, force: true });
  }
});

test('serve-stdio runs a confirmed action and its status, then exits with stdin', { timeout: 60_000, skip: existsSync(DIST) ? false : 'needs npm run build (an action runs dist/bin/prism-cli.js)' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'prism-stdio-'));
  mkdirSync(join(home, 'work'));
  mkdirSync(join(home, '.prism'));
  writeFileSync(join(home, '.prism', 'aws.json'), JSON.stringify({ profile: 'demo', region: 'us-west-2' }));
  const c = child(home, [DIST]);
  try {
    await c.next('hello');
    const start = await c.ask({ id: 1, op: 'act', path: '/api/action', body: { action: 'aws-disconnect', confirm: true } });
    assert.equal(start.status, 202);
    let s: any;
    for (let i = 2; i < 120; i++) {
      s = (await c.ask({ id: i, op: 'get', path: '/api/action/status' })).json;
      if (s.state === 'done') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(s.state, 'done');
    assert.equal(s.exitCode, 0, s.output);
    assert.equal(existsSync(join(home, '.prism', 'aws.json')), false);
    assert.match(readFileSync(join(home, '.prism', 'logs', 'dashboard-actions.log'), 'utf8'), /"action":"aws-disconnect"/);
  } finally {
    c.p.stdin.end();
    await new Promise((ok) => { c.p.on('exit', ok); setTimeout(ok, 5000); });
    rmSync(home, { recursive: true, force: true });
  }
});
