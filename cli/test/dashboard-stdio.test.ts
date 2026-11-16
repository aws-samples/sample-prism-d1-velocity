import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { dispatch, MAX_INFLIGHT, serveStdio, STDIO_PROTOCOL } from '../src/dashboard/stdio.js';
import { ApiAnswer } from '../src/dashboard/server.js';
import type { DashboardApi } from '../src/dashboard/api-core.js';
import { runInNewContext } from 'node:vm';
import { renderPage, uiBundle } from '../src/dashboard/page.js';
import { BRIDGE_SCRIPT } from '../src/dashboard/ui-bridge.js';

const api = (): DashboardApi & { posted: unknown[] } => {
  const posted: unknown[] = [];
  return {
    posted,
    getPayload: async () => ({}),
    getReport: async () => null,
    getApi: {
      '/api/data': async () => ({ schema: 'prism.dashboard.v2' }),
      '/api/security-run': async (url) => (url.searchParams.get('run') === 'r1' ? { found: true } : new ApiAnswer(404, { found: false })),
    },
    postApi: { '/api/action': async (b) => { posted.push(b); return { status: 202, json: { state: 'running' } }; } },
    shutdown: () => {},
  };
};

test('dispatch answers only exact routes with the matching op', async () => {
  const a = api();
  assert.deepEqual(await dispatch(a, { id: 1, op: 'get', path: '/api/data' }), { id: 1, status: 200, json: { schema: 'prism.dashboard.v2' } });
  assert.equal((await dispatch(a, { id: 2, op: 'get', path: '/api/security-run', query: { run: 'r1' } })).status, 200);
  assert.equal((await dispatch(a, { id: 3, op: 'get', path: '/api/security-run', query: { run: 'x' } })).status, 404);
  assert.equal((await dispatch(a, { id: 4, op: 'act', path: '/api/data', body: {} })).status, 404);
  assert.equal((await dispatch(a, { id: 5, op: 'get', path: '/api/action' })).status, 404);
  assert.equal((await dispatch(a, { id: 6, op: 'get', path: '/api/__proto__' })).status, 404);
  assert.equal((await dispatch(a, { id: 7, op: 'get', path: '/etc/passwd' })).status, 400);
  assert.equal((await dispatch(a, { id: 8, op: 'get', path: '/api/data', body: {} })).status, 400);
  assert.equal((await dispatch(a, { id: 9, op: 'get', path: '/api/data', query: { a: 1 } })).status, 400);
  assert.equal((await dispatch(a, { id: 10, op: 'get', path: '/api/data', extra: 1 })).status, 400);
  assert.deepEqual(await dispatch(a, 'nope'), { id: null, status: 400, json: { error: 'expected {id, op, path}' } });
  // The body reaches the handler as is: the handler (ActionRunner.start) is the validator, as over HTTP.
  assert.equal((await dispatch(a, { id: 11, op: 'act', path: '/api/action', body: { action: 'aws-disconnect', confirm: true } })).status, 202);
  assert.deepEqual(a.posted, [{ action: 'aws-disconnect', confirm: true }]);
});

test('serveStdio says hello with its routes, then answers lines by id', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let out = '';
  output.on('data', (b) => { out += b; });
  const done = serveStdio(api(), input, output, { version: '9.9.9' });
  input.write('{"id":1,"op":"get","path":"/api/data"}\nnot json\n');
  input.end();
  await done;
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].hello, STDIO_PROTOCOL);
  assert.deepEqual(lines[0].routes, { get: ['/api/data', '/api/security-run'], act: ['/api/action'] });
  assert.ok(lines.some((l) => l.id === 1 && l.status === 200));
  assert.ok(lines.some((l) => l.id === null && l.status === 400));
});

test('serveStdio joins lines split across chunks (multi-byte too) and caps requests in flight', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let out = '';
  output.on('data', (b) => { out += b; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const a = api();
  a.getApi['/api/slow'] = async () => { await gate; return { ok: true }; };
  const done = serveStdio(a, input, output, { version: '1' });
  // One request split inside a multi-byte character.
  const line = Buffer.from('{"id":1,"op":"get","path":"/api/security-run","query":{"run":"é"}}\n');
  const cut = line.indexOf(Buffer.from('é')) + 1;
  input.write(line.subarray(0, cut)); input.write(line.subarray(cut));
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < MAX_INFLIGHT + 2; i++) input.write(JSON.stringify({ id: 100 + i, op: 'get', path: '/api/slow' }) + '\n');
  await new Promise((r) => setImmediate(r));
  release();
  input.end();
  await done;
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.id === 1).status, 404); // run "é" is not r1: the line arrived whole
  assert.equal(lines.filter((l) => l.status === 429).length, 2);
  assert.equal(lines.filter((l) => l.id >= 100 && l.status === 200).length, MAX_INFLIGHT);
});

