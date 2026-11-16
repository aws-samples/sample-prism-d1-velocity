import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  catalogFrom, checkHello, cliIsCurrent, compareVersions, DECLINED, handlePanelMessage, MAX_MESSAGE, nativeConfirm, parseOpenReport, parseUiRequest,
  StdioClient, uiHtml, UPDATE_TEXT, updateHtml, withReportCsp, type SpawnFn, type UiRequest,
} from '../src/ui-host';
import { statusView } from '../src/status';

const HELLO = { hello: 'prism.dashboard.stdio', api: 1, version: '1.21.0', uiDir: '/opt/prism/dist/ui/', routes: { get: ['/api/data', '/api/setup', '/api/report'], act: ['/api/action'] } };

test('versions: 1.21.0 and later are current; older, missing or garbage are not', () => {
  assert.equal(compareVersions('1.21.0', '1.21.0'), 0);
  assert.equal(compareVersions('1.21.1', '1.21.0'), 1);
  assert.equal(compareVersions('1.9.9', '1.21.0'), -1);
  assert.equal(compareVersions('2.0.0-beta.1', '1.21.0'), 1);
  for (const v of ['1.21.0', '1.22.3', '2.0.0']) assert.ok(cliIsCurrent(v), v);
  for (const v of ['1.20.1', '1.7.1', '', 'latest', undefined, null, 121]) assert.ok(!cliIsCurrent(v), String(v));
});

test('hello: protocol, api and version are required; anything else asks for an update', () => {
  assert.deepEqual(checkHello(HELLO), HELLO);
  assert.equal(checkHello({ ...HELLO, version: '1.20.1' }), UPDATE_TEXT);
  assert.equal(checkHello({ ...HELLO, api: 0 }), UPDATE_TEXT);
  assert.equal(checkHello({ ...HELLO, hello: 'something else' }), UPDATE_TEXT);
  assert.equal(checkHello('nope'), UPDATE_TEXT);
  assert.match(String(checkHello({ ...HELLO, uiDir: 'relative/ui' })), /unexpected hello/);
  assert.match(String(checkHello({ ...HELLO, routes: { get: [1], act: [] } })), /unexpected hello/);
  assert.match(UPDATE_TEXT, /1\.21\.0 or later: npm install -g @prism-d1\/cli@latest$/);
});

test('webview requests: only the listed routes, the right op, plain strings, a size cap', () => {
  const ok = parseUiRequest({ type: 'prism-ui:request', id: 3, op: 'get', path: '/api/data', query: { fresh: '1' } }, HELLO);
  assert.deepEqual(ok, { id: 3, op: 'get', path: '/api/data', query: { fresh: '1' } });
  assert.deepEqual(parseUiRequest({ type: 'prism-ui:request', id: 4, op: 'act', path: '/api/action', body: { action: 'aws-disconnect', confirm: true } }, HELLO),
    { id: 4, op: 'act', path: '/api/action', body: { action: 'aws-disconnect', confirm: true } });
  const bad: unknown[] = [
    null, 'x', [], { type: 'other', id: 1, op: 'get', path: '/api/data' },
    { type: 'prism-ui:request', id: 1.5, op: 'get', path: '/api/data' },
    { type: 'prism-ui:request', id: 1, op: 'delete', path: '/api/data' },
    { type: 'prism-ui:request', id: 1, op: 'get', path: '/api/action' },
    { type: 'prism-ui:request', id: 1, op: 'act', path: '/api/data', body: {} },
    { type: 'prism-ui:request', id: 1, op: 'get', path: '/report/abc' },
    { type: 'prism-ui:request', id: 1, op: 'get', path: '/api/data', query: { a: 1 } },
    { type: 'prism-ui:request', id: 1, op: 'get', path: '/api/data', body: {} },
    { type: 'prism-ui:request', id: 1, op: 'act', path: '/api/action', body: ['aws-disconnect'] },
    { type: 'prism-ui:request', id: 1, op: 'act', path: '/api/action', body: { action: 'x', pad: 'a'.repeat(MAX_MESSAGE) } },
  ];
  for (const m of bad) assert.equal(parseUiRequest(m, HELLO), null, JSON.stringify(m)?.slice(0, 80));
});

