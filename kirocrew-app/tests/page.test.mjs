// The page's pure parts, with a stub createElement; run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleOutdated, checkMessage, errorBody, relay, renderReport, renderUpdate, srcdocFor, UPDATE_CMD, withReportCsp } from '../ui/index.mjs';

const h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() });
const walk = (n, f) => { if (n && typeof n === 'object') { f(n); n.children.forEach((c) => walk(c, f)); } };
const texts = (n) => { const out = []; walk(n, (x) => x.children.forEach((c) => typeof c === 'string' && out.push(c))); return out; };

const BUNDLE = { version: '1.21.0', css: 'body{}', js: 'void 0;', bridge: 'void 1;', body: '<header>PRISM</header>',
  hashes: { css: 'sha256-AAAA', js: 'sha256-BBBB', bridge: 'sha256-CCCC' } };

test('srcdoc: the CLI files allowed by hash only, no connect, and nothing that closes its element', () => {
  const d = srcdocFor(BUNDLE, 'light');
  assert.match(d, /content="default-src 'none'; script-src 'sha256-CCCC' 'sha256-BBBB'; style-src 'sha256-AAAA'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"/);
  assert.match(d, /data-theme="light"/);
  assert.ok(d.indexOf('void 1;') < d.indexOf('void 0;'), 'the bridge runs first');
  assert.throws(() => srcdocFor({ ...BUNDLE, js: 'a</script><script>alert(1)' }, 'dark'), /cannot be inlined/);
  assert.throws(() => srcdocFor({ ...BUNDLE, css: '</style>' }, 'dark'), /cannot be inlined/);
  assert.throws(() => srcdocFor({ ...BUNDLE, hashes: { ...BUNDLE.hashes, js: "sha256-x' 'unsafe-inline" } }, 'dark'), /valid hashes/);
});

test('messages from the iframe: requests by shape, reports by result id, anything else dropped', () => {
  assert.deepEqual(checkMessage({ type: 'prism-ui:request', id: 1, op: 'get', path: '/api/data', query: { fresh: '1' } }), { id: 1, op: 'get', path: '/api/data', query: { fresh: '1' } });
  assert.deepEqual(checkMessage({ type: 'prism-ui:request', id: 2, op: 'act', path: '/api/action', body: { action: 'aws-disconnect', confirm: true } }),
    { id: 2, op: 'act', path: '/api/action', body: { action: 'aws-disconnect', confirm: true } });
  assert.deepEqual(checkMessage({ type: 'prism-ui:open-report', id: 'abc_123' }), { report: 'abc_123' });
  for (const m of [null, 'x', {}, { type: 'prism-ui:open-report', id: '../x' }, { type: 'prism-ui:request', id: 1.5, op: 'get', path: '/api/data' },
    { type: 'prism-ui:request', id: 1, op: 'delete', path: '/api/data' }, { type: 'prism-ui:request', id: 1, op: 'get', path: '/etc/passwd' },
    { type: 'prism-ui:request', id: 1, op: 'act', path: '/api/action', body: ['x'] }, { type: 'prism-ui:request', id: 1, op: 'get', path: '/api/' + 'a'.repeat(200) }]) {
    assert.equal(checkMessage(m), null, JSON.stringify(m));
  }
});

test('relay: reads by GET with the query as JSON, actions by POST, an SDK error as an answer', async () => {
  const calls = [];
  const api = {
    get: async (u) => { calls.push(['GET', u]); return { status: 200, json: { ok: 1 } }; },
    post: async (u, b) => { calls.push(['POST', u, b]); return { status: 400, json: { error: 'this action needs confirm: true' } }; },
  };
  assert.deepEqual(await relay(api, { op: 'get', path: '/api/security-run', query: { repo: 'a', run: 'b&c' } }), { status: 200, json: { ok: 1 }, version: '' });
  assert.equal(calls[0][1], '/api/apps/prism/ui/get?path=%2Fapi%2Fsecurity-run&query=%7B%22repo%22%3A%22a%22%2C%22run%22%3A%22b%26c%22%7D');
  assert.deepEqual(await relay(api, { op: 'act', path: '/api/action', body: { action: 'aws-disconnect' } }), { status: 400, json: { error: 'this action needs confirm: true' }, version: '' });
  assert.deepEqual(calls[1], ['POST', '/api/apps/prism/ui/act', { path: '/api/action', body: { action: 'aws-disconnect' } }]);
  const denied = { get: async () => { throw Object.assign(new Error('API 403'), { status: 403, body: '{"error":"owner only"}' }); } };
  assert.deepEqual(await relay(denied, { op: 'get', path: '/api/data', query: {} }), { status: 403, json: { error: 'owner only' } });
  assert.deepEqual(errorBody({ body: 'not json' }), null);
});

test('update page: the title, the reason, the npm command and a Copy button, nothing else', () => {
  const copied = [];
  const tree = renderUpdate(h, { reason: 'prism-cli was not found (not on PATH).', command: UPDATE_CMD, min: '1.21.3' }, { copied: false, copy: (t) => copied.push(t), reload() {} });
  const t = texts(tree);
  assert.ok(t.includes('Update prism-cli to 1.21.3 or later'), 'the minimum comes from the gateway answer');
  assert.ok(texts(renderUpdate(h, { command: UPDATE_CMD, min: '<b>' }, { copied: false, copy() {}, reload() {} })).includes('Update prism-cli'), 'no version, or a garbled one: a plain title');
  assert.ok(t.includes('npm install -g @prism-d1/cli@latest'));
  assert.ok(t.includes('prism-cli was not found (not on PATH).'));
  walk(tree, (n) => { if (n.tag === 'button' && n.children.includes('Copy')) n.props.onClick(); });
  assert.deepEqual(copied, [UPDATE_CMD]);
  walk(tree, (n) => assert.notEqual(n.tag, 'iframe'));
});

test('report overlay: an empty sandbox and the report CSP first in head', () => {
  const evil = '<html><head><title>r</title></head><body><script>alert(1)</script></body></html>';
  let frame = null;
  walk(renderReport(h, { html: evil }, { closeReport() {}, downloadReport() {} }), (n) => { if (n.tag === 'iframe') frame = n; });
  assert.equal(frame.props.sandbox, '');
  assert.match(frame.props.srcDoc, /^<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/);
  assert.match(withReportCsp('plain'), /^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"/);
});

test('an answer from another prism-cli version means the bundle on screen is outdated', async () => {
  const api = { get: async () => ({ status: 200, json: {}, version: '1.21.3' }) };
  const a = await relay(api, { op: 'get', path: '/api/data', query: {} });
  assert.equal(a.version, '1.21.3');
  assert.equal(bundleOutdated('1.21.2', a.version), true);
  assert.equal(bundleOutdated('1.21.3', a.version), false);
  assert.equal(bundleOutdated('', '1.21.3'), false, 'no bundle drawn yet');
  assert.equal(bundleOutdated('1.21.2', ''), false, 'an answer without a version (a refusal from the gateway) is not an update');
});
