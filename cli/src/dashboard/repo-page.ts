/**
 * The per-repo view (#repo/<id>), as a JS string concatenated into page.ts's
 * single document (same nonce, same el()/txt()/sevPill() helpers). Every
 * value from the payload is placed with textContent or an attribute.
 */

import { MAX_SCANS, REVIEW_WINDOW_DAYS } from './codewatch.js';

export const REPO_SCRIPT = `
/** Reviews per repo in the payload (codewatch.ts MAX_SCANS); the chart shows all of them. */
const SCANS_LOADED = ${MAX_SCANS};
const REPO_CHART_RUNS = SCANS_LOADED;
/** Newest reviews listed in the repo view. */
const REPO_REVIEW_ROWS = 10;
/** Open findings listed before "N more". */
const REPO_FINDING_ROWS = 20;

/**
 * Stacked severity bars, one slot per review, oldest left. A review with no
 * findings is a thin tick: ok when it was clean, muted when it was skipped,
 * red when it failed. Fills are CSS classes, so both themes apply.
 */
function severityBars(runs, w, h, slots, label) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'bars'); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h));
  svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
  const max = Math.max(1, ...runs.map((r) => r.high + r.medium + r.low));
  const bw = w / Math.max(runs.length, slots), pad = Math.max(1, bw * 0.15);
  const rect = (x, y, rh, cls, tip) => {
    const r = document.createElementNS(SVG, 'rect');
    r.setAttribute('x', String(x + pad)); r.setAttribute('y', String(y)); r.setAttribute('width', String(Math.max(1, bw - 2 * pad))); r.setAttribute('height', String(rh));
    r.setAttribute('rx', '1.5'); r.setAttribute('class', cls);
    const t = document.createElementNS(SVG, 'title'); t.textContent = tip; r.append(t); svg.append(r);
  };
  runs.forEach((run, i) => {
    const x = i * bw, total = run.high + run.medium + run.low;
    const tip = when(run.started_at) + ': ' + (total ? run.high + ' high, ' + run.medium + ' medium, ' + run.low + ' low' : txt(REVIEW_STATUS[run.status] || run.status));
    if (!total) { rect(x, h - 3, 3, run.status === 'ok' ? 'clean' : run.status === 'error' ? 'failed' : 'skip', tip); return; }
    let y = h;
    for (const k of ['low', 'medium', 'high']) {
      if (!run[k]) continue;
      const bh = Math.max(2, (run[k] / max) * (h - 4)); y -= bh; rect(x, y, bh, k, tip);
    }
  });
  return svg;
}

/** "skipped" / "failed" / "clean" / severity pills for one review. */
function reviewPills(r) {
  if (r.status === 'skipped') return [sevPill('zero', 'skipped')];
  if (r.status === 'error') return [sevPill('blocked', 'failed')];
  return countPills(r.high, r.medium, r.low);
}

function repoCards(repo, row) {
  const cw = repo.codewatch, open = row ? row.high + row.medium + row.low : cw.bySeverity.high + cw.bySeverity.medium + cw.bySeverity.low;
  const r30 = cw.reviews30d || { total: 0, skipped: 0 }, blocks = cw.gitleaksBlocks.length;
  return el('div', { class: 'cards' },
    scard('Open findings', el('div', { class: 'v' }, String(open)), detail('latest review of each branch')),
    scard('Reviews (${REVIEW_WINDOW_DAYS} days)', el('div', { class: 'v' }, String(r30.total)), detail(r30.skipped + ' skipped · ' + cw.totalRuns + ' results recorded')),
    scard('Secrets blocked', el('div', { class: 'v' + (blocks ? ' s-bad' : '') }, String(blocks)), detail('pre-commit gitleaks')),
    scard('Spend this month', el('div', { class: 'v' }, repo.spend ? money(repo.spend.cost, LAST.usage && LAST.usage.currency) : '-'),
      detail(repo.spend ? 'codeburn, ' + repo.spend.sessions + ' session' + (repo.spend.sessions === 1 ? '' : 's') : 'no codeburn project here')));
}

function repoChart(cw) {
  const runs = cw.scans.slice(0, REPO_CHART_RUNS).reverse();
  const s = el('section', { class: 'card' }, el('h2', {}, 'Findings over time', el('span', { class: 'sub' }, 'last ' + runs.length + ' pre-push review' + (runs.length === 1 ? '' : 's'))));
  if (!runs.length) { s.append(el('p', { class: 'empty' }, 'No pre-push reviews yet. Reviews run on git push.')); return s; }
  s.append(el('div', { class: 'chart' }, severityBars(runs, 640, 150, REPO_CHART_RUNS, 'findings per pre-push review, oldest first, stacked by severity')));
  s.append(el('div', { class: 'legend' }, sevPill('high', 'high'), sevPill('medium', 'medium'), sevPill('low', 'low'), sevPill('ok', 'clean'), sevPill('zero', 'skipped')));
  return s;
}

function repoReviews(cw) {
  const rows = cw.scans.slice(0, REPO_REVIEW_ROWS);
  // The payload carries at most SCANS_LOADED reviews; past that the total is not known here.
  const of = cw.scans.length < SCANS_LOADED ? ' of ' + cw.scans.length : '';
  const s = el('section', { class: 'card' }, el('h2', {}, 'Reviews', el('span', { class: 'sub' }, 'newest ' + rows.length + of)));
  if (!rows.length) { s.append(el('p', { class: 'empty' }, 'No reviews yet.')); return s; }
  s.append(table(['When', 'Branch', 'Result', { label: 'Reviewer', cls: 'hide-sm' }, ''], rows.map((r) => [
    el('span', { title: when(r.started_at) }, ago(r.started_at)),
    el('code', {}, txt(r.branch || '-').replace(/^refs\\/heads\\//, '')),
    el('span', { class: 'pills' }, ...reviewPills(r), r.reason ? el('span', { class: 'fix' }, txt(r.reason)) : null),
    el('td', { class: 'hide-sm' }, txt(r.tool) + (r.model ? ' · ' + r.model : '')),
    reportLink(r.id, 'Report'),
  ])));
  return s;
}

function repoCommits(cw) {
  if (!cw.commits || !cw.commits.rows.length) return null;
  return el('section', { class: 'card' }, el('h2', {}, 'Commits', el('span', { class: 'sub' }, 'secret scan and review per commit')), commitsList(cw.commits));
}

function repoSetup(repo) {
  const st = repo.setup || {}, s = el('section', { class: 'card' }, el('h2', {}, 'Setup'));
  const label = { ok: 'on', warn: 'bypassed', missing: 'off', 'opted-out': 'opted out' };
  s.append(kv([
    ['Codewatch', sevPill(st.status === 'ok' ? 'ok' : st.status === 'warn' ? 'medium' : 'zero', (label[st.status] || txt(st.status)) + (st.global ? ' (global)' : ''))],
    ['Reviewer', st.reviewer ? txt(st.reviewer) + (st.model ? ' · ' + st.model : '') : '-'],
    ['Hooks', txt(st.detail || '-')],
  ]));
  if (st.fix) s.append(el('div', { class: 'fix' }, 'Fix: ', el('code', {}, st.fix)));
  return s;
}

/** Security Agent: setup state, then this repo's cached code review and threat model, if any. */
function repoSecurity(repo) {
  const sec = repo.security || { status: 'missing' }, s = el('section', { class: 'card' }, el('h2', {}, 'Security Agent'));
  s.append(kv([['Status', sevPill(sec.status === 'missing' ? 'zero' : 'ok', sec.status === 'missing' ? 'not set up' : SEC_LABEL[sec.status] || sec.status)], sec.status === 'missing' ? null : ['Detail', txt(sec.detail || '-')]]));
  if (sec.fix) s.append(el('div', { class: 'fix' }, 'Set up: ', el('code', {}, sec.fix)));
  const all = LAST.security || {};
  const review = (all.repos || []).find((r) => r.path === repo.path);
  const tm = (all.threat_models || []).find((t) => t.path === repo.path);
  if (review) s.append(el('h3', {}, 'Code review'), el('div', { class: 'pills' }, ...riskPills(review.counts, RISKS, 'no findings')), el('div', { class: 'fix' }, review.pending ? 'started ' + when(review.started_at) : when(review.finished_at)));
  if (tm) s.append(el('h3', {}, 'Threat model'), el('div', { class: 'pills' }, ...riskPills(tm.counts, THREAT_LEVELS, 'no threats')), el('div', { class: 'fix' }, tm.pending ? 'started ' + when(tm.started_at) : when(tm.finished_at)));
  return s;
}

function repoFindings(cw) {
  if (!cw.findings.length) return null;
  const s = el('section', { class: 'card' }, el('h2', {}, 'Open findings', el('span', { class: 'sub' }, 'latest review of each branch')));
  const list = el('ul', { class: 'sec-findings' });
  for (const f of cw.findings.slice(0, REPO_FINDING_ROWS)) {
    list.append(el('li', {}, sevPill(f.severity, f.severity), ' ', el('code', {}, f.file + (f.line ? ':' + f.line : '')),
      el('div', { class: 'fix' }, txt(f.message)), el('div', { class: 'fix' }, txt(f.category) + ' · ' + txt(f.rule) + (f.branch ? ' · ' + f.branch : ''))));
  }
  s.append(list);
  const more = cw.findings.length - REPO_FINDING_ROWS;
  if (more > 0) s.append(el('p', { class: 'note' }, (cw.findingsTruncated ? 'more than ' : '') + more + ' more; run prism-cli codewatch report for all'));
  else if (cw.findingsTruncated) s.append(el('p', { class: 'note' }, 'list truncated; run prism-cli codewatch report for all'));
  return s;
}

/** Draws #repo/<id> from the last loaded payload. */
function renderRepo(id) {
  const root = document.getElementById('repo');
  const repo = LAST && (LAST.repos || []).find((r) => r.id === id);
  if (!repo) {
    root.replaceChildren(el('div', { class: 'crumbs' }, el('a', { href: '#' }, 'Dashboard'), ' / not found'),
      el('p', { class: 'empty' }, LAST ? 'No repo with this id in the current scan.' : 'Loading...'));
    return;
  }
  const row = (LAST.overview.codewatch || []).find((r) => r.id === id) || null;
  const cw = repo.codewatch;
  const head = el('div', { class: 'repo-head' }, el('h2', {}, labelOf(repo)), el('span', { class: 'muted' }, tildePath(repo.path)),
    row ? el('span', { class: 'pills' }, ...countPills(row.high, row.medium, row.low)) : null, repo.current ? el('span', { class: 'tag' }, 'this repo') : null);
  const left = [repoChart(cw), repoReviews(cw), repoCommits(cw)].filter(Boolean);
  const right = [repoSetup(repo), repoSecurity(repo), repoFindings(cw)].filter(Boolean);
  root.replaceChildren(el('div', { class: 'crumbs' }, el('a', { href: '#' }, 'Dashboard'), ' / ', labelOf(repo)), head,
    cw.hasResults ? repoCards(repo, row) : el('p', { class: 'empty' }, 'No codewatch results yet. Run ', el('code', {}, (repo.setup && repo.setup.fix) || 'prism-cli enable codewatch'), ', then commit and push.'),
    el('div', { class: 'grid2' }, el('div', {}, ...left), el('div', {}, ...right)));
}
`;
