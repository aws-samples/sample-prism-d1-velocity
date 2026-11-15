/**
 * The Security Agent view (#security, #security/<repo-id>): a top-level page
 * next to Dashboard and Settings. A JS string concatenated into page.ts's
 * single document after setup-page.ts and settings-page.ts, whose helpers
 * (api, copyButton, copyOnly, actionDef, startAction, DIALOG) it uses.
 *
 * Two columns on a wide window: the picked repo (picker, results from its
 * .prism/results, Run buttons) on the left; the account and region, agent
 * spaces and setup health on the right. One column on a narrow one.
 *
 * Every value from the server is placed with textContent or an attribute.
 * Run buttons send only {action, repo id}; the server maps the id to a fixed
 * argv, appends --profile/--region itself and runs it in that repo. Loading the
 * page makes no AWS call (GET /api/security-agent); the agent-space lookup
 * runs on a click only.
 */

export const SECURITY_STYLE = `
.sa-grid { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(0,1fr); gap:18px; align-items:start; }
.sa-col { min-width:0; }
@media (max-width: 1060px) { .sa-grid { grid-template-columns:minmax(0,1fr); } }
ul.salist { list-style:none; margin:0; padding:0; } ul.salist > li { padding:10px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; } ul.salist > li:first-child { border-top:none; }
.sa-head { display:flex; gap:8px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
li.inuse { border-left:3px solid var(--ok); padding-left:10px; }
select.sa-repo { font:inherit; padding:4px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--text); max-width:100%; }
.sa-notice { font-weight:600; }
`;

