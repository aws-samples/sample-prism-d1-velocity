/**
 * The AccountGuard view (#accountguard): read-only checks of the AWS account
 * connected in Settings › AWS. A JS string concatenated into page.ts's single
 * document after setup-page.ts, whose helpers (api, copyButton, actionDef,
 * startAction, DIALOG) it uses.
 *
 * Loading it makes no AWS call: GET /api/accountguard reads the cached
 * `aws check` results and ranks them with aws recommend's own code. The two
 * Run buttons send only an action id; the server appends the connected
 * profile and region and runs from ~. Every value is placed with textContent
 * or an attribute.
 */

export const ACCOUNTGUARD_STYLE = `
.ag-tiles { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-bottom:18px; }
@media (max-width: 860px) { .ag-tiles { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width: 480px) { .ag-tiles { grid-template-columns:1fr; } }
.ag-tiles .tv { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:4px; } .ag-tiles .tv b { font-size:24px; font-weight:650; }
ul.checks > li.is-fail { border-left:3px solid var(--high); padding-left:10px; } ul.checks > li.is-ind { border-left:3px solid var(--line); padding-left:10px; }
.fixline { font-size:13px; margin-top:6px; overflow-wrap:anywhere; }
ul.steps2 { margin:6px 0; padding-left:18px; font-size:13px; } ul.steps2 li { margin:2px 0; overflow-wrap:anywhere; }
.ag-empty { text-align:center; padding:40px 20px; }
.aws-line { display:flex; gap:10px 14px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
`;

