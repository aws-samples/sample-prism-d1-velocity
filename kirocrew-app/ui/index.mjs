// PRISM page for Kiro Crew: prism-cli's own dashboard UI (the same pages, Run buttons and confirm
// dialogs as `prism-cli dashboard`). Loaded by the dashboard with import('/apps/prism/ui/index.mjs');
// React and the App SDK come from the host (window.__kirocrew_modules), so there is no build step.
//
// The UI bundle comes from the installed prism-cli (GET /api/apps/prism/ui/bundle) and runs in an
// iframe with sandbox="allow-scripts" and no allow-same-origin: an opaque origin with no access to
// the gateway's cookies, storage or DOM, and its own CSP (scripts and style by sha256 only,
// connect-src none). Its one way out is postMessage to this page, which accepts messages from that
// iframe only and relays them through useAppApi (scoped to /api/apps/prism/*, gateway-authenticated)
// to the app's /ui/get and /ui/act routes; prism-cli checks every request again. A report opens in
// a second iframe with an empty sandbox (no scripts at all) and a CSP that allows its inline styles only.

export const API = '/api/apps/prism';
export const UPDATE_TITLE = 'Update prism-cli to 1.21.0 or later';
export const UPDATE_CMD = 'npm install -g @prism-d1/cli@latest';
const BLOB_URL_TTL_MS = 10 * 1000;
/** POST /api/action answers 202 when an action started (actions.ts ActionRunner.start). */
const ACTION_STARTED = 202;
/** Longer than the longest action timeout (10 min): a redraw waits for a running action at most this long. */
const ACTION_WAIT_MAX_MS = 15 * 60 * 1000;
/** server.ts REPORT_ROUTE: a result id, never a path. */
const REPORT_ID = /^[A-Za-z0-9_-]{1,120}$/;
export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const str = (x) => (typeof x === 'string' ? x : x == null ? '' : String(x));
const v = (name, fallback) => `var(--${name}, ${fallback})`;

/** The iframe document. The bundle's text is the CLI's own; a file that could close its element early is refused. */
export function srcdocFor(b, theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  const csp = `default-src 'none'; script-src '${b.hashes.bridge}' '${b.hashes.js}'; style-src '${b.hashes.css}'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  const safe = (s) => { if (/<\/(script|style)/i.test(str(s))) throw new Error('the PRISM UI files cannot be inlined; reinstall prism-cli'); return str(s); };
  for (const k of ['bridge', 'js', 'css']) if (!/^sha256-[A-Za-z0-9+/]+=*$/.test(str(b.hashes && b.hashes[k]))) throw new Error('the PRISM UI files came without valid hashes');
  return `<!DOCTYPE html><html lang="en" data-theme="${t}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<style>${safe(b.css)}</style></head><body><div class="wrap">${str(b.body)}</div>`
    + `<script>${safe(b.bridge)}</script><script>${safe(b.js)}</script></body></html>`;
}

/** The iframe's message: a request, a report to open, or null. Shape only: the app route and prism-cli check again. */
export function checkMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'prism-ui:open-report') return typeof m.id === 'string' && REPORT_ID.test(m.id) ? { report: m.id } : null;
  if (m.type !== 'prism-ui:request' || !Number.isSafeInteger(m.id)) return null;
  if ((m.op !== 'get' && m.op !== 'act') || typeof m.path !== 'string' || !m.path.startsWith('/api/') || m.path.length > 200) return null;
  if (m.op === 'get') return { id: m.id, op: 'get', path: m.path, query: m.query && typeof m.query === 'object' && !Array.isArray(m.query) ? m.query : {} };
  return m.body && typeof m.body === 'object' && !Array.isArray(m.body) ? { id: m.id, op: 'act', path: m.path, body: m.body } : null;
}

