/**
 * The dashboard's single-page app: one self-contained HTML document with
 * inline CSS and JS (nonce-gated by the CSP), no CDN and no network fetch
 * other than its own GET routes (/api/data, then /api/usage), so it works offline.
 * Views are hash routes: # (dashboard), #security[/<repo-id>], #accountguard, #settings[/<tab>] (#setup is an alias), #repo/<id>.
 *
 * Every value from the payload is placed with textContent or a DOM attribute;
 * innerHTML is never used for data.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SETUP_SCRIPT, SETUP_STYLE, THEME_BOOT, THEME_SCRIPT } from './setup-page.js';
import { SETTINGS_SCRIPT, SETTINGS_STYLE } from './settings-page.js';
import { SECURITY_SCRIPT, SECURITY_STYLE } from './security-page.js';
import { SECURITY_RUNS_SCRIPT, SECURITY_RUNS_STYLE } from './security-runs-page.js';
import { ACCOUNTGUARD_SCRIPT, ACCOUNTGUARD_STYLE } from './accountguard-page.js';
import { MARKDOWN_SCRIPT } from './markdown-lite.js';
import { REPO_SCRIPT, REPO_STYLE } from './repo-page.js';
import { getAssetPath } from '../utils/root.js';

/** Colour tokens. Dark is the default; Light, and System on a light OS, switch to the light set. Light text colours keep at least 4.5:1 on --card, --bg, --raised and --accent-soft. */
const LIGHT_VARS = '--bg:#f7f7f8; --card:#fff; --text:#1d1d1f; --muted:#6b6b73; --line:#e3e3e8; --ok:#1a7f37; --warn:#8a5c00; --bad:#cf222e; --high:#cf222e; --medium:#7d6600; --low:#3d6fa8; --accent:#a35200; --accent-soft:#fdebd3; --raised:#f2f3f5; --heat0:#ebedf0; --heat1:#fbd9a8; --heat2:#f5b062; --heat3:#e88810; --heat4:#b85c00;';
const DARK_VARS = '--bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --line:#30363d; --ok:#3fb950; --warn:#d29922; --bad:#f85149; --high:#f85149; --medium:#e3c341; --low:#a5d6ff; --accent:#f59a2a; --accent-soft:#3a2410; --raised:#21262d; --heat0:#21262d; --heat1:#4a2c0e; --heat2:#8a4f12; --heat3:#d07a14; --heat4:#ffa53d;';