export const ACCOUNTGUARD_SCRIPT = `
/** The last GET /api/accountguard answer (null until loaded, or when the route is missing). */
let AG = null, AG_LOADED = false;
const agRoute = () => location.hash === '#accountguard';
const AG_CAUSE = {
  'access-denied': ['access denied', 'medium'],
  'prerequisite': ['waits on a fix', 'zero'],
  'no-credential-report': ['no credential report', 'zero'],
  'not-integrated': ['not integrated', 'zero'],
  'other': ['no answer', 'zero'],
};
const SEV_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

function agBadge() {
  const b = document.getElementById('accountguard-badge');
  if (!b) return;
  const n = (AG && AG.badge) || 0;
  b.textContent = n ? String(n) : '';
  b.setAttribute('title', n ? n + ' failing HIGH or CRITICAL check' + (n === 1 ? '' : 's') + ' in the latest aws check' : '');
  if (n) b.removeAttribute('hidden'); else b.setAttribute('hidden', '');
}

/** Confirm, then run: the dialog shows the server's exact line, Cancel has the focus. */
function agRun(id, label, ghost) {
  const a = actionDef(id);
  if (!a || !a.available || !AG || !AG.commands) return null;
  const cmd = id === 'accountguard-check' ? AG.commands.check : AG.commands.recommend;
  if (SNAPSHOT) return copyOnly(cmd, 'snapshot: copy only');
  const b = el('button', { type: 'button', class: ghost ? '' : 'run' }, label);
  b.addEventListener('click', () => confirmRun(a, { command: cmd }));
  return b;
}

const agCard = (title, sub, ...kids) => el('section', { class: 'card' }, el('h2', {}, title, sub ? el('span', { class: 'sub' }, sub) : null), ...kids);

function agTop() {
  const c = AG.connection, L = AG.latest;
  const card = agCard('AccountGuard', 'read-only checks of the AWS account connected in Settings › AWS',
    kv([['Account', el('span', {}, el('b', {}, txt(c.account4)), c.alias ? el('span', { class: 'tag' }, txt(c.alias)) : null)], ['Region', txt(c.region)],
      ['Profile', el('span', {}, el('code', {}, txt(c.profile)), el('span', { class: 'fix' }, ' · ' + txt(c.scope) + ' connection' + (c.verifiedAt ? ', verified ' + ago(c.verifiedAt) : '')))],
      ['Last check', L ? el('span', { title: when(L.started_at) }, when(L.started_at) + ' (' + ago(L.started_at) + ')') : el('span', { class: 'fix' }, 'never')]]),
    el('div', { class: 'srow-ctl' }, agRun('accountguard-check', L ? 'Run aws check again' : 'Run aws check'), L ? agRun('accountguard-recommend', 'Run aws recommend', true) : null,
      el('a', { href: '#settings/aws', class: 'rlink' }, 'Change the account in Settings › AWS →')));
  if (!L) return [card];
  const k = L.counts, f = L.fail_by_severity || {};
  const tile = (label, ...v) => el('div', { class: 'card score' }, el('span', { class: 'fix' }, label), el('div', { class: 'tv' }, ...v));
  const sev = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].filter((s) => f[s]).map((s) => sevPill(s, f[s] + ' ' + s.toLowerCase()));
  const d = AG.diff;
  return [card, el('div', { class: 'ag-tiles' },
    tile('Failing', el('b', {}, String(k.fail)), el('span', { class: 'pills' }, ...sev)),
    tile('Passing', el('b', {}, String(k.pass)), sevPill('ok', 'pass')),
    tile('Could not check', el('b', {}, String(k.indeterminate)), el('span', { class: 'fix' }, 'not a pass')),
    tile('Since the baseline', el('b', {}, d ? '+' + d.newFailures.length + ' / −' + d.fixed.length : '—'), el('span', { class: 'fix' }, d ? 'new failing / fixed' : 'the latest run is the baseline')))];
}

function agCheckRow(x, fixOf, accessOf, isNew) {
  const fail = x.status === 'FAIL', ind = x.status === 'INDETERMINATE';
  const cause = AG_CAUSE[x.cause] || AG_CAUSE.other;
  const status = fail ? sevPill(x.severity, txt(x.severity).toLowerCase()) : ind ? sevPill(cause[1], 'could not check') : sevPill('ok', 'pass');
  // aws check appends "Needs <action>." to every failed read; only an access-denied one is about IAM.
  const detail = ind && x.cause !== 'access-denied' ? txt(x.detail).replace(/ Needs [^.]+\\.$/, '') : txt(x.detail);
  const li = el('li', { class: fail ? 'is-fail' : ind ? 'is-ind' : 'is-pass' },
    el('div', { class: 'sa-head' }, el('b', {}, txt(x.title)), el('span', { class: 'pills' }, isNew ? sevPill('medium', 'new since baseline') : null, status)),
    el('div', { class: 'fix' }, detail));
  if (fail) {
    const r = fixOf.get(x.id);
    li.append(el('div', { class: 'fixline' }, el('b', {}, 'Fix: '), txt(x.remediation || (r && r.steps[0]) || ''), r ? el('span', { class: 'fix' }, ' · ranked fix ' + r.number) : null));
  }
  if (ind) { const a = accessOf.get(x.id); li.append(el('div', { class: 'fixline' }, sevPill(cause[1], cause[0]), ' ', txt(a ? a.steps[0] : 'Re-run prism-cli aws check.'))); }
  return li;
}

function agAreas() {
  const fixOf = new Map(), accessOf = new Map();
  for (const g of AG.recommendations) { for (const x of g.fixes) for (const c of x.covers) fixOf.set(c.id, x); for (const x of g.access) for (const c of x.covers) accessOf.set(c.id, x); }
  const isNew = new Set(((AG.diff && AG.diff.newFailures) || []).map((x) => x.id));
  const order = (x) => (x.status === 'FAIL' ? 0 : x.status === 'INDETERMINATE' ? 1 : 2);
  return AG.sections.map((s) => {
    const cs = AG.latest.checks.filter((x) => x.category === s.name).sort((a, b) => order(a) - order(b) || (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
    if (!cs.length) return null;
    const open = cs.filter((x) => x.status !== 'PASS'), passed = cs.filter((x) => x.status === 'PASS');
    const nf = cs.filter((x) => x.status === 'FAIL').length, ni = cs.filter((x) => x.status === 'INDETERMINATE').length;
    const row = (x) => agCheckRow(x, fixOf, accessOf, isNew.has(x.id));
    return agCard(txt(s.heading).replace(/ \\(.*\\)$/, ''), nf + ' failing · ' + passed.length + ' passing' + (ni ? ' · ' + ni + ' could not check' : ''),
      open.length ? el('ul', { class: 'salist checks' }, open.map(row)) : el('p', { class: 'empty' }, 'Nothing failing here.'),
      passed.length ? el('details', { 'data-key': 'ag:pass:' + s.name }, el('summary', { class: 'fix' }, passed.length + ' passing check' + (passed.length === 1 ? '' : 's')), el('ul', { class: 'salist checks' }, passed.map(row))) : null);
  }).filter(Boolean);
}

function agFixes() {
  const items = AG.recommendations.flatMap((g) => g.fixes).sort((a, b) => a.number - b.number);
  if (!items.length) return agCard('Ranked fixes', 'aws recommend', el('p', { class: 'empty' }, 'Nothing to fix: every check that ran passed.'));
  return agCard('Ranked fixes', 'aws recommend: severity first, then quick wins',
    el('ul', { class: 'salist' }, items.map((x) => el('li', {},
      el('div', { class: 'sa-head' }, el('b', {}, x.number + '. ' + txt(x.title)), el('span', { class: 'pills' }, sevPill(x.severity, txt(x.severity).toLowerCase()), sevPill('zero', txt(x.effort)))),
      el('div', { class: 'fix' }, txt(x.why)),
      x.covers.length > 1 ? el('div', { class: 'fix' }, 'Covers ' + x.covers.length + ' checks: ' + x.covers.map((c) => txt(c.title)).join('; ')) : null,
      el('ul', { class: 'steps2' }, x.steps.map((s) => el('li', {}, txt(s)))),
      x.command ? el('div', {}, copyButton(txt(x.command))) : null,
      /^https:\\/\\//.test(txt(x.doc)) ? el('div', {}, el('a', { href: x.doc, target: '_blank', rel: 'noopener noreferrer', class: 'rlink' }, 'Docs')) : null))),
    el('p', { class: 'fix' }, 'Each fix is a change you make in AWS yourself; AccountGuard never writes to the account.'));
}

async function agMark(run, btn) {
  btn.disabled = true;
  let r;
  try { r = await api('/api/accountguard/baseline', { run }); } catch (e) { r = { ok: false, json: { error: e.message } }; }
  if (!r.ok) { btn.disabled = false; btn.textContent = 'Could not save: ' + txt(r.json.error); return; }
  await renderAccountGuard();
}

function agChanges() {
  const d = AG.diff, L = AG.latest, b = AG.baseline;
  const line = (x, tag) => el('li', {}, el('div', { class: 'sa-head' }, el('b', {}, txt(x.title)), el('span', { class: 'pills' }, sevPill(x.severity, txt(x.severity).toLowerCase()), tag)));
  const mark = el('button', { type: 'button' }, 'Use the latest run as the baseline');
  mark.addEventListener('click', () => agMark(L.run, mark));
  if (SNAPSHOT) mark.disabled = true;
  return agCard('Since the baseline', 'baseline: ' + when(b.started_at) + ' (' + (b.how === 'marked' ? 'marked by you' : 'first run') + ')',
    !d ? el('p', { class: 'empty' }, 'The latest run is the baseline: nothing to compare yet. The next aws check is compared with it.')
      : el('div', {},
        el('h3', {}, 'New failures (' + d.newFailures.length + ')'), d.newFailures.length ? el('ul', { class: 'salist' }, d.newFailures.map((x) => line(x, sevPill('medium', 'was ' + txt(x.was).toLowerCase())))) : el('p', { class: 'empty' }, 'None.'),
        el('h3', {}, 'Fixed (' + d.fixed.length + ')'), d.fixed.length ? el('ul', { class: 'salist' }, d.fixed.map((x) => line(x, sevPill('ok', 'now pass')))) : el('p', { class: 'empty' }, 'None.'),
        d.noLongerChecked.length ? el('div', {}, el('h3', {}, 'No longer checked (' + d.noLongerChecked.length + ')'), el('ul', { class: 'salist' }, d.noLongerChecked.map((x) => line(x, sevPill('zero', 'could not check'))))) : null,
        el('p', { class: 'fix' }, d.stillFailing + ' check' + (d.stillFailing === 1 ? ' was' : 's were') + ' failing at the baseline and still ' + (d.stillFailing === 1 ? 'is' : 'are') + '.')),
    el('div', { class: 'srow-ctl' }, d ? mark : null, el('span', { class: 'fix' }, 'Saved on this machine only (~/.prism/accountguard.json); no AWS call.')));
}

function agRuns() {
  return el('details', { class: 'card', 'data-key': 'ag:runs' }, el('summary', {}, 'Runs for ' + txt(AG.connection.account4) + ' / ' + txt(AG.connection.region) + ' (' + AG.runs.length + ')'),
    el('ul', { class: 'salist' }, AG.runs.map((r) => {
      const b = el('button', { type: 'button', disabled: SNAPSHOT ? '' : null }, 'Use as baseline');
      b.addEventListener('click', () => agMark(r.run, b));
      return el('li', {}, el('div', { class: 'sa-head' }, el('span', {}, when(r.started_at)),
        el('span', { class: 'pills' }, sevPill('zero', r.counts.fail + ' fail'), sevPill('zero', r.counts.pass + ' pass'), r.run === AG.baseline.run ? sevPill('ok', 'baseline') : b)));
    })));
}

function agNever() {
  return agCard('No aws check yet', 'for ' + txt(AG.connection.account4) + ' / ' + txt(AG.connection.region),
    el('p', {}, 'Run aws check to get the account\\'s baseline. It checks:'),
    el('ul', { class: 'steps2' }, AG.sections.map((s) => el('li', {}, txt(s.heading)))),
    el('p', { class: 'fix' }, 'Read-only: every call is a describe, get or list, with the profile above. The first run becomes the baseline later runs are compared with.'),
    el('div', { class: 'srow-ctl' }, agRun('accountguard-check', 'Run aws check')));
}

/** Fetches GET /api/accountguard (no AWS call), then draws the page and the nav badge. Runs on every load, whatever the view. */
async function renderAccountGuard() {
  if (!SNAPSHOT) { try { const r = await api('/api/accountguard'); if (r.ok) AG = r.json; } catch (e) { /* keep the last good copy */ } }
  AG_LOADED = true;
  drawAccountGuard();
}

function drawAccountGuard() {
  agBadge();
  const root = document.getElementById('accountguard');
  if (!root) return;
  const openState = new Map([...root.querySelectorAll('details[data-key]')].map((d) => [d.getAttribute('data-key'), d.open]));
  root.replaceChildren(el('h2', { class: 'sr-only' }, 'AccountGuard'));
  if (SNAPSHOT) { root.append(el('section', { class: 'card' }, el('p', { class: 'empty' }, 'AccountGuard runs on the live dashboard only (prism-cli dashboard). The latest aws check summary is on the Dashboard.'))); return; }
  if (!AG_LOADED) { root.append(el('p', { class: 'loading' }, 'loading...')); return; }
  if (!AG) { root.append(el('section', { class: 'card' }, pill('error'), ' could not load the AccountGuard data')); return; }
  if (!AG.connection) {
    root.append(el('section', { class: 'card ag-empty' }, el('h2', {}, 'Connect an AWS account in Settings › AWS'),
      el('p', {}, 'AccountGuard checks the account saved by prism-cli aws connect. No account is connected on this machine.'),
      el('div', { class: 'srow-ctl' }, el('a', { href: '#settings/aws', class: 'rlink' }, 'Open Settings › AWS →'))));
    return;
  }
  for (const x of agTop()) root.append(x);
  if (!AG.latest) { root.append(agNever()); return; }
  root.append(el('div', { class: 'sa-grid' }, el('div', { class: 'sa-col' }, ...agAreas()), el('div', { class: 'sa-col' }, agFixes(), agChanges(), agRuns())));
  for (const d of root.querySelectorAll('details[data-key]')) { const k = d.getAttribute('data-key'); if (openState.has(k)) d.open = openState.get(k); }
}
`;
