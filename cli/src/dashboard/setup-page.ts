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
/** No saved choice: the theme the document starts with (dark on the browser page; the editor's or Kiro Crew's in an embedding host). */
const THEME_DEFAULT = ((t) => (t === 'light' || t === 'system' ? t : 'dark'))(document.documentElement.getAttribute('data-theme'));
function storedTheme() { try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' || t === 'system' ? t : THEME_DEFAULT; } catch (e) { return THEME_DEFAULT; } }
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
.signin { padding:4px 0; overflow-wrap:anywhere; } .signin p { margin:4px 0; }
label.extra { display:flex; gap:6px; align-items:flex-start; margin-top:10px; color:var(--bad); font-weight:600; }
`;

export const SETUP_SCRIPT = `
const CSRF = (document.querySelector('meta[name="prism-csrf"]') || {}).content || '';
let SETUP = null, POLL = null, DIALOG = null, URL_DRAFT = '';
const OUT = { status: el('div', { class: 'srow-head' }), pre: el('pre', { class: 'out', 'aria-live': 'polite' }),
  /** The codeburn sign-in (link, Copy link, paste the return address): drawn once per sign-in, so the 1 s poll keeps what was typed. */
  signIn: el('div', { class: 'signin', 'data-signin': '', hidden: '' }), signInKey: '' };
/** Action output: a drawer fixed to the bottom of the window, outside the redrawn Settings view, so a refresh keeps it. */
const DRAWER_CLOSE = el('button', { type: 'button' }, 'Close');
const ACTION_PANEL = el('div', { class: 'drawer', id: 'action-drawer', role: 'region', 'aria-label': 'Action output', hidden: '' },
  el('div', { class: 'drawer-head' }, el('b', {}, 'Action output'), OUT.status, el('span', { class: 'spacer' }), DRAWER_CLOSE), OUT.signIn, OUT.pre,
  el('p', { class: 'note' }, 'Secrets are masked. Each run is logged to ~/.prism/logs/dashboard-actions.log (time, action, repo, exit code).'));
DRAWER_CLOSE.addEventListener('click', () => { ACTION_PANEL.hidden = true; });
document.body.append(ACTION_PANEL);

/**
 * The Transport every read and action goes through: get(path, query) and act(path, body), each
 * resolving to { ok, status, json }. The browser page uses this one: a same-origin GET, or a POST
 * of JSON with the CSRF header (referrerPolicy same-origin so the browser sends this page's Origin).
 * A host with no server (the VS Code webview, the Kiro Crew app page) sets window.PRISM_TRANSPORT
 * from bridge.js before this script runs; it relays the same { path, query, body } to the same
 * handlers through prism-cli dashboard --serve-stdio. There reports is false and openReport(id) asks the host
 * to show the report (from GET /api/report), since the embedded page has no /report/<id> page to link to.
 */
async function fetchAnswer(res) {
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { ok: res.ok, status: res.status, json: json || { error: 'HTTP ' + res.status } };
}
const BROWSER_TRANSPORT = {
  kind: 'browser', reports: true,
  get: async (path, query) => {
    const q = new URLSearchParams(query || {}).toString();
    return fetchAnswer(await fetch(path + (q ? '?' + q : ''), { credentials: 'same-origin', cache: 'no-store' }));
  },
  act: async (path, body) => fetchAnswer(await fetch(path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Prism-CSRF': CSRF }, body: JSON.stringify(body),
  })),
};
const TRANSPORT = window.PRISM_TRANSPORT || BROWSER_TRANSPORT;
/** True in a host with no server (VS Code, Kiro Crew): the page must never navigate its own frame. */
const EMBEDDED = TRANSPORT !== BROWSER_TRANSPORT;

/**
 * Every in-app navigation goes through here: it only ever changes the fragment of this document.
 * In a srcdoc iframe the document's base URL is its PARENT's, so a plain href="#x" resolves to
 * <gateway>/apps/prism#x and following it loads that page into the sandboxed frame (white). Setting
 * location.hash keeps the frame on its own document in every host.
 */