test('report links carry a result id only', () => {
  assert.equal(parseOpenReport({ type: 'prism-ui:open-report', id: '20261116T1000Z-pre-push-review' }), '20261116T1000Z-pre-push-review');
  for (const id of ['../x', 'a/b', '', 'x'.repeat(121), 5]) assert.equal(parseOpenReport({ type: 'prism-ui:open-report', id }), null, String(id));
});

const SETUP = {
  actions: [
    { id: 'aws-disconnect', label: 'Disconnect the AWS account', command: 'prism-cli aws connect --clear', writesAws: false },
    { id: 'security-code-review', label: 'Start a code review of this branch', command: 'prism-cli security code-review --no-wait', writesAws: true },
    { id: 7, label: 'bad' },
  ],
  repoIds: { '/home/me/src/demo-shop': 'aaaaaaaaaaaaaaaa' },
};
const act = (body: Record<string, unknown>): UiRequest => ({ id: 1, op: 'act', path: '/api/action', body });

test('native confirm: AWS-writing actions from the CLI catalog, unknown ones too, never reads or local actions', () => {
  const cat = catalogFrom(SETUP);
  assert.equal(cat.actions.length, 2);
  const c = nativeConfirm(act({ action: 'security-code-review', repo: 'aaaaaaaaaaaaaaaa', confirm: true }), cat);
  assert.ok(c);
  assert.match(c!.title, /Start a code review of this branch\? This writes to AWS\./);
  assert.match(c!.detail, /prism-cli runs: prism-cli security code-review --no-wait/);
  assert.match(c!.detail, /In: \/home\/me\/src\/demo-shop/);
  assert.equal(nativeConfirm(act({ action: 'aws-disconnect', confirm: true }), cat), null);
  // Not in the catalog, or no catalog at all: ask rather than let a write through unasked.
  assert.ok(nativeConfirm(act({ action: 'security-threat-model', repo: 'x', confirm: true }), cat));
  assert.ok(nativeConfirm(act({ action: 'aws-disconnect' }), null));
  assert.equal(nativeConfirm({ id: 1, op: 'get', path: '/api/data', query: {} }, cat), null);
  assert.equal(nativeConfirm({ id: 1, op: 'act', path: '/api/update-check', body: {} }, cat), null);
  assert.equal(DECLINED.status, 409);
});

test('webview HTML: nonce scripts, the CLI bundle by URI, no connect, no inline handler', () => {
  const h = uiHtml({ nonce: 'bm9uY2U=', cspSource: 'https://*.vscode-cdn.net', cssUri: 'https://x/ui/prism-ui.css', bridgeUri: 'https://x/ui/bridge.js', jsUri: 'https://x/ui/prism-ui.js', body: '<header></header>', theme: 'light' });
  assert.match(h, /default-src 'none'; script-src 'nonce-bm9uY2U='; style-src https:\/\/\*\.vscode-cdn\.net;.*connect-src 'none'/);
  assert.match(h, /data-theme="light"/);
  assert.equal((h.match(/<script nonce="bm9uY2U=" src=/g) || []).length, 2);
  assert.ok(!/ on[a-z]+=/i.test(h));
  assert.throws(() => uiHtml({ nonce: '"><script>', cspSource: '', cssUri: '', bridgeUri: '', jsUri: '', body: '', theme: 'dark' }));
  const u = updateHtml({ reason: '<b>old</b>', command: 'npm install -g @prism-d1/cli@latest' });
  assert.match(u, /Update prism-cli to 1\.21\.0 or later/);
  assert.ok(u.includes('&#60;b&#62;old') && !u.includes('<script'));
  assert.match(withReportCsp('<html><head><title>r</title></head></html>'), /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/);
});

test('status bar: an older prism-cli says update, with the command', () => {
  const v = statusView({ kind: 'cli-old', installed: '1.20.1' });
  assert.equal(v.text, '$(shield) PRISM: update prism-cli');
  assert.match(v.tooltip, /prism-cli 1\.20\.1 is older than 1\.21\.0/);
  assert.match(v.tooltip, /npm install -g @prism-d1\/cli@latest/);
  assert.equal(v.command, 'prism.showInstallHint');
});