const STYLE = `
:root { color-scheme: dark; ${DARK_VARS} }
:root[data-theme="light"] { color-scheme: light; ${LIGHT_VARS} }
@media (prefers-color-scheme: light) { :root[data-theme="system"] { color-scheme: light; ${LIGHT_VARS} } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); font-variant-numeric:tabular-nums; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
.wrap { max-width:1120px; margin:0 auto; padding:28px 24px 64px; }
header { display:flex; flex-wrap:wrap; align-items:center; gap:12px 16px; margin-bottom:24px; }
header h1 { font-size:20px; margin:0; font-weight:650; letter-spacing:-.01em; display:flex; align-items:center; gap:10px; }
.logo { width:36px; height:36px; border-radius:9px; box-shadow:0 0 0 1px var(--line); }
.spacer { flex:1; }
.tools { display:flex; flex-wrap:wrap; gap:8px; align-items:center; color:var(--muted); font-size:12px; }
.verpill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:999px; border:1px solid var(--line); color:var(--muted); font-weight:600; white-space:nowrap; }
.verpill.up { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.verpill.up::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--accent); }
button { font:inherit; padding:5px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--text); cursor:pointer; }
@media (max-width: 640px) { .wrap { padding:16px 12px 40px; } header .tools { flex-basis:100%; } }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; min-width:0; }
section.card { padding:18px 20px; margin-bottom:18px; }
h2 { font-size:15px; margin:0 0 12px; font-weight:650; display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 10px; }
h2 .sub { color:var(--muted); font-weight:450; font-size:12px; }
h3 { font-size:12px; margin:16px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; font-weight:600; }
.muted { color:var(--muted); }
.empty { color:var(--muted); padding:8px 0; } .spend-empty > p { margin:6px 0 12px; max-width:72ch; } .spend-empty > .srow-ctl { margin:0 0 12px; } code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; background:var(--raised); padding:1px 5px; border-radius:4px; }
.tablewrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:10px; border-bottom:1px solid var(--line); vertical-align:middle; overflow-wrap:break-word; }
tr:last-child td { border-bottom:0; }
td.num, th.num { text-align:right; } td.msg { min-width:280px; } td code { white-space:normal; overflow-wrap:anywhere; } td code.path { display:inline-block; min-width:16ch; }
tr.click { cursor:pointer; } tr.click:hover td, tr.click:focus-within td { background:var(--raised); }
.repo-cell a { color:var(--text); font-weight:600; } .repo-cell small { display:block; color:var(--muted); font-weight:400; font-size:12px; overflow-wrap:anywhere; }
/* Severity pills, the same everywhere: colour and shape (high triangle, medium diamond, low dot, ok dot, blocked square, zero muted). */
.pill { display:inline-flex; align-items:center; gap:5px; padding:1px 8px; border-radius:999px; font-size:12px; font-weight:600; border:1px solid currentColor; white-space:nowrap; }
.pill::before { content:""; width:7px; height:7px; display:inline-block; background:currentColor; border-radius:50%; flex:none; }
.pill.high { color:var(--high); } .pill.high::before { clip-path:polygon(50% 0,100% 100%,0 100%); width:9px; height:8px; border-radius:0; }
.pill.medium { color:var(--medium); } .pill.medium::before { transform:rotate(45deg); width:6px; height:6px; border-radius:0; }
.pill.low { color:var(--low); } .pill.ok { color:var(--ok); }
.pill.zero { color:var(--muted); border-color:var(--line); } .pill.zero::before { opacity:.5; }
.pill.blocked { color:var(--bad); } .pill.blocked::before { width:8px; height:8px; border-radius:1px; }
.s-ok { color:var(--ok); } .s-info { color:var(--accent); } .s-warn, .s-findings, .s-skipped { color:var(--warn); } .s-missing, .s-error, .s-bad { color:var(--bad); }
.pills { display:inline-flex; gap:6px; flex-wrap:wrap; align-items:center; }
.fix { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.tag { margin-left:6px; font-size:11px; padding:0 6px; border-radius:8px; background:var(--raised); border:1px solid var(--line); color:var(--muted); white-space:nowrap; font-weight:500; }
.cards { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:14px; margin-bottom:22px; }
@media (max-width: 860px) { .cards { grid-template-columns:repeat(2, minmax(0,1fr)); } .hide-sm { display:none; } }
@media (max-width: 520px) { .cards { grid-template-columns:1fr; } }
.scard { min-width:0; display:flex; flex-direction:column; gap:4px; }
.scard .k { color:var(--muted); font-size:12px; font-weight:550; text-transform:uppercase; letter-spacing:.04em; }
.scard .v { font-size:24px; font-weight:650; line-height:1.25; overflow-wrap:anywhere; }
.scard .v .pills { font-size:14px; }
.scard .d { color:var(--muted); font-size:12px; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.banner { border:1px solid var(--warn); border-left-width:4px; border-radius:8px; padding:10px 12px; margin:4px 0 12px; background:color-mix(in srgb, var(--warn) 10%, var(--card)); }
.banner strong { color:var(--text); display:block; margin-bottom:4px; } .banner .fix code { white-space:normal; overflow-wrap:anywhere; }
.banner.snapshot { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, var(--card)); margin:0 0 20px; } .banner.snapshot strong { font-size:15px; }
.note { color:var(--muted); font-size:12px; margin-top:10px; } p.meta { margin-top:28px; border-top:1px solid var(--line); padding-top:12px; }
.callout { border:1px solid var(--accent); border-left-width:4px; border-radius:8px; padding:10px 12px; margin:6px 0 10px; background:color-mix(in srgb, var(--accent) 8%, var(--card)); }
.callout.warn { border-color:var(--warn); background:color-mix(in srgb, var(--warn) 10%, var(--card)); } .callout code { white-space:normal; overflow-wrap:anywhere; }
svg.bars rect.high { fill:var(--high); } svg.bars rect.medium { fill:var(--medium); } svg.bars rect.low { fill:var(--low); }
svg.bars rect.clean { fill:var(--ok); } svg.bars rect.skip { fill:var(--muted); opacity:.45; } svg.bars rect.failed { fill:var(--bad); }
svg.bars { display:block; } .chart svg.bars { width:100%; }
.legend { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
.heat-wrap { display:flex; gap:28px; align-items:flex-start; flex-wrap:wrap; }
.heat { display:grid; grid-template-rows:repeat(7, 13px); grid-auto-flow:column; grid-auto-columns:13px; gap:3px; }
.heat i { border-radius:3px; background:var(--heat0); }
.heat i.nd { background:transparent; box-shadow:inset 0 0 0 1px var(--line); }
.heat i.nd.pending { background:repeating-linear-gradient(135deg, transparent 0 3px, var(--line) 3px 4px); }
@keyframes prism-pending { from { opacity:.45; } to { opacity:1; } }
@media (prefers-reduced-motion: no-preference) { .heat i.nd.pending { animation:prism-pending 1.2s ease-in-out infinite alternate; } }
.heat-legend .range { margin-left:10px; }
.heat-note { font-size:11px; color:var(--muted); margin-top:6px; max-width:240px; overflow-wrap:anywhere; }
.heat i.l1 { background:var(--heat1); } .heat i.l2 { background:var(--heat2); } .heat i.l3 { background:var(--heat3); } .heat i.l4 { background:var(--heat4); }
.heat-legend { display:flex; gap:3px; align-items:center; font-size:11px; color:var(--muted); margin-top:8px; flex-wrap:wrap; }
.heat-legend i { width:11px; height:11px; border-radius:3px; display:inline-block; background:var(--heat0); }
.heat-legend i.nd { background:transparent; box-shadow:inset 0 0 0 1px var(--line); margin-left:8px; }
.heat-legend i.l1 { background:var(--heat1); } .heat-legend i.l2 { background:var(--heat2); } .heat-legend i.l3 { background:var(--heat3); } .heat-legend i.l4 { background:var(--heat4); }
.big { font-size:28px; font-weight:650; }
.barlist { display:grid; grid-template-columns:minmax(0,auto) minmax(40px,1fr) auto; gap:6px 12px; font-size:13px; flex:1 1 240px; max-width:360px; align-items:center; align-content:start; }
.barlist .t { grid-column:1/-1; color:var(--muted); font-size:12px; } .barlist .n { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bar { height:8px; border-radius:4px; background:var(--accent); min-width:2px; }
.cb-row { display:flex; gap:12px; flex-wrap:wrap; margin-top:18px; }
.cb-stat { background:var(--raised); border-radius:10px; padding:8px 14px; min-width:110px; } .cb-stat b { font-size:17px; font-weight:650; } .cb-stat .k { color:var(--muted); font-size:12px; }
.cb-stat.wide { flex:1; min-width:260px; }
.chip { display:inline-block; margin:4px 6px 0 0; padding:2px 8px; border-radius:999px; background:var(--card); border:1px solid var(--line); font-size:12px; }
.more { background:var(--raised); border:1px dashed var(--line); border-radius:12px; padding:14px 18px; display:flex; gap:10px 22px; flex-wrap:wrap; align-items:baseline; font-size:13px; margin-bottom:18px; }
.more b { font-weight:650; } .more .item { color:var(--muted); overflow-wrap:anywhere; } .more code { white-space:normal; }
.crumbs { font-size:13px; color:var(--muted); margin-bottom:8px; }
.repo-head { display:flex; align-items:baseline; gap:8px 12px; flex-wrap:wrap; margin-bottom:18px; } .repo-head h2 { font-size:22px; margin:0; } .repo-head .muted { overflow-wrap:anywhere; }
.grid2 { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1fr); gap:18px; }
@media (max-width: 860px) { .grid2 { grid-template-columns:minmax(0,1fr); } }
.sec-repo { border-top:1px solid var(--line); padding:10px 0; } .sec-repo:first-of-type { border-top:none; padding-top:0; } .sec-head { display:flex; gap:6px; align-items:baseline; flex-wrap:wrap; overflow-wrap:anywhere; }
.sec-pills { display:flex; gap:6px; flex-wrap:wrap; margin:6px 0; } ul.sec-findings { list-style:none; margin:4px 0 0; padding:0; } ul.sec-findings li { padding:8px 0; border-top:1px solid var(--line); font-size:13px; overflow-wrap:anywhere; } ul.sec-findings li:first-child { border-top:none; } .sec-title { font-weight:600; } ul.sec-findings code { white-space:normal; overflow-wrap:anywhere; }
.crow { display:grid; grid-template-columns: 6.5em minmax(10em,2.2fr) minmax(5em,0.8fr) 10.5em 7.5em minmax(11em,1.6fr); gap:8px; padding:8px 6px; border-bottom:1px solid var(--line); align-items:start; font-size:13px; overflow-wrap:anywhere; }
.chead { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; } summary.crow { cursor:pointer; list-style:none; } summary.crow::-webkit-details-marker { display:none; } details.cdetails[open] > summary.crow { background:var(--raised); } details.cdetails > .tablewrap { padding:4px 0 8px 18px; }
.grid2 .crow { grid-template-columns: 6em minmax(8em,2fr) minmax(4em,0.8fr) 9em 7em minmax(9em,1.4fr); }
@media (max-width: 760px) { .crow, .grid2 .crow { grid-template-columns: minmax(0,1fr) minmax(0,1fr); } .chead { display:none; } }
a.rlink { color:var(--accent); }
details.missing-group > summary { cursor:pointer; padding:8px 0; color:var(--muted); font-weight:600; }
.help { font-size:12px; margin-top:4px; overflow-wrap:anywhere; } .help-links { margin-top:2px; } .help-steps { margin:4px 0; padding-left:18px; } .help code { white-space:normal; overflow-wrap:anywhere; }
.changed { outline:2px solid var(--accent); outline-offset:1px; border-radius:4px; }
.loading { color:var(--muted); }
@keyframes prism-flash { from { background-color:color-mix(in srgb, var(--accent) 35%, transparent); } to { background-color:transparent; } }
@media (prefers-reduced-motion: no-preference) { .changed { animation:prism-flash 2.5s ease-out 1; } }
${SETUP_STYLE}
${SETTINGS_STYLE}
${SECURITY_STYLE}
${SECURITY_RUNS_STYLE}
${REPO_STYLE}
${ACCOUNTGUARD_STYLE}
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
/** A setup status pill (ok, warn, missing, ...). */
const pill = (status, label) => el('span', { class: 'pill s-' + txt(status).replace(/[^a-z-]/g, '') }, label || status);
/** A severity pill: high, medium, low, ok, blocked or zero (muted), each with its own shape. */
const SEV_CLASS = { high: 'high', critical: 'high', medium: 'medium', low: 'low', ok: 'ok', blocked: 'blocked', zero: 'zero' };
const sevPill = (level, label) => el('span', { class: 'pill ' + (SEV_CLASS[txt(level).toLowerCase()] || 'zero') }, label);
/** "1 high", "2 medium", ...; a clean result is one ok pill. */
function countPills(h, m, l) {
  if (!h && !m && !l) return [sevPill('ok', 'clean')];
  return [h ? sevPill('high', h + ' high') : null, m ? sevPill('medium', m + ' medium') : null, l ? sevPill('low', l + ' low') : null].filter(Boolean);
}
const when = (iso) => { const d = new Date(iso); return isNaN(d) ? txt(iso) : d.toLocaleString(); };
const short = (sha) => (sha ? txt(sha).slice(0, 8) : '');
function money(n, cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(n || 0); } catch { return '$' + (n || 0).toFixed(2); } }
/** 1234 -> 1.2k, 2500000 -> 2.5M. */
const compact = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
/** head: labels, or { label, cls } for a header cell with a class (num, hide-sm). rows: cell lists, or ready <tr> nodes. */
function table(head, rows) {
  const th = (h) => typeof h === 'object' && h ? el('th', { class: h.cls }, h.label) : el('th', {}, h);
  return el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map(th))),
    el('tbody', {}, rows.map((r) => (r instanceof Node && r.nodeName === 'TR') ? r : el('tr', {}, r.map((c) => (c instanceof Node && c.nodeName === 'TD') ? c : el('td', {}, c)))))));
}
const num = (v) => el('td', { class: 'num' }, txt(v));

/** The last /api/data payload; the repo view and the hash router draw from it. */
let LAST = null;
/** Repo labels (a parent path when two repos share a name), set on each load from data.repos. */
let LABELS = new Map();
const labelOf = (r) => LABELS.get(r.path) || txt(r.name);
/** A path with the home directory shown as ~ (worked out from the scan root and its display form). */
function tildePath(p) {
  const s = (LAST && LAST.scope) || {}, root = txt(s.root), disp = txt(s.root_display);
  if (!disp.startsWith('~')) return txt(p);
  const home = root.slice(0, root.length - (disp.length - 1));
  return home && (p === home || txt(p).startsWith(home + '/')) ? '~' + txt(p).slice(home.length) : txt(p);
}

/** Sections with no data: one item each in the "Get more from PRISM" strip, with the command that fills it. */
let MORE = [];
function moreItem(title, ...parts) { MORE.push(el('span', { class: 'item' }, el('b', {}, title), ': ', ...parts)); return null; }
/** A one-line empty state inside a card that has other content. */
const inlineEmpty = (title, ...parts) => el('p', { class: 'fix' }, el('b', {}, title), ': ', ...parts);

/** Values compared between loads: key -> text. A changed value is outlined. */
let PREV = null, CUR = {};
function track(key, value, node) { CUR[key] = txt(value); node.setAttribute('data-track', key); return node; }
/** A value that was empty before (usage still loading) is filled in, not changed. */
function changedKeys(prev, cur) { return prev ? Object.keys(cur).filter((k) => k in prev && prev[k] !== '' && prev[k] !== cur[k]) : []; }

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

/** Long detail text is clamped to three lines by CSS; the full text stays in the title. */
const DETAIL_TITLE_MIN = 80;
const detail = (...parts) => {
  const d = el('div', { class: 'd' }, ...parts);
  const full = d.textContent;
  if (full.length > DETAIL_TITLE_MIN) d.setAttribute('title', full);
  return d;
};
/** One summary card: label, large value, one detail line. */
const scard = (label, value, det) => el('div', { class: 'card scard' }, el('div', { class: 'k' }, label), value, det);

/** The four cards: latest review, spend today, spend this month, settings warnings. Same object as summary in --json. */
function summaryCards(sum) {
  const box = el('div', { class: 'cards', id: 'summary' });
  const rv = sum && sum.review;
  if (rv) {
    const ran = rv.status !== 'skipped' && rv.status !== 'error';
    const counts = ran ? rv.high + ' high · ' + rv.medium + ' medium · ' + rv.low + ' low' : txt(REVIEW_STATUS[rv.status] || rv.status);
    const value = el('div', { class: 'v' }, el('span', { class: 'pills' }, ...(ran ? countPills(rv.high, rv.medium, rv.low) : [sevPill(rv.status === 'error' ? 'blocked' : 'zero', counts)])));
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
  box.append(scard('Settings warnings',
    track('sum:warnings', w.count, el('div', { class: 'v' + (w.count ? ' s-warn' : '') }, String(w.count))),
    detail(w.first ? txt(w.first) + ' ' : 'Nothing needs attention. ', el('a', { href: '#settings' }, 'Open Settings →'))));
  return box;
}

const SCAN_LABEL = { ok: ['ok', 'ok'], 'not-scanned': ['warn', 'not scanned'], 'no-verify': ['warn', 'no-verify'], flagged: ['missing', 'secrets found'], none: ['skipped', '-'] };

/** Link to a scan report. Ids come from the server's own listing; encodeURIComponent keeps them literal. A snapshot has no report pages. */
function reportLink(id, label) {
  // A host with no /report pages (VS Code, Kiro Crew) opens the report itself, from GET /api/report.
  if (!SNAPSHOT && typeof TRANSPORT.openReport === 'function') {
    const b = el('a', { href: '#', class: 'rlink', role: 'button', 'data-own-click': '' }, label);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); TRANSPORT.openReport(id); });
    return b;
  }
  if (SNAPSHOT || !TRANSPORT.reports) return el('span', { title: 'Report pages open from the browser dashboard (prism-cli dashboard) or prism-cli codewatch report' }, label);
  const a = el('a', { href: '/report/' + encodeURIComponent(id), class: 'rlink' }, label);
  // Inside a clickable row: open the report, not the row's repo view.
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function reviewCell(rv) {
  if (rv.state === 'not-reviewed') return el('span', { class: 'fix' }, 'not reviewed');
  const link = rv.reportId ? [' ', reportLink(rv.reportId, 'report')] : [];
  if (rv.state === 'failed') return el('span', { title: txt(rv.reason) }, sevPill('blocked', 'review failed'), link);
  const who = el('span', { class: 'fix' }, ' ' + txt(rv.tool || '') + (rv.model ? ' / ' + rv.model : '') + (rv.reviewCount > 1 ? ' · reviewed ' + rv.reviewCount + 'x' : ''));
  return el('span', { class: 'pills' }, ...countPills(rv.high, rv.medium, rv.low), who, link);
}

/** Commits as rows; a row with findings expands to list them. */
function commitsList(c) {
  const wrap = el('div', { class: 'commits' });
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
    const d = el('details', { class: 'cdetails', 'data-key': 'commit:' + r.sha }, el('summary', { class: 'crow' }, cells));
    d.append(table(['Severity', 'Category', 'Location', 'Rule', 'Message'], r.findings.map((f) => [
      sevPill(f.severity, f.severity), f.category, el('code', {}, f.file + (f.line ? ':' + f.line : '')), f.rule,
      el('td', { class: 'msg' }, f.message, f.inPushOf ? el('div', { class: 'fix' }, 'in push of ' + txt(f.inPushOf).slice(0, 8) + ' (blame could not place this line)') : null)])));
    wrap.append(d);
  }
  if (c.truncated) wrap.append(el('p', { class: 'note' }, 'showing ' + c.rows.length + ' of ' + c.total + ' commits'));
  return wrap;
}

/** Opens the repo's own view (#repo/<id>); the browser's Back returns here. */
const openRepo = (id) => { navigate('#repo/' + id); };

function codewatchRow(r, cur) {
  const repo = el('a', { href: '#repo/' + r.id }, labelOf(r));
  const tr = el('tr', { class: 'click' });
  const spark = severityBars(r.trend || [], 140, 30, 12, 'findings per pre-push review, oldest first');
  tr.append(
    el('td', { class: 'repo-cell' }, repo, r.current ? el('span', { class: 'tag' }, 'this repo') : null, el('small', { title: r.path }, tildePath(r.path))),
    track('cw:f:' + r.path, r.high + '/' + r.medium + '/' + r.low, el('td', {}, el('span', { class: 'pills' }, ...(r.lastRunAt ? countPills(r.high, r.medium, r.low) : [sevPill('zero', 'no reviews')])))),
    el('td', {}, (r.trend || []).length ? spark : el('span', { class: 'fix' }, '-')),
    track('cw:last:' + r.path, r.lastRunAt, el('td', { class: 'hide-sm' }, r.lastRunAt ? (r.lastReviewId ? reportLink(r.lastReviewId, ago(r.lastRunAt)) : ago(r.lastRunAt)) : 'never')),
    el('td', { class: 'hide-sm' }, txt(r.reviewer || '-')),
    track('cw:u:' + r.path, r.unscannedCommits, el('td', { class: 'num hide-sm' }, String(r.unscannedCommits))),
    el('td', { class: 'hide-sm' }, r.gitleaksWarning ? sevPill('blocked', 'not scanned') : sevPill('zero', 'ok')),
    track('cw:spend:' + r.path, r.spendMonth, el('td', { class: 'num', title: 'codeburn projects at or under this repo' }, r.spendMonth === null || r.spendMonth === undefined ? '-' : money(r.spendMonth, cur))));
  tr.addEventListener('click', (e) => { if (!(e.target instanceof Element && e.target.closest('a'))) openRepo(r.id); });
  return tr;
}

function codewatchPanel(data) {
  const rows = data.overview.codewatch;
  const banner = scanBanner(data.machine.secretScanning);
  if (!rows.length && !banner) {
    const sg = (data.suggestions || []).find((x) => x.id === 'codewatch-global');
    return moreItem('Codewatch', sg ? el('code', {}, sg.command) : el('code', {}, 'prism-cli enable codewatch'));
  }
  const s = el('section', { class: 'card', id: 'codewatch' }, el('h2', {}, 'Codewatch',
    el('span', { class: 'sub' }, rows.length + ' repo' + (rows.length === 1 ? '' : 's') + ' with codewatch results or hooks · ' + data.overview.counts.codewatch + ' with hooks installed · click a repo for its own page')));
  if (banner) s.append(banner);
  if (!rows.length) {
    s.append(el('p', { class: 'empty' }, "Codewatch isn't enabled in any repo yet. Run ", el('code', {}, 'prism-cli enable codewatch'), ' inside a repo.'));
    return s;
  }
  const cur = data.usage && data.usage.currency;
  const head = ['Repo', 'Findings', 'Trend (last 12 runs)', { label: 'Last run', cls: 'hide-sm' }, { label: 'Reviewer', cls: 'hide-sm' },
    { label: 'Unscanned', cls: 'num hide-sm' }, { label: 'Gitleaks', cls: 'hide-sm' }, { label: 'Spend (month)', cls: 'num' }];
  s.append(table(head, rows.map((r) => codewatchRow(r, cur))));
  return s;
}
${REPO_SCRIPT}

/** A list of name, bar, value rows; at most \`n\`. Bar widths are CSSOM styles, which the CSP allows. */
function barList(title, rows, fmt, n) {
  const box = el('div', { class: 'barlist' }, el('span', { class: 't' }, title));
  const top = Math.max(1e-9, ...rows.map((x) => x.value));
  for (const x of rows.slice(0, n || 5)) {
    const bar = el('span', { class: 'bar' });
    bar.style.width = Math.max(2, (x.value / top) * 100) + '%';
    box.append(el('span', { class: 'n', title: txt(x.title || x.name) }, txt(x.name)), bar, el('span', {}, fmt(x.value)));
  }
  return box;
}

/** Kiro Crew workspaces (workspace-member-<name>) read as "crew: <name>". */
const projectName = (p) => /^workspace-member-./.test(txt(p.name)) ? 'crew: ' + txt(p.name).slice('workspace-member-'.length) : txt(p.name);

const isoDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const HEAT_WEEKS = 12;
/** Shades for days with spend (CSS .l1 to .l4). */
const HEAT_LEVELS = 4;

/**
 * Spend per day, HEAT_WEEKS weeks to today, a column per week (Monday on top).
 * Known days come from this month's rows and the prior weeks' rows: a known
 * day without a row had no usage (zero). A day neither export covered is
 * unknown and drawn as an outline, not as zero.
 */
function heatmap(u) {
  const end = new Date(txt(u.month.to) + 'T00:00:00');
  const start = new Date(end); start.setDate(start.getDate() - (HEAT_WEEKS * 7 - 1)); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const cost = new Map();
  const pr = u.prior || null;
  for (const r of (pr && pr.daily) || []) cost.set(r.date, r.cost);
  for (const r of u.daily || []) cost.set(r.date, r.cost);
  const known = (k) => k >= u.month.from || (pr && k >= pr.from && k <= pr.to);
  // The earlier weeks' export: pending draws its days as loading "no data", error as plain "no data" -- never as $0.
  const h = u.history || null;
  const pending = !!h && h.status === 'pending';
  const max = Math.max(0, ...cost.values());
  const grid = el('div', { class: 'heat', role: 'img', 'aria-label': 'spend per day, last ' + HEAT_WEEKS + ' weeks' });
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = isoDay(d), c = cost.get(k);
    if (!known(k)) { grid.append(el('i', { class: pending ? 'nd pending' : 'nd', title: k + (pending ? ': loading' : ': no data') })); continue; }
    // Levels 1..HEAT_LEVELS split (0, max] evenly; the busiest day is the top level.
    const lvl = !c ? 0 : Math.min(HEAT_LEVELS, Math.ceil((c / max) * HEAT_LEVELS));
    grid.append(el('i', { class: lvl ? 'l' + lvl : '', title: k + ': ' + (c ? money(c, u.currency) : 'no usage') }));
  }
  const note = pending ? 'Loading earlier weeks from codeburn...' : h && h.status === 'error' ? 'Earlier weeks unavailable: ' + txt(h.error || 'the export failed') : '';
  return el('div', {}, grid,
    el('div', { class: 'heat-legend' }, 'less ', el('i'), el('i', { class: 'l1' }), el('i', { class: 'l2' }), el('i', { class: 'l3' }), el('i', { class: 'l4' }), ' more', el('i', { class: 'nd' }), ' no data',
      el('span', { class: 'range' }, isoDay(start) + ' to ' + txt(u.month.to))),
    el('p', { class: 'heat-note', role: 'status', 'aria-live': 'polite', hidden: note ? null : '' }, note));
}

function codeburnStrip(cb) {
  if (!cb) return null;
  const row = el('div', { class: 'cb-row' });
  const stat = (k, v) => row.append(el('div', { class: 'cb-stat' }, el('div', { class: 'k' }, k), el('b', {}, v)));
  stat('API calls', compact(cb.calls)); stat('Sessions', compact(cb.sessions)); stat('Projects', compact(cb.projects));
  stat('Input tokens', compact(cb.tokens.input)); stat('Output tokens', compact(cb.tokens.output)); stat('Cache reads', compact(cb.tokens.cacheRead));
  if ((cb.tools || []).length) {
    row.append(el('div', { class: 'cb-stat wide' }, el('div', { class: 'k' }, 'Top tools'),
      el('div', {}, cb.tools.slice(0, 6).map((t) => el('span', { class: 'chip' }, txt(t.name) + ' ', el('b', {}, compact(t.calls)))))));
  }
  return row;
}

/** "updated <time>", and whether a refresh is running or the last one failed. */
function usageUpdated(u) {
  if (!u.updatedAt) return null;
  return el('p', { class: 'note' }, 'updated ' + when(u.updatedAt)
    + (u.refreshError ? ' · refresh failed: ' + txt(u.refreshError) : u.stale ? ' · refreshing in the background' : ''));
}

/** The Spend card's one command, shown once as copy text when codeburn is missing. */
const SPEND_SETUP_CMD = 'prism-cli enable codeburn';

/**
 * The Spend card before it has a month to draw, in its usual place: codeburn missing (what the card shows
 * once it is set up, Set up codeburn, and the command), or set up with no usage this month yet. The button
 * needs the action list, so fillSpendSetup adds it after /api/setup; a snapshot gets none.
 */
function spendEmpty(s, u) {
  if (u.status === 'no-data') {
    s.append(el('p', { class: 'empty', 'data-spend-empty': 'no-data' }, 'codeburn is set up but has no usage for this month yet.'), usageUpdated(u) || '');
    return s;
  }
  s.append(el('div', { class: 'spend-empty', 'data-spend-empty': 'not-installed' },
    el('p', {}, 'Once codeburn is set up, this card shows your monthly AI spend from codeburn: a heatmap of daily spend, and the spend by model, project and activity.'),
    el('div', { class: 'srow-ctl', 'data-spend-setup': '', hidden: '' }),
    el('div', { class: 'fix' }, SNAPSHOT ? 'To set it up, run in a terminal:' : 'Or run in a terminal:'), copyButton(SPEND_SETUP_CMD)));
  return s;
}

/** Puts Set up codeburn into the Spend card's empty state once the action list is in (live page only; it confirms first). */
function fillSpendSetup() {
  const main = document.getElementById('main');
  const slot = main && main.querySelectorAll('[data-spend-setup]')[0];
  if (!slot || SNAPSHOT) return;
  const b = runButton('codeburn-setup', { label: 'Set up codeburn' });
  if (!b) return;
  slot.replaceChildren(b);
  slot.removeAttribute('hidden');
}

function spendPanel(u) {
  const s = el('section', { class: 'card', id: 'spend' }, el('h2', {}, 'Spend', el('span', { class: 'sub' }, u.month ? 'codeburn · ' + u.month.from + ' to ' + u.month.to : 'codeburn')));
  if (u.status === 'loading') { s.append(el('p', { class: 'empty loading' }, txt(u.message))); return s; }
  if (u.status === 'not-installed' || u.status === 'no-data') return spendEmpty(s, u);
  if (u.status !== 'ok') { s.append(el('p', { class: 'empty' }, pill('error', u.status), ' ', txt(u.message))); return s; }
  const fmt = (n) => money(n, u.currency);
  const busy = (u.daily || []).slice().sort((a, b) => b.cost - a.cost)[0];
  const busyDay = busy ? new Date(busy.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const wrap = el('div', { class: 'heat-wrap' }, heatmap(u),
    el('div', {}, el('div', { class: 'fix' }, 'This month'), track('use:month', u.month.cost, el('div', { class: 'big' }, fmt(u.month.cost))),
      el('div', { class: 'fix' }, busy && busy.cost ? 'busiest day: ' + busyDay + ', ' + fmt(busy.cost) : 'no usage yet this month')));
  wrap.append(barList('By model', u.topModels.map((m) => ({ name: m.name, value: m.cost })), fmt, 4));
  wrap.append(barList('By project', u.topProjects.map((p) => ({ name: projectName(p), title: p.path, value: p.cost })), fmt, 4));
  const cb = u.codeburn;
  if (cb && cb.activity.length) wrap.append(barList('By activity', cb.activity.map((a) => ({ name: a.name, value: a.cost })), fmt, 5));
  s.append(wrap, codeburnStrip(cb) || '', usageUpdated(u) || '',
    el('p', { class: 'note' }, "Full breakdown by task, tool, model and project in codeburn's own dashboard: ", el('code', {}, 'codeburn web --period month'), ' · in the terminal: ', el('code', {}, 'codeburn month')));
  return s;
}

/** Help text for a row: the text, any steps and commands, then its doc links (https only), each opening in a new tab. */
function helpBlock(h) {
  const links = (h.links || []).filter((l) => /^https:\\/\\//.test(txt(l.url)))
    .map((l) => el('a', { href: txt(l.url), class: 'rlink', target: '_blank', rel: 'noopener noreferrer' }, txt(l.label)));
  const steps = (h.steps || []).length ? el('ol', { class: 'help-steps' }, h.steps.map((x) => el('li', {}, txt(x)))) : null;
  const cmds = (h.commands || []).length ? el('div', { class: 'help-links' }, 'Commands: ', h.commands.flatMap((c, n) => n ? [', ', el('code', {}, txt(c))] : [el('code', {}, txt(c))])) : null;
  return el('div', { class: 'help' }, txt(h.text), steps, cmds, links.length ? el('div', { class: 'help-links' }, links.flatMap((a, n) => n ? [' · ', a] : [a])) : null);
}

const SEC_LABEL = { ok: 'ok', 'in-use': 'in use', missing: 'missing' };


/** Risk levels of Security Agent results, highest first; the pills follow the codewatch severity pills. */
const RISKS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL', 'UNKNOWN'];
/** One pill per level with a count, highest first; none: a single ok pill. */
const riskPills = (counts, levels, none) => {
  const shown = levels.filter((k) => ((counts || {})[k] || 0) > 0);
  return shown.length ? shown.map((k) => sevPill(k, counts[k] + ' ' + k.toLowerCase())) : [sevPill('ok', none)];
};

/** stale?: past the window and no check found it still running; with a failed check, the pill's title says why. */
const stalePill = (x) => { const p = sevPill('zero', 'stale?'); const e = x.check && x.check.state === 'error' ? x.check : null; if (e) p.setAttribute('title', 'could not check with AWS: ' + txt(e.reason)); return p; };
/** A failed auto-check of a pending job: why, and the command to fetch it by hand. */
const checkNote = (x) => { const e = x && x.check && x.check.state === 'error' ? x.check : null;
  return e ? el('div', { class: 'fix', 'data-check-error': '' }, 'Could not check with AWS: ' + txt(e.reason) + '. Fetch by hand: ', el('code', {}, txt(e.command))) : null; };
/** A cached result's pills: running (pending), the job's failure, else its counts. */
const resultPills = (x, levels, none) => x.pending ? [sevPill('medium', 'running'), x.stale ? stalePill(x) : null].filter(Boolean)
  : x.status === 'error' ? [sevPill('blocked', txt(x.job_status).toLowerCase())] : riskPills(x.counts, levels, none);

const SCOPE_TEXT = { diff: 'branch diff', full: 'whole repo' };
/** A newer code review still running while the last completed one is shown (security.ts running); null when there is none. */
const runningNote = (r, hint) => r && r.running ? el('p', { class: 'note' }, sevPill('medium', 'new review running'), r.running.stale ? stalePill(r.running) : null,
  ' started ' + when(r.running.started_at) + ' · ' + txt(SCOPE_TEXT[r.running.scope] || 'scope unknown') + ' · job ' + txt(r.running.job_id).slice(0, 12)
  + '. Shown: the last completed review' + (hint ? '; fetch the new one with ' : '.'), hint ? el('code', {}, hint) : null, hint ? '.' : null) : null;

/** No saved Security Agent run yet: where to start (the Security runs card replaces this once there is one). */
function securityPanel(sec) {
  return moreItem('Security Agent', el('code', {}, 'prism-cli enable security'), ', then ', el('code', {}, (sec && sec.hint) || 'prism-cli security code-review'));
}

const THREAT_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const AUDIT_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** The latest aws check per account, one line each (the detail is on AccountGuard). Local results only. */
function awsPanel(aws) {
  const rows = (aws && aws.accounts) || [];
  if (!rows.length) return moreItem('AWS account checks', el('code', {}, (aws && aws.hint) || 'prism-cli aws check'), ' (read-only), or run it from ', el('a', { href: '#accountguard', class: 'rlink' }, 'AccountGuard'));
  const s = el('section', { class: 'card', id: 'aws' }, el('h2', {}, 'AWS account', el('span', { class: 'sub' }, 'latest aws check')));
  for (const a of rows) {
    const c = a.counts || {}, f = a.fail_by_severity || {};
    const pills = el('span', { class: 'pills' }, ...AUDIT_SEVERITIES.filter((k) => f[k]).map((k) => sevPill(k, f[k] + ' ' + k.toLowerCase())),
      sevPill('ok', (c.pass || 0) + ' pass'), c.indeterminate ? sevPill('zero', c.indeterminate + ' could not check') : null);
    s.append(el('div', { class: 'aws-line sec-repo' },
      el('span', {}, el('b', {}, maskAccount(a.account)), a.alias ? el('span', { class: 'tag' }, txt(a.alias)) : null, el('span', { class: 'fix' }, ' · ' + txt(a.region) + ' · checked ' + ago(a.checked_at))),
      pills, el('a', { href: '#accountguard', class: 'rlink' }, 'Open AccountGuard →')));
  }
  return s;
}

/** The header's version pill: grey when current (or unchecked), orange with the newer version when npm has one. */
function versionPill(v) {
  const box = document.getElementById('ver');
  if (!box || !v) return;
  const checked = v.checkedAt ? 'checked ' + when(v.checkedAt) : 'not checked yet';
  const a = el('a', { href: '#settings/updates', class: 'verpill' + (v.update ? ' up' : ''),
    title: v.update ? 'prism-cli ' + v.latest + ' is on npm (' + checked + '). Click for the update command.' : v.latest ? 'latest on npm: ' + v.latest + ' (' + checked + ')' : v.off ? 'update check: off (PRISM_NO_UPDATE_CHECK=1)' : 'update check: ' + checked },
    v.update ? 'Update: ' + v.installed + ' → ' + v.latest : 'prism-cli ' + v.installed);
  box.replaceChildren(a);
}

/** Auto-refresh period while the tab is visible; paused while hidden. */
const AUTO_REFRESH_MS = 60000;
let lastLoad = 0, loading = false;
/** While the heatmap's earlier weeks load: poll this often, at most this many times (past the export's 60 s timeout). */
const HISTORY_POLL_MS = 3000, HISTORY_POLL_MAX = 40;
let historyPolls = 0, historyTimer = null;
const historyPending = () => !!(LAST && LAST.usage && LAST.usage.history && LAST.usage.history.status === 'pending');

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
    const hist = (x) => JSON.stringify((x && x.history) || null);
    if (u && u.usage && (u.usage.updatedAt !== was.updatedAt || u.usage.status !== was.status || hist(u.usage) !== hist(was))) await render();
  } finally {
    loading = false; lastLoad = Date.now();
    // One poll chain at a time, whichever load (refresh, auto-refresh, poll) found the weeks pending.
    clearTimeout(historyTimer);
    if (!SNAPSHOT && historyPending() && historyPolls < HISTORY_POLL_MAX) { historyPolls++; historyTimer = setTimeout(() => load(false), HISTORY_POLL_MS); }
    else if (!historyPending()) historyPolls = 0;
    // Pending Security Agent runs: ask the server to check them with AWS (security-runs-page.ts).
    securityCheck();
  }
}

async function getJson(path) {
  if (SNAPSHOT) {
    if (path === '/api/data') return SNAPSHOT.data;
    if (path.startsWith('/api/usage')) return { usage: SNAPSHOT.data.usage, cacheHit: true };
    throw new Error('not in this snapshot');
  }
  // Through the page's Transport (setup-page.ts api()), so every host reads the same way.
  const r = await api(path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json;
}

/** The dashboard view: cards, then each section with data; empty ones become "Get more from PRISM" items. */
function renderMain(main, data) {
  MORE = [];
  const parts = [summaryCards(data.summary), codewatchPanel(data), spendPanel(data.usage), (data.security_runs || []).length ? securityRunsCard() : securityPanel(data.security), awsPanel(data.aws)];
  if (data.scope.error) main.append(el('section', { class: 'card' }, pill('error'), ' ', data.scope.error));
  main.append(...parts.filter(Boolean));
  if (MORE.length) main.append(el('div', { class: 'more', id: 'more' }, el('b', {}, 'Get more from PRISM'), ...MORE));
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
  LAST = data;
  // Open/closed state of keyed <details> survives the redraw.
  const openState = new Map([...document.querySelectorAll('details[data-key]')].map((d) => [d.getAttribute('data-key'), d.open]));
  LABELS = new Map((data.repos || []).map((r) => [r.path, r.label || r.name]));
  CUR = {};
  main.replaceChildren();
  renderMain(main, data);
  versionPill(data.version);
  const changed = new Set(changedKeys(PREV, CUR));
  for (const n of main.querySelectorAll('[data-track]')) {
    const k = n.getAttribute('data-track');
    if (changed.has(k)) { n.classList.add('changed'); n.setAttribute('title', 'changed since the previous load (was ' + PREV[k] + ')'); }
  }
  PREV = CUR;
  const c = data.overview.counts;
  meta.textContent = c.repos + ' repos under ' + txt(data.scope.root_display) + ' · ' + c.codewatch + ' with codewatch hooks installed' + (data.scope.truncated ? ' (scan capped)' : '')
    + (SNAPSHOT ? ' · data from ' + when(data.generated_at) + ' · static snapshot, does not refresh'
      : ' · updated ' + when(data.generated_at) + (changed.size ? ' · ' + changed.size + ' value' + (changed.size === 1 ? '' : 's') + ' changed (outlined)' : '') + ' · refreshes every minute while visible');
  const r = repoRoute();
  if (r) renderRepo(r);
  await renderSetup(data);
  fillSpendSetup();
  await renderSecurity();
  await renderAccountGuard();
  for (const d of document.querySelectorAll('details[data-key]')) {
    const k = d.getAttribute('data-key');
    if (openState.has(k)) d.open = openState.get(k);
  }
  return data;
}
${SETUP_SCRIPT}
${MARKDOWN_SCRIPT}
${SECURITY_RUNS_SCRIPT}
${SECURITY_SCRIPT}
${ACCOUNTGUARD_SCRIPT}
${SETTINGS_SCRIPT}
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

/** The PRISM marks as data: URIs, read once from the shipped assets (dist/assets/dashboard); empty when missing. */
let MARKS: { icon: string; logo: string } | null = null;
export function brandMarks(): { icon: string; logo: string } {
  if (!MARKS) {
    const uri = (name: string) => {
      try { return 'data:image/png;base64,' + readFileSync(getAssetPath(import.meta.url, `dashboard/${name}`)).toString('base64'); } catch { return ''; }
    };
    MARKS = { icon: uri('prism-mark-32.png'), logo: uri('prism-mark-96.png') };
  }
  return MARKS;
}

/** <link rel=icon> and the header, shared by the live page and the snapshot. `live` adds the Refresh button. */
function shell(live: boolean): { head: string; header: string } {
  const m = brandMarks();
  // Base64 only: nothing user-derived reaches these attributes.
  const head = m.icon ? `<link rel="icon" type="image/png" href="${m.icon}">` : '';
  const logo = m.logo ? `<img class="logo" src="${m.logo}" width="36" height="36" alt="">` : '';
  const header = `<header><h1>${logo}PRISM dashboard</h1>