function navigate(hash) {
  location.hash = txt(hash).replace(/^#?/, '#');
}
/**
 * One capture-phase handler for every link click, so no link reaches the browser's default
 * navigation with a relative fragment. A plain click on an in-app link (href starting with #) is
 * routed through navigate(). In the browser a modifier or middle click keeps its default (a new
 * tab of the same dashboard). In an embedded host it is kept in this frame, and any other link
 * that would load into this frame (no target=_blank) is refused: the frame never leaves its document.
 * Links that handle their own click (data-own-click, the report buttons) are left to their handler.
 */
function routeLinkClick(e) {
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || a.hasAttribute('data-own-click')) return;
  const href = a.getAttribute('href') || '';
  const plain = e.type === 'click' && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  if (href.startsWith('#')) {
    if (!plain && !EMBEDDED) return;
    e.preventDefault();
    navigate(href);
    return;
  }
  // An external link opens outside the frame (target=_blank); anything else would replace the frame's document.
  if (EMBEDDED && a.getAttribute('target') !== '_blank') e.preventDefault();
}
document.addEventListener('click', routeLinkClick, true);
document.addEventListener('auxclick', routeLinkClick, true);

/** GET, or an action (POST) when there is a body. The path may carry its query string; it is split off for the transport. */
async function api(path, body) {
  // A static snapshot answers the two reads it embeds and refuses everything else; it never fetches.
  if (SNAPSHOT) {
    if (body === undefined && path === '/api/setup') return { ok: true, status: 200, json: SNAPSHOT.setup };
    if (body === undefined && path === '/api/action/status') return { ok: true, status: 200, json: { state: 'idle' } };
    return { ok: false, status: 0, json: { error: 'this is a static snapshot: nothing runs from it' } };
  }
  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  const query = q < 0 ? {} : Object.fromEntries(new URLSearchParams(path.slice(q + 1)));
  return body === undefined ? TRANSPORT.get(pathname, query) : TRANSPORT.act(pathname, body);
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
    if (o.open) o.open(url); else confirmRun(a, { repo: o.repo, where: o.where, url });
  });
  return b;
}

/** Client-side copy of the CLI's syncUrlKey (utils/otel-sync-schedule.ts): one key for two spellings of a collector URL. */
function syncUrlKey(s) {
  try { const u = new URL(s); return u.origin + u.pathname.replace(/[/]+$/, '') + u.search; } catch (e) { return null; }
}

/** Client-side copies of SECRET_QUERY_KEY and redactUrl (utils/redact.ts): a URL as the page shows it. */
const SECRET_QUERY_KEY = /token|key|secret|sig|signature|password|auth|code/i;
function redactUrl(s) {
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  const q = [...u.searchParams].map(([k, v]) => encodeURIComponent(k) + '=' + (SECRET_QUERY_KEY.test(k) ? 'REDACTED' : encodeURIComponent(v)));
  return u.origin + (u.pathname === '/' ? '' : u.pathname) + (q.length ? '?' + q.join('&') : '');
}

/** Re-run sync setup for the URL codeburn stores: the server appends it (codeburn-team-rerun); the page only names it, redacted. */
function rerunSync() {
  const cur = SETUP && SETUP.codeburnSyncUrl, a = actionDef('codeburn-team-rerun');
  if (!cur || !a) return;
  confirmRun(a, { shownUrl: cur, title: 'Re-run sync setup for ' + cur, runLabel: 'Re-run sync setup',
    lead: ['codeburn already syncs to ' + cur + '. This runs its sync setup again for the same URL, so you sign in again.'] });
}

/**
 * Sync to team. With no sync URL on this machine: codeburn-team, as before. Over one: a dialog naming the
 * current URL and the new one, then codeburn-team-yes (--yes), because the run has no terminal to answer
 * enable codeburn's question; the same URL is the re-run. The page has the stored URL only redacted, so a typed
 * URL with a secret-looking query value is never taken for it: that one is a switch, and enable codeburn
 * compares the real URLs. An unparseable URL is never the same as another.
 */
function teamSync(url) {
  const cur = SETUP && SETUP.codeburnSyncUrl;
  const again = actionDef('codeburn-team-yes');
  if (!cur || !again || !again.available) { confirmRun(actionDef('codeburn-team'), { url }); return; }
  const shown = redactUrl(url) || url;
  const k = syncUrlKey(cur);
  if (k !== null && k === syncUrlKey(shown) && ![...new URL(url).searchParams.keys()].some((x) => SECRET_QUERY_KEY.test(x))) { rerunSync(); return; }
  confirmRun(again, { url, shownUrl: shown, title: 'Switch to ' + shown, runLabel: 'Switch', lead: ['codeburn syncs to ' + cur + ' now.', 'After this it syncs to ' + shown + ' instead.'] });
}

