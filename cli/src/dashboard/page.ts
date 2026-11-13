/**
 * The dashboard's single-page app: one self-contained HTML document with
 * inline CSS and JS (nonce-gated by the CSP), no CDN and no network fetch
 * other than its own GET routes (/api/data, then /api/usage), so it works offline.
 *
 * Every value from the payload is placed with textContent or a DOM attribute;
 * innerHTML is never used for data.
 */

import { createHash } from 'node:crypto';
import { SETUP_SCRIPT, SETUP_STYLE, THEME_BOOT, THEME_SCRIPT } from './setup-page.js';

/** Colour tokens; the dark set applies by system preference unless the toggle picks Light, and always with Dark. */
const LIGHT_VARS = '--bg:#f7f7f8; --card:#fff; --text:#1d1d1f; --muted:#6b6b73; --line:#e3e3e8; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --high:#cf222e; --medium:#bf8700; --low:#3d6fa8; --accent:#0969da; --raised:var(--bg);';
const DARK_VARS = '--bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --line:#30363d; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --high:#f85149; --medium:#d29922; --low:#a5d6ff; --accent:#58a6ff; --raised:#21262d;';

const STYLE = `
:root { color-scheme: light; ${LIGHT_VARS} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; ${DARK_VARS} } }
:root[data-theme="dark"] { color-scheme: dark; ${DARK_VARS} }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; padding:14px 20px; border-bottom:1px solid var(--line); background:var(--card); }
header h1 { font-size:17px; margin:0; } header .meta { color:var(--muted); font-size:12px; margin-left:auto; }
button { font:inherit; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); cursor:pointer; }
main { padding:16px 20px; display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); }
@media (max-width: 640px) { main { padding:12px; gap:12px; } header { padding:12px; } header .meta { margin-left:0; flex-basis:100%; } }
section.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; min-width:0; }
section.wide { grid-column: 1 / -1; }
.sec-repo { border-top:1px solid var(--line); padding:10px 0; } .sec-repo:first-of-type { border-top:none; padding-top:0; } .sec-head { display:flex; gap:6px; align-items:baseline; flex-wrap:wrap; overflow-wrap:anywhere; }
.sec-pills { display:flex; gap:6px; flex-wrap:wrap; margin:6px 0; } ul.sec-findings { list-style:none; margin:4px 0 0; padding:0; } ul.sec-findings li { padding:6px 0; border-top:1px dashed var(--line); font-size:13px; overflow-wrap:anywhere; } .sec-title { font-weight:600; } ul.sec-findings code { white-space:normal; overflow-wrap:anywhere; }
h2 { font-size:15px; margin:0 0 10px; } h3 { font-size:13px; margin:14px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.empty { color:var(--muted); padding:8px 0; } code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; background:var(--bg); padding:1px 4px; border-radius:4px; }
.tablewrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; } th, td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:break-word; }
th { white-space:nowrap; } td.msg { min-width:280px; } td.count { font-variant-numeric:tabular-nums; font-weight:600; } td code { white-space:normal; overflow-wrap:anywhere; }
th { color:var(--muted); font-weight:600; } td.num { text-align:right; font-variant-numeric: tabular-nums; }
.pill { white-space:nowrap; display:inline-block; padding:0 7px; border-radius:10px; font-size:12px; font-weight:600; border:1px solid currentColor; }
.s-ok { color:var(--ok); } .s-info { color:var(--accent); } .s-warn, .s-findings, .s-skipped { color:var(--warn); } .s-missing, .s-error { color:var(--bad); }
.sev-high { color:var(--high); } .sev-medium { color:var(--medium); } .sev-low { color:var(--low); }
.stats { display:flex; gap:18px; flex-wrap:wrap; margin:6px 0; } .stat b { display:block; font-size:20px; } .stat span { color:var(--muted); font-size:12px; }
.fix { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.tag { margin-left:6px; font-size:11px; padding:0 6px; border-radius:8px; background:var(--bg); border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
details.missing-group > summary { cursor:pointer; padding:8px 0; color:var(--muted); font-weight:600; }
details.repo { border-top:1px solid var(--line); padding:8px 0; } details.repo > summary { cursor:pointer; padding:4px 0; } details.repo .detail { padding-left:14px; }
.callout { border:1px solid var(--accent); border-left-width:4px; border-radius:6px; padding:10px 12px; margin:6px 0 10px; background:color-mix(in srgb, var(--accent) 8%, var(--card)); }
.callout.warn { border-color:var(--warn); background:color-mix(in srgb, var(--warn) 10%, var(--card)); } .callout code { white-space:normal; overflow-wrap:anywhere; }
.crow { display:grid; grid-template-columns: 6.5em minmax(10em,2.2fr) minmax(5em,0.8fr) 10.5em 7.5em minmax(11em,1.6fr); gap:8px; padding:6px 6px; border-bottom:1px solid var(--line); align-items:start; font-size:13px; overflow-wrap:anywhere; }
.chead { color:var(--muted); font-weight:600; } summary.crow { cursor:pointer; list-style:none; } summary.crow::-webkit-details-marker { display:none; } details.cdetails[open] > summary.crow { background:var(--bg); } details.cdetails > .tablewrap { padding:4px 0 8px 18px; }
@media (max-width: 760px) { .crow { grid-template-columns: 1fr 1fr; } .chead { display:none; } }
a.rlink { color:var(--accent); } a.rlink:hover { text-decoration:underline; }
.help { font-size:12px; margin-top:4px; overflow-wrap:anywhere; } .help-links { margin-top:2px; } .help-steps { margin:4px 0; padding-left:18px; } .help code { white-space:normal; overflow-wrap:anywhere; }
.banner { border:1px solid var(--warn); border-left-width:4px; border-radius:6px; padding:10px 12px; margin:4px 0 12px; background:color-mix(in srgb, var(--warn) 10%, var(--card)); }
.banner strong { color:var(--text); display:block; margin-bottom:4px; } .banner .fix code { white-space:normal; overflow-wrap:anywhere; } .note { color:var(--muted); font-size:12px; margin-top:10px; }
.banner.snapshot { margin:12px 20px 0; border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, var(--card)); } .banner.snapshot strong { font-size:15px; }
svg.trend rect.high { fill:var(--high); } svg.trend rect.medium { fill:var(--medium); } svg.trend rect.low { fill:var(--low); } svg.trend rect.zero { fill:var(--ok); }
svg.trend line { stroke:var(--line); }
.repo-title { font-size:12px; color:var(--muted); margin-bottom:6px; word-break:break-all; }
.summary { display:grid; gap:14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
@media (min-width: 641px) and (max-width: 1040px) { .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .summary { grid-template-columns: 1fr; gap:10px; } }
.scard { min-width:0; display:flex; flex-direction:column; gap:6px; padding:14px 16px; border:1px solid var(--line); border-radius:8px; background:var(--raised); }
.scard .k { color:var(--muted); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
.scard .v { font-size:28px; font-weight:700; line-height:1.15; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.scard .v .unit { font-size:13px; font-weight:600; color:var(--muted); margin:0 10px 0 4px; }
.scard .d { color:var(--muted); font-size:13px; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.slim-line { padding:5px 0; border-top:1px solid var(--line); font-size:13px; overflow-wrap:anywhere; } .slim-line:first-of-type { border-top:none; } .slim-line code { white-space:normal; overflow-wrap:anywhere; }
.empty-line { color:var(--muted); margin:10px 0 4px; font-size:13px; overflow-wrap:anywhere; } .empty-line b { color:var(--text); }
.changed { outline:2px solid var(--accent); outline-offset:1px; border-radius:4px; }
.loading { color:var(--muted); }
@keyframes prism-flash { from { background-color:color-mix(in srgb, var(--accent) 35%, transparent); } to { background-color:transparent; } }
@media (prefers-reduced-motion: no-preference) { .changed { animation:prism-flash 2.5s ease-out 1; } }
${SETUP_STYLE}
`;

