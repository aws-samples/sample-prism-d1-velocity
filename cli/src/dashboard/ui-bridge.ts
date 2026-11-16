/**
 * bridge.js: the postMessage Transport for hosts that embed the shared UI
 * without a server. It runs before prism-ui.js and sets
 * window.PRISM_TRANSPORT; prism-ui.js then sends every read and action
 * through it instead of fetch.
 *
 *   VS Code: the webview's acquireVsCodeApi().postMessage, answered by the
 *            extension host (only it can post into the webview).
 *   Kiro Crew: a sandboxed iframe (allow-scripts, opaque origin) posting to
 *            window.parent; answers are accepted only from window.parent.
 *
 * Messages: {type:'prism-ui:request', id, op:'get'|'act', path, query, body}
 * out, {type:'prism-ui:response', id, status, json} back; and
 * {type:'prism-ui:open-report', id} out, for the host to show a report. The host checks the
 * shape and relays it to `prism-cli dashboard --serve-stdio`, which looks the
 * path up in the same route table as the browser server. Nothing here holds
 * a token: the page has none to leak.
 *
 * The Kiro Crew target origin is '*' because a sandboxed iframe's own origin is
 * opaque and the parent's is not known to it. The message only ever goes to
 * window.parent, the page that embedded this document (the PRISM app page), and
 * carries the same route, query and action body the page would send itself.
 */
export const BRIDGE_SCRIPT = `(function () {
  'use strict';
  var vs = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  var post = vs ? function (m) { vs.postMessage(m); } : function (m) { window.parent.postMessage(m, '*'); };
  var seq = 0, pending = new Map();
  var TIMEOUT_MS = 130000;
  window.addEventListener('message', function (e) {
    if (!vs && e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.type !== 'prism-ui:response' || !pending.has(m.id)) return;
    var p = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(p.timer);
    var s = typeof m.status === 'number' ? m.status : 0;
    p.done({ ok: s >= 200 && s < 300, status: s, json: m.json && typeof m.json === 'object' ? m.json : { error: 'the host sent no answer' } });
  });
  function call(op, path, query, body) {
    return new Promise(function (done) {
      var id = ++seq;
      var timer = setTimeout(function () { pending.delete(id); done({ ok: false, status: 0, json: { error: 'the host did not answer in time' } }); }, TIMEOUT_MS);
      pending.set(id, { done: done, timer: timer });
      var m = { type: 'prism-ui:request', id: id, op: op, path: path };
      if (op === 'get') m.query = query || {}; else m.body = body;
      post(m);
    });
  }
  window.PRISM_TRANSPORT = Object.freeze({
    kind: vs ? 'vscode' : 'embedded',
    reports: false,
    get: function (path, query) { return call('get', path, query); },
    act: function (path, body) { return call('act', path, null, body); },
    // The host shows the report (it reads GET /api/report?id=); the id is a result id or nothing is sent.
    openReport: function (id) { if (/^[A-Za-z0-9_-]{1,120}$/.test(String(id))) post({ type: 'prism-ui:open-report', id: String(id) }); },
  });
})();
`;
