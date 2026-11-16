/**
 * The Settings view's shared parts (actions, confirm dialog, action drawer, the
 * machine, usage sync and AWS sections) and the theme toggle, as CSS and JS strings concatenated into
 * page.ts's single document (same nonce, same el()/txt()/pill() helpers).
 *
 * Every value from the server is placed with textContent or an attribute.
 * Run buttons only send an action id (plus a repo id or the collector URL);
 * the server maps the id to a fixed argv. Each Run shows the exact command in
 * a confirm dialog first. AWS-writing commands are Copy only here; the
 * Security Agent page (security-page.ts) runs its two upload actions.
 */

/**
 * Runs in <head> before first paint: applies a saved Light, Dark or System
 * choice so the page does not flash. The page starts as data-theme="dark", the default.
 */
export const THEME_BOOT = `(function(){try{var t=localStorage.getItem('prism-theme');if(t==='light'||t==='dark'||t==='system')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

/** The header toggle: Light, Dark (the default) or System (follows prefers-color-scheme). Saved in localStorage only. */
export const THEME_SCRIPT = `
const THEME_KEY = 'prism-theme';
function storedTheme() { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' || t === 'system' ? t : 'dark'; } catch (e) { return 'dark'; } }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  for (const b of document.querySelectorAll('[data-theme-set]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === t));
}
function setTheme(t) {
  const v = t === 'light' || t === 'system' ? t : 'dark';
  try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* storage off: applies for this page only */ }
  applyTheme(v);
}
for (const b of document.querySelectorAll('[data-theme-set]')) b.addEventListener('click', () => setTheme(b.getAttribute('data-theme-set')));
applyTheme(storedTheme());
`;

export const SETUP_STYLE = `
[hidden] { display:none !important; }
nav.tabs { display:flex; flex-wrap:wrap; gap:4px; margin-left:8px; }
@media (max-width: 640px) { nav.tabs { margin-left:0; } nav.tabs a { padding:5px 8px; } }
nav.tabs a { color:var(--muted); text-decoration:none; padding:6px 12px; border-radius:8px; font-weight:550; display:inline-flex; align-items:center; gap:6px; }
nav.tabs a[aria-current="page"] { color:var(--accent); background:var(--accent-soft); }
a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible, tr.click:focus-within { outline:2px solid var(--accent); outline-offset:1px; }
.theme { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.theme button { border:none; border-radius:0; background:var(--card); color:var(--muted); padding:4px 9px; }
.theme button[aria-pressed="true"] { background:var(--raised); color:var(--text); font-weight:600; }
#setup { display:grid; gap:0 18px; grid-template-columns:repeat(auto-fit, minmax(min(420px, 100%), 1fr)); align-items:start; } #setup > .wide { grid-column:1 / -1; }
.srow { padding:8px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; } .srow:first-of-type { border-top:none; }
.srow-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
.srow-ctl { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:6px; } .srow-ctl code { min-width:0; overflow-wrap:anywhere; } .srow-ctl select { max-width:100%; min-width:0; }
.cmdline { display:inline-flex; gap:6px; align-items:center; flex-wrap:wrap; max-width:100%; } .cmdline code { white-space:normal; overflow-wrap:anywhere; }
code.cmdw, pre.cmd.cmdw { overflow-wrap:normal; } .cmdw .w { white-space:nowrap; } .cmdw .w.long { white-space:normal; overflow-wrap:anywhere; }
.badge { font-size:11px; padding:0 6px; border-radius:999px; border:1px solid var(--line); color:var(--muted); background:var(--raised); white-space:nowrap; font-weight:600; }
.badge.warn { color:var(--warn); }
button.run { background:var(--accent); border-color:var(--accent); color:var(--bg); font-weight:600; }
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
let SETUP = null, POLL = null, DIALOG = null, URL_DRAFT = '';
const OUT = { status: el('div', { class: 'srow-head' }), pre: el('pre', { class: 'out', 'aria-live': 'polite' }) };
/** Action output: a drawer fixed to the bottom of the window, outside the redrawn Settings view, so a refresh keeps it. */
const DRAWER_CLOSE = el('button', { type: 'button' }, 'Close');
const ACTION_PANEL = el('div', { class: 'drawer', id: 'action-drawer', role: 'region', 'aria-label': 'Action output', hidden: '' },
  el('div', { class: 'drawer-head' }, el('b', {}, 'Action output'), OUT.status, el('span', { class: 'spacer' }), DRAWER_CLOSE), OUT.pre,
  el('p', { class: 'note' }, 'Secrets are masked. Each run is logged to ~/.prism/logs/dashboard-actions.log (time, action, repo, exit code).'));
DRAWER_CLOSE.addEventListener('click', () => { ACTION_PANEL.hidden = true; });
document.body.append(ACTION_PANEL);

/** GET, or POST JSON with the CSRF header. referrerPolicy same-origin so the browser sends this page's Origin. */
async function api(path, body) {
  // A static snapshot answers the two reads it embeds and refuses everything else; it never fetches.
  if (SNAPSHOT) {
    if (body === undefined && path === '/api/setup') return { ok: true, status: 200, json: SNAPSHOT.setup };
    if (body === undefined && path === '/api/action/status') return { ok: true, status: 200, json: { state: 'idle' } };
    return { ok: false, status: 0, json: { error: 'this is a static snapshot: nothing runs from it' } };
  }
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

/**
 * A command whose lines break only at its spaces, never inside a flag or a
 * name (a browser breaks after a hyphen otherwise: --repo -/-profile). Each
 * word is a nowrap span; a word over 20 characters may still break, so the
 * line never scrolls sideways. The text, selected or copied, is the command.
 */
function cmdWords(tag, cls, cmd) {
  const kids = [];
  txt(cmd).split(' ').forEach((w, i) => { if (i) kids.push(' '); kids.push(el('span', { class: w.length > 20 ? 'w long' : 'w' }, w)); });
  return el(tag, { class: (cls ? cls + ' ' : '') + 'cmdw' }, ...kids);
}

function copyButton(cmd) {
  const b = el('button', { type: 'button', title: 'Copy to the clipboard' }, 'Copy');
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cmd); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select the text to copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });
  return el('span', { class: 'cmdline' }, cmdWords('code', '', cmd), b);
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
  if (SNAPSHOT) {
    const cd = o.where && SETUP.repoCd && SETUP.repoCd[o.where];
    return copyOnly((cd ? cd + ' && ' : '') + a.command + (a.url ? ' <collector-url>' : ''), 'snapshot: copy only');
  }
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
  // o.command: the server's exact line (it appends --profile/--region itself); o.profile/o.region: aws-connect's picked names.
  const cmd = o.command || (a.command + (o.profile ? ' --profile ' + o.profile + ' --region ' + o.region : '') + (o.url ? ' ' + o.url : ''));
  const run = el('button', { type: 'button', class: 'run' + (a.confirm ? ' danger' : '') }, 'Run');
  const cancel = el('button', { type: 'button' }, 'Cancel');
  const kids = [el('h2', { id: 'confirm-title' }, a.label), el('p', {}, 'This will run:'), el('pre', { class: 'cmd' }, cmd),
    o.command ? null : el('p', { class: 'fix' }, 'in ' + txt(o.where || (a.inHome ? '~' : (SETUP && SETUP.cwd)) || '')),
    el('p', { class: 'note' }, a.readOnlyAws ? 'Read-only in AWS: describe, get and list calls only. Nothing in AWS is changed.'
      : a.installs ? 'Installs software from the npm registry on this machine. No AWS calls.' : a.note ? null : 'Changes setup on this machine only. No AWS calls.'),
    a.note ? el('p', { class: 'note' }, txt(a.note)) : null,
    el('p', { class: 'note' }, 'It runs without a terminal, so it cannot ask questions; it is stopped after ' + Math.max(1, Math.round(a.timeoutSec / 60)) + ' min.')];
  if (a.confirm) {
    const cb = el('input', { type: 'checkbox' });
    run.disabled = true;
    cb.addEventListener('change', () => { run.disabled = !cb.checked; });
    kids.push(el('label', { class: 'extra' }, cb, txt(a.confirmLabel || 'Yes, run it')));
  }
  kids.push(el('div', { class: 'actions' }, cancel, run));
  DIALOG.replaceChildren(...kids.filter(Boolean));
  cancel.addEventListener('click', () => DIALOG.close());
  run.addEventListener('click', () => { DIALOG.close(); startAction(a, o); });
  DIALOG.showModal();
  cancel.focus();
}

