/**
 * The dashboard's single-page app: one self-contained HTML document with
 * inline CSS and JS (nonce-gated by the CSP), no CDN and no network fetch
 * other than its own GET /api/data, so it works offline.
 *
 * Every value from the payload is placed with textContent or a DOM attribute;
 * innerHTML is never used for data.
 */

const STYLE = `
:root { color-scheme: light dark; --bg:#f7f7f8; --card:#fff; --text:#1d1d1f; --muted:#6b6b73; --line:#e3e3e8;
  --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --high:#cf222e; --medium:#bf8700; --low:#57606a; --accent:#0969da; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --line:#30363d;
  --ok:#3fb950; --warn:#d29922; --bad:#f85149; --high:#f85149; --medium:#d29922; --low:#8b949e; --accent:#58a6ff; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); background:var(--card); }
header h1 { font-size:17px; margin:0; } header .meta { color:var(--muted); font-size:12px; margin-left:auto; }
button { font:inherit; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); cursor:pointer; }
main { padding:16px 20px; display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); }
section.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; min-width:0; }
section.wide { grid-column: 1 / -1; }
h2 { font-size:15px; margin:0 0 10px; } h3 { font-size:13px; margin:14px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
.empty { color:var(--muted); padding:8px 0; } code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; background:var(--bg); padding:1px 4px; border-radius:4px; }
.tablewrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; } th, td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:break-word; }
th { white-space:nowrap; } td.msg { min-width:280px; } td.count { font-variant-numeric:tabular-nums; font-weight:600; } td code { white-space:normal; overflow-wrap:anywhere; }
th { color:var(--muted); font-weight:600; } td.num { text-align:right; font-variant-numeric: tabular-nums; }
.pill { white-space:nowrap; display:inline-block; padding:0 7px; border-radius:10px; font-size:12px; font-weight:600; border:1px solid currentColor; }
.s-ok { color:var(--ok); } .s-warn, .s-findings, .s-skipped { color:var(--warn); } .s-missing, .s-error { color:var(--bad); }
.sev-high { color:var(--high); } .sev-medium { color:var(--medium); } .sev-low { color:var(--low); }
.stats { display:flex; gap:18px; flex-wrap:wrap; margin:6px 0; } .stat b { display:block; font-size:20px; } .stat span { color:var(--muted); font-size:12px; }
.fix { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.tag { margin-left:6px; font-size:11px; padding:0 6px; border-radius:8px; background:var(--bg); border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
details.missing-group > summary { cursor:pointer; padding:8px 0; color:var(--muted); font-weight:600; }
details.repo { border-top:1px solid var(--line); padding:8px 0; } details.repo > summary { cursor:pointer; padding:4px 0; } details.repo .detail { padding-left:14px; }
.callout { border:1px solid var(--accent); border-left-width:4px; border-radius:6px; padding:10px 12px; margin:6px 0 10px; background:color-mix(in srgb, var(--accent) 8%, var(--card)); }
.callout.warn { border-color:var(--warn); background:color-mix(in srgb, var(--warn) 10%, var(--card)); } .callout code { white-space:normal; overflow-wrap:anywhere; }
.banner { border:1px solid var(--warn); border-left-width:4px; border-radius:6px; padding:10px 12px; margin:4px 0 12px; background:color-mix(in srgb, var(--warn) 10%, var(--card)); }
.banner strong { color:var(--text); display:block; margin-bottom:4px; } .banner .fix code { white-space:normal; overflow-wrap:anywhere; } .note { color:var(--muted); font-size:12px; margin-top:10px; }
svg.trend rect.high { fill:var(--high); } svg.trend rect.medium { fill:var(--medium); } svg.trend rect.low { fill:var(--low); } svg.trend rect.zero { fill:var(--ok); }
svg.trend line { stroke:var(--line); }
.repo-title { font-size:12px; color:var(--muted); margin-bottom:6px; word-break:break-all; }
`;

