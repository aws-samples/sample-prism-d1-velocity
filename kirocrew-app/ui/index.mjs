// PRISM page for Kiro Crew. Loaded by the dashboard with import('/apps/prism/ui/index.mjs');
// React and the App SDK come from the host (window.__kirocrew_modules), so there is no build step.
//
// Every value from the backend is recorded text (repo names, finding messages written by a
// reviewer model). It is only ever passed to React as a text child, which React escapes:
// nothing here sets innerHTML, builds a URL or an event handler from data. The report HTML
// goes into an iframe with an empty sandbox (no scripts, no same-origin, no forms, no popups)
// and carries a CSP that blocks script and every remote load.
// The page sends only indexes (repoIndex) to the backend, never a path.

export const REFRESH_MS = 5 * 60 * 1000;
export const API = '/api/apps/prism';

const v = (name, fallback) => `var(--${name}, ${fallback})`;
const S = {
  page: { padding: '16px', maxWidth: '1100px', color: v('text', 'inherit'), fontSize: '14px', lineHeight: 1.45, boxSizing: 'border-box', width: '100%' },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' },
  h1: { fontSize: '22px', fontWeight: 700, margin: 0, color: v('text-strong', 'inherit') },
  h2: { fontSize: '15px', fontWeight: 600, margin: '0 0 8px', color: v('text-strong', 'inherit') },
  muted: { color: v('muted', 'GrayText'), fontSize: '13px', margin: '2px 0', overflowWrap: 'anywhere' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', margin: '12px 0' },
  card: { background: v('card', 'transparent'), border: `1px solid ${v('border', 'GrayText')}`, borderRadius: '8px', padding: '10px 12px', minWidth: 0 },
  cardTitle: { color: v('muted', 'GrayText'), fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em' },
  cardValue: { fontSize: '20px', fontWeight: 700, margin: '4px 0 2px', overflowWrap: 'anywhere' },
  block: { background: v('card', 'transparent'), border: `1px solid ${v('border', 'GrayText')}`, borderRadius: '8px', padding: '12px', margin: '12px 0', minWidth: 0 },
  two: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' },
  ul: { listStyle: 'none', margin: 0, padding: 0 },
  li: { borderTop: `1px solid ${v('border', 'GrayText')}`, padding: '8px 0', minWidth: 0 },
  row: { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px', overflowWrap: 'anywhere' },
  btn: { border: `1px solid ${v('border', 'GrayText')}`, background: v('bg-elevated', 'transparent'), color: v('text', 'inherit'), borderRadius: '6px', padding: '4px 10px', fontSize: '13px', cursor: 'pointer' },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', background: v('bg-elevated', 'transparent'), padding: '2px 6px', borderRadius: '4px', overflowWrap: 'anywhere' },
  pre: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '13px', margin: '6px 0 0' },
  frame: { width: '100%', height: '70vh', minHeight: '320px', border: `1px solid ${v('border', 'GrayText')}`, borderRadius: '6px', background: '#fff' },
  error: { color: v('danger-text', 'red'), overflowWrap: 'anywhere' },
};
const TONE = { ok: v('ok', 'green'), warn: v('warn', 'orange'), error: v('danger', 'red'), none: v('border', 'GrayText') };
const STATUS_TONE = { ok: 'ok', info: 'none', warn: 'warn', missing: 'error' };
const SEV_TONE = { high: 'error', medium: 'warn', low: 'none' };
const str = (x) => (typeof x === 'string' ? x : x == null ? '' : String(x));

function badge(h, text, tone) {
  return h('span', { style: { display: 'inline-block', fontSize: '12px', fontWeight: 600, padding: '0 8px', borderRadius: '999px', border: `1px solid ${TONE[tone] || TONE.none}`, color: TONE[tone] || 'inherit' } }, str(text));
}

function list(h, title, rows) {
  return h('section', { style: S.block },
    h('h2', { style: S.h2 }, title),
    rows.length ? h('ul', { style: S.ul }, ...rows.map((r, i) => h('li', { key: i, style: S.li }, h('div', { style: S.row }, h('span', null, str(r.name)), h('span', { style: S.muted }, str(r.value))))))
      : h('p', { style: S.muted }, 'No data yet.'));
}

/**
 * The page body for one model. Pure: `h` is React.createElement (or a stub in tests),
 * `ui` holds the view state and callbacks. Exported for tests.
 */
export function renderModel(h, m, ui) {
  const repos = Array.isArray(m.repos) ? m.repos : [];
  const out = [];
  out.push(h('div', { key: 'head', style: S.head },
    h('h1', { style: S.h1 }, 'PRISM'),
    h('button', { type: 'button', style: S.btn, onClick: ui.refresh, disabled: ui.loading }, ui.loading ? 'Refreshing…' : 'Refresh')));
  out.push(h('p', { key: 'meta', style: S.muted },
    `Data from ${str(m.generatedAt)} · usage cached ${str(m.usageUpdatedAt) || 'unknown'}${m.usageStale ? ' (refreshing in the background)' : ''} · prism-cli ${str(m.version)}`));
  out.push(h('section', { key: 'cards', style: S.cards }, ...(m.cards || []).map((c, i) =>
    h('div', { key: i, style: S.card }, h('div', { style: S.cardTitle }, str(c.title)), h('div', { style: S.cardValue }, str(c.value)), h('div', { style: S.muted }, str(c.detail))))));
  out.push(h('div', { key: 'lists', style: S.two }, list(h, 'Top models this month', m.topModels || []), list(h, 'Top projects this month', m.topProjects || [])));

  out.push(h('section', { key: 'repos', style: S.block },
    h('h2', { style: S.h2 }, 'Repositories with codewatch'),
    m.reposNote ? h('p', { style: S.muted }, str(m.reposNote)) : null,
    repos.length ? null : h('p', { style: S.muted }, 'No repository has codewatch yet.'),
    h('ul', { style: S.ul }, ...repos.map((r, repoIndex) => h('li', { key: repoIndex, style: { ...S.li, borderLeft: `3px solid ${TONE[r.tone] || TONE.none}`, paddingLeft: '10px' } },
      h('div', { style: S.row },
        h('strong', null, str(r.name)),
        h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          badge(h, 'codewatch ' + str(r.status), STATUS_TONE[r.status] || 'none'),
          r.hasReport ? h('button', { type: 'button', style: S.btn, onClick: () => ui.openReport(repoIndex) }, 'Open report') : null)),
      h('p', { style: S.muted }, str(r.commit)),
      h('p', { style: S.muted }, r.when ? `Latest review: ${str(r.review)} · ${str(r.when)}` : str(r.review)),
      Array.isArray(r.findings) && r.findings.length ? h('details', null,
        h('summary', { style: { cursor: 'pointer', fontSize: '13px' } }, `Findings (${r.findings.length}${r.more ? '+' : ''})`),
        h('ul', { style: S.ul }, ...r.findings.map((f, fi) => h('li', { key: fi, style: S.li },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' } },
            badge(h, f.severity, SEV_TONE[f.severity] || 'none'), h('code', { style: S.code }, str(f.location)), h('span', { style: S.muted }, 'branch ' + str(f.branch))),
          h('div', { style: { marginTop: '4px', overflowWrap: 'anywhere' } }, str(f.message))))),
        r.more ? h('p', { style: S.muted }, str(r.more)) : null) : null,
      ui.report && ui.report.index === repoIndex ? reportView(h, ui.report, ui) : null)))));

  const d = m.digest || {};
  out.push(h('section', { key: 'digest', style: S.block },
    h('h2', { style: S.h2 }, 'Last digest'),
    h('p', { style: S.muted }, `Ran ${str(d.ran)} · last notification ${str(d.notified) || 'never'}`),
    d.message ? h('pre', { style: S.pre }, str(d.message)) : h('p', { style: S.muted }, 'Nothing notified yet.')));

  out.push(h('section', { key: 'setup', style: S.block },
    h('h2', { style: S.h2 }, 'Setup checklist'),
    h('p', { style: S.muted }, 'Commands are copy-only: paste them into a terminal to run them yourself.'),
    h('ul', { style: S.ul }, ...(m.checklist || []).map((c, i) => h('li', { key: i, style: S.li },
      h('div', { style: S.row }, h('strong', null, str(c.label)), badge(h, c.status, STATUS_TONE[c.status] || 'none')),
      h('p', { style: S.muted }, str(c.detail)),
      c.fix ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' } },
        h('code', { style: S.code }, str(c.fix)),
        h('button', { type: 'button', style: S.btn, onClick: () => ui.copy(str(c.fix)) }, ui.copied === str(c.fix) ? 'Copied' : 'Copy')) : null)))));
  return h('div', { style: S.page }, ...out);
}

