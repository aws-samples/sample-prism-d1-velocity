/**
 * The Setup view and the theme toggle, as CSS and JS strings concatenated into
 * page.ts's single document (same nonce, same el()/txt()/pill() helpers).
 *
 * Every value from the server is placed with textContent or an attribute.
 * Run buttons only send an action id (plus a repo id or the collector URL);
 * the server maps the id to a fixed argv. Each Run shows the exact command in
 * a confirm dialog first. AWS-writing commands are Copy only.
 */

/** Runs in <head> before first paint: applies a saved Light/Dark choice so the page does not flash. */
export const THEME_BOOT = `(function(){try{var t=localStorage.getItem('prism-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

/** The header toggle: Light, Dark or System (no data-theme; follows prefers-color-scheme). Saved in localStorage only. */
export const THEME_SCRIPT = `
const THEME_KEY = 'prism-theme';
function storedTheme() { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch (e) { return 'system'; } }
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
  for (const b of document.querySelectorAll('[data-theme-set]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === t));
}
function setTheme(t) {
  const v = t === 'light' || t === 'dark' ? t : 'system';
  try { if (v === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v); } catch (e) { /* storage off: applies for this page only */ }
  applyTheme(v);
}
for (const b of document.querySelectorAll('[data-theme-set]')) b.addEventListener('click', () => setTheme(b.getAttribute('data-theme-set')));
applyTheme(storedTheme());
`;

export const SETUP_STYLE = `
[hidden] { display:none !important; }
nav.tabs { display:flex; gap:4px; }
nav.tabs a { color:var(--muted); text-decoration:none; padding:4px 10px; border-radius:6px; border:1px solid transparent; }
nav.tabs a[aria-current="page"] { color:var(--text); background:var(--bg); border-color:var(--line); font-weight:600; }
a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.theme { display:inline-flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; }
.theme button { border:none; border-radius:0; background:var(--card); color:var(--muted); padding:4px 9px; }
.theme button[aria-pressed="true"] { background:var(--bg); color:var(--text); font-weight:600; }
.srow { padding:8px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; } .srow:first-of-type { border-top:none; }
.srow-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
.srow-ctl { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px; }
.cmdline { display:inline-flex; gap:6px; align-items:center; flex-wrap:wrap; max-width:100%; } .cmdline code { white-space:normal; overflow-wrap:anywhere; }
.badge { font-size:11px; padding:0 6px; border-radius:8px; border:1px solid var(--line); color:var(--muted); background:var(--raised); white-space:nowrap; }
button.run { background:var(--accent); border-color:var(--accent); color:var(--card); font-weight:600; }
button.run.danger { background:var(--card); border-color:var(--bad); color:var(--bad); }
button:disabled { opacity:.55; cursor:not-allowed; }
input.url { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); min-width:min(320px,100%); flex:1; }
input.url::placeholder { color:var(--muted); }
.msg { color:var(--bad); font-size:12px; }
ol.steps { margin:4px 0; padding-left:20px; } ol.steps li { padding:3px 0; overflow-wrap:anywhere; }
dl.kv { display:grid; grid-template-columns:8em minmax(0,1fr); gap:2px 10px; font-size:13px; margin:6px 0; overflow-wrap:anywhere; } dl.kv dt { color:var(--muted); } dl.kv dd { margin:0; }
details.copies > summary { cursor:pointer; color:var(--muted); font-size:12px; padding:4px 0; } details.copies > div { padding:3px 0; }
dialog.confirm { background:var(--card); color:var(--text); border:1px solid var(--line); border-radius:10px; padding:16px 18px; width:min(640px, 92vw); box-shadow:0 10px 30px rgb(0 0 0 / .35); }
dialog.confirm::backdrop { background:rgb(0 0 0 / .5); }
dialog.confirm h2 { margin-bottom:6px; } dialog.confirm p { margin:6px 0; }
dialog.confirm .actions { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
pre.cmd, pre.out { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:8px 10px; white-space:pre-wrap; overflow-wrap:anywhere; margin:6px 0; }
pre.out { max-height:420px; overflow:auto; }
label.extra { display:flex; gap:6px; align-items:flex-start; margin-top:10px; color:var(--bad); font-weight:600; }
`;

export const SETUP_SCRIPT = `
const CSRF = (document.querySelector('meta[name="prism-csrf"]') || {}).content || '';
let SETUP = null, POLL = null, DIALOG = null, CHECK = null, URL_DRAFT = '';
const OUT = { status: el('div', { class: 'srow-head' }), pre: el('pre', { class: 'out', 'aria-live': 'polite' }) };
const ACTION_PANEL = el('section', { class: 'card wide', hidden: '' }, el('h2', {}, 'Action output'), OUT.status, OUT.pre,
  el('p', { class: 'note' }, 'Secrets are masked. Each run is logged to ~/.prism/logs/dashboard-actions.log (time, action, repo, exit code).'));

function currentView() { return location.hash === '#setup' ? 'setup' : 'dashboard'; }
function showView() {
  const v = currentView();
  document.getElementById('main').hidden = v !== 'dashboard';
  document.getElementById('setup').hidden = v !== 'setup';
  for (const a of document.querySelectorAll('[data-view]')) {
    if (a.getAttribute('data-view') === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange', showView);
showView();

/** GET, or POST JSON with the CSRF header. referrerPolicy same-origin so the browser sends this page's Origin. */
async function api(path, body) {
  const init = body === undefined ? { credentials: 'same-origin', cache: 'no-store' } : {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Prism-CSRF': CSRF }, body: JSON.stringify(body),
  };
  const res = await fetch(path, init);
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { ok: res.ok, status: res.status, json: json || { error: 'HTTP ' + res.status } };
}

function ago(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return 'unknown';
  const s = Math.max(0, (Date.now() - t) / 1000);
  for (const [n, w] of [[86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
    if (s >= n) { const k = Math.floor(s / n); return k + ' ' + w + (k === 1 ? '' : 's') + ' ago'; }
  }
  return 'just now';
}

function copyButton(cmd) {
  const b = el('button', { type: 'button', title: 'Copy to the clipboard' }, 'Copy');
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cmd); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select the text to copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  return el('span', { class: 'cmdline' }, el('code', {}, cmd), b);
}
const copyOnly = (cmd, why) => el('div', { class: 'srow-ctl' }, copyButton(cmd), why ? el('span', { class: 'badge' }, why) : null);

/** Client-side copy of the server's collector URL rule; the server checks again. */
function urlProblem(s) {
  if (!s) return 'enter the collector URL';
  if (s.length > 2048) return 'the URL is longer than 2048 characters';
  let u;
  try { u = new URL(s); } catch (e) { return 'not a valid URL'; }
  if (u.protocol !== 'https:') return 'the URL must use https';
  if (!u.hostname) return 'the URL has no hostname';
  if (u.username || u.password) return 'the URL must not contain a user name or password';
  return null;
}

const actionDef = (id) => SETUP && (SETUP.actions || []).find((a) => a.id === id);

/** A Run button for an allowlisted action; null when the action is not available here. */
function runButton(id, o) {
  const a = actionDef(id);
  if (!a || !a.available) return null;
  o = o || {};
  const b = el('button', { type: 'button', class: 'run' + (a.confirm ? ' danger' : '') }, o.label || 'Run');
  b.addEventListener('click', () => {
    let url;
    if (a.url) {
      url = o.urlInput ? o.urlInput.value : '';
      const p = urlProblem(url);
      if (p) { if (o.msg) o.msg.textContent = p; return; }
      if (o.msg) o.msg.textContent = '';
    }
    confirmRun(a, { repo: o.repo, where: o.where, url });
  });
  return b;
}

function confirmRun(a, o) {
  if (!DIALOG) { DIALOG = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' }); document.body.append(DIALOG); }
  const cmd = a.command + (o.url ? ' ' + o.url : '');
  const run = el('button', { type: 'button', class: 'run' + (a.confirm ? ' danger' : '') }, 'Run');
  const cancel = el('button', { type: 'button' }, 'Cancel');
  const kids = [el('h2', { id: 'confirm-title' }, a.label), el('p', {}, 'This will run:'), el('pre', { class: 'cmd' }, cmd),
    el('p', { class: 'fix' }, 'in ' + txt(o.where || (SETUP && SETUP.cwd) || '')),
    el('p', { class: 'note' }, a.readOnlyAws ? 'Read-only in AWS: describe, get and list calls only. Nothing in AWS is changed.' : 'Changes setup on this machine only. No AWS calls.'),
    el('p', { class: 'note' }, 'It runs without a terminal, so it cannot ask questions; it is stopped after ' + Math.max(1, Math.round(a.timeoutSec / 60)) + ' min.')];
  if (a.confirm) {
    const cb = el('input', { type: 'checkbox' });
    run.disabled = true;
    cb.addEventListener('change', () => { run.disabled = !cb.checked; });
    kids.push(el('label', { class: 'extra' }, cb, 'Yes, remove the scheduled codeburn sync push from this machine'));
  }
  kids.push(el('div', { class: 'actions' }, cancel, run));
  DIALOG.replaceChildren(...kids);
  cancel.addEventListener('click', () => DIALOG.close());
  run.addEventListener('click', () => { DIALOG.close(); startAction(a, o); });
  DIALOG.showModal();
  cancel.focus();
}

async function startAction(a, o) {
  const body = { action: a.id };
  if (a.repo) body.repo = o.repo;
  if (a.url) body.url = o.url;
  if (a.confirm) body.confirm = true;
  ACTION_PANEL.hidden = false;
  OUT.status.replaceChildren(pill('warn', 'starting'), el('code', {}, a.command));
  OUT.pre.textContent = '';
  let r;
  try { r = await api('/api/action', body); } catch (e) { r = { ok: false, json: { error: e.message } }; }
  if (!r.ok) { OUT.status.replaceChildren(pill('error', 'refused'), txt(r.json.error)); return; }
  showStatus(r.json);
  ACTION_PANEL.scrollIntoView({ block: 'nearest' });
  poll();
}

function showStatus(s) {
  if (!s || s.state === 'idle') return;
  ACTION_PANEL.hidden = false;
  const p = s.state === 'running' ? pill('warn', 'running') : s.exitCode === 0 ? pill('ok', 'exit 0') : pill('error', s.timedOut ? 'timed out' : 'exit ' + s.exitCode);
  OUT.status.replaceChildren(p, el('code', {}, txt(s.command)), el('span', { class: 'fix' }, (s.repo ? 'in ' + txt(s.repo) + ' · ' : '') + 'started ' + when(s.startedAt)));
  OUT.pre.textContent = txt(s.output) || (s.state === 'running' ? '(no output yet)' : '(no output)');
  OUT.pre.scrollTop = OUT.pre.scrollHeight;
}

function poll() {
  clearTimeout(POLL);
  POLL = setTimeout(async () => {
    try {
      const r = await api('/api/action/status');
      if (r.ok) showStatus(r.json);
      if (r.ok && r.json.state !== 'running') { load(); return; }
    } catch (e) { /* retry */ }
    poll();
  }, 1000);
}

function srow(status, label, detail, ...ctl) {
  const c = ctl.filter(Boolean);
  return el('div', { class: 'srow' }, el('div', { class: 'srow-head' }, status, el('b', {}, label)),
    detail ? el('div', { class: 'fix' }, detail) : null, c.length ? el('div', { class: 'srow-ctl' }, c) : null);
}

function machineSection(data) {
  const s = el('section', { class: 'card' }, el('h2', {}, 'This machine'));
  for (const i of data.machine.setup) {
    if (i.id === 'codeburn-sync' || i.id === 'aws-credentials') continue;
    let ctl = null;
    if (i.id === 'codewatch-global' && i.status !== 'ok') {
      const elsewhere = (data.machine.globalHooks || {}).state === 'elsewhere';
      ctl = elsewhere ? copyOnly('prism-cli enable codewatch --global --force', 'replaces another global hooks path')
        : runButton('codewatch-global', { label: 'Enable for every repo' });
    } else if (i.fix) {
      ctl = copyOnly(i.fix, i.id === 'gitleaks' ? 'installs software' : i.id === 'codeburn' ? 'asks before installing' : null);
    }
    s.append(srow(pill(i.status), i.label, i.detail, ctl));
  }
  s.append(el('p', { class: 'note' }, 'AWS credentials: see the AWS section.'));
  return s;
}

const CW_PILL = { ok: 'ok', warn: 'warn', missing: 'missing', 'opted-out': 'skipped' };
function reposSection(data) {
  const s = el('section', { class: 'card wide' }, el('h2', {}, 'Repos'));
  const recheck = el('button', { type: 'button' }, 'Re-check status');
  recheck.addEventListener('click', async () => { recheck.disabled = true; try { await api('/api/recheck'); } catch (e) { /* load() reports */ } await load(); });
  s.append(el('div', { class: 'srow-ctl' }, recheck, el('span', { class: 'fix' }, 'Codewatch hooks and Security Agent setup per repo, from local files.')));
  const ids = SETUP.repoIds || {}, cds = SETUP.repoCd || {}, cp = SETUP.copy || {};
  const rowOf = (r) => {
    const cw = el('div', {}, pill(CW_PILL[r.status] || 'missing', r.status === 'opted-out' ? 'opted out' : r.status + (r.status === 'ok' && r.global ? ' (global)' : '')), ' ',
      el('span', { class: 'fix' }, r.status === 'ok' ? 'reviewer ' + txt(r.reviewer || 'none') : txt(r.detail)));
    if ((r.status === 'missing' || r.status === 'warn') && ids[r.path]) cw.append(el('div', { class: 'srow-ctl' }, runButton('codewatch-repo', { repo: ids[r.path], where: r.path, label: 'Enable codewatch' })));
    const sec = r.security || { status: 'missing' };
    const sc = el('div', {}, pill(sec.status === 'missing' ? 'missing' : 'ok', sec.status === 'in-use' ? 'in use' : sec.status));
    const cd = cds[r.path] ? cds[r.path] + ' && ' : '';
    if (sec.status === 'missing') sc.append(copyOnly(sec.fix || cd + cp.enableSecurity, 'AWS'));
    else sc.append(el('details', { class: 'copies' }, el('summary', {}, 'Security Agent commands (AWS, copy only)'),
      [cp.codeReview, cp.threatModel, cp.pentest].map((c) => el('div', {}, copyButton(cd + c)))));
    return [repoName(r), cw, sc];
  };
  const rows = data.overview.setup || [];
  const shown = rows.filter((r) => !r.collapsed), hidden = rows.filter((r) => r.collapsed);
  if (shown.length) s.append(table(['Repo', 'Codewatch', 'Security Agent'], shown.map(rowOf)));
  else if (!hidden.length) s.append(el('p', { class: 'empty' }, 'No git repositories found under ' + txt(data.scope.root_display) + '.'));
  if (hidden.length) s.append(el('details', { class: 'missing-group', 'data-key': 'setup-view:other' },
    el('summary', {}, hidden.length + ' other repo' + (hidden.length === 1 ? '' : 's') + ': not set up'), table(['Repo', 'Codewatch', 'Security Agent'], hidden.map(rowOf))));
  return s;
}

function syncSection(data) {
  const s = el('section', { class: 'card' }, el('h2', {}, 'Usage sync (codeburn)'));
  const item = data.machine.setup.find((i) => i.id === 'codeburn-sync');
  const mode = (data.machine.codeburnSync || {}).mode || 'local';
  if (item) s.append(srow(pill(item.status), item.label, item.detail));
  if (item && item.help) s.append(helpBlock(item.help));
  s.append(el('p', { class: 'fix' }, 'Sync mode: ' + mode));
  s.append(srow(null, 'Local only', 'codeburn usage stays on this machine; no endpoint and no schedule.', runButton('codeburn-local', { label: 'Keep usage local' })));
  const input = el('input', { type: 'url', class: 'url', placeholder: 'collector URL (https, from your platform team)', maxlength: '2048', 'aria-label': 'Collector URL', spellcheck: 'false', autocomplete: 'off' });
  input.value = URL_DRAFT;
  input.addEventListener('input', () => { URL_DRAFT = input.value; });
  const msg = el('span', { class: 'msg', role: 'status' });
  s.append(srow(null, "Sync to my team's PRISM", 'Sets up codeburn sync for the collector URL and schedules the push. codeburn opens a browser to sign in.',
    input, runButton('codeburn-team', { label: 'Sync to team', urlInput: input, msg }), msg));
  if (actionDef('codeburn-systemd') && actionDef('codeburn-systemd').available) {
    s.append(srow(null, 'Use a systemd user timer', mode === 'team' ? 'Schedules the sync push with a systemd user timer; your crontab is not touched.' : 'Team mode only: set up sync to your team first.',
      mode === 'team' ? runButton('codeburn-systemd', { label: 'Use systemd timer' }) : null));
  }
  s.append(srow(null, 'Remove the sync schedule', 'Removes the scheduled sync push (cron entry or systemd timer). codeburn and its sync config stay.', runButton('codeburn-remove', { label: 'Remove schedule' })));
  s.append(srow(null, 'Status', 'codeburn, sync and schedule status.', runButton('codeburn-status', { label: 'Show status' })));
  s.append(srow(null, 'Platform team: add a developer', 'Creates a telemetry account in AWS (Cognito), so it is copy only.', copyOnly((SETUP.copy || {}).addDeveloper, 'AWS write')));
  return s;
}

const STEP_PILL = { used: ['ok', 'used'], skipped: ['skipped', 'skipped'], 'not-set': ['info', 'not set'], 'n/a': ['skipped', 'n/a'] };
function kv(pairs) { return el('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])); }

function checkResult(r) {
  if (!r) return null;
  if (!r.ok) return el('div', {}, pill('error', 'refused'), ' ', txt(r.json.error));
  const j = r.json;
  if (j.ok) {
    const m = j.matches === true ? pill('ok', 'matches the saved account') : j.matches === false ? pill('error', 'does not match saved account ' + txt(j.savedAccount)) : pill('info', 'no saved account');
    return el('div', {}, pill('ok', 'credentials work'), kv([['Account', txt(j.account)], ['Caller', txt(j.arn)], ['Region', txt(j.region || 'not set')], ['Saved', m]]), el('p', { class: 'note' }, txt(j.note)));
  }
  return el('div', {}, pill('error', j.expired ? 'expired or invalid' : 'check failed'), ' ', el('span', {}, txt(j.error)),
    el('div', { class: 'help' }, 'Fixes:', el('ul', { class: 'help-steps' }, (j.fixes || []).map((f) => el('li', {}, /^(aws|prism-cli) /.test(f) ? copyButton(f) : txt(f))))));
}

function awsSection(a) {
  const s = el('section', { class: 'card wide' }, el('h2', {}, 'AWS'));
  s.append(el('p', { class: 'note' }, 'From the environment and local config files only: no AWS call until you press Check now. Only setting names are read from ~/.aws; secret values are never read or shown.'));
  s.append(el('div', { class: 'srow' }, el('div', {}, 'prism-cli would use ', el('b', {}, a.profile ? 'profile ' + txt(a.profile) : txt(a.source)), ' · ', el('span', { class: 'badge' }, txt(a.credentialLabel))),
    el('div', { class: 'fix' }, 'chosen by ' + txt(a.source) + ' · region ' + (a.region ? txt(a.region.value) + ' (' + txt(a.region.source) + ')' : 'not set'))));
  for (const w of a.warnings || []) s.append(el('div', { class: 'callout warn', role: 'note' }, txt(w)));
  s.append(el('h3', {}, 'Resolution order'), el('ol', { class: 'steps' }, (a.steps || []).map((st) => {
    const p = STEP_PILL[st.state] || ['skipped', st.state];
    return el('li', {}, el('b', {}, txt(st.label)), ' ', pill(p[0], p[1]), ' ', el('span', { class: 'fix' }, txt(st.detail)));
  })));
  s.append(el('h3', {}, 'Saved aws connect'));
  if (a.saved) {
    const v = a.saved;
    s.append(kv([['Account', el('span', {}, txt(v.account), v.alias ? el('span', { class: 'tag' }, txt(v.alias)) : null)], ['Profile', txt(v.profile) + (v.inUse ? '' : ' (not in use)')],
      ['Region', txt(v.region)], ['Verified', v.verifiedAt ? el('span', { title: when(v.verifiedAt) }, ago(v.verifiedAt)) : 'unknown'], ['File', txt(v.path) + ' (' + v.scope + ')'],
      ['Admin / org', 'not stored by aws connect (it prints them when it runs)']]));
  } else s.append(el('p', { class: 'empty-line' }, 'None saved. ', copyButton((SETUP.copy || {}).awsConnect)));
  const btn = el('button', { type: 'button', class: 'run' }, 'Check now');
  const out = el('div', { 'aria-live': 'polite' }, checkResult(CHECK));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    out.replaceChildren(el('span', { class: 'fix' }, 'checking...'));
    try { CHECK = await api('/api/check-now', {}); } catch (e) { CHECK = { ok: false, json: { error: e.message } }; }
    out.replaceChildren(checkResult(CHECK));
    btn.disabled = false;
    if (CHECK.ok && CHECK.json.updated) load();
  });
  s.append(el('h3', {}, 'Check now'), el('div', { class: 'srow-ctl' }, btn, el('span', { class: 'fix' }, 'One read-only call: aws sts get-caller-identity, as aws connect does it.')), out);
  s.append(el('h3', {}, 'Read-only AWS commands'),
    srow(null, 'Account check', 'Every call is a describe, get or list; the result is saved to .prism/results/.', runButton('aws-check', { label: 'Run aws check' })),
    srow(null, 'Team stack info', 'Reads the PRISM stack outputs (collector URL, user pool).', runButton('team-info', { label: 'Run team info' })));
  const cp = SETUP.copy || {};
  s.append(el('h3', {}, 'Copy only (writes to AWS or needs a terminal)'),
    srow(null, 'Choose and save the AWS profile', 'Asks questions on a terminal.', copyOnly(cp.awsConnect, 'terminal')),
    srow(null, 'Set up the Security Agent in a repo', 'Creates AWS resources.', copyOnly(cp.enableSecurity, 'AWS write')),
    srow(null, 'Add a developer telemetry account', 'Creates a Cognito user.', copyOnly(cp.addDeveloper, 'AWS write')),
    srow(null, 'Security Agent runs', 'Uploads code and starts AWS jobs.', copyOnly(cp.codeReview, 'AWS write'), copyOnly(cp.threatModel, 'AWS write'), copyOnly(cp.pentest, 'AWS write')));
  return s;
}

async function renderSetup(data) {
  try { const r = await api('/api/setup'); if (r.ok) SETUP = r.json; } catch (e) { /* keep the last good copy */ }
  const root = document.getElementById('setup');
  const openState = new Map([...root.querySelectorAll('details[data-key]')].map((d) => [d.getAttribute('data-key'), d.open]));
  root.replaceChildren();
  if (!SETUP) { root.append(el('section', { class: 'card wide' }, pill('error'), ' could not load the setup data')); return; }
  root.append(machineSection(data), syncSection(data), reposSection(data), awsSection(SETUP.aws || {}), ACTION_PANEL);
  for (const d of root.querySelectorAll('details[data-key]')) { const k = d.getAttribute('data-key'); if (openState.has(k)) d.open = openState.get(k); }
}
// A reload while an action runs picks its output back up.
api('/api/action/status').then((r) => { if (r.ok && r.json.state === 'running') { showStatus(r.json); poll(); } }).catch(() => {});
`;
