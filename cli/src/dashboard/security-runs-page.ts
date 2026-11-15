/**
 * Security runs on the page: the runs table (Dashboard card with the latest 5,
 * the full table on the Security Agent page, the repo page's table for one
 * repo), the drill-down (#security/run/<repoId>/<runId>), and the "Complete.
 * View findings" link for the action drawer and the results card.
 *
 * A JS string concatenated into page.ts's single document before
 * security-page.ts, whose router calls drawRunDetail. The rows come from
 * /api/data (security_runs); a drill-down reads GET /api/security-run, which
 * reads local result files only. Every value from the server is placed with
 * textContent or an attribute: finding text comes from AWS and from code.
 */

export const SECURITY_RUNS_STYLE = `
.runtype { display:inline-flex; align-items:center; gap:7px; font-weight:600; white-space:nowrap; }
.runtype svg { width:18px; height:18px; color:var(--accent); flex:none; }
.st { display:inline-flex; align-items:center; gap:6px; font-weight:600; font-size:13px; white-space:nowrap; }
.st::before { content:""; width:9px; height:9px; border-radius:50%; background:currentColor; flex:none; }
.st.complete { color:var(--ok); }
.st.running { color:var(--warn); } .st.running::before { background:transparent; border:2px solid currentColor; border-right-color:transparent; animation:runspin 1.2s linear infinite; }
.st.failed { color:var(--bad); } .st.failed::before { border-radius:2px; }
.st.noverdict { color:var(--muted); } .st.noverdict::before { background:transparent; border:2px dashed currentColor; }
@keyframes runspin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .st.running::before { animation:none; } }
.runfilters { display:flex; flex-wrap:wrap; gap:8px 10px; align-items:center; margin:0 0 12px; }
.runfilters label { font-size:12px; color:var(--muted); display:inline-flex; align-items:center; gap:6px; }
.runfilters select { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); }
.runfilters .count { margin-left:auto; font-size:12px; color:var(--muted); }
table.runs { width:100%; border-collapse:collapse; font-size:13px; }
table.runs th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
table.runs td { padding:10px; border-bottom:1px solid var(--line); vertical-align:middle; }
table.runs tr:last-child td { border-bottom:0; }
table.runs tbody tr:hover td { background:var(--raised); }
/* The marker: a bar on the row's first cell, red for failed, amber for running. */
table.runs tr.run-failed td:first-child { box-shadow:inset 3px 0 0 var(--bad); }
table.runs tr.run-running td:first-child { box-shadow:inset 3px 0 0 var(--warn); }
table.runs .rrepo { font-weight:600; overflow-wrap:anywhere; } table.runs .rrepo small { display:block; color:var(--muted); font-weight:400; font-size:12px; }
table.runs .rwhen { white-space:nowrap; } table.runs .rwhen small { display:block; color:var(--muted); font-size:12px; }
table.runs .rsum { min-width:220px; } table.runs .rsum .fix { margin-top:3px; }
table.runs .rgo { text-align:right; white-space:nowrap; } .rgo a { font-weight:600; } .rgo .later { color:var(--muted); font-size:12px; }
.runchips { display:inline-flex; gap:5px; flex-wrap:wrap; } .runchips .pill { font-size:11px; padding:0 7px; }
.runchips .pill.zero::before { background:transparent; border:1px solid currentColor; }
.runmore { margin-top:12px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
@media (max-width: 700px) {
  table.runs thead { display:none; }
  table.runs, table.runs tbody, table.runs tr, table.runs td { display:block; width:100%; }
  table.runs tr { border-bottom:1px solid var(--line); padding:10px 0 10px 8px; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 10px; }
  table.runs td { border:0; padding:0; }
  table.runs tr.run-failed td:first-child, table.runs tr.run-running td:first-child { box-shadow:none; }
  table.runs tr.run-failed { box-shadow:inset 3px 0 0 var(--bad); } table.runs tr.run-running { box-shadow:inset 3px 0 0 var(--warn); }
  table.runs .c-type { grid-column:1; grid-row:1; } table.runs .c-status { grid-column:2; grid-row:1; text-align:right; }
  table.runs .c-repo, table.runs .rwhen, table.runs .rsum, table.runs .rgo { grid-column:1 / -1; }
  table.runs .rgo { text-align:left; }
  table.runs .rrepo small, table.runs .rwhen small { display:inline; margin-left:6px; }
  .runfilters .count { margin-left:0; flex-basis:100%; }
}
.rundl { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:6px 18px; font-size:13px; margin:0; }
.rundl dt { color:var(--muted); } .rundl dd { margin:0; overflow-wrap:anywhere; }
.runhead h3 { margin-top:0; }
.runhead { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); gap:18px; }
@media (max-width: 860px) { .runhead { grid-template-columns:minmax(0,1fr); } }
.sevboxes { display:flex; flex-wrap:wrap; gap:8px; margin:6px 0 2px; }
.sevbox { border:1px solid var(--line); border-radius:10px; padding:6px 12px; min-width:84px; background:var(--raised); }
.sevbox b { font-size:18px; display:block; } .sevbox span { font-size:12px; color:var(--muted); text-transform:capitalize; }
.sevbox.critical b, .sevbox.high b { color:var(--high); } .sevbox.medium b { color:var(--medium); } .sevbox.low b { color:var(--low); } .sevbox.zero b { color:var(--muted); }
.sevfilter { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 12px; }
.sevfilter button { border-radius:999px; padding:2px 10px; font-size:12px; color:var(--muted); }
.sevfilter button[aria-pressed="true"] { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); font-weight:600; }
details.rf { border:1px solid var(--line); border-radius:10px; margin-bottom:8px; }
details.rf > summary { list-style:none; cursor:pointer; padding:10px 12px; display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:4px 12px; align-items:center; }
details.rf > summary::-webkit-details-marker { display:none; }
details.rf > summary .t { font-weight:600; overflow-wrap:anywhere; }
details.rf > summary .loc { grid-column:2 / -1; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
details.rf > summary .chev { color:var(--muted); } details.rf[open] > summary .chev { transform:rotate(90deg); }
details.rf[open] > summary { border-bottom:1px solid var(--line); background:var(--raised); border-radius:10px 10px 0 0; }
details.rf .body { padding:10px 14px 14px; font-size:13px; } details.rf .body p { margin:4px 0 10px; white-space:pre-wrap; overflow-wrap:anywhere; }
details.rf .body h4 { margin:10px 0 2px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
ul.runlinks { list-style:none; padding:0; margin:0; } ul.runlinks li { margin:0 0 10px; overflow-wrap:anywhere; }
.rundone { margin-top:8px; padding:8px 12px; border:1px solid var(--ok); border-left-width:4px; border-radius:8px; background:color-mix(in srgb, var(--ok) 10%, var(--card)); display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.rundone b { color:var(--ok); } .rundone.bad { border-color:var(--bad); background:color-mix(in srgb, var(--bad) 10%, var(--card)); } .rundone.bad b { color:var(--bad); }
`;