function reportView(h, rep, ui) {
  if (rep.loading) return h('p', { style: S.muted }, 'Building the report…');
  if (rep.error) return h('p', { style: S.error }, str(rep.error));
  return h('div', { style: { marginTop: '8px' } },
    h('div', { style: S.row },
      h('span', { style: S.muted }, str(rep.note)),
      h('span', { style: { display: 'flex', gap: '6px' } },
        h('button', { type: 'button', style: S.btn, onClick: ui.downloadReport }, 'Download'),
        h('button', { type: 'button', style: S.btn, onClick: ui.closeReport }, 'Close'))),
    // sandbox="" : no scripts, opaque origin, no forms, no popups, no top navigation.
    h('iframe', { title: 'Codewatch report for ' + str(rep.repo), sandbox: '', referrerPolicy: 'no-referrer', srcDoc: str(rep.html), style: S.frame }));
}

/** The notice shown instead of data when no usage is cached for today. Exported for tests. */
export function renderNeedsCache(h, ui) {
  return h('div', { style: S.page },
    h('div', { style: S.head }, h('h1', { style: S.h1 }, 'PRISM')),
    h('section', { style: S.block },
      h('h2', { style: S.h2 }, 'No AI usage cached for today yet'),
      h('p', { style: S.muted }, 'This page reads the usage cache that prism-cli dashboard keeps, so it never starts a codeburn export by itself. Open prism-cli dashboard once, or load now: that runs the codeburn export and can take a minute.'),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', style: S.btn, onClick: ui.refresh, disabled: ui.loading }, 'Check again'),
        h('button', { type: 'button', style: S.btn, onClick: ui.loadWithExport, disabled: ui.loading }, ui.loading ? 'Loading…' : 'Load now (runs codeburn export)'))));
}

