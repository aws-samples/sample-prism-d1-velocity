/**
 * The Settings view (#settings/<tab>): vertical section tabs with a count
 * badge or a green dot each, an Overview with scores and a "Needs you" list,
 * and one pane per area. A JS string concatenated into page.ts's single
 * document after setup-page.ts, whose helpers (runButton, copyOnly, srow,
 * machineSection, syncSection, awsSection, api) it uses.
 *
 * Every value from the server is placed with textContent or an attribute.
 * Run buttons send only an action id (see actions.ts) and show the exact
 * command in the confirm dialog first.
 */
import { PLUGIN_UPDATE, UPDATE_CMD } from './needs-you.js';

export const SETTINGS_STYLE = `
.setup-layout { display:grid; grid-template-columns:200px minmax(0,1fr); gap:22px; align-items:start; }
nav.stabs { display:flex; flex-direction:column; gap:2px; position:sticky; top:16px; }
nav.stabs a { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; border-radius:8px; color:var(--muted); font-weight:550; border-left:3px solid transparent; }
nav.stabs a:hover { background:var(--raised); text-decoration:none; }
nav.stabs a[aria-selected="true"] { background:var(--accent-soft); color:var(--text); border-left-color:var(--accent); }
.okdot { width:8px; height:8px; border-radius:50%; background:var(--ok); display:inline-block; flex:none; }
.scores { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin-bottom:18px; }
.score b { font-size:24px; font-weight:650; display:block; }
ul.todo { list-style:none; margin:0; padding:0; } ul.todo li { padding:10px 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; } ul.todo li:last-child { border-bottom:0; }
ul.todo .go { float:right; font-size:12px; margin-left:12px; }
.stabs-ctl { padding:12px 12px 0; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.drawer { position:fixed; left:0; right:0; bottom:0; z-index:5; background:var(--card); border-top:2px solid var(--accent); box-shadow:0 -8px 24px rgb(0 0 0 / .35); max-height:45vh; display:flex; flex-direction:column; padding:0 24px 10px; }
.drawer-head { display:flex; gap:12px; align-items:center; flex-wrap:wrap; padding:10px 0; border-bottom:1px solid var(--line); }
.drawer pre.out { flex:1; max-height:none; overflow:auto; }
body:has(.drawer:not([hidden])) .wrap { padding-bottom:48vh; }
@media (max-width: 860px) {
  .setup-layout { grid-template-columns:minmax(0,1fr); }
  nav.stabs { flex-direction:row; overflow-x:auto; position:static; }
  nav.stabs a { border-left:0; border-bottom:3px solid transparent; white-space:nowrap; border-radius:8px 8px 0 0; }
  nav.stabs a[aria-selected="true"] { border-bottom-color:var(--accent); }
  .scores { grid-template-columns:1fr; }
}
`;