async function startAction(a, o) {
  const body = { action: a.id };
  if (a.repo) body.repo = o.repo;
  if (a.url) body.url = o.url;
  if (a.choose) { body.profile = o.profile; body.region = o.region; }
  if (a.confirm) body.confirm = true;
  ACTION_PANEL.hidden = false;
  OUT.status.replaceChildren(pill('warn', 'starting'), el('code', {}, a.command));
  OUT.pre.textContent = '';
  let r;
  try { r = await api('/api/action', body); } catch (e) { r = { ok: false, json: { error: e.message } }; }
  if (!r.ok) { OUT.status.replaceChildren(pill('error', 'refused'), txt(r.json.error)); return; }
  showStatus(r.json);
  poll();
}

function showStatus(s) {
  if (!s || s.state === 'idle') return;
  ACTION_PANEL.hidden = false;
  // outcome pending: the Security Agent job has no verdict yet (exit 2). That is not a failure, so it is not red.
  const pending = s.state === 'done' && s.outcome === 'pending';
  // outcome nothing: a branch code review found no changes against its base and started nothing. Neither red nor green.
  const nothing = s.state === 'done' && s.outcome === 'nothing';
  const p = s.state === 'running' ? pill('warn', 'running') : nothing ? pill('info', 'nothing to review') : s.exitCode === 0 ? pill('ok', 'exit 0')
    : pending ? pill('warn', 'still running (exit ' + s.exitCode + ')') : pill('error', s.timedOut ? 'timed out' : 'exit ' + s.exitCode);
  // replaceChildren would print a null as text: only nodes go in.
  OUT.status.replaceChildren(...[p, el('code', {}, txt(s.command)), el('span', { class: 'fix' }, (s.repo ? 'in ' + txt(s.repo) + ' · ' : '') + 'started ' + when(s.startedAt)),
    pending ? el('span', { class: 'fix', 'data-pending-hint': '' }, 'The job is still running in AWS; nothing failed. Check back later, or run the same command with --wait.') : null,
    nothing ? el('span', { class: 'fix', 'data-nothing-hint': '' }, 'No changes against the branch\\'s base, so no job was started and nothing was uploaded. Uncommitted changes are never reviewed.') : null,
    nothing && typeof saFullOffer === 'function' ? saFullOffer(s.repoId) : null,
    // A Security Agent action that saved a finished run: the server read its id from the result file.
    s.state === 'done' && typeof runDoneBar === 'function' ? runDoneBar(s.result) : null].filter(Boolean));
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
  s.append(el('p', { class: 'note' }, 'AWS credentials: see the AWS tab.'));
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
  s.append(srow(null, 'Team stack info', 'Reads the PRISM team stack outputs (collector URL, user pool). Read-only in AWS.', runButton('team-info', { label: 'Run team info' })));
  return s;
}

const STEP_PILL = { used: ['ok', 'used'], skipped: ['skipped', 'skipped'], 'not-set': ['info', 'not set'], 'n/a': ['skipped', 'n/a'] };
function kv(pairs) { return el('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])); }

/** An AWS account id as its last 4 digits; the full id is never put on the Settings page. */
const maskAccount = (a) => { const v = txt(a); return v.length > 4 ? '••••' + v.slice(-4) : v; };

/** Settings › AWS: the account the AWS commands default to (prism-cli aws connect), and what prism-cli would use. */
function awsSection(a) {
  const s = el('section', { class: 'card wide' }, el('h2', {}, 'AWS account', el('span', { class: 'sub' }, a.saved ? 'connected' : 'not connected')));
  const v = a.saved;
  if (v) {
    s.append(kv([['Profile', el('code', {}, txt(v.profile))], ['Region', txt(v.region)],
      ['Account', el('span', { title: 'last 4 digits' }, maskAccount(v.account), v.alias ? el('span', { class: 'tag' }, txt(v.alias)) : null)],
      ['Verified', el('span', {}, v.verifiedAt ? el('span', { title: when(v.verifiedAt) }, ago(v.verifiedAt)) : 'unknown', ' ', v.inUse ? pill('ok', 'in use') : pill('warn', 'not in use'))],
      ['Saved in', txt(v.path) + (v.scope === 'repo' ? ' (this repo only)' : ' (every repo; a repo\\'s own .prism/aws.local.json wins there)')]]));
    s.append(el('div', { class: 'srow-ctl' }, runButton('aws-connect-status', { label: 'Show status' }), runButton('aws-disconnect', { label: 'Disconnect' })));
  } else s.append(el('p', { class: 'empty' }, 'No account connected. AWS commands use the default credential chain until you connect one.'));
  const ch = a.choices || { profiles: [], regions: [] };
  const conn = el('section', { class: 'card wide' }, el('h2', {}, v ? 'Connect or re-verify' : 'Connect an account', el('span', { class: 'sub' }, 'prism-cli aws connect')));
  if (!ch.profiles.length) {
    conn.append(el('p', { class: 'empty' }, 'No AWS profiles in ' + txt((a.files || {}).config) + ' or ' + txt((a.files || {}).credentials) + '. Create one in a terminal, then reload: '), copyButton('aws configure sso'));
  } else {
    const prof = el('select', { class: 'pick', id: 'aws-profile', 'aria-label': 'Profile' });
    for (const p of ch.profiles) { const o = el('option', { value: p.name }, p.name + (p.region ? ' (' + p.region + ')' : '') + (p.from === 'credentials' ? ' · keys file' : '')); if (v && p.name === v.profile) o.setAttribute('selected', ''); prof.append(o); }
    const reg = el('select', { class: 'pick', id: 'aws-region', 'aria-label': 'Region' });
    const start = v ? v.region : (ch.profiles[0].region || 'us-east-1');
    for (const r of ch.regions) { const o = el('option', { value: r }, r); if (r === start) o.setAttribute('selected', ''); reg.append(o); }
    prof.value = v && ch.profiles.some((p) => p.name === v.profile) ? v.profile : ch.profiles[0].name;
    reg.value = ch.regions.includes(start) ? start : ch.regions[0];
    const act = actionDef('aws-connect');
    const go = el('button', { type: 'button', class: 'run', disabled: SNAPSHOT || !act || !act.available ? '' : null }, '');
    const label = () => { go.textContent = v && prof.value === v.profile && reg.value === v.region ? 'Re-verify' : v ? 'Connect instead' : 'Connect'; };
    prof.addEventListener('change', () => { const p = ch.profiles.find((x) => x.name === prof.value); if (p && p.region && ch.regions.includes(p.region)) reg.value = p.region; label(); });
    reg.addEventListener('change', label);
    label();
    go.addEventListener('click', () => { if (act) confirmRun(act, { profile: prof.value, region: reg.value }); });
    conn.append(el('div', { class: 'srow-ctl' }, el('label', { for: 'aws-profile' }, 'Profile'), prof, el('label', { for: 'aws-region' }, 'Region'), reg, go),
      el('p', { class: 'fix' }, 'Profiles are the section names in ' + txt((a.files || {}).config) + ' and ' + txt((a.files || {}).credentials) + '; only the names and a configured region are read, never a key or token. Connect checks the profile with STS (read-only) and saves the profile name, region, account and alias; it stores no credentials.'));
    if (SNAPSHOT) conn.append(el('p', { class: 'fix' }, 'Disabled in a static snapshot. Run prism-cli aws connect in a terminal instead.'));
  }
  const uses = el('section', { class: 'card wide' }, el('h2', {}, 'What prism-cli uses', el('span', { class: 'sub' }, 'from the environment and local files; no AWS call')));
  uses.append(el('div', { class: 'srow' }, el('div', {}, 'prism-cli would use ', el('b', {}, a.profile ? 'profile ' + txt(a.profile) : txt(a.source)), ' · ', el('span', { class: 'badge' }, txt(a.credentialLabel))),
    el('div', { class: 'fix' }, 'chosen by ' + txt(a.source) + ' · region ' + (a.region ? txt(a.region.value) + ' (' + txt(a.region.source) + ')' : 'not set'))));
  for (const w of a.warnings || []) uses.append(el('div', { class: 'callout warn', role: 'note' }, txt(w)));
  uses.append(el('h3', {}, 'Resolution order'), el('ol', { class: 'steps' }, (a.steps || []).map((st) => {
    const p = STEP_PILL[st.state] || ['skipped', st.state];
    return el('li', {}, el('b', {}, txt(st.label)), ' ', pill(p[0], p[1]), ' ', el('span', { class: 'fix' }, txt(st.detail)));
  })));
  const ptr = el('p', { class: 'callout', role: 'note' }, 'Account checks moved to ', el('a', { href: '#accountguard', class: 'rlink' }, 'AccountGuard →'),
    ' · Security Agent has ', el('a', { href: '#security', class: 'rlink' }, 'its own page →'), ' · Team stack info is under ', el('a', { href: '#settings/sync', class: 'rlink' }, 'Usage sync'), '.');
  return [s, conn, uses, ptr];
}

// A reload while an action runs picks its output back up.
api('/api/action/status').then((r) => { if (r.ok && r.json.state === 'running') { showStatus(r.json); poll(); } }).catch(() => {});
`;