/** A stand-in for `prism-cli dashboard --serve-stdio`: node running `script`, whatever cli path is asked for. */
const fake = (script: string): SpawnFn => (_file, args, opts) => spawn(process.execPath, ['-e', script, '--', ...args], opts);
const FAKE = (version: string) => `
  const readline = require('node:readline');
  process.stdout.write(JSON.stringify({ hello: 'prism.dashboard.stdio', api: 1, version: ${JSON.stringify(version)}, uiDir: '/opt/ui', routes: { get: ['/api/data', '/api/setup'], act: ['/api/action'] } }) + '\\n');
  readline.createInterface({ input: process.stdin }).on('line', (l) => {
    const m = JSON.parse(l);
    if (m.path === '/api/data' && m.query && m.query.crash) process.exit(3);
    const json = m.path === '/api/setup' ? ${JSON.stringify(SETUP)} : { echo: m };
    process.stdout.write(JSON.stringify({ id: m.id, status: 200, json }) + '\\n');
  });`;

test('stdio client: hello, relays by its own ids, loads the catalog, restarts after a crash', async () => {
  const c = new StdioClient('/fake/prism-cli', process.cwd(), process.env, fake(FAKE('1.21.0')));
  try {
    const h = await c.start();
    assert.equal(h.version, '1.21.0');
    const [a, b] = await Promise.all([c.request({ op: 'get', path: '/api/data', query: { x: '1' } }), c.request({ op: 'act', path: '/api/action', body: { action: 'a' } })]);
    assert.deepEqual((a.json as any).echo, { id: 1, op: 'get', path: '/api/data', query: { x: '1' } });
    assert.deepEqual((b.json as any).echo, { id: 2, op: 'act', path: '/api/action', body: { action: 'a' } });
    const cat = await c.loadCatalog();
    assert.equal(cat?.actions.find((x) => x.id === 'security-code-review')?.writesAws, true);
    const crashed = await c.request({ op: 'get', path: '/api/data', query: { crash: '1' } });
    assert.equal(crashed.status, 503);
    const again = await c.request({ op: 'get', path: '/api/data', query: {} });
    assert.equal(again.status, 200, 'restarted on the next request');
  } finally { c.dispose(); }
});

test('stdio client: an older prism-cli, or one without --serve-stdio, means update', async () => {
  const old = new StdioClient('/fake', process.cwd(), process.env, fake(FAKE('1.20.1')));
  await assert.rejects(old.start(), (e: Error) => e.message === UPDATE_TEXT);
  old.dispose();
  const none = new StdioClient('/fake', process.cwd(), process.env, fake(`process.stderr.write("error: unknown option '--serve-stdio'\\n"); process.exit(1);`));
  await assert.rejects(none.start(), (e: Error) => e.message.startsWith(UPDATE_TEXT));
  none.dispose();
  const after = await none.request({ op: 'get', path: '/api/data' });
  assert.equal(after.status, 503);
});

test('panel messages: an AWS write waits for the native modal; declined, nothing reaches prism-cli', async () => {
  const c = new StdioClient('/fake', process.cwd(), process.env, fake(FAKE('1.21.0')));
  try {
    await c.start();
    const posted: any[] = [], asked: string[] = [];
    let answer = false;
    const deps = { confirm: async (x: { title: string }) => { asked.push(x.title); return answer; }, showReport: () => {}, noReport: () => {}, post: (m: any) => posted.push(m) };
    const write = { type: 'prism-ui:request', id: 9, op: 'act', path: '/api/action', body: { action: 'security-code-review', repo: 'aaaaaaaaaaaaaaaa', confirm: true } };
    await handlePanelMessage(write, c, deps);
    assert.deepEqual(posted[0], { type: 'prism-ui:response', id: 9, ...DECLINED });
    answer = true;
    await handlePanelMessage({ ...write, id: 10 }, c, deps);
    assert.equal(posted[1].id, 10);
    assert.deepEqual(posted[1].json.echo.body, write.body, 'relayed only after yes');
    assert.equal(asked.length, 2);
    await handlePanelMessage({ type: 'prism-ui:request', id: 11, op: 'act', path: '/api/action', body: { action: 'aws-disconnect', confirm: true } }, c, deps);
    assert.equal(asked.length, 2, 'a local action asks no native question');
    await handlePanelMessage({ type: 'prism-ui:request', id: 12, op: 'get', path: '/etc/passwd' }, c, deps);
    assert.equal(posted.length, 3, 'a request off the route list gets no answer');
  } finally { c.dispose(); }
});