export const SETTINGS_SCRIPT = `
/** The Settings tabs, in order: id and label. */
const SETTINGS_TABS = [['overview', 'Overview'], ['machine', 'This machine'], ['repos', 'Repos'], ['agents', 'Agent hooks'], ['sync', 'Usage sync'], ['aws', 'AWS'], ['updates', 'Updates']];
const tabLabel = (id) => (SETTINGS_TABS.find(([t]) => t === id) || [id, id])[1];

/** #repo/<16 hex>. */
function repoRoute() { const m = /^#repo\\/([0-9a-f]{16})$/.exec(location.hash); return m ? m[1] : null; }
/** #settings or #settings/<tab>; #setup and #setup/<tab> stay as aliases for old links. An unknown tab is the Overview. */
function settingsRoute() {
  const m = /^#(?:settings|setup)(?:\\/([a-z]+))?$/.exec(location.hash);
  if (!m) return null;
  return SETTINGS_TABS.some(([t]) => t === m[1]) ? m[1] : 'overview';
}
function currentView() { return settingsRoute() ? 'settings' : securityRoute() ? 'security' : agRoute() ? 'accountguard' : repoRoute() ? 'repo' : 'dashboard'; }
function showView() {
  const v = currentView();
  document.getElementById('main').hidden = v !== 'dashboard';
  document.getElementById('repo').hidden = v !== 'repo';
  document.getElementById('settings').hidden = v !== 'settings';
  const sec = document.getElementById('security');
  if (sec) sec.hidden = v !== 'security';
  const ag = document.getElementById('accountguard');
  if (ag) ag.hidden = v !== 'accountguard';
  // Leaving a run's page drops its cached copy (security-runs-page.ts), so coming back reads it again.
  if (v !== 'security' && typeof runLeave === 'function') runLeave();
  if (v === 'repo') renderRepo(repoRoute());
  if (v === 'security') drawSecurity();
  if (v === 'accountguard') drawAccountGuard();
  if (v === 'settings') selectTab(settingsRoute());
  for (const a of document.querySelectorAll('[data-view]')) {
    if (a.getAttribute('data-view') === (v === 'repo' ? 'dashboard' : v)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
}
window.addEventListener('hashchange', showView);
showView();

/** Shows one pane and marks its tab; the others stay in the DOM, hidden. */
function selectTab(id) {
  for (const a of document.querySelectorAll('[data-tab]')) a.setAttribute('aria-selected', String(a.getAttribute('data-tab') === id));
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.getAttribute('data-pane') !== id;
}

const PLUGIN_UPDATE = ${JSON.stringify(PLUGIN_UPDATE)};
const machineRow = (data, id) => (data.machine.setup || []).find((i) => i.id === id) || null;

/** Everything that needs the person, built once on the server (needs-you.ts); the card, the badges and the Needs you list read it. */
const needsYou = (data) => data.needsYou || [];

/** A fix: a Copy button when it is one plain command, else its text (some fixes are instructions). */
const fixLine = (f) => /^[a-z][\\w-]* [^();]*$/.test(txt(f)) ? el('div', {}, copyButton(f)) : el('div', { class: 'fix' }, 'Fix: ' + txt(f));
const countBadge = (n) => n ? el('span', { class: 'badge warn' }, String(n)) : el('span', { class: 'okdot', title: 'all good' });
const section = (title, sub, ...kids) => el('section', { class: 'card' }, el('h2', {}, title, sub ? el('span', { class: 'sub' }, sub) : null), ...kids);

function overviewPane(data, items) {
  const checks = (data.machine.setup || []).filter((i) => i.status !== 'info');
  const c = data.overview.counts, rows = (data.agentHooks || { rows: [] }).rows;
  const score = (v, label) => el('div', { class: 'card score' }, el('b', {}, v), el('span', { class: 'fix' }, label));
  const list = el('ul', { class: 'todo' }, items.map((it) => el('li', {}, el('a', { class: 'go', href: '#settings/' + it.tab }, 'Open ' + tabLabel(it.tab) + ' →'),
    sevPill('medium', tabLabel(it.tab)), ' ', it.text, it.fixes.map(fixLine))));
  return [el('div', { class: 'scores' },
    score(checks.filter((i) => i.status === 'ok').length + '/' + checks.length, 'machine checks pass'),
    score(c.codewatch + '/' + c.repos, 'repos have codewatch'),
    score(String(rows.filter((r) => r.state === 'installed').length), 'agent hook installs')),
  section('Needs you', items.length ? items.length + ' item' + (items.length === 1 ? '' : 's') : 'nothing', items.length ? list : el('p', { class: 'empty' }, 'Everything is set up.'))];
}

const CW_PILL = { ok: 'ok', warn: 'warn', missing: 'missing', 'opted-out': 'skipped' };
function repoRowCells(r) {
  const ids = SETUP.repoIds || {}, cp = SETUP.copy || {};
  const cw = el('div', {}, pill(CW_PILL[r.status] || 'missing', r.status === 'opted-out' ? 'opted out' : r.status + (r.status === 'ok' && r.global ? ' (global)' : '')), ' ',
    el('span', { class: 'fix' }, r.status === 'ok' ? 'reviewer ' + txt(r.reviewer || 'none') + (r.reviewer && r.model ? ', model ' + txt(r.model) : '') : txt(r.detail)));
  // The reviewer and model are changed on the repo page (one place); link there.
  if (ids[r.path]) cw.append(el('div', {}, el('a', { href: '#repo/' + ids[r.path], class: 'rlink', 'data-cw-link': '' }, 'Change reviewer or model →')));
  if ((r.status === 'missing' || r.status === 'warn') && ids[r.path]) cw.append(el('div', { class: 'srow-ctl' }, runButton('codewatch-repo', { repo: ids[r.path], where: r.path, label: 'Enable codewatch' })));
  const sec = r.security || { status: 'missing' };
  const sc = el('div', {}, pill(sec.status === 'missing' ? 'missing' : 'ok', sec.status === 'in-use' ? 'in use' : sec.source === 'machine' ? 'machine setup' : sec.source === 'repo' ? 'repo override' : sec.status));
  // enable security is once per machine, from any directory: no cd.
  if (sec.status === 'missing') sc.append(copyOnly(sec.fix || cp.enableSecurity, 'AWS'));
  if (ids[r.path]) sc.append(el('div', {}, el('a', { href: '#security/' + ids[r.path], class: 'rlink' }, 'Open in Security Agent →')));
  return [repoName(r), cw, sc];
}

/** GET /api/codewatch/defaults (your default and the repos that override it), and the default's edit form. */
let CW_DEF = null, CW_DEF_LOADING = false, CW_DEF_EDIT = null;
async function cwDefaultsLoad() {
  if (SNAPSHOT || CW_DEF_LOADING) return;
  CW_DEF_LOADING = true;
  let r;
  try { r = await api('/api/codewatch/defaults'); } catch (e) { r = { ok: false, json: { error: e.message } }; }
  CW_DEF_LOADING = false;
  CW_DEF = r.ok ? r.json : { error: txt((r.json || {}).error) || 'could not read the codewatch defaults' };
  cwDefaultsDraw();
}
/** Read again after any action (the drawer's poll calls cwRevInvalidate). */
function cwDefaultsInvalidate() { CW_DEF = null; CW_DEF_EDIT = null; }

function cwDefaultsSection() {
  const s = section('Codewatch default reviewer and model', 'yours, for every repo on this machine');
  s.setAttribute('id', 'cw-defaults');
  if (SNAPSHOT) { s.append(el('p', { class: 'empty' }, 'Shown on the live dashboard only.')); return s; }
  if (!CW_DEF) { s.append(el('p', { class: 'loading' }, 'loading...')); cwDefaultsLoad(); return s; }
  cwDefaultsFill(s);
  return s;
}
function cwDefaultsDraw() {
  const s = document.getElementById('cw-defaults');
  if (!s) return;
  s.replaceChildren(el('h2', {}, 'Codewatch default reviewer and model', el('span', { class: 'sub' }, 'yours, for every repo on this machine')));
  cwDefaultsFill(s);
}

function cwDefaultsFill(s) {
  const d = CW_DEF;
  if (d.error) { s.append(el('p', { class: 'fix' }, pill('error'), ' ', txt(d.error))); return; }
  const tool = (id) => (d.tools || []).find((t) => t.id === id) || {};
  const g = d.global || {}, models = g.models || {};
  const modelOf = (id) => (models[id] ? txt(models[id]) : 'tool default');
  s.append(kv([
    ['Reviewer', g.reviewer ? txt(tool(g.reviewer).name || g.reviewer) + (tool(g.reviewer).installed ? '' : ' (' + txt(tool(g.reviewer).binary) + ' not installed)') : 'not set: the team file, else whichever tool is installed'],
    ...(d.tools || []).map((t) => ['Model for ' + t.name, modelOf(t.id)]),
  ]));
  s.append(el('details', {}, el('summary', {}, 'Which setting wins'), el('p', { class: 'fix' }, 'Reviewer: ' + txt(d.precedence.reviewer)), el('p', { class: 'fix' }, 'Model: ' + txt(d.precedence.model))));
  const e = CW_DEF_EDIT;
  if (!e) {
    const change = el('button', { type: 'button', 'data-cwd-change': '' }, 'Change my default');
    change.addEventListener('click', () => { CW_DEF_EDIT = { reviewer: g.reviewer || (d.tools.find((t) => t.installed) || d.tools[0]).id, model: models[g.reviewer] || '' }; cwDefaultsDraw(); });
    const clear = g.reviewer || Object.values(models).some(Boolean) ? runButton('codewatch-reviewer-global-reset', { label: 'Remove my default' }) : null;
    s.append(el('div', { class: 'srow-ctl' }, change, clear));
  } else {
    const sel = el('select', { id: 'cwd-reviewer', 'aria-label': 'Default reviewer' }, ...(d.tools || []).map((t) => el('option', { value: t.id, selected: t.id === e.reviewer ? '' : null }, t.name + (t.installed ? '' : ' (not installed)'))));
    sel.addEventListener('change', () => { e.reviewer = sel.value; e.model = models[sel.value] || ''; cwDefaultsDraw(); });
    const t = tool(e.reviewer);
    const list = el('datalist', { id: 'cwd-models' }, el('option', { value: 'auto' }), ...(t.suggestions || []).map((m) => el('option', { value: m })));
    const model = el('input', { type: 'text', id: 'cwd-model', list: 'cwd-models', value: e.model, placeholder: 'auto (the tool default)', 'aria-label': 'Default model', autocomplete: 'off', spellcheck: 'false' });
    const re = new RegExp(d.modelPattern);
    const msg = el('span', { class: 'fix', role: 'status' });
    const save = el('button', { type: 'button', class: 'run', 'data-cwd-save': '' }, 'Save');
    const check = () => { const bad = e.model.trim() !== '' && !re.test(e.model.trim()); msg.textContent = bad ? 'A model id is letters, digits and . _ : / -, not starting with -.' : ''; save.disabled = bad; return !bad; };
    model.addEventListener('input', () => { e.model = model.value; check(); });
    check();
    save.addEventListener('click', () => {
      const a = actionDef('codewatch-reviewer-global');
      if (!a || !check()) return;
      const m = e.model.trim() || 'auto';
      confirmRun(a, { reviewer: e.reviewer, model: m, command: a.command + ' --reviewer ' + e.reviewer + ' --model ' + m });
    });
    const cancel = el('button', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => { CW_DEF_EDIT = null; cwDefaultsDraw(); });
    s.append(el('div', { class: 'cwrev', 'data-cwd-form': '' },
      el('div', { class: 'srow-ctl' }, el('label', { for: 'cwd-reviewer' }, 'Reviewer'), sel),
      el('div', { class: 'srow-ctl' }, el('label', { for: 'cwd-model' }, 'Model'), model, list, msg),
      el('p', { class: 'fix' }, 'Writes git config --global prism.reviewer and ' + txt(t.modelKey) + '. A repo override wins over it; a team eval.model for this reviewer wins over the model.'),
      el('div', { class: 'srow-ctl' }, save, cancel)));
  }
  const ov = d.overrides || [];
  s.append(el('h3', {}, 'Repos that override it', el('span', { class: 'sub' }, ' ' + ov.length + ' of ' + d.repoCount)));
  if (!ov.length) { s.append(el('p', { class: 'empty', 'data-cwd-none': '' }, 'None: every repo follows your default (or its team file).')); return; }
  // The dashboard's label (a parent path when two repos share a name), as on every other page.
  const name = (o) => { const own = ((LAST && LAST.repos) || []).find((x) => x.id === o.id); return own ? labelOf(own) : txt(o.name); };
  const rows = ov.map((o) => [
    el('a', { href: '#repo/' + o.id, 'data-cwd-repo': o.id }, name(o)),
    el('span', { class: 'fix' }, [o.reviewer ? 'reviewer ' + txt(o.reviewer) : null, ...(d.tools || []).filter((t) => o.models[t.id]).map((t) => t.id + ' model ' + txt(o.models[t.id]))].filter(Boolean).join(', ')),
    runButton('codewatch-reviewer-clone-reset', { repo: o.id, where: o.path, label: 'Reset to default' })]);
  s.append(table(['Repo', 'Its own setting', ''], rows));
  const all = actionDef('codewatch-reviewer-apply-all');
  if (all && all.available) {
    const b = el('button', { type: 'button', class: 'run danger', 'data-cwd-apply-all': '' }, 'Apply my default to all repos');
    b.addEventListener('click', () => confirmRun(all, { list: ov.map((o) => name(o) + ' (' + txt(o.path) + ')'), command: all.command + ' <the ' + d.repoCount + ' repos the dashboard found>' }));
    s.append(el('div', { class: 'srow-ctl' }, b, el('span', { class: 'fix' }, 'Removes the ' + ov.length + ' override' + (ov.length === 1 ? '' : 's') + ' above. Team files (.prism/config.json) are not touched.')));
  }
}

/** Info (or warn) callout for the global install. */
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

/** Repos with codewatch in a table; the rest collapsed behind one "enable for every repo" item. */
function reposPane(data) {
  const cwDefault = cwDefaultsSection();
  const rows = data.overview.setup || [];
  const on = rows.filter((r) => r.status === 'ok' || r.status === 'warn'), off = rows.filter((r) => r.status !== 'ok' && r.status !== 'warn');
  const head = ['Repo', 'Codewatch', 'Security Agent'];
  const recheck = el('button', { type: 'button', disabled: SNAPSHOT ? '' : null, title: SNAPSHOT ? 'Not in a static snapshot' : null }, 'Re-check status');
  recheck.addEventListener('click', async () => { recheck.disabled = true; try { await api('/api/recheck'); } catch (e) { /* load() reports */ } await load(); });
  const withCw = section('Repos with codewatch', on.length + ' of ' + data.overview.counts.repos + ' repos under ' + txt(data.scope.root_display),
    el('div', { class: 'srow-ctl' }, recheck, el('span', { class: 'fix' }, 'Codewatch hooks and Security Agent setup per repo, from local files.')),
    on.length ? table(head, on.map(repoRowCells)) : el('p', { class: 'empty' }, rows.length ? 'None yet.' : 'No git repositories found under ' + txt(data.scope.root_display) + '.'));
  if (!off.length) return [cwDefault, withCw];
  const sg = (data.suggestions || []).find((x) => x.id === 'codewatch-global');
  const elsewhere = (data.machine.globalHooks || {}).state === 'elsewhere';
  const all = elsewhere ? copyOnly('prism-cli enable codewatch --global --force', 'replaces another global hooks path') : runButton('codewatch-global', { label: 'Enable for every repo' });
  return [cwDefault, withCw, section('Repos without codewatch', off.length + ' repo' + (off.length === 1 ? '' : 's'),
    sg ? suggestionCallout(sg) : null, all ? el('div', { class: 'srow-ctl' }, all) : null,
    el('details', { class: 'missing-group', 'data-key': 'settings:repos-off' }, el('summary', {}, 'Show the ' + off.length + ' repo' + (off.length === 1 ? '' : 's')), table(head, off.map(repoRowCells))))];
}

const HOOK_PILL = { installed: ['ok', 'installed'], outdated: ['warn', 'outdated'], missing: ['skipped', 'not installed'], unreadable: ['error', 'unreadable'], 'no-repo': ['skipped', 'no repo'] };
/** Install / Update / Remove for one agent-hooks row: only an action id goes to the server. */
function hookButton(r, plugin) {
  const id = 'agent-hooks-' + r.client + (r.scope === 'global' ? '-global' : '');
  if (r.state === 'no-repo') return el('span', { class: 'fix' }, 'start prism-cli dashboard inside a repo for project hooks');
  if (r.state === 'installed') return runButton(id + '-remove', { label: 'Remove' });
  if (r.client === 'claude' && plugin && plugin.active) return el('span', { class: 'fix' }, plugin.outdated ? 'update the plugin (below); it runs these hooks from 0.3.0' : 'the plugin runs these hooks');
  return r.state === 'unreadable' ? null : runButton(id, { label: r.state === 'outdated' ? 'Update' : 'Install' });
}

function agentsPane(data) {
  const ah = data.agentHooks || { rows: [], plugin: {} }, p = ah.plugin || {};
  const rows = ah.rows.map((r) => {
    const st = HOOK_PILL[r.state] || ['skipped', r.state];
    return [r.client, r.scope, pill(st[0], st[1]), r.path ? el('code', { class: 'path' }, r.path + (r.others ? ' (+' + r.others + ' other)' : '')) : '-', hookButton(r, p)];
  });
  const kc = machineRow(data, 'kirocrew-app');
  const st = machineRow(data, 'kirocrew-steering');
  return [
    section('Agent hooks', 'the push check and finish check for coding agents (enable agent-hooks)', table(['Client', 'Scope', 'Status', 'File', ''], rows),
      el('p', { class: 'note' }, 'Project hooks are for the repo the dashboard started in. Cursor and Codex: planned.')),
    section('Claude Code plugin', null, kv([
      ['Installed', p.active ? el('span', {}, txt(p.version || 'version unknown'), ' ', p.outdated ? sevPill('medium', 'needs 0.3.0 or newer') : sevPill('ok', 'ok')) : 'not installed or disabled'],
      ['Update', el('div', {}, PLUGIN_UPDATE.map((c) => el('div', {}, copyButton(c))))]]),
      el('p', { class: 'note' }, 'From 0.3.0 the plugin runs the harness hooks itself, so the claude rows above stay uninstalled.')),
    section('Kiro Crew app', null, kc ? kv([['Installed', txt(kc.detail)],
      ...(st ? [['Steering note', el('span', {}, txt(st.detail), ' ', /^(outdated|missing)/.test(st.detail) ? sevPill('medium', 'needs update') : null)]] : []),
      ['Install or update', runButton('kirocrew-app', { label: 'Run enable kirocrew' }) || copyOnly('prism-cli enable kirocrew')]])
      : el('p', { class: 'empty' }, 'Kiro Crew is not on this machine.'),
      st ? el('p', { class: 'note' }, 'The steering note tells every Kiro Crew session to load the prism-fix-findings skill in a repo with codewatch. prism-cli enable kirocrew --uninstall removes it.') : null),
  ];
}

/** The update command (needs-you.ts); the Update button runs it as a fixed action id, never as text from the page. */
const UPDATE_CMD = ${JSON.stringify(UPDATE_CMD)};

function updatesPane(data) {
  const v = data.version || {};
  const state = v.off ? sevPill('zero', 'check off') : v.update ? sevPill('medium', 'update available') : v.latest ? sevPill('ok', 'up to date') : sevPill('zero', 'not checked');
  const check = el('button', { type: 'button', disabled: SNAPSHOT || v.off ? '' : null, title: v.off ? 'PRISM_NO_UPDATE_CHECK=1 turns the update check off' : null }, 'Check now');
  const msg = el('span', { class: 'fix', role: 'status' }, v.off ? 'The update check is off (PRISM_NO_UPDATE_CHECK=1 in the environment the dashboard started in).' : '');
  check.addEventListener('click', async () => {
    check.disabled = true; msg.textContent = 'asking the npm registry...';
    let r;
    try { r = await api('/api/update-check', {}); } catch (e) { r = { ok: false, json: { error: e.message } }; }
    msg.textContent = r.ok ? '' : 'check failed: ' + txt(r.json.error);
    check.disabled = false;
    if (r.ok) await load();
  });
  const rel = SETUP && SETUP.links && /^https:\\/\\//.test(txt(SETUP.links.releases))
    ? el('a', { href: SETUP.links.releases, target: '_blank', rel: 'noopener noreferrer', class: 'rlink' }, 'Release notes') : null;
  const update = v.update ? runButton('update-cli', { label: 'Update prism-cli' }) || copyOnly(UPDATE_CMD, 'installs software') : null;
  const comp = (id) => { const r = machineRow(data, id); return r ? txt(r.detail) : 'not on this machine'; };
  const p = (data.agentHooks || {}).plugin || {};
  return [
    section('prism-cli', null, el('div', { class: 'srow-head' }, state), kv([
      ['Installed', el('b', {}, txt(v.installed || '-'))],
      ['Latest on npm', el('span', {}, el('b', {}, txt(v.latest || '-')), v.publishedAt ? el('span', { class: 'fix' }, ' · published ' + when(v.publishedAt)) : null)],
      ['Last checked', v.checkedAt ? el('span', { title: when(v.checkedAt) }, ago(v.checkedAt)) : v.off ? 'never: the check is off' : 'not yet'],
    ]), el('div', { class: 'srow-ctl' }, update, check, rel, msg),
    el('p', { class: 'note' }, 'The dashboard asks the npm registry at most once a day and never updates by itself; PRISM_NO_UPDATE_CHECK=1 turns the check off. After an update, restart prism-cli dashboard, update the Claude Code plugin (', el('code', {}, PLUGIN_UPDATE[1]), ') and run ', el('code', {}, 'prism-cli enable kirocrew'), ', so the plugin and the Kiro Crew app match the new CLI.')),
    section('Components', null, table(['Component', 'Installed', 'Note'], [
      ['Claude Code plugin', p.active ? txt(p.version || 'version unknown') : 'not installed', p.outdated ? sevPill('medium', 'needs 0.3.0 or newer') : 'the harness hooks need 0.3.0 or newer'],
      ['Kiro Crew app', comp('kirocrew-app'), 'prism-cli enable kirocrew installs the app bundled with this CLI'],
      ['gitleaks', comp('gitleaks'), 'the pre-commit secret scan'],
      ['codeburn', comp('codeburn'), 'usage and spend'],
    ])),
  ];
}

/** Draws the tabs and every pane, keeps the selected tab and open sections, and sets the Settings badge. */
async function renderSetup(data) {
  try { const r = await api('/api/setup'); if (r.ok) SETUP = r.json; } catch (e) { /* keep the last good copy */ }
  const root = document.getElementById('settings');
  const openState = new Map([...root.querySelectorAll('details[data-key]')].map((d) => [d.getAttribute('data-key'), d.open]));
  const items = needsYou(data);
  const badge = document.getElementById('settings-badge');
  if (badge) { badge.textContent = items.length ? String(items.length) : ''; if (items.length) badge.removeAttribute('hidden'); else badge.setAttribute('hidden', ''); }
  root.replaceChildren();
  if (!SETUP) { root.append(el('section', { class: 'card' }, pill('error'), ' could not load the settings data')); return; }
  const machine = { ...data, machine: { ...data.machine, setup: (data.machine.setup || []).filter((i) => i.id !== 'kirocrew-app' && i.id !== 'kirocrew-steering') } };
  const panes = { overview: overviewPane(data, items), machine: [machineSection(machine)], repos: reposPane(data), agents: agentsPane(data), sync: [syncSection(data)], aws: awsSection(SETUP.aws || {}), updates: updatesPane(data) };
  const nav = el('nav', { class: 'stabs', role: 'tablist', 'aria-label': 'Settings sections' });
  const box = el('div', { class: 'spanes' });
  for (const [id, label] of SETTINGS_TABS) {
    const n = id === 'overview' ? items.length : items.filter((x) => x.tab === id).length;
    nav.append(el('a', { href: '#settings/' + id, role: 'tab', 'data-tab': id, id: 'tab-' + id, 'aria-controls': 'pane-' + id }, label, countBadge(n)));
    box.append(el('div', { role: 'tabpanel', 'data-pane': id, id: 'pane-' + id, 'aria-labelledby': 'tab-' + id }, ...panes[id].filter(Boolean)));
  }
  const checkAll = el('button', { type: 'button', disabled: SNAPSHOT ? '' : null, title: 'Re-run every local check' }, 'Check now');
  checkAll.addEventListener('click', async () => { checkAll.disabled = true; try { await api('/api/recheck'); } catch (e) { /* load() reports */ } await load(); });
  nav.append(el('div', { class: 'stabs-ctl' }, checkAll));
  root.append(el('h2', { class: 'sr-only' }, 'Settings'), el('div', { class: 'setup-layout' }, nav, box));
  selectTab(settingsRoute() || 'overview');
  for (const d of root.querySelectorAll('details[data-key]')) { const k = d.getAttribute('data-key'); if (openState.has(k)) d.open = openState.get(k); }
}
`;