const SCRIPT = `
'use strict';
/** Set in a static snapshot (dashboard --snapshot): the embedded data. Nothing is fetched and nothing runs. */
const SNAPSHOT = (() => { const n = document.getElementById('prism-snapshot'); try { return n ? JSON.parse(n.textContent) : null; } catch (e) { return null; } })();
const SVG = 'http://www.w3.org/2000/svg';
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v !== null && v !== undefined) n.setAttribute(k, String(v)); }
  for (const c of kids.flat()) { if (c === null || c === undefined || c === false) continue; n.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  return n;
}
const txt = (v) => (v === null || v === undefined ? '' : String(v));
const pill = (status, label) => el('span', { class: 'pill s-' + txt(status).replace(/[^a-z-]/g, '') }, label || status);
const sev = (s) => el('span', { class: 'sev-' + txt(s).replace(/[^a-z]/g, '') }, s);
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? txt(iso) : d.toLocaleString(); };
const short = (sha) => (sha ? txt(sha).slice(0, 8) : '');
function money(n, cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(n || 0); } catch { return '$' + (n || 0).toFixed(2); } }
function table(head, rows) {
  return el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => (c instanceof Node && c.nodeName === 'TD') ? c : el('td', {}, c)))))));
}
const num = (v) => el('td', { class: 'num' }, txt(v));

/** Repo labels (a parent path when two repos share a name), set on each load from data.repos. */
let LABELS = new Map();
const labelOf = (r) => LABELS.get(r.path) || txt(r.name);

/** Sections with no data, each collected as one line into the "Nothing recorded yet" card. */
let EMPTY = [];
function emptyLine(title, ...parts) { EMPTY.push(el('div', { class: 'slim-line' }, el('b', {}, title), ': ', ...parts)); return null; }
/** The same one line, inside a card that has other content. */
const inlineEmpty = (title, ...parts) => el('p', { class: 'empty-line' }, el('b', {}, title), ': ', ...parts);

/** Values compared between loads: key -> text. A changed value is outlined. */
let PREV = null, CUR = {};
function track(key, value, node) { CUR[key] = txt(value); node.setAttribute('data-track', key); return node; }
function changedKeys(prev, cur) { return prev ? Object.keys(cur).filter((k) => k in prev && prev[k] !== cur[k]) : []; }

function trendSvg(trend) {
  const w = Math.max(trend.length * 14, 140), h = 48, svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'trend'); svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h + 2));
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'findings per run, oldest first');
  const max = Math.max(1, ...trend.map((r) => r.high + r.medium + r.low));
  const base = document.createElementNS(SVG, 'line');
  base.setAttribute('x1', '0'); base.setAttribute('x2', String(w)); base.setAttribute('y1', String(h)); base.setAttribute('y2', String(h)); svg.append(base);
  trend.forEach((r, i) => {
    let y = h; const parts = [['high', r.high], ['medium', r.medium], ['low', r.low]];
    const total = r.high + r.medium + r.low;
    if (total === 0) parts.push(['zero', 0]);
    for (const [cls, n] of parts) {
      const bh = cls === 'zero' ? 3 : Math.round((n / max) * (h - 4)); if (!bh) continue;
      y -= bh; const rect = document.createElementNS(SVG, 'rect');
      rect.setAttribute('x', String(i * 14 + 2)); rect.setAttribute('y', String(y)); rect.setAttribute('width', '10'); rect.setAttribute('height', String(bh)); rect.setAttribute('class', cls);
      const t = document.createElementNS(SVG, 'title'); t.textContent = when(r.started_at) + ' ' + r.kind + ' ' + r.status + ' (' + r.tool + '): ' + r.high + ' high, ' + r.medium + ' medium, ' + r.low + ' low';
      rect.append(t); svg.append(rect);
    }
  });
  return svg;
}

function scanBanner(ss) {
  if (!ss || !ss.banner) return null;
  return el('div', { class: 'banner', role: 'alert' },
    el('strong', {}, ss.banner),
    el('div', { class: 'fix' }, 'Install: ', el('code', {}, ss.installHint)));
}

function repoName(r) {
  return el('span', { title: r.path }, labelOf(r), r.current ? el('span', { class: 'tag' }, 'this repo') : null);
}

const REVIEW_STATUS = { ok: 'clean', findings: 'findings', error: 'failed', skipped: 'skipped' };

/** The summary strip: latest review, spend, setup warnings. Same object as summary in --json. */
/** Long detail text is clamped to three lines by CSS; the full text stays in the title. */
const DETAIL_TITLE_MIN = 80;
const detail = (...parts) => {
  const d = el('div', { class: 'd' }, ...parts);
  const full = d.textContent;
  if (full.length > DETAIL_TITLE_MIN) d.setAttribute('title', full);
  return d;
};
/** One summary card: label, large value, one detail line. */
const scard = (label, value, det) => el('div', { class: 'scard' }, el('div', { class: 'k' }, label), value, det);

/** The summary cards: latest review, spend today, spend this month, setup warnings. Same object as summary in --json. */
function summaryPanel(sum) {
  const s = el('section', { class: 'card wide' }, el('h2', {}, 'Summary'));
  const box = el('div', { class: 'summary' });
  const rv = sum && sum.review;
  if (rv) {
    const ran = rv.status !== 'skipped' && rv.status !== 'error';
    const counts = ran ? rv.high + ' high · ' + rv.medium + ' medium · ' + rv.low + ' low' : txt(REVIEW_STATUS[rv.status] || rv.status);
    const value = ran
      ? el('div', { class: 'v' }, el('span', { class: rv.high ? 'sev-high' : '' }, String(rv.high)), el('span', { class: 'unit' }, 'high'),
        el('span', { class: rv.medium ? 'sev-medium' : '' }, String(rv.medium)), el('span', { class: 'unit' }, 'med'),
        el('span', { class: rv.low ? 'sev-low' : '' }, String(rv.low)), el('span', { class: 'unit' }, 'low'))
      : el('div', { class: 'v' }, counts.charAt(0).toUpperCase() + counts.slice(1));
    box.append(scard('Latest codewatch review', track('sum:review', rv.id + ' ' + counts, value),
      detail(el('span', { title: rv.path }, txt(rv.repo)), ' · ', reportLink(rv.id, when(rv.at)), ' · ' + txt(rv.reviewer) + (rv.reason ? ' · ' + txt(rv.reason) : ''))));
  } else {
    box.append(scard('Latest codewatch review', el('div', { class: 'v' }, 'none'), detail('No pre-push review recorded yet.')));
  }
  const sp = sum && sum.spend;
  const ok = sp && sp.status === 'ok';
  const loadingUsage = sp && sp.status === 'loading';
  const updated = sp && sp.updatedAt ? ' · updated ' + when(sp.updatedAt) : '';
  const spendCard = (label, key, n, det) => scard(label,
    ok ? track(key, n, el('div', { class: 'v' }, money(n, sp.currency))) : el('div', { class: 'v' + (loadingUsage ? ' loading' : '') }, loadingUsage ? 'loading' : '-'),
    detail(ok ? det + updated : txt((sp && sp.message) || (sp && sp.status) || 'no codeburn data')));
  box.append(spendCard('Spend today', 'sum:today', sp && sp.today, 'codeburn, all projects'));
  box.append(spendCard('Spend this month', 'sum:month', sp && sp.month, 'codeburn, this calendar month'));
  const w = (sum && sum.warnings) || { count: 0, first: null };
  box.append(scard('Setup warnings',
    track('sum:warnings', w.count, el('div', { class: 'v' + (w.count ? ' s-warn' : ' s-ok') }, String(w.count))),
    detail(w.first ? txt(w.first) : 'Nothing needs attention.')));
  s.append(box);
  return s;
}

const SCAN_LABEL = { ok: ['ok', 'ok'], 'not-scanned': ['warn', 'not scanned'], 'no-verify': ['warn', 'no-verify'], flagged: ['missing', 'secrets found'], none: ['skipped', '-'] };

/** Link to a scan report. Ids come from the server's own listing; encodeURIComponent keeps them literal. A snapshot has no report pages. */
const reportLink = (id, label) => SNAPSHOT
  ? el('span', { title: 'Report pages open from the live dashboard (prism-cli dashboard) or prism-cli codewatch report' }, label)
  : el('a', { href: '/report/' + encodeURIComponent(id), class: 'rlink' }, label);

function reviewCell(rv) {
  if (rv.state === 'not-reviewed') return el('span', { class: 'fix' }, 'not reviewed');
  const link = rv.reportId ? [' ', reportLink(rv.reportId, 'report')] : [];
  if (rv.state === 'failed') return el('span', { title: txt(rv.reason) }, pill('error', 'review failed'), link);
  const who = el('span', { class: 'fix' }, ' ' + txt(rv.tool || '') + (rv.model ? ' / ' + rv.model : '') + (rv.reviewCount > 1 ? ' · reviewed ' + rv.reviewCount + 'x' : ''));
  if (rv.state === 'clean') return el('span', {}, pill('ok', 'reviewed, clean'), who, link);
  const counts = el('span', {},
    rv.high ? el('b', { class: 'sev-high' }, rv.high + ' high ') : null,
    rv.medium ? el('b', { class: 'sev-medium' }, rv.medium + ' medium ') : null,
    rv.low ? el('b', { class: 'sev-low' }, rv.low + ' low') : null);
  return el('span', {}, counts, who, link);
}

/** The newest reviews, each linking to its report. */
function scansList(scans) {
  if (!scans || !scans.length) return el('p', { class: 'empty' }, 'No pre-push reviews yet.');
  return table(['When', 'Branch', 'Reviewer', 'Result', 'Findings', ''], scans.map((s) => [
    when(s.started_at), txt(s.branch || '-'), txt(s.tool) + (s.model ? ' / ' + s.model : ''),
    pill(s.status === 'ok' ? 'ok' : s.status === 'findings' ? 'findings' : s.status === 'error' ? 'error' : 'skipped', s.status === 'ok' ? 'clean' : s.status),
    el('span', {}, s.high ? el('b', { class: 'sev-high' }, s.high + ' high ') : null, s.medium ? el('b', { class: 'sev-medium' }, s.medium + ' medium ') : null, s.low ? el('b', { class: 'sev-low' }, s.low + ' low') : null, (s.high + s.medium + s.low) ? null : '-'),
    reportLink(s.id, 'Report'),
  ]));
}

/** Commits as rows; a row with findings expands to list them. */
function commitsList(c) {
  const wrap = el('div', { class: 'commits' });
  if (!c || !c.rows.length) { wrap.append(el('p', { class: 'empty' }, 'No commits recorded yet.')); return wrap; }
  wrap.append(el('div', { class: 'crow chead' }, el('span', {}, 'Commit'), el('span', {}, 'Subject'), el('span', {}, 'Branch'), el('span', {}, 'Date'), el('span', {}, 'Secret scan'), el('span', {}, 'Review')));
  for (const r of c.rows) {
    const scan = SCAN_LABEL[r.secretScan.state] || ['skipped', r.secretScan.state];
    const cells = [
      el('code', {}, r.short),
      el('span', { class: r.inHistory ? '' : 'fix' }, r.inHistory ? txt(r.subject) : '(no longer in history)'),
      el('span', {}, txt(r.branch || '-')),
      el('span', {}, r.authorDate ? when(r.authorDate) : '-'),
      r.secretScan.state === 'none' ? el('span', { class: 'fix' }, '-') : el('span', { title: txt(r.secretScan.reason) }, pill(scan[0], scan[1])),
      reviewCell(r.review),
    ];
    if (!r.findings.length) { wrap.append(el('div', { class: 'crow' }, cells)); continue; }
    const d = el('details', { class: 'cdetails' }, el('summary', { class: 'crow' }, cells));
    d.append(table(['Severity', 'Category', 'Location', 'Rule', 'Message'], r.findings.map((f) => [
      sev(f.severity), f.category, el('code', {}, f.file + (f.line ? ':' + f.line : '')), f.rule,
      el('td', { class: 'msg' }, f.message, f.inPushOf ? el('div', { class: 'fix' }, 'in push of ' + txt(f.inPushOf).slice(0, 8) + ' (blame could not place this line)') : null)])));
    wrap.append(d);
  }
  if (c.truncated) wrap.append(el('p', { class: 'note' }, 'showing ' + c.rows.length + ' of ' + c.total + ' commits'));
  return wrap;
}

/** One repo's detail, shown inside its <details>. */
function codewatchDetail(repo) {
  const cw = repo.codewatch, s = el('div', { class: 'detail' });
  if (!cw.hasResults) {
    const fix = repo.setup && repo.setup.fix ? repo.setup.fix : 'prism-cli enable codewatch';
    s.append(el('p', { class: 'empty' }, 'No codewatch results yet. Run ', el('code', {}, fix), ', then commit and push.'));
    return s;
  }
  s.append(el('div', { class: 'stats' },
    el('div', { class: 'stat' }, el('b', {}, cw.byCategory.security), el('span', {}, 'security')),
    el('div', { class: 'stat' }, el('b', {}, cw.byCategory.quality), el('span', {}, 'quality')),
    el('div', { class: 'stat' }, el('b', {}, cw.gitleaksBlocks.length), el('span', {}, 'gitleaks blocks')),
    el('div', { class: 'stat' }, el('b', {}, cw.skipped.length), el('span', {}, 'pushed without a scan'))));

  if (!cw.commits || !cw.commits.rows.length) s.append(inlineEmpty('Commits', 'none recorded yet; commits appear after a pre-commit scan or a pre-push review that runs.'));
  else s.append(el('h3', {}, 'Commits'), commitsList(cw.commits));

  if (!cw.scans.length) s.append(inlineEmpty('Scans', 'no pre-push reviews yet.'));
  else s.append(el('h3', {}, 'Scans (last ' + cw.scans.length + ')'), scansList(cw.scans));

  const skipped = cw.skippedRuns || 0;
  if (!cw.trend.length) {
    // By design: a skipped run (nothing new to review, or no gitleaks) has no findings, so it is not charted.
    s.append(inlineEmpty('Trend', 'nothing to chart. ' + (skipped
      ? 'All ' + skipped + ' run' + (skipped === 1 ? ' was' : 's were') + ' skipped (for example a push with no changes against upstream), and skipped runs have no findings to chart.'
      : 'No run has finished yet.')));
  } else {
    s.append(el('h3', {}, 'Trend (last ' + cw.trend.length + ' runs)'), trendSvg(cw.trend));
    if (skipped) s.append(el('p', { class: 'note' }, skipped + ' skipped run' + (skipped === 1 ? ' is' : 's are') + ' not charted: they have no findings.'));
  }

  if (!cw.gitleaksBlocks.length) s.append(inlineEmpty('Gitleaks blocks', 'no commits blocked.'));
  else s.append(el('h3', {}, 'Gitleaks blocks'), table(['When', 'Branch', 'Result', 'Secrets'], cw.gitleaksBlocks.slice(0, 20).map((r) => [when(r.started_at), txt(r.branch), pill(r.status), r.status === 'findings' ? r.high : txt(r.reason)])));

  if (!cw.skipped.length) s.append(inlineEmpty('Commits pushed without a pre-commit scan', 'none.'));
  else {
    s.append(el('h3', {}, 'Commits pushed without a pre-commit scan'));
    s.append(table(['Commit', 'Branch', 'Recorded'], cw.skipped.slice(0, 20).map((r) => [el('code', {}, short(r.commit)), txt(r.branch), when(r.started_at)])));
    s.append(el('p', { class: 'note' }, 'Usually git commit --no-verify; rebases and cherry-picks also show up here.'));
  }
  return s;
}

/** "29 other repos: not set up", expanding to one line per repo. key keeps it open across refreshes. */
function otherRepos(key, list, what, line) {
  if (!list.length) return null;
  return el('details', { class: 'missing-group', 'data-key': key },
    el('summary', {}, list.length + ' other repo' + (list.length === 1 ? '' : 's') + ': ' + what),
    el('ul', { class: 'sec-findings' }, list.map((r) => el('li', {}, repoName(r), line(r)))));
}

function codewatchPanel(data) {
  const rows = data.overview.codewatch;
  const banner = scanBanner(data.machine.secretScanning);
  if (!rows.length && !banner) {
    const sg = (data.suggestions || []).find((x) => x.id === 'codewatch-global');
    if (sg) return emptyLine('Codewatch', "isn't enabled in any repo yet. Cover every repo at once: ", el('code', {}, sg.command), ', or run ', el('code', {}, 'prism-cli enable codewatch'), ' inside one repo.');
    return emptyLine('Codewatch', "isn't enabled in any repo yet. Run ", el('code', {}, 'prism-cli enable codewatch'), ' inside a repo.');
  }
  const s = el('section', { class: 'card wide' }, el('h2', {}, 'Codewatch'));
  if (banner) s.append(banner);
  if (!rows.length) {
    s.append(el('p', { class: 'empty' }, "Codewatch isn't enabled in any repo yet. Run ", el('code', {}, 'prism-cli enable codewatch'), ' inside a repo.'));
    return s;
  }
  const cur = data.usage && data.usage.currency;
  const count = (key, n, cls) => track(key, n, el('td', { class: 'count' + (n ? ' ' + cls : '') }, n));
  s.append(table(['Repo', 'High', 'Medium', 'Low', 'Last run', 'Reviewer', 'Unscanned', 'Gitleaks', 'Spend (month)'], rows.map((r) => [
    repoName(r), count('cw:h:' + r.path, r.high, 'sev-high'), count('cw:m:' + r.path, r.medium, 'sev-medium'), count('cw:l:' + r.path, r.low, 'sev-low'),
    track('cw:last:' + r.path, r.lastRunAt, el('td', {}, r.lastRunAt ? (r.lastReviewId ? reportLink(r.lastReviewId, when(r.lastRunAt)) : when(r.lastRunAt)) : 'never')),
    txt(r.reviewer || '-'), count('cw:u:' + r.path, r.unscannedCommits, 'sev-medium'),
    r.gitleaksWarning ? pill('warn', 'not scanned') : '-',
    track('cw:spend:' + r.path, r.spendMonth, el('td', { class: 'num', title: 'codeburn projects at or under this repo' }, r.spendMonth === null || r.spendMonth === undefined ? '-' : money(r.spendMonth, cur))),
  ])));
  const byPath = Object.fromEntries(data.repos.map((r) => [r.path, r]));
  s.append(el('h3', {}, 'Per repo'));
  for (const row of rows) {
    const repo = byPath[row.path]; if (!repo) continue;
    const total = row.high + row.medium + row.low;
    const d = el('details', repo.current ? { class: 'repo', open: '', 'data-key': 'cw:' + repo.path } : { class: 'repo', 'data-key': 'cw:' + repo.path },
      el('summary', {}, el('b', {}, labelOf(repo)), ' ', el('span', { class: 'fix' }, repo.codewatch.hasResults ? total + ' finding' + (total === 1 ? '' : 's') + ' in the latest reviews' : 'no results yet'),
        repo.current ? el('span', { class: 'tag' }, 'this repo') : null),
      el('div', { class: 'repo-title' }, repo.path));
    d.append(codewatchDetail(repo));
    s.append(d);
  }
  const shown = new Set(rows.map((r) => r.path));
  const rest = data.overview.setup.filter((r) => !shown.has(r.path));
  const other = otherRepos('cw:other', rest, 'no codewatch', (r) => r.fix ? el('div', { class: 'fix' }, 'Fix: ', el('code', {}, r.fix)) : el('div', { class: 'fix' }, txt(r.detail)));
  if (other) s.append(other);
  return s;
}

/** "updated <time>", and whether a refresh is running or the last one failed. */
function usageUpdated(u) {
  if (!u.updatedAt) return null;
  return el('p', { class: 'note' }, 'updated ' + when(u.updatedAt)
    + (u.refreshError ? ' · refresh failed: ' + txt(u.refreshError) : u.stale ? ' · refreshing in the background' : ''));
}

function usagePanel(u) {
  if (u.status === 'loading') {
    return el('section', { class: 'card' }, el('h2', {}, 'Usage (codeburn)'), el('p', { class: 'empty loading' }, txt(u.message)));
  }
  if (u.status === 'not-installed' || u.status === 'no-data') {
    return emptyLine('Usage (codeburn)', txt(u.message), u.status === 'not-installed' ? '' : el('span', {}, ' Usage appears once a coding tool records sessions; full charts: ', el('code', {}, txt(u.fullView)), '.'));
  }
  const s = el('section', { class: 'card' }, el('h2', {}, 'Usage (codeburn)'));
  if (u.status !== 'ok') {
    s.append(el('p', { class: 'empty' }, pill('missing', u.status), ' ', txt(u.message)));
  } else {
    s.append(el('div', { class: 'stats' },
      el('div', { class: 'stat' }, track('use:today', u.today.cost, el('b', {}, money(u.today.cost, u.currency))), el('span', {}, 'today, ' + u.today.calls + ' calls')),
      el('div', { class: 'stat' }, track('use:month', u.month.cost, el('b', {}, money(u.month.cost, u.currency))), el('span', {}, 'this month, ' + u.month.calls + ' calls, ' + u.month.sessions + ' sessions'))));
    s.append(el('h3', {}, 'Top models this month'));
    s.append(table(['Model', 'Cost', 'Calls'], u.topModels.map((m) => [m.name, num(money(m.cost, u.currency)), num(m.calls)])));
    s.append(el('h3', {}, 'Top projects this month'));
    s.append(table(['Project', 'Cost', 'Sessions'], u.topProjects.map((p) => [el('span', { title: p.path }, p.name), num(money(p.cost, u.currency)), num(p.sessions)])));
  }
  s.append(usageUpdated(u) || '', el('p', { class: 'note' }, 'Full charts: run ', el('code', {}, txt(u.fullView)), ' in a terminal.'));
  return s;
}

/** Info (or warn) callout for the global install. Text only: the page never runs anything. */
function suggestionCallout(sg) {
  if (sg.style === 'warn') {
    return el('div', { class: 'callout warn', role: 'note' },
      el('strong', {}, sg.missing + " repos don't have codewatch."),
      el('div', {}, 'Your global core.hooksPath is set to ', el('code', {}, txt(sg.currentHooksPath)), ', so the plain global install would refuse. Use ',
        el('code', {}, sg.command), ': it saves that value and still runs its hooks after codewatch.'));
  }
  return el('div', { class: 'callout info', role: 'note' },
    el('strong', {}, sg.missing + " repos don't have codewatch. Cover all of them at once: "), el('code', {}, sg.command),
    el('div', { class: 'fix' }, 'Applies to every repo on this machine, including new clones. Repos can opt out with ', el('code', {}, 'git config prism.codewatch false'), '.'));
}

/** A row's help: the text, any steps and commands, then its doc links (https only), each opening in a new tab. */
function helpBlock(h) {
  const links = (h.links || []).filter((l) => /^https:\\/\\//.test(txt(l.url)))
    .map((l) => el('a', { href: txt(l.url), class: 'rlink', target: '_blank', rel: 'noopener noreferrer' }, txt(l.label)));
  const steps = (h.steps || []).length ? el('ol', { class: 'help-steps' }, h.steps.map((x) => el('li', {}, txt(x)))) : null;
  const cmds = (h.commands || []).length ? el('div', { class: 'help-links' }, 'Commands: ', h.commands.flatMap((c, n) => n ? [', ', el('code', {}, txt(c))] : [el('code', {}, txt(c))])) : null;
  return el('div', { class: 'help' }, txt(h.text), steps, cmds, links.length ? el('div', { class: 'help-links' }, links.flatMap((a, n) => n ? [' · ', a] : [a])) : null);
}

function setupPanel(data) {
  const s = el('section', { class: 'card' }, el('h2', {}, 'Setup checklist'));
  const rows = (items) => items.map((i) => [pill(i.status), i.label, el('div', {}, i.detail,
    i.help ? helpBlock(i.help) : i.fix ? el('div', { class: 'fix' }, 'Fix: ' + i.fix) : null)]);
  s.append(el('h3', {}, 'This machine'), table(['', 'Check', 'Detail'], rows(data.machine.setup)));
  const repos = data.overview.setup, c = data.overview.counts;
  s.append(el('h3', {}, 'Per repo: codewatch (' + c.codewatch + ' of ' + c.repos + ' installed)'));
  const label = { ok: 'ok', warn: 'warn', missing: 'missing', 'opted-out': 'opted out' };
  const pillClass = { ok: 'ok', warn: 'warn', missing: 'missing', 'opted-out': 'skipped' };
  const rowOf = (r) => [
    repoName(r),
    el('div', {}, pill(pillClass[r.status] || 'missing', (label[r.status] || r.status) + (r.status === 'ok' && r.global ? ' (global)' : '')), ' ',
      r.status === 'ok' ? 'reviewer ' + txt(r.reviewer || 'none') : txt(r.detail),
      r.fix ? el('div', { class: 'fix' }, 'Fix: ', el('code', {}, r.fix)) : null),
    securityCell(r.security),
  ];
  const sg = (data.suggestions || []).find((x) => x.id === 'codewatch-global');
  if (sg) s.append(suggestionCallout(sg));
  // Shown: the current repo, repos with activity (listed first), and repos with something set up.
  const shown = repos.filter((r) => !r.collapsed);
  const hidden = repos.filter((r) => r.collapsed);
  if (shown.length) s.append(table(['Repo', 'Codewatch', 'Security Agent'], shown.map(rowOf)));
  else if (!hidden.length) s.append(el('p', { class: 'empty' }, 'No git repositories found under ' + txt(data.scope.root_display) + '.'));
  const optedOut = hidden.filter((r) => r.status === 'opted-out').length;
  const group = el('details', { class: 'missing-group', 'data-key': 'setup:other' },
    el('summary', {}, hidden.length + ' other repo' + (hidden.length === 1 ? '' : 's') + ': not set up' + (optedOut ? ' (' + optedOut + ' opted out of codewatch)' : '')),
    table(['Repo', 'Codewatch', 'Security Agent'], hidden.map(rowOf)));
  if (hidden.length) s.append(group);
  return s;
}

const SEC_LABEL = { ok: 'ok', 'in-use': 'in use', missing: 'missing' };

/** Security Agent per repo: the enable security marker, else saved results (local evidence; the page makes no AWS calls). */
function securityCell(sec) {
  if (!sec) return el('span', { class: 'fix' }, '-');
  return el('div', {}, pill(sec.status === 'missing' ? 'missing' : 'ok', SEC_LABEL[sec.status] || sec.status), ' ', sec.status === 'missing' ? '' : txt(sec.detail).replace(/^in use /, ''),
    sec.fix ? el('div', { class: 'fix' }, 'Fix: ', el('code', {}, sec.fix)) : null);
}

/** Cached Security Agent code review results; the page only reads them. */
const RISKS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL', 'UNKNOWN'];
const RISK_CLASS = { CRITICAL: 'sev-high', HIGH: 'sev-high', MEDIUM: 'sev-medium', LOW: 'sev-low' };
/** A risk-level pill; colour follows the codewatch severity colours. */
const riskPill = (level, label) => el('span', { class: 'pill ' + (RISK_CLASS[level] || 'fix') }, label);

/** One column wide (fits beside Usage and Setup): a compact block per repo, findings as wrapping rows. */
function securityPanel(sec) {
  const s = el('section', { class: 'card' }, el('h2', {}, 'Security findings'));
  const rows = (sec && sec.repos) || [];
  const tms = (sec && sec.threat_models) || [];
  const pts = (sec && sec.pentests) || [];
  if (!rows.length && !tms.length && !pts.length) {
    return emptyLine('Security findings', 'No Security Agent code reviews, threat models or penetration tests yet. Run ', el('code', {}, (sec && sec.hint) || 'prism-cli security code-review'), ', ', el('code', {}, 'prism-cli security threat-model'), ' or ', el('code', {}, 'prism-cli security pentest'), ' in a repo set up with ', el('code', {}, 'prism-cli enable security'), '.');
  }
  if (!rows.length) s.append(inlineEmpty('Code reviews', 'none yet. Run ', el('code', {}, (sec && sec.hint) || 'prism-cli security code-review'), '.'));
  for (const r of rows) {
    const counts = r.counts || {};
    const b = el('div', { class: 'sec-repo' });
    b.append(el('div', { class: 'sec-head' }, el('b', {}, labelOf(r)), r.current ? el('span', { class: 'tag' }, 'this repo') : null));
    b.append(el('div', { class: 'fix' },
      (r.pending ? 'started ' + when(r.started_at) : when(r.finished_at)) + ' · ' + (r.scope === 'diff' ? 'branch diff' : r.scope === 'full' ? 'whole repo' : 'fetched') + ' · job ' + txt(r.job_id).slice(0, 12)));
    const pills = el('div', { class: 'sec-pills' });
    if (r.pending) {
      // Results are local: the page only knows the job was started, not whether it has finished since.
      pills.append(pill('warn', 'review running'));
      if (r.stale) pills.append(pill('skipped', 'stale?'));
      b.append(pills, el('p', { class: 'note' }, r.stale ? 'Started over 2 h ago and not fetched yet; it has most likely finished. ' : '', 'Fetch the results with ', el('code', {}, (sec && sec.pending_hint) || 'prism-cli security findings'), '.'));
      s.append(b);
      continue;
    }
    if (r.status === 'error') pills.append(pill('error', txt(r.job_status).toLowerCase()));
    else {
      const shown = RISKS.filter((k) => (counts[k] || 0) > 0);
      if (!shown.length) pills.append(pill('ok', 'no findings'));
      for (const k of shown) pills.append(riskPill(k, counts[k] + ' ' + k.toLowerCase()));
    }
    b.append(pills);
    if (r.reason) b.append(el('p', { class: 'note' }, txt(r.reason)));
    if (r.status === 'error' && !r.findings.length) b.append(el('p', { class: 'empty' }, 'The job did not complete.'));
    if (r.findings.length) {
      const list = el('ul', { class: 'sec-findings' });
      for (const f of r.findings) {
        list.append(el('li', {},
          riskPill(f.risk_level, txt(f.risk_level).toLowerCase()), ' ',
          el('span', { class: 'sec-title' }, txt(f.title)),
          el('div', { class: 'fix' }, el('code', {}, f.file ? f.file + (f.line ? ':' + f.line : '') : 'no location'), f.cwe ? ' · ' + txt(f.cwe) : '')));
      }
      b.append(list);
    }
    if (r.truncated) b.append(el('p', { class: 'note' }, 'showing the first ' + r.findings.length + '; run prism-cli security findings for all'));
    s.append(b);
  }
  securityPentestRows(s, sec);
  if (tms.length) {
    s.append(el('h3', {}, 'Threat models'));
    for (const t of tms) s.append(threatModelBlock(t, (sec && sec.threats_hint) || 'prism-cli security threats'));
  } else s.append(inlineEmpty('Threat models', 'none yet. Run ', el('code', {}, 'prism-cli security threat-model'), '.'));
  return s;
}

const THREAT_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
/** "INFORMATION_DISCLOSURE" -> "information disclosure". */
const strideText = (list) => (list || []).map((x) => txt(x).toLowerCase().replace(/_/g, ' ')).join(', ');

/** One cached threat model per repo, in the code review blocks' compact style. */
function threatModelBlock(t, hint) {
  const b = el('div', { class: 'sec-repo' });
  b.append(el('div', { class: 'sec-head' }, el('b', {}, labelOf(t)), t.current ? el('span', { class: 'tag' }, 'this repo') : null));
  const docs = (t.scope_docs || []).length;
  b.append(el('div', { class: 'fix' },
    (t.pending ? 'started ' + when(t.started_at) : when(t.finished_at)) + ' · commit ' + txt(t.commit).slice(0, 12)
    + ' · ' + (docs ? docs + ' scope doc' + (docs === 1 ? '' : 's') : 'source only') + ' · job ' + txt(t.job_id).slice(0, 12)));
  const pills = el('div', { class: 'sec-pills' });
  if (t.pending) {
    // Results are local: the page only knows the job was started, not whether it has finished since.
    pills.append(pill('warn', 'threat model running'));
    if (t.stale) pills.append(pill('skipped', 'stale?'));
    b.append(pills, el('p', { class: 'note' }, t.stale ? 'Started over 2 h ago and not fetched yet; it has most likely finished. ' : '', 'Fetch the threats with ', el('code', {}, hint), '.'));
    return b;
  }
  if (t.status === 'error') pills.append(pill('error', txt(t.job_status).toLowerCase()));
  else {
    const counts = t.counts || {};
    const shown = THREAT_LEVELS.filter((k) => (counts[k] || 0) > 0);
    if (!shown.length) pills.append(pill('ok', 'no threats'));
    for (const k of shown) pills.append(riskPill(k, counts[k] + ' ' + k.toLowerCase()));
  }
  b.append(pills);
  if (t.reason) b.append(el('p', { class: 'note' }, txt(t.reason)));
  if (t.overview) b.append(el('p', { class: 'note' }, txt(t.overview)));
  if ((t.threats || []).length) {
    const list = el('ul', { class: 'sec-findings' });
    for (const x of t.threats) {
      list.append(el('li', {},
        riskPill(x.severity, txt(x.severity).toLowerCase()), ' ',
        el('span', { class: 'sec-title' }, txt(x.title)),
        (x.stride || []).length ? el('div', { class: 'fix' }, strideText(x.stride)) : null));
    }
    b.append(list);
  }
  if (t.more) b.append(el('p', { class: 'note' }, t.more + ' more; run ' + hint + ' for all'));
  return b;
}

/** Penetration-test rows, in the same Security card below the code-review rows. */
function securityPentestRows(s, sec) {
  const rows = (sec && sec.pentests) || [];
  if (!rows.length) { s.append(inlineEmpty('Penetration tests', 'none yet. Run ', el('code', {}, 'prism-cli security pentest'), '.')); return; }
  s.append(el('h3', {}, 'Penetration tests'));
  for (const r of rows) {
    const counts = r.counts || {};
    const b = el('div', { class: 'sec-repo' });
    b.append(el('div', { class: 'sec-head' }, el('b', {}, labelOf(r)), r.current ? el('span', { class: 'tag' }, 'this repo') : null));
    b.append(el('div', { class: 'fix' },
      (r.pending ? 'started ' + when(r.started_at) : when(r.finished_at)) + ' · ' + txt(r.target_host) + ' · job ' + txt(r.job_id).slice(0, 12)));
    const pills = el('div', { class: 'sec-pills' });
    if (r.pending) {
      pills.append(pill('warn', 'pentest running'));
      if (r.stale) pills.append(pill('skipped', 'stale?'));
      b.append(pills, el('p', { class: 'note' }, r.stale ? 'Started over 6 h ago and not refreshed. ' : '', 'Refresh with ', el('code', {}, (sec && sec.pentest_hint) || 'prism-cli security pentest --status'), '.'));
      s.append(b);
      continue;
    }
    if (r.status === 'error') pills.append(pill('error', txt(r.job_status).toLowerCase()));
    else {
      const shown = RISKS.filter((k) => (counts[k] || 0) > 0);
      if (!shown.length) pills.append(pill('ok', 'no findings'));
      for (const k of shown) pills.append(riskPill(k, counts[k] + ' ' + k.toLowerCase()));
    }
    if (r.teardown_failed) pills.append(pill('error', 'teardown failed'));
    b.append(pills);
    if (r.reason) b.append(el('p', { class: 'note' }, txt(r.reason)));
    if (r.teardown_failed) b.append(el('p', { class: 'note' }, 'The environment is still up (' + txt(r.teardown_failed.reason) + '). Retry with ', el('code', {}, 'prism-cli security pentest --cleanup'), '.'));
    if (r.findings.length) {
      const list = el('ul', { class: 'sec-findings' });
      for (const f of r.findings) {
        list.append(el('li', {},
          riskPill(f.risk_level, txt(f.risk_level).toLowerCase()), ' ',
          el('span', { class: 'sec-title' }, txt(f.title)),
          f.confidence ? el('div', { class: 'fix' }, txt(f.confidence).toLowerCase() + ' confidence') : null));
      }
      b.append(list);
    }
    if (r.truncated) b.append(el('p', { class: 'note' }, 'showing the first ' + r.findings.length + '; run prism-cli security findings --pentest for all'));
    s.append(b);
  }
}

const AUDIT_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** The latest aws check per account, in the Security panel's compact style. Local results only. */
function awsPanel(aws) {
  const rows = (aws && aws.accounts) || [];
  if (!rows.length) return emptyLine('AWS account', 'no checks yet. Run ', el('code', {}, (aws && aws.hint) || 'prism-cli aws check'), ' (read-only).');
  const s = el('section', { class: 'card' }, el('h2', {}, 'AWS account'));
  for (const a of rows) {
    const b = el('div', { class: 'sec-repo' });
    b.append(el('div', { class: 'sec-head' }, el('b', {}, txt(a.account)), a.alias ? el('span', { class: 'tag' }, txt(a.alias)) : null));
    b.append(el('div', { class: 'fix' }, txt(a.region) + ' · ' + when(a.checked_at) + (a.profile ? ' · profile ' + txt(a.profile) + (a.profile_source ? ' (' + txt(a.profile_source) + ')' : '') : '')));
    const c = a.counts || {}, pills = el('div', { class: 'sec-pills' });
    pills.append(pill('ok', (c.pass || 0) + ' pass'));
    if (c.fail) pills.append(pill('error', c.fail + ' fail'));
    if (c.indeterminate) pills.append(pill('warn', c.indeterminate + ' not checked'));
    for (const k of AUDIT_SEVERITIES) if ((a.fail_by_severity || {})[k]) pills.append(riskPill(k, a.fail_by_severity[k] + ' ' + k.toLowerCase()));
    b.append(pills);
    if ((a.top_failures || []).length) {
      const list = el('ul', { class: 'sec-findings' });
      for (const f of a.top_failures) list.append(el('li', {}, riskPill(f.severity, txt(f.severity).toLowerCase()), ' ', el('span', { class: 'sec-title' }, txt(f.title)), el('div', { class: 'fix' }, txt(f.section))));
      b.append(list);
    }
    if (a.more) b.append(el('p', { class: 'note' }, a.more + ' more'));
    if (c.indeterminate) b.append(el('p', { class: 'note' }, 'Checks that could not run are not passes.'));
    s.append(b);
  }
  s.append(el('p', { class: 'note' }, 'Ranked fixes: run ', el('code', {}, (aws && aws.recommend_hint) || 'prism-cli aws recommend'), '.'));
  return s;
}

/** Auto-refresh period while the tab is visible; paused while hidden. */
const AUTO_REFRESH_MS = 60000;
let lastLoad = 0, loading = false;

/**
 * Two stages: /api/data (local checks, with cached usage or "loading") paints
 * at once; then /api/usage, and when its usage differs from what was painted,
 * /api/data again (cheap: the server rebuilds it from the cache). fresh: the
 * Refresh button, which runs new codeburn exports; auto-refresh uses the cache.
 */
async function load(fresh) {
  if (loading) return;
  loading = true;
  try {
    const data = await render();
    if (!data) return;
    let u;
    try { u = await getJson('/api/usage' + (fresh ? '?fresh=1' : '')); } catch (e) { return; }
    const was = data.usage || {};
    if (u && u.usage && (u.usage.updatedAt !== was.updatedAt || u.usage.status !== was.status)) await render();
  } finally { loading = false; lastLoad = Date.now(); }
}

async function getJson(path) {
  if (SNAPSHOT) {
    if (path === '/api/data') return SNAPSHOT.data;
    if (path.startsWith('/api/usage')) return { usage: SNAPSHOT.data.usage, cacheHit: true };
    throw new Error('not in this snapshot');
  }
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function render() {
  const main = document.getElementById('main'), meta = document.getElementById('meta');
  const before = meta.textContent;
  meta.textContent = 'loading...';
  let data;
  try {
    data = await getJson('/api/data');
  } catch (e) {
    // Keep the last good view; say the refresh failed.
    meta.textContent = 'failed to load: ' + e.message + (before && before !== 'loading...' ? ' · showing ' + before : '');
    return null;
  }
  // Open/closed state of keyed <details> survives the redraw.
  const openState = new Map([...main.querySelectorAll('details[data-key]')].map((d) => [d.getAttribute('data-key'), d.open]));
  LABELS = new Map((data.repos || []).map((r) => [r.path, r.label || r.name]));
  EMPTY = []; CUR = {};
  main.replaceChildren();
  if (data.scope.error) main.append(el('section', { class: 'card wide' }, pill('error'), ' ', data.scope.error));
  const panels = [summaryPanel(data.summary), codewatchPanel(data), usagePanel(data.usage), setupPanel(data), securityPanel(data.security), awsPanel(data.aws)];
  main.append(...panels.filter(Boolean));
  if (EMPTY.length) main.append(el('section', { class: 'card wide' }, el('h2', {}, 'Nothing recorded yet'), ...EMPTY));
  for (const d of main.querySelectorAll('details[data-key]')) {
    const k = d.getAttribute('data-key');
    if (openState.has(k)) d.open = openState.get(k);
  }
  const changed = new Set(changedKeys(PREV, CUR));
  for (const n of main.querySelectorAll('[data-track]')) {
    const k = n.getAttribute('data-track');
    if (changed.has(k)) { n.classList.add('changed'); n.setAttribute('title', 'changed since the previous load (was ' + PREV[k] + ')'); }
  }
  PREV = CUR;
  const c = data.overview.counts;
  meta.textContent = c.repos + ' repos under ' + txt(data.scope.root_display) + ' · ' + c.codewatch + ' with codewatch' + (data.scope.truncated ? ' (scan capped)' : '')
    + (SNAPSHOT ? ' · data from ' + when(data.generated_at) + ' · static snapshot, does not refresh'
      : ' · updated ' + when(data.generated_at) + (changed.size ? ' · ' + changed.size + ' value' + (changed.size === 1 ? '' : 's') + ' changed (outlined)' : '') + ' · refreshes every minute while visible');
  await renderSetup(data);
  return data;
}
${SETUP_SCRIPT}
${THEME_SCRIPT}
if (SNAPSHOT) {
  const at = document.getElementById('snapshot-at');
  if (at) at.textContent = when(SNAPSHOT.generatedAt);
  load(false);
} else {
  document.getElementById('refresh').addEventListener('click', () => load(true));
  setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - lastLoad >= AUTO_REFRESH_MS - 1000) load(false); }, AUTO_REFRESH_MS / 4);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastLoad >= AUTO_REFRESH_MS) load(false); });
  load(false);
}
`;

