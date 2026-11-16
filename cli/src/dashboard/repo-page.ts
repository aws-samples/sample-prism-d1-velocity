/**
 * The per-repo view (#repo/<id>), as a JS string concatenated into page.ts's
 * single document (same nonce, same el()/txt()/sevPill() helpers). Every
 * value from the payload is placed with textContent or an attribute.
 */

import { MAX_SCANS, REVIEW_WINDOW_DAYS } from './codewatch.js';

export const REPO_STYLE = `
.cwrev fieldset { border:1px solid var(--line); border-radius:8px; padding:8px 12px; margin:8px 0; min-width:0; }
.cwrev legend { font-size:12px; color:var(--muted); padding:0 4px; }
.cwrev label.opt { display:block; margin:3px 0; overflow-wrap:anywhere; }
.cwrev input[type=text], .cwrev select { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); max-width:100%; min-width:0; }
.cwrev input[type=text] { width:22ch; }
pre.diff span.add { color:var(--ok); } pre.diff span.del { color:var(--bad); }
`;

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
  const st = repo.setup || {}, s = el('section', { class: 'card' }, el('h2', {}, 'Repo settings'));
  const label = { ok: 'on', warn: 'bypassed', missing: 'off', 'opted-out': 'opted out' };
  s.append(kv([
    ['Codewatch', sevPill(st.status === 'ok' ? 'ok' : st.status === 'warn' ? 'medium' : 'zero', (label[st.status] || txt(st.status)) + (st.global ? ' (global)' : ''))],
    ['Hooks', txt(st.detail || '-')],
  ]));
  if (st.fix) s.append(el('div', { class: 'fix' }, 'Fix: ', el('code', {}, st.fix)));
  s.append(cwReviewerBlock(repo));
  return s;
}