test('the shared bundle is byte for byte what the browser page inlines', () => {
  const b = uiBundle();
  const html = renderPage('bm9uY2U=', 'csrf');
  assert.ok(html.includes(b.js) && html.includes(b.css) && html.includes(b.themeBoot));
  assert.ok(!/<\/(script|style)/i.test(b.js + b.css), 'inlinable: no closing tags inside');
  assert.ok(!/prism_dash_|token=/.test(b.body), 'no token in the body markup');
});

test('bridge.js relays by id, ignores strangers, and sends only result ids to openReport', async () => {
  const posted: any[] = [];
  const listeners: ((e: any) => void)[] = [];
  const parent: any = { postMessage: (m: any) => posted.push(m) };
  const win: any = { addEventListener: (_: string, f: (e: any) => void) => listeners.push(f), parent };
  runInNewContext(BRIDGE_SCRIPT, { window: win, Map, setTimeout, clearTimeout, Promise, Object, String });
  const t = win.PRISM_TRANSPORT;
  assert.equal(t.kind, 'embedded');
  const p = t.get('/api/data', { a: 'b' });
  const plainOf = (x: unknown) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(plainOf(posted[0]), { type: 'prism-ui:request', id: 1, op: 'get', path: '/api/data', query: { a: 'b' } });
  // Not from the parent: ignored. From the parent: resolves.
  listeners.forEach((f) => f({ source: {}, data: { type: 'prism-ui:response', id: 1, status: 200, json: { forged: true } } }));
  listeners.forEach((f) => f({ source: parent, data: { type: 'prism-ui:response', id: 1, status: 200, json: { ok: 1 } } }));
  assert.deepEqual(plainOf(await p), { ok: true, status: 200, json: { ok: 1 } });
  t.openReport('../x'); t.openReport('abc_123');
  assert.deepEqual(plainOf(posted.slice(1)), [{ type: 'prism-ui:open-report', id: 'abc_123' }]);
});

test('serveStdio answers a last line with no newline, and stops serving when stdout errors', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let out = '';
  output.on('data', (b) => { out += b; });
  const done = serveStdio(api(), input, output, { version: '1' });
  input.end('{"id":7,"op":"get","path":"/api/data"}');
  await done;
  assert.ok(out.trim().split('\n').map((l) => JSON.parse(l)).some((l) => l.id === 7 && l.status === 200));
  const in2 = new PassThrough(), out2 = new PassThrough();
  const d2 = serveStdio(api(), in2, out2, { version: '1' });
  out2.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  await d2; // resolves instead of throwing
});

test('serveStdio answers a last line with no newline, and stops serving when stdout errors', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let out = '';
  output.on('data', (b) => { out += b; });
  const done = serveStdio(api(), input, output, { version: '1' });
  input.end('{"id":7,"op":"get","path":"/api/data"}');
  await done;
  assert.ok(out.trim().split('\n').map((l) => JSON.parse(l)).some((l) => l.id === 7 && l.status === 200));
  const in2 = new PassThrough(), out2 = new PassThrough();
  const d2 = serveStdio(api(), in2, out2, { version: '1' });
  out2.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  await d2; // resolves instead of throwing
});

test('every in-app navigation goes through navigate(): one capture-phase link handler, no raw location.hash writes', () => {
  const js = uiBundle().js;
  assert.match(js, /document\.addEventListener\('click', routeLinkClick, true\)/);
  assert.match(js, /document\.addEventListener\('auxclick', routeLinkClick, true\)/);
  // The one write is inside navigate(); any other would bypass it.
  assert.equal((js.match(/location\.hash\s*=[^=]/g) || []).length, 1);
  assert.ok(!/window\.open\(|location\.(href|assign|replace)\b\s*[=(]/.test(js), 'nothing else navigates the document');
  assert.ok(!/<form\b|el\('form'/.test(js + uiBundle().body), 'no form can submit and navigate the frame');
  // A link with its own click handler (the report buttons) is left to it.
  assert.match(js, /'data-own-click': ''/);
});