export function renderPage(nonce: string, csrf = ''): string {
  // The nonce and the CSRF token are base64/base64url generated server-side; nothing user-derived is interpolated here.
  if (!/^[A-Za-z0-9_-]*$/.test(csrf)) throw new Error('bad CSRF token');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="prism-csrf" content="${csrf}">
<script nonce="${nonce}">${THEME_BOOT}</script>
<title>PRISM dashboard</title><style nonce="${nonce}">${STYLE}</style></head>
<body><header><h1>PRISM dashboard</h1>
<nav class="tabs" aria-label="Views"><a href="#" data-view="dashboard">Dashboard</a><a href="#setup" data-view="setup">Setup</a></nav>
<button id="refresh" type="button">Refresh</button>
<div class="theme" role="group" aria-label="Theme"><button type="button" data-theme-set="light">Light</button><button type="button" data-theme-set="dark">Dark</button><button type="button" data-theme-set="system">System</button></div>
<span class="meta" id="meta"></span></header>
<main id="main"></main>
<main id="setup" hidden></main>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

/** What a static snapshot embeds: the /api/data payload and the /api/setup answer, as the live page would fetch them. */
export interface SnapshotData {
  data: unknown;
  setup: unknown;
  /** ISO time the snapshot was written. */
  generatedAt: string;
  version: string;
}

const sha256 = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** JSON for a <script type="application/json"> block: `<` escaped, so the text can never close the element. */
export function embedJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The exact element markers renderSnapshotPage writes, so a test can read the file back without parsing HTML. */
export const SNAPSHOT_MARKERS = {
  script: '<script>',
  data: '<script type="application/json" id="prism-snapshot">',
  scriptEnd: '</script>',
  style: '<style>',
  styleEnd: '</style>',
} as const;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The same page as renderPage, as one static file: the data is embedded, the
 * scripts and the style are allowed by hash in a CSP meta tag with
 * default-src 'none' (no fetch, no remote resource), and the Setup page's Run
 * buttons become Copy buttons. No token, no server.
 */
export function renderSnapshotPage(s: SnapshotData): string {
  const M = SNAPSHOT_MARKERS;
  const at = escapeHtml(s.generatedAt);
  const csp = `default-src 'none'; script-src ${sha256(THEME_BOOT)} ${sha256(SCRIPT)}; style-src ${sha256(STYLE)}; img-src data:; base-uri 'none'; form-action 'none'`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
${M.script}${THEME_BOOT}${M.scriptEnd}
<title>PRISM dashboard snapshot ${at}</title>${M.style}${STYLE}${M.styleEnd}</head>
<body><header><h1>PRISM dashboard</h1>
<nav class="tabs" aria-label="Views"><a href="#" data-view="dashboard">Dashboard</a><a href="#setup" data-view="setup">Setup</a></nav>
<div class="theme" role="group" aria-label="Theme"><button type="button" data-theme-set="light">Light</button><button type="button" data-theme-set="dark">Dark</button><button type="button" data-theme-set="system">System</button></div>
<span class="meta" id="meta"></span></header>
<div class="banner snapshot" role="note"><strong>Snapshot generated <time id="snapshot-at" datetime="${at}">${at}</time></strong>
<div class="fix">A static copy written by prism-cli ${escapeHtml(s.version)} dashboard --snapshot. It does not refresh and nothing on it runs: commands are copy only. For the live page run <code>prism-cli dashboard</code>.</div></div>
<main id="main"></main>
<main id="setup" hidden></main>
${M.data}${embedJson(s)}${M.scriptEnd}
${M.script}${SCRIPT}${M.scriptEnd}</body></html>`;
}