function confirmRun(a, o) {
  if (!DIALOG) { DIALOG = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' }); document.body.append(DIALOG); }
  // o.command: the server's exact line (it appends --profile/--region itself); o.profile/o.region: aws-connect's picked names.
  // o.shownUrl: the URL as the dialog shows it (redacted); o.url is still what the request sends.
  const cmd = o.command || (a.command + (o.profile ? ' --profile ' + o.profile + ' --region ' + o.region : '') + ((o.shownUrl || o.url) ? ' ' + (o.shownUrl || o.url) : ''));
  const run = el('button', { type: 'button', class: 'run' + (a.confirm ? ' danger' : '') }, o.runLabel || 'Run');
  const cancel = el('button', { type: 'button' }, 'Cancel');
  // o.title / o.lead: a heading and lines naming what this run changes (Sync to team names both URLs).
  const kids = [el('h2', { id: 'confirm-title' }, txt(o.title || a.label)), ...(o.lead || []).map((t) => el('p', { 'data-confirm-lead': '' }, txt(t))), el('p', {}, 'This will run:'), el('pre', { class: 'cmd' }, cmd),
    o.command ? null : el('p', { class: 'fix' }, 'in ' + txt(o.where || (a.inHome ? '~' : (SETUP && SETUP.cwd)) || '')),
    el('p', { class: 'note' }, a.readOnlyAws ? 'Read-only in AWS: describe, get and list calls only. Nothing in AWS is changed.'
      : a.installs ? 'Installs software from the npm registry on this machine. No AWS calls.' : a.note ? null : 'Changes setup on this machine only. No AWS calls.'),
    a.note ? el('p', { class: 'note' }, txt(a.note)) : null,
    // o.diff: the file change the run makes (the repo page's team default), as - and + lines.
    o.diff ? diffBlock(o.diff) : null,
    // o.list: what the run changes, named (the Apply to all repos dialog lists the repos).
    o.list ? el('p', {}, 'It changes these repos:') : null,
    o.list ? el('ul', { 'data-confirm-list': '' }, ...o.list.map((x) => el('li', {}, txt(x)))) : null,
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

/** A small line diff ([' x', '-y', '+z']) as a pre with one span per line, marked by class. */
function diffBlock(lines) {
  return el('pre', { class: 'cmd diff', 'data-diff': '' }, ...lines.map((l) => el('span', { class: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : null }, txt(l) + '\\n')));
}

async function startAction(a, o) {
  const body = { action: a.id };
  if (a.repo) body.repo = o.repo;
  if (a.url) body.url = o.url;
  if (a.choose) { body.profile = o.profile; body.region = o.region; }
  if (a.pick) { if (o.reviewer) body.reviewer = o.reviewer; if (o.model !== undefined) body.model = o.model; }
  // A pentest action: the picker's checked choice (the server checks it again), or the run to clean up.
  if (a.pentest === 'choice' && o.target) { body.dockerfile = o.target.dockerfile; body.app_dir = o.target.appDir; body.port = o.target.port; body.health_path = o.target.healthPath; }
  if (a.pentest === 'run') body.run = o.run;
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
  // outcome detached (Start pentest, 1.21.7): the deploy runs in its own process; the run's page follows it.
  const detached = s.state === 'done' && s.outcome === 'detached';
  const p = s.state === 'running' ? pill('warn', 'running') : detached ? pill('ok', 'Bootstrapping started') : nothing ? pill('info', 'nothing to review') : s.exitCode === 0 ? pill('ok', 'exit 0')
    : pending ? pill('warn', 'still running (exit ' + s.exitCode + ')') : pill('error', s.timedOut ? 'timed out' : 'exit ' + s.exitCode);
  // replaceChildren would print a null as text: only nodes go in.
  OUT.status.replaceChildren(...[p, el('code', {}, txt(s.command)), el('span', { class: 'fix' }, (s.repo ? 'in ' + txt(s.repo) + ' · ' : '') + 'started ' + when(s.startedAt)),
    pending ? el('span', { class: 'fix', 'data-pending-hint': '' }, 'The job is still running in AWS; nothing failed. Check back later, or run the same command with --wait.') : null,
    nothing ? el('span', { class: 'fix', 'data-nothing-hint': '' }, 'No changes against the branch\\'s base, so no job was started and nothing was uploaded. Uncommitted changes are never reviewed.') : null,
    nothing && typeof saFullOffer === 'function' ? saFullOffer(s.repoId) : null,
    // A Security Agent action that saved a finished run: the server read its id from the result file.
    s.state === 'done' && typeof runDoneBar === 'function' ? runDoneBar(s.result) : null].filter(Boolean));
  showSignIn(s.state === 'running' && s.signIn ? s.signIn : null, s.runId);
  OUT.pre.textContent = txt(s.output) || (s.state === 'running' ? '(no output yet)' : '(no output)');
  OUT.pre.scrollTop = OUT.pre.scrollHeight;
}

/** The sign-in block under the drawer's head while codeburn waits; redrawn only when the sign-in changes. */
function showSignIn(si, runId) {
  const key = si ? txt(runId) + ' ' + txt(si.url) : '';
  if (key === OUT.signInKey) return;
  OUT.signInKey = key;
  OUT.signIn.replaceChildren(...(si ? signInHint(si) : []));
  OUT.signIn.hidden = !si;
}

/**
 * codeburn sync setup is waiting for a sign-in: its link (the server checked it is https), Copy link, and, when the
 * browser is on another machine, a field for the address it ended on (127.0.0.1:<port>/callback?...), which
 * the server hands to codeburn's listener (POST /api/action/sign-in-return, checked there). The ssh -L forward stays
 * as the other way. In an embedded host (Kiro Crew) the frame cannot open a window, so the link asks the host to
 * open it (TRANSPORT.openExternal; the host opens only the sign-in URL the server reported).
 */
function signInHint(si) {
  const port = si.callbackPort;
  const link = el('a', { href: si.url, target: '_blank', rel: 'noopener noreferrer', class: 'rlink' }, 'Open the codeburn sign-in page');
  if (EMBEDDED && typeof TRANSPORT.openExternal === 'function') {
    link.setAttribute('data-own-click', '');
    link.addEventListener('click', (e) => { e.preventDefault(); TRANSPORT.openExternal(si.url); });
  }
  const shown = el('input', { type: 'text', class: 'url', readonly: '', value: si.url, 'aria-label': 'codeburn sign-in link', hidden: '', spellcheck: 'false' });
  const copy = el('button', { type: 'button', title: 'Copy the sign-in link' }, 'Copy link');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(si.url); copy.textContent = 'Copied'; }
    catch (e) { shown.hidden = false; shown.focus(); shown.select(); copy.textContent = 'Select the link to copy'; }
    setTimeout(() => { copy.textContent = 'Copy link'; }, 1500);
  });
  const parts = [el('div', { class: 'srow-ctl' }, el('span', { class: 'fix' }, 'No browser opened?'), link, copy), el('div', { class: 'srow-ctl' }, shown)];
  if (port) {
    const input = el('input', { type: 'url', class: 'url', placeholder: '127.0.0.1:' + port + '/callback?code=…', maxlength: '4096', 'aria-label': 'The address your browser ended on', spellcheck: 'false', autocomplete: 'off' });
    const submit = el('button', { type: 'button', class: 'run' }, 'Submit');
    const msg = el('span', { class: 'fix', role: 'status', 'data-signin-msg': '' });
    submit.addEventListener('click', async () => {
      const url = input.value.trim();
      if (!url) { msg.textContent = 'Paste the address first.'; return; }
      submit.disabled = true; msg.textContent = 'Sending it to codeburn…';
      let r;
      try { r = await api('/api/action/sign-in-return', { url }); } catch (e) { r = { ok: false, json: { error: e.message } }; }
      submit.disabled = false;
      msg.textContent = txt(r.ok ? r.json.message : r.json.error || r.json.message);
      if (r.ok) input.value = '';
    });
    parts.push(el('p', { class: 'fix' }, 'Browser on another machine? After you sign in it ends on a page at 127.0.0.1:' + port + ' that does not load. Paste the address your browser ended on:'),
      el('div', { class: 'srow-ctl' }, input, submit), msg,
      el('p', { class: 'fix' }, 'Or forward port ' + port + ' before you sign in (ssh -L ' + port + ':127.0.0.1:' + port + ' <this machine>): the sign-in returns to 127.0.0.1:' + port + ' on this machine.'));
  }
  parts.push(el('p', { class: 'fix' }, 'codeburn waits 5 min for it.'));
  return parts;
}

function poll() {
  clearTimeout(POLL);
  POLL = setTimeout(async () => {
    try {
      const r = await api('/api/action/status');
      if (r.ok) showStatus(r.json);
      if (r.ok && r.json.state !== 'running') { if (typeof cwRevInvalidate === 'function') cwRevInvalidate(); if (typeof cwDefaultsInvalidate === 'function') cwDefaultsInvalidate(); load(); return; }
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
  const cur = SETUP && SETUP.codeburnSyncUrl;
  if (cur) s.append(srow(null, 'Current collector', cur, runButton('codeburn-team-rerun', { label: 'Re-run sync setup', open: rerunSync })));
  s.append(srow(null, "Sync to my team's PRISM", 'Sets up codeburn sync for the collector URL and schedules the push. codeburn opens a browser to sign in.' + (cur ? ' Asks first, naming both URLs, before it replaces the current one.' : ''),
    input, runButton('codeburn-team', { label: 'Sync to team', urlInput: input, msg, open: teamSync }), msg));
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