const SCRIPT = `
'use strict';
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
  return el('span', { title: r.path }, r.name, r.current ? el('span', { class: 'tag' }, 'this repo') : null);
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

  s.append(el('h3', {}, 'Latest run per branch'));
  s.append(table(['Branch', 'Review', 'Reviewer', 'When', 'Secret scan'], cw.latestByBranch.map((b) => [
    b.branch,
    b.review ? pill(b.review.status) : '-',
    b.review ? b.review.tool + (b.review.model ? ' / ' + b.review.model : '') : '-',
    b.review ? when(b.review.started_at) : '-',
    b.secrets ? pill(b.secrets.status) : '-',
  ])));

  s.append(el('h3', {}, 'Findings (latest review per branch)'));
  if (!cw.findings.length) s.append(el('p', { class: 'empty' }, 'No findings in the latest reviews.'));
  else s.append(table(['Severity', 'Category', 'Location', 'Rule', 'Message'], cw.findings.map((f) => [
    sev(f.severity), f.category, el('code', {}, f.file + (f.line ? ':' + f.line : '')), f.rule, el('td', { class: 'msg' }, f.message)])));
  if (cw.findingsTruncated) s.append(el('p', { class: 'note' }, 'List truncated.'));

  s.append(el('h3', {}, 'Trend (last ' + cw.trend.length + ' runs)'));
  s.append(trendSvg(cw.trend));

  s.append(el('h3', {}, 'Gitleaks blocks'));
  if (!cw.gitleaksBlocks.length) s.append(el('p', { class: 'empty' }, 'No commits blocked.'));
  else s.append(table(['When', 'Branch', 'Result', 'Secrets'], cw.gitleaksBlocks.slice(0, 20).map((r) => [when(r.started_at), txt(r.branch), pill(r.status), r.status === 'findings' ? r.high : txt(r.reason)])));

  s.append(el('h3', {}, 'Commits pushed without a pre-commit scan'));
  if (!cw.skipped.length) s.append(el('p', { class: 'empty' }, 'None.'));
  else {
    s.append(table(['Commit', 'Branch', 'Recorded'], cw.skipped.slice(0, 20).map((r) => [el('code', {}, short(r.commit)), txt(r.branch), when(r.started_at)])));
    s.append(el('p', { class: 'note' }, 'Usually git commit --no-verify; rebases and cherry-picks also show up here.'));
  }
  return s;
}

function codewatchPanel(data) {
  const s = el('section', { class: 'card wide' }, el('h2', {}, 'Codewatch'));
  const banner = scanBanner(data.machine.secretScanning);
  if (banner) s.append(banner);
  const rows = data.overview.codewatch;
  if (!rows.length) {
    const sg = (data.suggestions || []).find((x) => x.id === 'codewatch-global');
    if (sg) s.append(el('p', { class: 'empty' }, "Codewatch isn't enabled in any repo yet. Cover every repo at once: ", el('code', {}, sg.command), ', or run ', el('code', {}, 'prism-cli enable codewatch'), ' inside one repo.'));
    else s.append(el('p', { class: 'empty' }, "Codewatch isn't enabled in any repo yet. Run ", el('code', {}, 'prism-cli enable codewatch'), ' inside a repo.'));
    return s;
  }
  const count = (n, cls) => el('td', { class: 'count' + (n ? ' ' + cls : '') }, n);
  s.append(table(['Repo', 'High', 'Medium', 'Low', 'Last run', 'Reviewer', 'Unscanned', 'Gitleaks'], rows.map((r) => [
    repoName(r), count(r.high, 'sev-high'), count(r.medium, 'sev-medium'), count(r.low, 'sev-low'),
    r.lastRunAt ? when(r.lastRunAt) : 'never', txt(r.reviewer || '-'), count(r.unscannedCommits, 'sev-medium'),
    r.gitleaksWarning ? pill('warn', 'not scanned') : '-',
  ])));
  const byPath = Object.fromEntries(data.repos.map((r) => [r.path, r]));
  s.append(el('h3', {}, 'Per repo'));
  for (const row of rows) {
    const repo = byPath[row.path]; if (!repo) continue;
    const total = row.high + row.medium + row.low;
    const d = el('details', repo.current ? { class: 'repo', open: '' } : { class: 'repo' },
      el('summary', {}, el('b', {}, repo.name), ' ', el('span', { class: 'fix' }, repo.codewatch.hasResults ? total + ' finding' + (total === 1 ? '' : 's') + ' in the latest reviews' : 'no results yet'),
        repo.current ? el('span', { class: 'tag' }, 'this repo') : null),
      el('div', { class: 'repo-title' }, repo.path));
    d.append(codewatchDetail(repo));
    s.append(d);
  }
  return s;
}

function usagePanel(u) {
  const s = el('section', { class: 'card' }, el('h2', {}, 'Usage (codeburn)'));
  if (u.status !== 'ok') {
    s.append(el('p', { class: 'empty' }, pill(u.status === 'no-data' ? 'warn' : 'missing', u.status), ' ', txt(u.message)));
  } else {
    s.append(el('div', { class: 'stats' },
      el('div', { class: 'stat' }, el('b', {}, money(u.today.cost, u.currency)), el('span', {}, 'today, ' + u.today.calls + ' calls')),
      el('div', { class: 'stat' }, el('b', {}, money(u.month.cost, u.currency)), el('span', {}, 'this month, ' + u.month.calls + ' calls, ' + u.month.sessions + ' sessions'))));
    s.append(el('h3', {}, 'Top models this month'));
    s.append(table(['Model', 'Cost', 'Calls'], u.topModels.map((m) => [m.name, num(money(m.cost, u.currency)), num(m.calls)])));
    s.append(el('h3', {}, 'Top projects this month'));
    s.append(table(['Project', 'Cost', 'Sessions'], u.topProjects.map((p) => [el('span', { title: p.path }, p.name), num(money(p.cost, u.currency)), num(p.sessions)])));
  }
  s.append(el('p', { class: 'note' }, 'Full charts: run ', el('code', {}, txt(u.fullView)), ' in a terminal.'));
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

function setupPanel(data) {
  const s = el('section', { class: 'card' }, el('h2', {}, 'Setup checklist'));
  const rows = (items) => items.map((i) => [pill(i.status), i.label, el('div', {}, i.detail, i.fix ? el('div', { class: 'fix' }, 'Fix: ' + i.fix) : null)]);
  s.append(el('h3', {}, 'This machine'), table(['', 'Check', 'Detail'], rows(data.machine.setup)));
  const repos = data.overview.setup, c = data.overview.counts;
  s.append(el('h3', {}, 'Codewatch per repo (' + c.codewatch + ' of ' + c.repos + ' installed)'));
  const label = { ok: 'ok', warn: 'warn', missing: 'missing', 'opted-out': 'opted out' };
  const pillClass = { ok: 'ok', warn: 'warn', missing: 'missing', 'opted-out': 'skipped' };
  const rowOf = (r) => [
    repoName(r),
    el('div', {}, pill(pillClass[r.status] || 'missing', (label[r.status] || r.status) + (r.status === 'ok' && r.global ? ' (global)' : '')), ' ',
      r.status === 'ok' ? 'reviewer ' + txt(r.reviewer || 'none') : txt(r.detail),
      r.fix ? el('div', { class: 'fix' }, 'Fix: ', el('code', {}, r.fix)) : null),
  ];
  const sg = (data.suggestions || []).find((x) => x.id === 'codewatch-global');
  if (sg) s.append(suggestionCallout(sg));
  // Always shown: the current repo (installed or not) and every installed repo.
  const shown = repos.filter((r) => !r.collapsed);
  const hidden = repos.filter((r) => r.collapsed);
  if (shown.length) s.append(table(['Repo', 'Codewatch'], shown.map(rowOf)));
  else if (!hidden.length) s.append(el('p', { class: 'empty' }, 'No git repositories found under ' + txt(data.scope.root_display) + '.'));
  if (hidden.length) {
    s.append(el('details', { class: 'missing-group' },
      el('summary', {}, hidden.length + ' repo' + (hidden.length === 1 ? '' : 's') + ' without codewatch'),
      table(['Repo', 'Codewatch'], hidden.map(rowOf))));
  }
  return s;
}

function securityPanel(sec) {
  return el('section', { class: 'card' }, el('h2', {}, 'Security findings'), el('p', { class: 'empty' }, sec.status === 'coming-soon' ? ['Coming with ', el('code', {}, 'prism-cli security findings'), '.'] : txt(sec.message)));
}

async function load() {
  const main = document.getElementById('main'), meta = document.getElementById('meta');
  meta.textContent = 'loading...';
  let data;
  try {
    const res = await fetch('/api/data', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) { meta.textContent = 'failed to load: ' + e.message; return; }
  main.replaceChildren();
  if (data.scope.error) main.append(el('section', { class: 'card wide' }, pill('error'), ' ', data.scope.error));
  main.append(codewatchPanel(data), usagePanel(data.usage), setupPanel(data), securityPanel(data.security));
  const c = data.overview.counts;
  meta.textContent = c.repos + ' repos under ' + txt(data.scope.root_display) + ' · ' + c.codewatch + ' with codewatch' + (data.scope.truncated ? ' (scan capped)' : '') + ' · updated ' + when(data.generated_at);
}
document.getElementById('refresh').addEventListener('click', load);
load();
`;

export function renderPage(nonce: string): string {
  // The nonce is base64 generated server-side; nothing user-derived is interpolated here.
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRISM dashboard</title><style nonce="${nonce}">${STYLE}</style></head>
<body><header><h1>PRISM dashboard</h1><button id="refresh" type="button">Refresh</button><span class="meta" id="meta"></span></header>
<main id="main"></main>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