export const SECURITY_RUNS_SCRIPT = `
const RUN_TYPES = { 'code-review': 'Code review', 'threat-model': 'Threat model', pentest: 'Pentest' };
const RUN_STATUS = { complete: 'complete', running: 'running', failed: 'failed', noverdict: 'no verdict yet' };
const RUN_SEVS = ['critical', 'high', 'medium', 'low'];
/** Each type's icon as SVG elements (built with createElementNS; no markup strings). */
const RUN_ICON = {
  'code-review': [['polyline', { points: '8 6 2 12 8 18' }], ['polyline', { points: '16 6 22 12 16 18' }], ['line', { x1: '13.5', y1: '4', x2: '10.5', y2: '20' }]],
  'threat-model': [['path', { d: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z' }], ['path', { d: 'M12 8v4' }], ['circle', { cx: '12', cy: '15.5', r: '.6' }]],
  pentest: [['circle', { cx: '12', cy: '12', r: '8' }], ['circle', { cx: '12', cy: '12', r: '3' }], ['line', { x1: '12', y1: '1', x2: '12', y2: '5' }], ['line', { x1: '12', y1: '19', x2: '12', y2: '23' }], ['line', { x1: '1', y1: '12', x2: '5', y2: '12' }], ['line', { x1: '19', y1: '12', x2: '23', y2: '12' }]],
};
function runIcon(type) {
  const s = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  for (const [tag, a] of RUN_ICON[type] || []) { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(a)) n.setAttribute(k, v); s.append(n); }
  return s;
}
const runType = (t) => el('span', { class: 'runtype' }, runIcon(t), RUN_TYPES[t] || txt(t));
const runStatus = (s) => el('span', { class: 'st ' + (RUN_STATUS[s] ? s : 'noverdict') }, RUN_STATUS[s] || txt(s));
const runHref = (r) => '#security/run/' + txt(r.repo_id) + '/' + encodeURIComponent(txt(r.run_id));
function runDur(s) {
  if (typeof s !== 'number') return null;
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' min';
}
/** Four labeled chips, highest first; a zero is greyed out. */
const runChips = (c) => el('span', { class: 'runchips' }, ...RUN_SEVS.map((s) => { const n = (c || {})[s] || 0; return sevPill(n ? s : 'zero', n + ' ' + s); }));
function runSummary(r) {
  if (r.status === 'running') return [el('div', {}, 'Running in Security Agent'), el('div', { class: 'fix' }, 'Findings appear when it finishes')];
  if (r.status === 'noverdict') return [el('div', {}, 'Started, but no result was fetched'), el('div', { class: 'fix' }, 'Fetch its findings on the Security Agent page')];
  if (r.status === 'failed') return [el('div', {}, 'No verdict'), r.reason ? el('div', { class: 'fix' }, txt(r.reason)) : null];
  return [runChips(r.counts), el('div', { class: 'fix' }, r.total ? 'Top: ' + txt(r.top_title) : 'No findings')];
}
function runLink(r) {
  if (r.status === 'running') return el('span', { class: 'later' }, 'no findings yet');
  return el('a', { href: runHref(r) }, r.status === 'complete' ? 'View findings →' : 'View details →');
}
function runRow(r) {
  const wait = r.status === 'running' ? 'running for ' + ago(r.started_at).replace(/ ago$/, '') : runDur(r.duration_s) ? 'took ' + runDur(r.duration_s) : '';
  return el('tr', { class: 'run-' + txt(r.status), 'data-run': txt(r.run_id) },
    el('td', { class: 'c-type' }, runType(r.type)),
    el('td', { class: 'c-repo rrepo' }, txt(r.repo), el('small', {}, [r.branch ? txt(r.branch) : null, r.commit ? txt(r.commit).slice(0, 7) : null].filter(Boolean).join(' @ '))),
    el('td', { class: 'c-status' }, runStatus(r.status)),
    el('td', { class: 'rwhen' }, ago(r.started_at), wait ? el('small', {}, wait) : null),
    el('td', { class: 'rsum' }, ...runSummary(r)),
    el('td', { class: 'rgo' }, runLink(r)));
}
const runRows = () => (LAST && LAST.security_runs) || [];

/**
 * The runs table. o: { repoId (fixed repo), limit (rows shown), step (Show more adds), filters, title, sub, foot }.
 * Filters and paging redraw only this card.
 */
function runsTable(o) {
  const all = runRows().filter((r) => !o.repoId || r.repo_id === o.repoId);
  const state = { type: '', repo: '', status: '', shown: o.limit };
  const s = el('section', { class: 'card', id: o.id || null }, el('h2', {}, o.title || 'Security runs', o.sub ? el('span', { class: 'sub' }, o.sub) : null));
  if (!all.length) {
    s.append(el('p', { class: 'empty' }, o.repoId ? 'No code reviews, threat models or pentests saved for this repo yet. Start one on the ' : 'No code reviews, threat models or pentests saved yet. Start one on the ',
      el('a', { href: '#security' }, 'Security Agent page'), '.'));
    return s;
  }
  const body = el('tbody'), count = el('span', { class: 'count' }), more = el('div', { class: 'runmore' });
  if (o.filters) {
    const sel = (label, key, opts) => {
      const x = el('select', { 'aria-label': label, 'data-filter': key }, el('option', { value: '' }, 'All'), ...opts.map(([v, t]) => el('option', { value: v }, t)));
      x.addEventListener('change', () => { state[key] = x.value; state.shown = o.limit; draw(); });
      return el('label', {}, label, x);
    };
    const repos = [...new Map(all.map((r) => [r.repo_id, r.repo])).entries()];
    s.append(el('div', { class: 'runfilters' }, sel('Type', 'type', Object.entries(RUN_TYPES)), o.repoId || repos.length < 2 ? null : sel('Repo', 'repo', repos),
      sel('Status', 'status', Object.entries(RUN_STATUS)), count));
  }
  s.append(el('div', { class: 'tablewrap' }, el('table', { class: 'runs' },
    el('thead', {}, el('tr', {}, ...['Type', 'Repo', 'Status', 'Started', 'Summary', ''].map((h) => el('th', {}, h)))), body)), more);
  function draw() {
    const rows = all.filter((r) => (!state.type || r.type === state.type) && (!state.repo || r.repo_id === state.repo) && (!state.status || r.status === state.status));
    const shown = rows.slice(0, state.shown);
    count.textContent = rows.length ? 'Showing ' + shown.length + ' of ' + rows.length + ' run' + (rows.length === 1 ? '' : 's') : '';
    body.replaceChildren(...(shown.length ? shown.map(runRow) : [el('tr', {}, el('td', { colspan: '6', class: 'fix' }, 'No runs match these filters.'))]));
    more.replaceChildren();
    if (o.step && rows.length > shown.length) {
      const b = el('button', { type: 'button' }, 'Show ' + Math.min(o.step, rows.length - shown.length) + ' more');
      b.addEventListener('click', () => { state.shown += o.step; draw(); });
      more.append(b);
    }
    if (o.foot) more.append(o.foot(rows.length));
  }
  draw();
  return s;
}

/** The Dashboard's card: the latest 5 runs in every repo, and a link to the full table. */
function securityRunsCard() {
  const n = runRows().length;
  return runsTable({ id: 'security-runs', limit: 5, title: 'Security runs', sub: 'latest code reviews, threat models and pentests in every repo',
    foot: () => n ? el('a', { href: '#security', class: 'rlink', 'data-all-runs': '' }, 'See all ' + n + ' run' + (n === 1 ? '' : 's') + ' →') : null });
}

/** The Security Agent page's full table: filters, 25 rows, Show more. */
const allRunsCard = () => runsTable({ id: 'security-runs-all', limit: 25, step: 25, filters: true, title: 'Security runs',
  sub: 'every repo, newest first; from each repo\\'s .prism/results, no AWS call' });

/** The repo page's table: that repo only. */
const repoRunsCard = (repoId) => runsTable({ repoId, limit: 10, step: 25, filters: true, title: 'Security runs', sub: 'this repo, newest first' });

/** The newest run of this type in this repo, for the results card's link. */
const latestRunOf = (repoId, type) => runRows().find((r) => r.repo_id === repoId && r.type === type) || null;

/** "Complete. View findings →" for a finished run; nothing while it runs. */
function runDoneBar(r, summary) {
  if (!r || r.status === 'running' || !r.repo || !r.run) return null;
  const href = '#security/run/' + txt(r.repo) + '/' + encodeURIComponent(txt(r.run));
  const ok = r.status === 'complete';
  return el('div', { class: 'rundone' + (ok ? '' : ' bad'), 'data-run-link': '' }, el('b', {}, ok ? 'Complete.' : r.status === 'failed' ? 'Failed.' : 'No verdict yet.'), summary || null,
    el('a', { href }, ok ? 'View findings →' : 'View details →'));
}
/** The results card cell's link for the newest run of a type. */
const runCellLink = (repoId, type) => { const r = latestRunOf(repoId, type); return r ? runDoneBar({ repo: r.repo_id, run: r.run_id, status: r.status }) : null; };

// ---------------------------------------------------------------- the drill-down
const RUN_RE = new RegExp('^#security/run/([a-f0-9]{16})/([A-Za-z0-9_-]{1,200})$');
function runRoute() { const m = RUN_RE.exec(location.hash); return m ? { repo: m[1], run: m[2] } : null; }
let RUN_DETAIL = null, RUN_KEY = null, RUN_FETCH = null, RUN_SHOWN = null;
/** A run without a verdict yet can change under the page: its cached copy is refetched on every draw (route entry, the minute refresh). */
const runStale = (d) => !d || !d.found || d.run.status === 'running' || d.run.status === 'noverdict';
/** Leaving the drill-down (the router calls this) drops its copy, so coming back always reads the run again. */
function runLeave() { RUN_DETAIL = null; RUN_KEY = null; RUN_SHOWN = null; }

/** Draws the cached copy at once (when there is one), then reads the run again if it may have changed. */
async function drawRunDetail(root, route) {
  const key = route.repo + '/' + route.run;
  if (SNAPSHOT) { root.replaceChildren(el('section', { class: 'card' }, el('p', { class: 'empty' }, 'A run\\'s findings open on the live dashboard only (prism-cli dashboard). '), el('a', { href: '#security' }, 'Back to Security runs'))); return; }
  const cached = RUN_KEY === key ? RUN_DETAIL : null;
  // A finished run already on screen stays as it is: a refresh keeps the open findings and the filter.
  if (cached && !runStale(cached)) { if (RUN_SHOWN !== key) paintRunDetail(root, cached, key); return; }
  if (cached) paintRunDetail(root, cached, key); else root.replaceChildren(el('p', { class: 'loading' }, 'loading...'));
  if (RUN_FETCH === key) return;
  RUN_FETCH = key;
  let r;
  try { r = await api('/api/security-run?repo=' + encodeURIComponent(route.repo) + '&run=' + encodeURIComponent(route.run)); } catch (e) { r = { ok: false, json: { error: e.message } }; }
  finally { RUN_FETCH = null; }
  if (location.hash !== '#security/run/' + key) return;
  RUN_KEY = key; RUN_DETAIL = r.ok ? r.json : { found: false, error: txt(r.json && r.json.error) || 'could not load the run' };
  paintRunDetail(root, RUN_DETAIL, key);
}

function paintRunDetail(root, d, key) {
  RUN_SHOWN = key;
  const back = el('a', { href: '#security' }, 'Back to Security runs');
  if (!d.found) {
    root.replaceChildren(el('div', { class: 'crumbs' }, el('a', { href: '#' }, 'Dashboard'), ' / ', el('a', { href: '#security' }, 'Security Agent'), ' / run not found'),
      el('section', { class: 'card', 'data-run-missing': '' }, el('h2', {}, 'Run not found'), el('p', {}, txt(d.error)), el('p', {}, back)));
    return;
  }
  root.replaceChildren(...runDetail(d));
}

function runDetail(d) {
  const r = d.run, c = r.counts || {};
  const crumbs = el('div', { class: 'crumbs' }, el('a', { href: '#' }, 'Dashboard'), ' / ', el('a', { href: '#security' }, 'Security runs'), ' / ', (RUN_TYPES[r.type] || '') + ' · ' + txt(r.repo));
  const kv = (k, v) => v === null || v === undefined || v === '' ? [] : [el('dt', {}, k), el('dd', {}, v)];
  const head = el('section', { class: 'card', 'data-run-detail': txt(r.run_id) },
    el('h2', {}, runType(r.type), el('span', {}, txt(r.repo)), runStatus(r.status)),
    el('div', { class: 'runhead' },
      el('dl', { class: 'rundl' },
        ...kv('Repo', el('a', { href: '#repo/' + txt(r.repo_id) }, txt(r.repo))),
        ...kv('Branch, commit', [r.branch ? txt(r.branch) : null, r.commit ? el('code', {}, txt(r.commit)) : null].filter(Boolean).flatMap((x, i) => i ? [' @ ', x] : [x])),
        ...kv('Scope', d.scope ? txt(d.scope) : null),
        ...kv('Target', d.target_host ? el('code', {}, txt(d.target_host)) : null),
        ...kv('Account, region', d.account4 || d.region ? 'account ' + txt(d.account4 || 'unknown') + ' / ' + txt(d.region || 'unknown') : null),
        ...kv('Started', when(r.started_at) + ' (' + ago(r.started_at) + ')'),
        ...kv('Duration', r.status === 'running' ? 'still running' : runDur(r.duration_s) || 'not recorded'),
        ...kv('Job', r.job_id ? copyButton(txt(r.job_id)) : null)),
      el('div', {},
        el('h3', {}, r.type === 'threat-model' ? 'Threats by severity' : 'Findings by severity'),
        el('div', { class: 'sevboxes' }, ...RUN_SEVS.map((s) => el('div', { class: 'sevbox ' + ((c[s] || 0) ? s : 'zero') }, el('b', {}, String(c[s] || 0)), el('span', {}, s)))),
        d.overview ? el('p', { class: 'fix' }, 'Overview: ' + txt(d.overview)) : null)));
  const out = [crumbs, head];
  if (r.status === 'failed') out.push(el('section', { class: 'card' }, el('h2', {}, 'Why there is no verdict'), el('p', {}, txt(r.reason) || 'The job did not complete.')));
  if (r.status === 'running' || r.status === 'noverdict') out.push(el('section', { class: 'card' }, el('h2', {}, r.status === 'running' ? 'Still running' : 'No verdict fetched yet'),
    el('p', { class: 'fix' }, (r.status === 'running' ? 'Findings appear here when the job finishes. ' : 'The job most likely finished. ') + 'Fetch them on the ', el('a', { href: '#security/' + txt(r.repo_id) }, 'Security Agent page'), ', or run the command below.')));
  if (r.status === 'complete') out.push(runFindingsCard(d));
  out.push(el('section', { class: 'card' }, el('h2', {}, 'Report and links'), el('ul', { class: 'runlinks' },
    el('li', {}, el('b', {}, 'Result file: '), el('code', {}, txt(d.result_file))),
    el('li', {}, el('b', {}, 'Same run in a terminal: '), copyButton(txt(d.cli))),
    el('li', {}, el('b', {}, 'Security Agent console: '), el('span', { class: 'fix' }, 'prism-cli has no direct link to this run yet. Open the Security Agent web application and find the job id above.')))));
  return out;
}

function runFindingsCard(d) {
  const r = d.run, fs = d.findings || [], label = r.type === 'threat-model' ? 'Threats' : 'Findings';
  const s = el('section', { class: 'card', 'data-run-findings': String(fs.length) }, el('h2', {}, label, el('span', { class: 'sub' }, fs.length ? 'most severe first; open one for the full description' + (d.no_remediation ? '' : ' and recommendation') : '')));
  if (!fs.length) { s.append(el('p', { class: 'fix' }, r.type === 'threat-model' ? 'No threats in this run.' : 'No findings in this run.')); return s; }
  const levels = [...new Set(fs.map((f) => f.severity))];
  let pick = '';
  const list = el('div');
  const bar = el('div', { class: 'sevfilter', role: 'group', 'aria-label': 'Filter by severity' });
  const chip = (v, text) => { const b = el('button', { type: 'button', 'aria-pressed': String(v === pick), 'data-sev': v }, text); b.addEventListener('click', () => { pick = v; sync(); }); return b; };
  function sync() {
    bar.replaceChildren(chip('', 'All ' + fs.length), ...['critical', 'high', 'medium', 'low', 'info', 'unknown'].filter((x) => levels.includes(x)).map((x) => chip(x, x[0].toUpperCase() + x.slice(1) + ' ' + fs.filter((f) => f.severity === x).length)));
    list.replaceChildren(...fs.filter((f) => !pick || f.severity === pick).map((f, i) => runFinding(f, d, i === 0)));
  }
  sync();
  s.append(bar, list);
  return s;
}

function runFinding(f, d, open) {
  const where = [f.location ? el('code', {}, txt(f.location)) : null, f.cwe ? txt(f.cwe) : null, (f.stride || []).length ? (f.stride || []).map((x) => txt(x).toLowerCase().replace(/_/g, ' ')).join(', ') : null,
    f.confidence ? txt(f.confidence).toLowerCase() + ' confidence' : null].filter(Boolean).flatMap((x, i) => i ? [' · ', x] : [x]);
  const thr = d.run.type === 'threat-model';
  const dt = el('details', { class: 'rf' },
    el('summary', {}, sevPill(f.severity, txt(f.severity)), el('span', { class: 't' }, txt(f.title)), el('span', { class: 'chev', 'aria-hidden': 'true' }, '›'),
      where.length ? el('span', { class: 'loc' }, ...where) : null),
    el('div', { class: 'body' },
      el('h4', {}, thr ? 'Threat' : 'Description'), el('p', {}, txt(f.description) || 'No description saved.'),
      el('h4', {}, thr ? 'Recommendation' : 'Remediation'), el('p', { class: f.remediation ? null : 'fix' }, f.remediation ? txt(f.remediation) : txt(d.no_remediation) || 'None given.'),
      (f.evidence || []).length ? [el('h4', {}, 'Evidence'), el('p', {}, ...f.evidence.flatMap((e, i) => i ? [', ', el('code', {}, txt(e))] : [el('code', {}, txt(e))]))] : null,
      f.finding_id ? el('p', { class: 'fix' }, 'Finding id ', el('code', {}, txt(f.finding_id))) : null));
  if (open) dt.open = true;
  return dt;
}
`;