<nav class="tabs" aria-label="Views"><a href="#" data-view="dashboard">Dashboard</a><a href="#security" data-view="security">Security Agent <span class="badge warn" id="security-badge" hidden></span></a><a href="#accountguard" data-view="accountguard">AccountGuard <span class="badge warn" id="accountguard-badge" hidden></span></a><a href="#settings" data-view="settings">Settings <span class="badge warn" id="settings-badge" hidden></span></a></nav>
<span class="spacer"></span>
<div class="tools"><span id="ver"></span>${live ? '<button id="refresh" type="button">Refresh</button>' : ''}
<div class="theme" role="group" aria-label="Theme"><button type="button" data-theme-set="light">Light</button><button type="button" data-theme-set="dark">Dark</button><button type="button" data-theme-set="system">System</button></div></div></header>`;
  return { head, header };
}

const VIEWS = '<main id="main"></main>\n<main id="repo" hidden></main>\n<main id="security" hidden></main>\n<main id="accountguard" hidden></main>\n<main id="settings" hidden></main>\n<p class="note meta" id="meta"></p>';

export function renderPage(nonce: string, csrf = ''): string {
  // The nonce and the CSRF token are base64/base64url generated server-side; nothing user-derived is interpolated here.
  if (!/^[A-Za-z0-9_-]*$/.test(csrf)) throw new Error('bad CSRF token');
  const s = shell(true);
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="prism-csrf" content="${csrf}">
<script nonce="${nonce}">${THEME_BOOT}</script>
${s.head}<title>PRISM dashboard</title><style nonce="${nonce}">${STYLE}</style></head>
<body><div class="wrap">${s.header}
${VIEWS}
</div><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
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
 * default-src 'none' (no fetch, no remote resource; images only as data:
 * URIs), and the Settings page's Run buttons become Copy buttons. No token, no server.
 */
export function renderSnapshotPage(s: SnapshotData): string {
  const M = SNAPSHOT_MARKERS;
  const at = escapeHtml(s.generatedAt);
  const sh = shell(false);
  const csp = `default-src 'none'; script-src ${sha256(THEME_BOOT)} ${sha256(SCRIPT)}; style-src ${sha256(STYLE)}; img-src data:; base-uri 'none'; form-action 'none'`;
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
${M.script}${THEME_BOOT}${M.scriptEnd}
${sh.head}<title>PRISM dashboard snapshot ${at}</title>${M.style}${STYLE}${M.styleEnd}</head>
<body><div class="wrap">${sh.header}
<div class="banner snapshot" role="note"><strong>Snapshot generated <time id="snapshot-at" datetime="${at}">${at}</time></strong>
<div class="fix">A static copy written by prism-cli ${escapeHtml(s.version)} dashboard --snapshot. It does not refresh and nothing on it runs: commands are copy only. For the live page run <code>prism-cli dashboard</code>.</div></div>
${VIEWS}
</div>
${M.data}${embedJson(s)}${M.scriptEnd}
${M.script}${SCRIPT}${M.scriptEnd}</body></html>`;
}

/**
 * The shared UI bundle (scripts/build-ui.mjs writes it to dist/ui): the same style, body markup
 * and script the browser page inlines, for the hosts that load it from the installed package
 * (the VS Code webview, the Kiro Crew app page). The body has no data and no token in it.
 */
export function uiBundle(): { css: string; js: string; body: string; themeBoot: string } {
  const s = shell(true);
  return { css: STYLE, js: SCRIPT, body: `${s.header}\n${VIEWS}`, themeBoot: THEME_BOOT };
}