export const SECURITY_SCRIPT = `
/** The last GET /api/security-agent answer, and the repo the page targets (an id from it). */
let SA = null, SA_PICK = null, SA_LOADED = false;
const SA_RE = new RegExp('^#security(?:/([a-f0-9]{16}))?$');
/** #security or #security/<16 hex>; null for any other route. */
function securityRoute() { const m = SA_RE.exec(location.hash); return m ? { id: m[1] || null } : null; }

/** The picked repo: the route's id, else the last pick, else the repo the dashboard started in, else the first. */
function saRepo() {
  const list = (SA && SA.repos) || [];
  const r = securityRoute();
  const by = (id) => (id ? list.find((x) => x.id === id) : null);
  return by(r && r.id) || by(SA_PICK) || list.find((x) => x.current) || list[0] || null;
}

/** This repo's latest cached results, from the /api/data payload (no AWS call), matched by repo id. */
function saResults(repo) {
  const s = (LAST && LAST.security) || {};
  const own = ((LAST && LAST.repos) || []).find((x) => x.id === repo.id);
  const same = (x) => !!own && x.path === own.path;
  return { review: (s.repos || []).find(same) || null, threat: (s.threat_models || []).find(same) || null, pentest: (s.pentests || []).find(same) || null };
}
const highOrCritical = (c) => ((c || {}).CRITICAL || 0) + ((c || {}).HIGH || 0) > 0;
const credsFailed = (l) => !!(l && !l.ok && l.credentials);

/**
 * Things to act on for the picked repo; the nav badge counts them. Failed
 * credentials (the lookup); no space for prism-cli (only after a
 * lookup); a HIGH or CRITICAL latest result; a pending code review or threat
 * model job. A running pentest is not counted: it runs for hours.
 */
function saActItems(repo) {
  if (!repo) return [];
  const out = [], l = repo.lookup;
  if (credsFailed(l)) out.push('the AWS credentials did not work');
  else if (l && l.ok && !l.inUse) out.push('no agent space is set up for prism-cli in ' + txt(l.region));
  const r = saResults(repo);
  if (r.review) {
    if (r.review.pending || r.review.running) out.push('a code review job is pending');
    // With a newer job running, the row is the last completed review: its findings still count.
    if (!r.review.pending && highOrCritical(r.review.counts)) out.push(r.review.running ? 'high findings in the last completed code review' : 'high findings in the latest code review');
  }
  if (r.threat) { if (r.threat.pending) out.push('a threat model job is pending'); else if (highOrCritical(r.threat.counts)) out.push('high threats in the latest threat model'); }
  if (r.pentest && !r.pentest.pending && highOrCritical(r.pentest.counts)) out.push('high findings in the latest pentest');
  return out;
}

function saBadge() {
  const b = document.getElementById('security-badge');
  if (!b) return;
  const items = saActItems(saRepo());
  b.textContent = items.length ? String(items.length) : '';
  b.setAttribute('title', items.join('; '));
  if (items.length) b.removeAttribute('hidden'); else b.setAttribute('hidden', '');
}

/** Confirm, then run an allowlisted action in the picked repo. The command shown is the server's exact line. */
function saConfirm(a, repo) {
  if (!DIALOG) { DIALOG = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' }); document.body.append(DIALOG); }
  const cmd = txt((repo.commands || {})[a.id]);
  const notice = a.writesAws ? (repo.notices || {})[a.id] : null;
  const run = el('button', { type: 'button', class: 'run' + (a.writesAws ? ' danger' : '') }, a.writesAws ? 'Upload and start' : 'Run');
  const cancel = el('button', { type: 'button' }, 'Cancel');
  const kids = [el('h2', { id: 'confirm-title' }, a.label)];
  if (a.writesAws) kids.push(el('p', { class: 'sa-notice' }, txt(notice && notice.text)));
  kids.push(el('p', {}, 'This will run:'), el('pre', { class: 'cmd' }, cmd));
  kids.push(el('p', { class: 'note' }, a.writesAws
    ? 'This writes to AWS: an S3 upload and one started job, which may incur cost. It does not wait for the job; fetch the result here later.'
    : 'Read-only in AWS: describe, get and list calls only. Nothing in AWS is changed.'));
  if (a.note) kids.push(el('p', { class: 'note' }, txt(a.note)));
  kids.push(el('p', { class: 'note' }, 'It runs without a terminal, so it cannot ask questions; one action runs at a time and this one is stopped after ' + Math.max(1, Math.round(a.timeoutSec / 60)) + ' min.'));
  kids.push(el('div', { class: 'actions' }, cancel, run));
  DIALOG.replaceChildren(...kids);
  cancel.addEventListener('click', () => DIALOG.close());
  run.addEventListener('click', () => { DIALOG.close(); startAction(a, { repo: repo.id }); });
  DIALOG.showModal();
  // Cancel has the focus, so Enter never confirms; the run needs its own click.
  cancel.focus();
}

/** A Run button for one page action, or why it cannot run, or (snapshot) the command to copy. */
function saRun(id, repo, label) {
  const a = actionDef(id);
  if (!a || !a.available || !repo) return null;
  const cmd = txt((repo.commands || {})[id]);
  if (SNAPSHOT) return copyOnly(cmd, 'snapshot: copy only');
  if (a.writesAws) {
    const n = (repo.notices || {})[id];
    if (!n || !n.text) return el('span', { class: 'fix' }, txt((n && n.reason) || 'not available'));
  }
  const b = el('button', { type: 'button', class: 'run' + (a.writesAws ? ' danger' : '') }, label || 'Run');
  b.addEventListener('click', () => saConfirm(a, repo));
  return b;
}

const saCard = (title, sub, ...kids) => el('section', { class: 'card' }, el('h2', {}, title, sub ? el('span', { class: 'sub' }, sub) : null), ...kids);

function saPicker(repo) {
  const sel = el('select', { class: 'sa-repo', id: 'sa-repo', 'aria-label': 'Target repo' });
  for (const r of SA.repos) {
    // The dashboard's label (a parent path when two repos share a name), as on every other page.
    const own = ((LAST && LAST.repos) || []).find((x) => x.id === r.id);
    const o = el('option', { value: r.id }, (own ? labelOf(own) : txt(r.name)) + (r.current ? ' (this repo)' : ''));
    if (r.id === repo.id) o.setAttribute('selected', '');
    sel.append(o);
  }
  sel.addEventListener('change', () => { SA_PICK = sel.value; location.hash = '#security/' + sel.value; });
  return saCard('Target repo', 'every command on this page runs in this repo, as if you ran it there',
    el('div', { class: 'srow-ctl' }, el('label', { for: 'sa-repo' }, 'Repo'), sel, el('code', { class: 'path' }, txt(repo.path))),
    el('p', { class: 'fix' }, saSetupLine(repo.setup)));
}

/** Which setup record the commands use in a repo: its repo override, else the machine setup. */
function saSetupLine(s) {
  if (!s) return 'Not set up on this machine yet (no ~/.prism/security.json): run enable security once, from any directory.';
  const where = 'account ' + txt(s.account4) + ' / ' + txt(s.region) + (s.setupAt ? ', set up ' + when(s.setupAt) : '');
  return s.source === 'repo'
    ? 'Repo override: .prism/security.local.json (' + (s.codeReviewId ? 'code review ' + txt(s.codeReviewId) + ', ' : '') + where + '). It takes precedence over the machine setup in this repo.'
    : 'Uses the machine setup (~/.prism/security.json): ' + where + '.';
}

/** The short form for a card subtitle. */
const saSetupTag = (s) => (!s ? 'not set up on this machine' : s.source === 'repo' ? 'repo override' : 'uses machine setup');

/** One result line: its pills and when, or "none saved". */
function saResultCell(x, levels) {
  if (!x) return el('span', { class: 'fix' }, 'none saved');
  return el('div', {}, el('span', { class: 'pills' }, ...resultPills(x, levels, 'clean')), el('div', { class: 'fix' }, (x.pending ? 'started ' + when(x.started_at) : when(x.finished_at)) + ' · job ' + txt(x.job_id).slice(0, 12)),
    runningNote(x, null));
}

function saResultsCard(repo) {
  const r = saResults(repo);
  const row = (label, x, levels, id, btn) => el('tr', {}, el('td', {}, el('b', {}, label)), el('td', {}, saResultCell(x, levels)), el('td', {}, saRun(id, repo, btn)));
  return saCard('Results for ' + txt(repo.name), saSetupTag(repo.setup) + ' · from this repo\\'s .prism/results; no AWS call to show them',
    table(['Result', 'Latest', 'Refresh (read-only)'], [
      row('Code review', r.review, RISKS, 'security-findings', 'Fetch findings'),
      row('Threat model', r.threat, THREAT_LEVELS, 'security-threats', 'Fetch threats'),
      row('Pentest', r.pentest, RISKS, 'security-pentest-findings', 'Fetch pentest findings')]),
    el('p', { class: 'note' }, 'All findings are on the ', el('a', { href: '#' }, 'Dashboard'), ' under Security findings.'));
}

function saStartCard(repo) {
  const c = repo.copy || {};
  const item = (label, why, ctl) => el('li', {}, el('div', { class: 'sa-head' }, el('b', {}, label)), el('div', { class: 'fix' }, why), el('div', { class: 'srow-ctl' }, ctl));
  return saCard('Start new work in ' + txt(repo.name), 'writes to AWS',
    el('ul', { class: 'salist' },
      item('Code review of this branch', 'Uploads the repo at HEAD and a patch of your branch to the scan bucket and starts a code review job.', saRun('security-code-review', repo, 'Start code review')),
      item('Code review of the whole repo', 'Uploads the repo at HEAD and starts a code review job.', saRun('security-code-review-full', repo, 'Start full review')),
      item('Threat model', 'Uploads the repo and its scope docs at HEAD, creates a threat model and starts a job.', saRun('security-threat-model', repo, 'Start threat model')),
      item('Pentest plan', 'Shows the plan, target and cost. Copy only: run it in a terminal.', copyOnly(txt(c.pentestDryRun), 'terminal')),
      item('Pentest', 'Deploys a private copy of the app in a temporary VPC and starts a pentest (hours; costs money). Copy only.', copyOnly(txt(c.pentest), 'AWS write')),
      item('Pentest status', 'Refreshes the job and tears the environment down once it has finished. Copy only.', copyOnly(txt(c.pentestStatus), 'AWS write'))));
}

/** One card for the whole machine: enable security runs once, from any directory, so its command has no cd. */
function saSetupCard(repo, why, open) {
  const body = [el('p', {}, why), el('ol', { class: 'steps' },
    el('li', {}, el('b', {}, 'See the plan. '), 'Every read runs and nothing is changed: the account, the stack it would use, the resource diff and the exact calls.', el('div', { class: 'srow-ctl' }, saRun('security-dry-run', repo, 'Dry run'))),
    el('li', {}, el('b', {}, 'Set it up once, in a terminal, from any directory. '), 'Deploys only the PrismD1SecurityAgent stack (agent space prism-d1-security, an IAM service role, an encrypted S3 scan bucket, SSM parameters), then the application, and saves ~/.prism/security.json. Every repo on this machine uses it: a repo gets its code review on its first code review run. It shows the diff and asks before any change.',
      copyOnly(txt(SA.setupCommand), 'AWS write')),
    el('li', {}, el('b', {}, 'Check it. '), el('div', { class: 'srow-ctl' }, saRun('security-status', repo, 'Run status check'))))];
  if (open) return saCard('Set up Security Agent on this machine', 'once, with prism-cli enable security', ...body);
  return el('details', { class: 'card', 'data-key': 'security:setup' }, el('summary', {}, 'Set up Security Agent on this machine'), ...body);
}

function saAccountCard(repo) {
  const t = repo.target || {}, l = repo.lookup;
  const cred = credsFailed(l) ? pill('error', 'check failed') : l && l.ok ? pill('ok', 'account ' + txt(l.account4)) : pill('info', 'not checked');
  return saCard('Account and region', 'what prism-cli resolves in this repo',
    kv([['Profile', t.profile ? el('code', {}, txt(t.profile)) : el('span', { class: 'fix' }, 'none (the AWS CLI chain)')],
      ['Chosen by', txt(t.source)], ['Region', t.region ? txt(t.region) + (t.regionFrom === 'repo' ? ' (repo override)' : t.regionFrom === 'machine' ? ' (machine setup)' : '') : el('span', { class: 's-missing' }, 'not set')],
      ['Credentials', el('span', {}, cred, ' ', el('a', { href: '#settings/aws' }, 'Settings › AWS →'))]]),
    el('p', { class: 'fix' }, 'prism-cli has no flag to pick an agent space: the commands use the space this account and region are set up with. To use another, change the profile or region (prism-cli aws connect).'));
}

function saSpacesCard(repo) {
  const l = repo.lookup;
  const msg = el('span', { class: 'fix', role: 'status' });
  const btn = el('button', { type: 'button', class: 'run', disabled: SNAPSHOT ? '' : null }, l && l.ok ? 'Look up again' : 'Look up agent spaces');
  btn.addEventListener('click', async () => {
    btn.disabled = true; msg.textContent = 'looking up (read-only)...';
    let r;
    try { r = await api('/api/security-agent/spaces', { repo: repo.id, refresh: !!(l && l.ok) }); } catch (e) { r = { ok: false, json: { error: e.message } }; }
    msg.textContent = r.ok ? '' : 'lookup refused: ' + txt(r.json.error);
    btn.disabled = false;
    if (r.ok) await renderSecurity();
  });
  const kids = [el('div', { class: 'srow-ctl' }, btn, msg),
    el('p', { class: 'fix' }, 'On a click only, never on page load. Read-only: sts get-caller-identity, securityagent list-agent-spaces and batch-get-agent-spaces, ssm get-parameter; 20 s per call; kept 5 minutes.')];
  if (l && !l.ok) kids.push(el('div', { class: 'callout warn', role: 'note' }, pill('error', l.credentials ? 'credentials' : 'failed'), ' ', txt(l.error),
    l.credentials ? el('div', { class: 'fix' }, 'Sign in again (aws sso login, or your credential_process), then look up again. ', el('a', { href: '#settings/aws' }, 'Re-verify in Settings › AWS →')) : null));
  if (l && l.ok) {
    // The console link comes from the server (fixed text plus a checked region), like the release-notes link; https only.
    const url = /^https:\\/\\//.test(txt(l.consoleUrl)) ? l.consoleUrl : null;
    if (!l.spaces.length) kids.push(el('p', { class: 'empty' }, 'No agent spaces in ' + txt(l.region) + '.'));
    else kids.push(el('ul', { class: 'salist' }, l.spaces.map((s) => el('li', { class: s.inUse ? 'inuse' : null },
      el('div', { class: 'sa-head' }, el('b', {}, txt(s.name)), s.inUse ? sevPill('ok', 'used by prism-cli') : s.pentest ? sevPill('zero', 'temporary pentest space') : sevPill('zero', 'not used by prism-cli')),
      el('div', { class: 'fix' }, el('code', {}, txt(s.id)), s.createdAt ? ' · created ' + when(s.createdAt) : '', s.pentest || !l.scanBucket ? '' : ' · scan bucket ',
        s.pentest || !l.scanBucket ? null : s.bucketListed === true ? sevPill('ok', 'listed') : s.bucketListed === false ? sevPill('medium', 'not listed') : sevPill('zero', 'unknown')),
      el('div', { class: 'fix' }, s.inUse ? 'named by SSM /prism/continuum/agent-space-id' : s.pentest ? 'created by security pentest for one run; removed at teardown' : 'no prism-cli command can target it today')))));
    kids.push(el('p', { class: 'note' }, 'Looked up ' + when(l.at) + ' · account ' + txt(l.account4) + ' / ' + txt(l.region) + (l.scanBucket ? ' · scan bucket ' + txt(l.scanBucket) : ''),
      url ? el('span', {}, ' · ', el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'rlink' }, 'Security Agent console')) : null));
  }
  return saCard('Agent spaces', l && l.ok ? l.spaces.length + ' in ' + txt(l.region) : 'not looked up yet', ...kids);
}

function saHealthCard(repo) {
  return saCard('Setup health', 'enable security --status',
    el('div', { class: 'srow-ctl' }, saRun('security-status', repo, 'Run status check')),
    el('p', { class: 'fix' }, 'Which setup ' + txt(repo.name) + ' uses (' + saSetupTag(repo.setup) + '), then the stack, agent space, application, SSM parameters, scan bucket, this repo\\'s code review and the CI step. Read-only; the report opens in the Action output drawer.'));
}

function saWhichCard() {
  const r = (cmd, how, writes) => el('li', {}, el('code', {}, cmd), ' ', writes ? sevPill('medium', 'writes to AWS') : sevPill('ok', 'read-only'), el('div', { class: 'fix' }, how));
  return el('details', { class: 'card', 'data-key': 'security:which' }, el('summary', {}, 'Which command uses which space'),
    el('ul', { class: 'salist' },
      r('security code-review', 'the space in SSM agent-space-id, the code review in code-review-id/<repo> (created on its first run in a repo); the setup record only as a fallback', true),
      r('security findings', 'the same as code-review', false),
      r('security threat-model', 'the space in SSM agent-space-id', true),
      r('security threats', 'the space in SSM agent-space-id', false),
      r('security pentest', 'a new pentest-<slug> space for each run, deleted at teardown', true),
      r('CI eval gate', 'the space in SSM agent-space-id and code-review-id/<repo>', true)));
}

/** Fetches GET /api/security-agent (no AWS call), then draws the page and the nav badge. Runs on every load, whatever the view. */
async function renderSecurity() {
  if (!SNAPSHOT) { try { const r = await api('/api/security-agent'); if (r.ok) SA = r.json; } catch (e) { /* keep the last good copy */ } }
  SA_LOADED = true;
  drawSecurity();
}

/** Draws the page from the last answer; the hash router calls it for #security/<id> without fetching. */
function drawSecurity() {
  saBadge();
  const root = document.getElementById('security');
  if (!root) return;
  if (!SA_LOADED) { root.replaceChildren(el('p', { class: 'loading' }, 'loading...')); return; }
  const openState = new Map([...root.querySelectorAll('details[data-key]')].map((d) => [d.getAttribute('data-key'), d.open]));
  root.replaceChildren(el('h2', { class: 'sr-only' }, 'Security Agent'));
  if (SNAPSHOT) { root.append(el('section', { class: 'card' }, el('p', { class: 'empty' }, 'The Security Agent page runs on the live dashboard only (prism-cli dashboard). The saved results are on the Dashboard under Security findings.'))); return; }
  if (!SA) { root.append(el('section', { class: 'card' }, pill('error'), ' could not load the Security Agent data')); return; }
  const repo = saRepo();
  if (!repo) { root.append(el('section', { class: 'card' }, el('p', { class: 'empty' }, 'No git repositories found under ' + txt(LAST && LAST.scope && LAST.scope.root_display) + '.'))); return; }
  SA_PICK = repo.id;
  const l = repo.lookup, noSpace = !!(l && l.ok && !l.inUse);
  const left = [saPicker(repo)], right = [saAccountCard(repo), saSpacesCard(repo)];
  if (credsFailed(l)) root.append(el('div', { class: 'callout warn', role: 'note' }, el('strong', {}, 'The AWS credentials did not work. '), 'Sign in again, then look up agent spaces or fetch results. ', el('a', { href: '#settings/aws' }, 'Open Settings › AWS →')));
  if (noSpace) left.push(saSetupCard(repo, 'This account has no agent space set up for prism-cli in ' + txt(l.region) + ' (SSM /prism/continuum/agent-space-id is not set). enable security creates its own, prism-d1-security, and leaves any others alone.', true), saResultsCard(repo));
  else if (!SA.machine && !repo.setup) { left.push(saSetupCard(repo, 'Security Agent is not set up on this machine yet. Run enable security once, from any directory; every repo then uses it.', true), saResultsCard(repo), saStartCard(repo)); right.push(saHealthCard(repo)); }
  else { left.push(saResultsCard(repo), saStartCard(repo), saSetupCard(repo, 'Set up already? Re-running enable security is safe: it shows what would change and asks first.', false)); right.push(saHealthCard(repo)); }
  right.push(saWhichCard());
  root.append(el('div', { class: 'sa-grid' }, el('div', { class: 'sa-col' }, ...left), el('div', { class: 'sa-col' }, ...right)));
  for (const d of root.querySelectorAll('details[data-key]')) { const k = d.getAttribute('data-key'); if (openState.has(k)) d.open = openState.get(k); }
}
`;