export default function PrismPage() {
  const React = window.__kirocrew_modules.react;
  const { useAppApi } = window.__kirocrew_modules['@kirocrew/app-sdk'];
  const { useState, useEffect, useCallback, useRef, createElement: h } = React;
  const api = useAppApi();
  const [model, setModel] = useState(null);
  const [needsCache, setNeedsCache] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [copied, setCopied] = useState('');
  const lastLoad = useRef(0);

  const load = useCallback((allowExport) => {
    setLoading(true);
    lastLoad.current = Date.now();
    api.get(API + '/data' + (allowExport ? '?allowExport=1' : ''))
      .then((d) => {
        if (d && d.needsUsageCache) { setNeedsCache(true); return; }
        setNeedsCache(false); setModel(d); setError(''); setReport(null);
      })
      .catch((e) => setError(str(e && e.body ? e.body : e && e.message)))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(() => {
    load(false);
    // Auto-refresh every 5 minutes while the page is visible; catch up when it becomes visible again.
    const tick = () => { if (document.visibilityState === 'visible' && Date.now() - lastLoad.current >= REFRESH_MS) load(false); };
    const timer = setInterval(tick, 30 * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  const ui = {
    loading, copied, report,
    refresh: () => load(false),
    loadWithExport: () => load(true),
    copy: (text) => { navigator.clipboard && navigator.clipboard.writeText(text).then(() => setCopied(text), () => setCopied('')); },
    openReport: (index) => {
      setReport({ index, loading: true });
      api.get(API + '/report?repoIndex=' + encodeURIComponent(String(index)))
        .then((r) => setReport({ index, repo: str(r.repo), note: str(r.note), html: str(r.html) }))
        .catch((e) => setReport({ index, error: str(e && e.body ? e.body : e && e.message) }));
    },
    closeReport: () => setReport(null),
    downloadReport: () => {
      if (!report || !report.html) return;
      const url = URL.createObjectURL(new Blob([report.html], { type: 'text/html' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'prism-codewatch-report.html';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
  };

  if (needsCache) return renderNeedsCache(h, ui);
  if (!model) return h('div', { style: S.page }, h('h1', { style: S.h1 }, 'PRISM'), error ? h('p', { style: S.error }, error) : h('p', { style: S.muted }, 'Loading PRISM data…'));
  return h(React.Fragment, null, error ? h('p', { style: { ...S.error, padding: '8px 16px 0' } }, error) : null, renderModel(h, model, ui));
}