/** An SDK error's JSON body (the route's {error, update, command}), or null. */
export function errorBody(e) {
  try { const j = JSON.parse(str(e && e.body)); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

/** One relayed request: the route answers 200 with prism-cli's own { status, json }. */
export async function relay(api, r) {
  try {
    const a = r.op === 'get'
      ? await api.get(`${API}/ui/get?path=${encodeURIComponent(r.path)}&query=${encodeURIComponent(JSON.stringify(r.query))}`)
      : await api.post(`${API}/ui/act`, { path: r.path, body: r.body });
    return { status: a && typeof a.status === 'number' ? a.status : 502, json: a ? a.json : { error: 'no answer' }, version: a && typeof a.version === 'string' ? a.version : '' };
  } catch (e) {
    const j = errorBody(e);
    return { status: e && typeof e.status === 'number' ? e.status : 0, json: { error: str(j ? j.error : e && (e.body || e.message)) || 'the gateway refused the request' } };
  }
}

/** True when an answer came from another prism-cli than the bundle on screen: reload the bundle. */
export const bundleOutdated = (shown, answered) => !!shown && !!answered && shown !== answered;

/** The report HTML with its CSP first in <head>. */
export function withReportCsp(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;
  const s = str(html);
  const m = /<head[^>]*>/i.exec(s);
  return m ? s.slice(0, m.index + m[0].length) + meta + s.slice(m.index + m[0].length) : `<!DOCTYPE html><html><head>${meta}</head><body>${s}</body></html>`;
}

const S = {
  page: { padding: '16px', color: v('text', 'inherit'), fontSize: '14px', lineHeight: 1.45, maxWidth: '760px' },
  h1: { fontSize: '20px', fontWeight: 700, margin: '0 0 8px', color: v('text-strong', 'inherit') },
  muted: { color: v('muted', 'GrayText'), overflowWrap: 'anywhere' },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px', background: v('bg-elevated', 'transparent'), padding: '4px 8px', borderRadius: '4px', overflowWrap: 'anywhere', userSelect: 'all' },
  btn: { border: `1px solid ${v('border', 'GrayText')}`, background: v('bg-elevated', 'transparent'), color: v('text', 'inherit'), borderRadius: '6px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer' },
  error: { color: v('danger-text', 'red'), overflowWrap: 'anywhere' },
  frame: { width: '100%', height: 'calc(100vh - 24px)', minHeight: '480px', border: 0, display: 'block' },
  overlay: { position: 'fixed', inset: '24px', background: v('card', '#fff'), border: `1px solid ${v('border', 'GrayText')}`, borderRadius: '8px', display: 'flex', flexDirection: 'column', zIndex: 10, boxShadow: '0 10px 30px rgb(0 0 0 / .35)' },
  bar: { display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-end', padding: '8px 12px' },
  report: { flex: 1, border: 0, background: '#fff', borderRadius: '0 0 8px 8px' },
};

/** The page when prism-cli is missing or older than 1.21.0: the message and the command, nothing else. Exported for tests. */
export function renderUpdate(h, u, ui) {
  return h('div', { style: S.page },
    h('h1', { style: S.h1 }, UPDATE_TITLE),
    u.reason ? h('p', { style: S.muted }, str(u.reason)) : null,
    h('p', null, 'Run this in a terminal on the Kiro Crew machine, then reload this page:'),
    h('p', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      h('code', { style: S.code }, str(u.command || UPDATE_CMD)),
      h('button', { type: 'button', style: S.btn, onClick: () => ui.copy(str(u.command || UPDATE_CMD)) }, ui.copied ? 'Copied' : 'Copy'),
      h('button', { type: 'button', style: S.btn, onClick: ui.reload }, 'Check again')));
}

/** The report overlay (sandbox="": no scripts, no same-origin, no forms, no popups). Exported for tests. */
export function renderReport(h, rep, ui) {
  return h('div', { style: S.overlay, role: 'dialog', 'aria-label': 'Codewatch report' },
    h('div', { style: S.bar },
      rep.error ? h('span', { style: { ...S.error, marginRight: 'auto' } }, str(rep.error)) : h('span', { style: { ...S.muted, marginRight: 'auto' } }, 'Codewatch report'),
      rep.html ? h('button', { type: 'button', style: S.btn, onClick: ui.downloadReport }, 'Download') : null,
      h('button', { type: 'button', style: S.btn, onClick: ui.closeReport }, 'Close')),
    rep.html ? h('iframe', { title: 'Codewatch report', sandbox: '', referrerPolicy: 'no-referrer', srcDoc: withReportCsp(rep.html), style: S.report }) : null);
}

export default function PrismPage() {
  const React = window.__kirocrew_modules.react;
  const sdk = window.__kirocrew_modules['@kirocrew/app-sdk'];
  const { useState, useEffect, useRef, useCallback, createElement: h } = React;
  const api = sdk.useAppApi();
  const theme = typeof sdk.useTheme === 'function' ? sdk.useTheme() : null;
  const frame = useRef(null);
  /** The prism-cli version of the bundle on screen. */
  const shownVersion = useRef('');
  /** When the running action started (0: none), from its start until its status says it is done. */
  const actionRunning = useRef(0);
  const [doc, setDoc] = useState('');
  const [error, setError] = useState('');
  const [update, setUpdate] = useState(null);
  const [copied, setCopied] = useState(false);
  const [report, setReport] = useState(null);
  const dark = !theme || (typeof theme === 'object' ? theme.mode !== 'light' && theme.resolved !== 'light' : theme !== 'light');

  const load = useCallback(() => {
    setError(''); setUpdate(null);
    api.get(API + '/ui/bundle')
      .then((b) => { shownVersion.current = str(b.version); setDoc(srcdocFor(b, dark ? 'dark' : 'light')); })
      .catch((e) => {
        const j = errorBody(e);
        if (j && j.update) setUpdate({ reason: str(j.error).replace(/\s*Update prism-cli to [\s\S]*$/, ''), command: str(j.command) });
        else setError(str(j ? j.error : e && (e.body || e.message)) || 'could not load the PRISM page');
      });
  }, [api, dark]);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onMessage = async (e) => {
      const f = frame.current;
      if (!f || e.source !== f.contentWindow) return;
      const m = checkMessage(e.data);
      if (!m) return;
      if (m.report) {
        const a = await relay(api, { op: 'get', path: '/api/report', query: { id: m.report } });
        setReport(a.status === 200 && a.json && typeof a.json.html === 'string' ? { html: a.json.html } : { error: 'No report for that review (' + str(a.json && a.json.error) + ').' });
        return;
      }
      const a = await relay(api, m);
      // The iframe's origin is opaque ("null"), so '*' is the only target that reaches it; the window itself is the target.
      if (frame.current && frame.current.contentWindow) frame.current.contentWindow.postMessage({ type: 'prism-ui:response', id: m.id, status: a.status, json: a.json }, '*');
      // Is an action running? Its start answers 202 and the drawer polls /api/action/status until it is done.
      if (m.op === 'act' && a.status === ACTION_STARTED) actionRunning.current = Date.now();
      else if (m.path === '/api/action/status' && a.json && a.json.state !== 'running') actionRunning.current = 0;
      // The drawer polls until the action ends; past the longest action timeout, stop waiting for it.
      if (actionRunning.current && Date.now() - actionRunning.current > ACTION_WAIT_MAX_MS) actionRunning.current = 0;
      // prism-cli was updated while this page was open: the backend already runs the new one. Redraw from its
      // bundle, after the answer above reached the frame and never while an action's output is still coming in.
      if (!actionRunning.current && bundleOutdated(shownVersion.current, a.version)) { shownVersion.current = a.version; loadRef.current(); }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [api]);

  const ui = {
    copied,
    copy: (text) => { navigator.clipboard && navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false)); },
    reload: () => { setDoc(''); load(); },
    closeReport: () => setReport(null),
    downloadReport: () => {
      if (!report || !report.html) return;
      const url = URL.createObjectURL(new Blob([report.html], { type: 'text/html' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'prism-codewatch-report.html'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
    },
  };

  if (update) return renderUpdate(h, update, ui);
  if (error) return h('div', { style: S.page }, h('h1', { style: S.h1 }, 'PRISM'), h('p', { style: S.error }, error), h('button', { type: 'button', style: S.btn, onClick: ui.reload }, 'Try again'));
  if (!doc) return h('p', { style: { ...S.page, ...S.muted } }, 'Loading PRISM…');
  return h(React.Fragment, null,
    h('iframe', { ref: frame, title: 'PRISM', sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', srcDoc: doc, style: S.frame }),
    report ? renderReport(h, report, ui) : null);
}