/** GET /api/codewatch/reviewer answers per repo id, and the Change form's state (kept across the minute refresh). */
const CW_REV = new Map();
let CW_REV_LOADING = null;
let CW_EDIT = { id: null, open: false, scope: 'clone', reviewer: '', model: '', proposal: null, asked: '' };
const CW_SCOPES = [['clone', 'Override for this repo', 'just you: git config --local', null], ['default', 'Use my default', 'removes this repo\\'s override; set the default in Settings › Repos', null], ['team', 'Team default', '.prism/config.json, a repo file to commit; the CI eval gate reads it too', 'Reset the team default']];

/** An action finished (the drawer's poll): the settings may have changed, so read them again and close the form. */
function cwRevInvalidate() { CW_REV.clear(); CW_EDIT = { id: null, open: false }; }

async function cwRevLoad(id) {
  if (SNAPSHOT || CW_REV_LOADING === id) return;
  CW_REV_LOADING = id;
  let r;
  try { r = await api('/api/codewatch/reviewer?repo=' + id); } catch (e) { r = { ok: false, json: { error: e.message } }; }
  CW_REV_LOADING = null;
  CW_REV.set(id, r.ok ? r.json : { error: txt((r.json || {}).error) || 'could not read the reviewer settings' });
  if (repoRoute() === id) renderRepo(id);
}

/** Asks the server what the proposed change means: the team pin warning and, for the team scope, the file diff. Read-only. */
async function cwPropose(id) {
  const e = CW_EDIT;
  if (e.scope === 'default') { e.proposal = null; e.asked = ''; return; }
  const q = '&scope=' + encodeURIComponent(e.scope) + (e.reviewer ? '&reviewer=' + encodeURIComponent(e.reviewer) : '') + (e.model.trim() ? '&model=' + encodeURIComponent(e.model.trim()) : '');
  if (q === e.asked) return;
  e.asked = q;
  let r;
  try { r = await api('/api/codewatch/reviewer?repo=' + id + q); } catch (x) { r = { ok: false, json: { error: x.message } }; }
  if (CW_EDIT !== e || e.asked !== q) return;
  e.proposal = r.ok ? r.json.proposal || null : { error: txt((r.json || {}).error) };
  if (repoRoute() === id) renderRepo(id);
}

const CW_FROM = (d, k) => (d.labels && d.labels[k]) || k;

/** The reviewer and model a push uses here, where each comes from, and the Change form. */
function cwReviewerBlock(repo) {
  const box = el('div', { class: 'cwrev', 'data-cwrev': '' }, el('h3', {}, 'Reviewer and model'));
  if (SNAPSHOT) { const st = repo.setup || {}; box.append(el('p', { class: 'fix' }, st.reviewer ? txt(st.reviewer) + ' · ' + txt(st.model) : 'no reviewer')); return box; }
  const d = CW_REV.get(repo.id);
  if (!d) { cwRevLoad(repo.id); box.append(el('p', { class: 'loading' }, 'loading...')); return box; }
  if (d.error) { box.append(el('p', { class: 'fix' }, pill('error'), ' ', txt(d.error))); return box; }
  const v = d.view, tool = (id) => (d.tools || []).find((t) => t.id === id) || {};
  const inst = (id) => (tool(id).installed ? pill('ok', tool(id).binary + ' installed') : pill('missing', tool(id).binary + ' not installed'));
  box.append(kv([
    ['Reviewer', v.reviewer ? el('span', {}, el('b', {}, txt(tool(v.reviewer).name || v.reviewer)), ' ', inst(v.reviewer)) : el('span', { class: 's-missing' }, 'none installed')],
    ['From', txt(CW_FROM(d, v.reviewerFrom))],
    ['Model', el('span', {}, el('code', {}, txt(v.model)))],
    ['From', txt(CW_FROM(d, v.modelFrom))],
  ]));
  if (v.fallback) box.append(el('div', { class: 'callout warn', role: 'note', 'data-fallback': '' }, txt(v.wanted.id ? tool(v.wanted.id).name + ' was chosen (' + CW_FROM(d, v.wanted.from) + '), but ' : ''), txt(v.fallback), v.reviewer ? '. Pushes here use ' + txt(tool(v.reviewer).name) + ' instead.' : '. Pushes here run no review until one is installed.'));
  if (v.modelNote) box.append(el('p', { class: 'fix' }, 'Note: ' + txt(v.modelNote)));
  if (v.teamPin) box.append(el('p', { class: 'fix' }, 'The team pins model ' + txt(v.teamPin) + ' in ' + txt(d.teamFile) + ': it wins over personal model settings.'));
  const overridden = !!(v.clone.reviewer || Object.values(v.clone.models || {}).some(Boolean));
  box.append(el('p', { class: 'fix', 'data-cw-follow': overridden ? 'override' : 'default' }, overridden ? 'This repo overrides your default. ' : 'This repo follows your default. ',
    el('a', { href: '#settings/repos', class: 'rlink' }, 'Your default reviewer and model →')));
  const edit = CW_EDIT.id === repo.id ? CW_EDIT : null;
  if (!edit || !edit.open) {
    const b = el('button', { type: 'button', 'data-cw-change': '' }, 'Change');
    b.addEventListener('click', () => { CW_EDIT = { id: repo.id, open: true, scope: 'clone', reviewer: v.reviewer || v.wanted.id || 'kiro', model: '', proposal: null, asked: '' }; renderRepo(repo.id); cwPropose(repo.id); });
    const back = overridden ? runButton('codewatch-reviewer-clone-reset', { repo: repo.id, where: repo.path, label: 'Reset to my default' }) : null;
    box.append(el('div', { class: 'srow-ctl' }, b, back));
    return box;
  }
  box.append(cwForm(repo, d, edit));
  return box;
}

function cwForm(repo, d, e) {
  const v = d.view, form = el('div', { 'data-cw-form': '' });
  const redraw = () => { renderRepo(repo.id); cwPropose(repo.id); };
  const scopes = el('fieldset', {}, el('legend', {}, 'Who it applies to'), ...CW_SCOPES.map(([id, label, how]) => {
    const r = el('input', { type: 'radio', name: 'cw-scope', value: id, checked: e.scope === id ? '' : null });
    r.addEventListener('change', () => { e.scope = id; redraw(); });
    return el('label', { class: 'opt' }, r, ' ', el('b', {}, label), el('span', { class: 'fix' }, ' ' + how));
  }));
  const sel = el('select', { id: 'cw-reviewer', 'aria-label': 'Reviewer' }, ...(d.tools || []).map((t) => el('option', { value: t.id, selected: t.id === e.reviewer ? '' : null }, t.name + (t.installed ? '' : ' (not installed)'))));
  sel.addEventListener('change', () => { e.reviewer = sel.value; redraw(); });
  const t = (d.tools || []).find((x) => x.id === e.reviewer) || {};
  const list = el('datalist', { id: 'cw-models' }, el('option', { value: 'auto' }), ...(t.suggestions || []).map((m) => el('option', { value: m })));
  const model = el('input', { type: 'text', id: 'cw-model', list: 'cw-models', value: e.model, placeholder: 'auto (the tool\\'s default)', 'aria-label': 'Model', autocomplete: 'off', spellcheck: 'false' });
  const re = new RegExp(d.modelPattern);
  const bad = () => e.model.trim() !== '' && !re.test(e.model.trim());
  const msg = el('span', { class: 'fix', role: 'status' }, bad() ? 'A model id is letters, digits and . _ : / -, not starting with -.' : '');
  model.addEventListener('input', () => { e.model = model.value; msg.textContent = bad() ? 'A model id is letters, digits and . _ : / -, not starting with -.' : ''; });
  model.addEventListener('change', () => { e.model = model.value; renderRepo(repo.id); if (!bad()) cwPropose(repo.id); });
  form.append(scopes);
  if (e.scope !== 'default') form.append(el('div', { class: 'srow-ctl' }, el('label', { for: 'cw-reviewer' }, 'Reviewer'), sel),
    el('div', { class: 'srow-ctl' }, el('label', { for: 'cw-model' }, 'Model'), model, list, msg),
    el('p', { class: 'fix' }, (t.suggestions || []).length ? 'Suggestions are ' + t.name + '\\'s documented aliases; any model id works.' : t.name + ' has no model list that is sure to work offline, so type the id (empty or auto: its default).'));
  if (d.precedence) form.append(el('details', {}, el('summary', {}, 'Which setting wins'), el('p', { class: 'fix' }, 'Reviewer: ' + txt(d.precedence.reviewer)), el('p', { class: 'fix' }, 'Model: ' + txt(d.precedence.model))));
  if (e.scope === 'team') form.append(el('div', { class: 'callout warn', role: 'note' }, el('strong', {}, txt(d.teamFile) + ' is a repo file. '), 'Commit it to share the change; the CI eval gate reads it from the base branch too.'));
  const p = e.proposal;
  if (p && p.error) form.append(el('p', { class: 'fix' }, pill('error'), ' ', txt(p.error)));
  if (p && p.warning) {
    const toTeam = el('button', { type: 'button' }, 'Use the team default instead');
    toTeam.addEventListener('click', () => { e.scope = 'team'; redraw(); });
    form.append(el('div', { class: 'callout warn', role: 'note', 'data-pin-warning': '' }, txt(p.warning), el('div', { class: 'srow-ctl' }, toTeam)));
  }
  if (e.scope === 'team' && p && p.diff) form.append(el('p', { class: 'fix' }, 'This change to ' + txt(d.teamFile) + (p.created ? ' (a new file)' : '') + ':'), diffBlock(p.diff));
  // The command the server will run: the action's fixed argv plus the two checked values.
  const ids = { clone: 'codewatch-reviewer-clone', team: 'codewatch-reviewer-team', default: 'codewatch-reviewer-clone-reset' };
  const a = actionDef(ids[e.scope]), m = e.model.trim();
  const save = el('button', { type: 'button', class: 'run' + (a && a.confirm ? ' danger' : ''), 'data-cw-save': '', disabled: !a || bad() ? '' : null }, 'Save');
  save.addEventListener('click', () => {
    if (!a || bad()) return;
    if (e.scope === 'default') { confirmRun(a, { repo: repo.id, where: repo.path, command: 'cd ' + txt(tildePath(repo.path)) + ' && ' + a.command }); return; }
    // An empty model is the tool's default (auto). The reviewer is always sent, so the model is stored for the tool picked here.
    const body = { repo: repo.id, where: repo.path, reviewer: e.reviewer, model: m || 'auto' };
    body.command = 'cd ' + txt(tildePath(repo.path)) + ' && ' + a.command + (body.reviewer ? ' --reviewer ' + body.reviewer : '') + (body.model !== undefined ? ' --model ' + body.model : '');
    if (e.scope === 'team' && p && p.diff) body.diff = p.diff;
    confirmRun(a, body);
  });
  const cancel = el('button', { type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => { CW_EDIT = { id: null, open: false }; renderRepo(repo.id); });
  const ra = e.scope === 'team' ? actionDef('codewatch-reviewer-team-reset') : null;
  const reset = ra ? el('button', { type: 'button', 'data-cw-reset': '' }, (CW_SCOPES.find((s) => s[0] === e.scope) || [])[3]) : null;
  if (reset) reset.addEventListener('click', () => confirmRun(ra, { repo: repo.id, where: repo.path, command: 'cd ' + txt(tildePath(repo.path)) + ' && ' + ra.command }));
  form.append(el('div', { class: 'srow-ctl' }, save, cancel, reset));
  return form;
}

/** Security Agent: setup state, then this repo's cached code review and threat model, if any. */
function repoSecurity(repo) {
  const sec = repo.security || { status: 'missing' }, s = el('section', { class: 'card' }, el('h2', {}, 'Security Agent'));
  s.append(kv([['Status', sevPill(sec.status === 'missing' ? 'zero' : 'ok', sec.status === 'missing' ? 'not set up' : SEC_LABEL[sec.status] || sec.status)], sec.status === 'missing' ? null : ['Detail', txt(sec.detail || '-')]]));
  if (sec.fix) s.append(el('div', { class: 'fix' }, 'Set up: ', el('code', {}, sec.fix)));
  const all = LAST.security || {};
  const review = (all.repos || []).find((r) => r.path === repo.path);
  const tm = (all.threat_models || []).find((t) => t.path === repo.path);
  // resultPills: a pending job reads "running", never "no findings".
  if (review) s.append(el('h3', {}, 'Code review'), el('div', { class: 'pills' }, ...resultPills(review, RISKS, 'no findings')), el('div', { class: 'fix' }, review.pending ? 'started ' + when(review.started_at) : when(review.finished_at)), ...[runningNote(review, all.pending_hint)].filter(Boolean));
  if (tm) s.append(el('h3', {}, 'Threat model'), el('div', { class: 'pills' }, ...resultPills(tm, THREAT_LEVELS, 'no threats')), el('div', { class: 'fix' }, tm.pending ? 'started ' + when(tm.started_at) : when(tm.finished_at)));
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
  if (CW_EDIT.id && CW_EDIT.id !== id) CW_EDIT = { id: null, open: false };
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
    el('div', { class: 'grid2' }, el('div', {}, ...left), el('div', {}, ...right)), repoRunsCard(repo.id));
}
`;
