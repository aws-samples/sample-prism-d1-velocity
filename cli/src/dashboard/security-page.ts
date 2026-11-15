/**
 * The Security Agent view (#security, #security/<repo-id>): a top-level page
 * next to Dashboard and Settings. A JS string concatenated into page.ts's
 * single document after setup-page.ts and settings-page.ts, whose helpers
 * (api, copyButton, copyOnly, actionDef, startAction, DIALOG) it uses.
 *
 * First the setup gate (security-gate.ts): three steps, checked in order,
 * and only the first one not met is shown, as one card with "step n of 3".
 * Steps 1 and 2 read local files only, and their card checks again every
 * 10 s (GET /api/security-agent) while it is open. Step 3 is the read-only
 * agent-space lookup: once steps 1 and 2 pass, the page starts it by itself,
 * once per repo and profile and region (never on the minute refresh), and
 * the server keeps the answer for the dashboard session; Check again and
 * Retry run it again. One lookup at a time.
 *
 * Once all three pass: a "Security Agent ready" strip, then two columns on a
 * wide window: the picked repo (picker, results from its .prism/results, Run
 * buttons) on the left; the account and region, agent spaces and setup
 * health on the right. One column on a narrow one. Runs, results and Start
 * buttons are drawn only then.
 *
 * Every value from the server is placed with textContent or an attribute.
 * Run buttons send only {action, repo id}; the server maps the id to a fixed
 * argv, appends --profile/--region itself and runs it in that repo.
 * enable security and aws sso login are Copy only.
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
.gate { max-width:720px; margin:12px auto 18px; border:1px solid var(--line); border-radius:14px; background:var(--card); overflow:hidden; }
.gate-top { padding:16px 22px 0; } .gate-body { padding:14px 22px 20px; } .gate-body h3 { font-size:18px; margin:4px 0 8px; } .gate-body p { margin:6px 0 10px; overflow-wrap:anywhere; }
.gate-step { font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.05em; display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; }
.gbar { height:6px; border-radius:3px; margin:10px 0 0; overflow:hidden; display:grid; grid-template-columns:repeat(3,1fr); gap:3px; }
.gbar i { display:block; height:100%; background:var(--raised); } .gbar i.done { background:var(--ok); } .gbar i.now { background:var(--accent); } .gbar i.bad { background:var(--bad); }
ol.gsteps { display:flex; gap:6px 16px; flex-wrap:wrap; margin:10px 0 0; padding:0; list-style:none; font-size:12px; color:var(--muted); }
ol.gsteps li::before { content:"○ "; } ol.gsteps li.done { color:var(--ok); } ol.gsteps li.done::before { content:"✓ "; } ol.gsteps li.now { color:var(--text); font-weight:650; } ol.gsteps li.now::before { content:"● "; color:var(--accent); } ol.gsteps li.bad { color:var(--bad); font-weight:650; } ol.gsteps li.bad::before { content:"✕ "; }
.gate .actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:14px; } .recheck { font-size:12px; color:var(--muted); }
.gchoice { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:12px 0; } @media (max-width: 700px) { .gchoice { grid-template-columns:1fr; } .gate-top, .gate-body { padding-left:14px; padding-right:14px; } }
.gopt { border:1px solid var(--line); border-radius:10px; padding:12px; background:var(--raised); min-width:0; } .gopt b { display:block; margin-bottom:4px; }
.okstrip { display:flex; flex-wrap:wrap; gap:6px 16px; align-items:center; font-size:12px; color:var(--muted); border:1px solid var(--line); border-radius:10px; padding:8px 14px; margin-bottom:18px; background:var(--card); overflow-wrap:anywhere; }
.okstrip b { color:var(--ok); } .okstrip span.ok::before { content:"✓ "; color:var(--ok); }
`;

export const SECURITY_SCRIPT = `
/** The last GET /api/security-agent answer, and the repo the page targets (an id from it). */
let SA = null, SA_PICK = null, SA_LOADED = false;
const SA_STEPS = ['AWS connected', 'Security Agent set up', 'Agent space verified'];
/** Gate states whose card checks again by itself (local files only), and how often. */
const SA_POLL_STATES = ['connect', 'profile', 'setup', 'mismatch'];
const SA_POLL_MS = 10000;
let SA_TIMER = null;
/** Repo|profile|region keys whose automatic lookup already ran on this page load: step 3 starts once each, never on a refresh. */
const SA_AUTO = new Set();
/** The repo id of the lookup in flight (one at a time), and the last refused request per repo (another action running, a network error). */
let SA_LOOKING = null;
const SA_LOOK_ERR = new Map();
const SA_RE = new RegExp('^#security(?:/([a-f0-9]{16}))?$');
/** #security or #security/<16 hex>; null for any other route. */
function securityRoute() {
  const m = SA_RE.exec(location.hash);
  if (m) return { id: m[1] || null };
  const run = runRoute();
  return run ? { id: run.repo, run } : null;
}

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

/**
 * Things to act on for the picked repo; the nav badge counts them. A setup
 * gate step that is not met (not while its lookup runs); a HIGH or CRITICAL
 * latest result; a pending code review or threat model job. A running
 * pentest is not counted: it runs for hours.
 */
function saActItems(repo) {
  if (!repo) return [];
  const out = [], g = repo.gate;
  if (g && g.state !== 'ready' && g.state !== 'checking') out.push('Security Agent setup, step ' + g.step + ' of 3: ' + txt(g.title));
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
function saDialog() {
  if (!DIALOG) { DIALOG = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' }); document.body.append(DIALOG); }
  return DIALOG;
}
function saConfirm(a, repo) {
  saDialog();
  const cmd = txt((repo.commands || {})[a.id]);
  const notice = a.writesAws ? (repo.notices || {})[a.id] : null;
  const run = el('button', { type: 'button', class: 'run' + (a.writesAws ? ' danger' : '') }, a.writesAws ? 'Upload and start' : 'Run');
  const cancel = el('button', { type: 'button' }, 'Cancel');
  const kids = [el('h2', { id: 'confirm-title' }, a.label)];
  if (a.writesAws) kids.push(el('p', { class: 'sa-notice' }, txt(notice && notice.text)));
  kids.push(el('p', {}, 'This will run:'), cmdWords('pre', 'cmd', cmd));
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

/** The code review action that passes --force: the guard dialog's "Start another anyway". */
const SA_FORCE = { 'security-code-review': 'security-code-review-force', 'security-code-review-full': 'security-code-review-full-force' };

/**
 * Before the confirm dialog of a code review: a review of this repo still
 * running offers View it or Start another anyway (--force: code-review refuses
 * to replace the shared snapshot otherwise); a finished review of HEAD offers
 * Open those findings first. From the server's guard (local result files).
 */
function saStart(a, repo) {
  const g = repo.guard || {};
  if (!SA_FORCE[a.id] || (!g.running && !g.reviewed)) { saConfirm(a, repo); return; }
  saDialog();
  const cancel = el('button', { type: 'button' }, 'Cancel');
  const go = (hash) => { DIALOG.close(); location.hash = hash; };
  const kids = [el('h2', { id: 'confirm-title' }, a.label)];
  if (g.running) {
    const r = g.running, force = actionDef(SA_FORCE[a.id]);
    kids.push(el('div', { class: 'callout warn', role: 'note' }, el('strong', {}, 'A code review of ' + txt(repo.name) + ' is already running. '),
      'Started ' + when(r.started_at) + (r.branch ? ' on ' + txt(r.branch) : '') + (r.commit ? ' @ ' + txt(r.commit) : '') + ' (job ' + txt(r.job_id) + '). '
      + 'Another one uploads a new snapshot of the repo (its latest.zip in the scan bucket) while that job may still be reading the old one.'));
    const view = el('button', { type: 'button', class: 'run' }, 'View it →');
    view.addEventListener('click', () => go('#security/run/' + repo.id + '/' + r.run_id));
    const again = el('button', { type: 'button' }, 'Start another anyway');
    again.addEventListener('click', () => { DIALOG.close(); if (force) saConfirm(force, repo); });
    kids.push(el('div', { class: 'actions' }, cancel, view, force && force.available ? again : null));
  } else {
    const d = g.reviewed, c = d.counts || {};
    kids.push(el('div', { class: 'callout', role: 'note' }, el('strong', {}, 'This commit already has a finished review. '),
      txt(d.commit) + ' was reviewed ' + when(d.finished_at) + ': ' + (d.total ? (c.critical || 0) + ' critical, ' + (c.high || 0) + ' high, ' + (c.medium || 0) + ' medium, ' + (c.low || 0) + ' low.' : 'no findings.')));
    const open = el('button', { type: 'button', class: 'run' }, 'Open those findings →');
    open.addEventListener('click', () => go('#security/run/' + repo.id + '/' + d.run_id));
    const again = el('button', { type: 'button' }, 'Review it again');
    again.addEventListener('click', () => { DIALOG.close(); saConfirm(a, repo); });
    kids.push(el('div', { class: 'actions' }, cancel, open, again));
  }
  DIALOG.replaceChildren(...kids);
  cancel.addEventListener('click', () => DIALOG.close());
  DIALOG.showModal();
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
  b.addEventListener('click', () => saStart(a, repo));
  return b;
}

const saCard = (title, sub, ...kids) => el('section', { class: 'card' }, el('h2', {}, title, sub ? el('span', { class: 'sub' }, sub) : null), ...kids);

function saSelect(repo) {
  const sel = el('select', { class: 'sa-repo', id: 'sa-repo', 'aria-label': 'Target repo' });
  for (const r of SA.repos) {
    // The dashboard's label (a parent path when two repos share a name), as on every other page.
    const own = ((LAST && LAST.repos) || []).find((x) => x.id === r.id);
    const o = el('option', { value: r.id }, (own ? labelOf(own) : txt(r.name)) + (r.current ? ' (this repo)' : ''));
    if (r.id === repo.id) o.setAttribute('selected', '');
    sel.append(o);
  }
  sel.addEventListener('change', () => { SA_PICK = sel.value; location.hash = '#security/' + sel.value; });
  return sel;
}

function saPicker(repo) {
  return saCard('Target repo', 'every command on this page runs in this repo, as if you ran it there',
    el('div', { class: 'srow-ctl' }, el('label', { for: 'sa-repo' }, 'Repo'), saSelect(repo), el('code', { class: 'path' }, txt(repo.path))),
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
function saResultCell(x, levels, link) {
  if (!x) return el('span', { class: 'fix' }, 'none saved');
  return el('div', {}, el('span', { class: 'pills' }, ...resultPills(x, levels, 'clean')), el('div', { class: 'fix' }, (x.pending ? 'started ' + when(x.started_at) : when(x.finished_at)) + ' · job ' + txt(x.job_id).slice(0, 12)),
    runningNote(x, null), x.pending ? null : link);
}

function saResultsCard(repo) {
  const r = saResults(repo);
  // A finished run links to its findings; a running one stays amber with no link.
  const row = (label, x, levels, id, btn, type) => el('tr', {}, el('td', {}, el('b', {}, label)), el('td', {}, saResultCell(x, levels, runCellLink(repo.id, type))), el('td', {}, saRun(id, repo, btn)));
  return saCard('Results for ' + txt(repo.name), saSetupTag(repo.setup) + ' · from this repo\\'s .prism/results; no AWS call to show them',
    table(['Result', 'Latest', 'Refresh (read-only)'], [
      row('Code review', r.review, RISKS, 'security-findings', 'Fetch findings', 'code-review'),
      row('Threat model', r.threat, THREAT_LEVELS, 'security-threats', 'Fetch threats', 'threat-model'),
      row('Pentest', r.pentest, RISKS, 'security-pentest-findings', 'Fetch pentest findings', 'pentest')]),
    el('p', { class: 'note' }, 'Every run, with its findings, is in Security runs above.'));
}

function saStartCard(repo) {
  const c = repo.copy || {};
  const item = (label, why, ctl) => el('li', {}, el('div', { class: 'sa-head' }, el('b', {}, label)), el('div', { class: 'fix' }, why), el('div', { class: 'srow-ctl' }, ctl));
  return saCard('Start new work in ' + txt(repo.name), 'writes to AWS',
    el('ul', { class: 'salist' },
      item('Code review of this branch', 'Uploads the repo at HEAD and a patch of your branch to the scan bucket and starts a code review job. The first run in a repo also creates its code review, as the CI gate does.', saRun('security-code-review', repo, 'Start code review')),
      item('Code review of the whole repo', 'Uploads the repo at HEAD and starts a code review job.', saRun('security-code-review-full', repo, 'Start full review')),
      item('Threat model', 'Uploads the repo and its scope docs at HEAD, creates a threat model and starts a job.', saRun('security-threat-model', repo, 'Start threat model')),
      item('Pentest plan', 'Shows the plan, target and cost. Copy only: run it in a terminal.', copyOnly(txt(c.pentestDryRun), 'terminal')),
      item('Pentest', 'Deploys a private copy of the app in a temporary VPC and starts a pentest (hours; costs money). Copy only.', copyOnly(txt(c.pentest), 'AWS write')),
      item('Pentest status', 'Refreshes the job and tears the environment down once it has finished. Copy only.', copyOnly(txt(c.pentestStatus), 'AWS write'))));
}

/** One folded card for the whole machine: enable security runs once, from any directory, so its command has no cd. */
function saSetupCard(repo, why) {
  const body = [el('p', {}, why), el('ol', { class: 'steps' },
    el('li', {}, el('b', {}, 'See the plan. '), 'Every read runs and nothing is changed: the account, the stack it would use, the resource diff and the exact calls.', el('div', { class: 'srow-ctl' }, saRun('security-dry-run', repo, 'Dry run'))),
    el('li', {}, el('b', {}, 'Set it up once, in a terminal, from any directory. '), 'Deploys only the PrismD1SecurityAgent stack (agent space prism-d1-security, an IAM service role, an encrypted S3 scan bucket, SSM parameters), then the application, and saves ~/.prism/security.json. Every repo on this machine uses it: a repo gets its code review on its first code review run. It shows the diff and asks before any change.',
      copyOnly(txt(SA.setupCommand), 'AWS write')),
    el('li', {}, el('b', {}, 'Check it. '), el('div', { class: 'srow-ctl' }, saRun('security-status', repo, 'Run status check'))))];
  return el('details', { class: 'card', 'data-key': 'security:setup' }, el('summary', {}, 'Set up Security Agent on this machine'), ...body);
}

function saAccountCard(repo) {
  const t = repo.target || {}, l = repo.lookup;
  const cred = l && !l.ok ? pill('error', 'check failed') : l && l.ok ? pill('ok', 'account ' + txt(l.account4)) : pill('info', 'not checked');
  return saCard('Account and region', 'what prism-cli resolves in this repo',
    kv([['Profile', t.profile ? el('code', {}, txt(t.profile)) : el('span', { class: 'fix' }, 'none (the AWS CLI chain)')],
      ['Chosen by', txt(t.source)], ['Region', t.region ? txt(t.region) + (t.regionFrom === 'repo' ? ' (repo override)' : t.regionFrom === 'machine' ? ' (machine setup)' : '') : el('span', { class: 's-missing' }, 'not set')],
      ['Credentials', el('span', {}, cred, ' ', el('a', { href: '#settings/aws' }, 'Settings › AWS →'))]]),
    el('p', { class: 'fix' }, 'prism-cli has no flag to pick an agent space: the commands use the space this account and region are set up with. To use another, change the profile or region (prism-cli aws connect).'));
}

function saSpacesCard(repo) {
  const l = repo.lookup;
  const kids = [el('p', { class: 'fix' }, 'From the read-only check at the top (sts get-caller-identity, securityagent list-agent-spaces and batch-get-agent-spaces, ssm get-parameter; 20 s per call), kept until the dashboard stops. Check again refreshes it.')];
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
  return saCard('Agent spaces', l && l.ok ? l.spaces.length + ' in ' + txt(l.region) : 'not checked yet', ...kids);
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

/**
 * The agent-space lookup (read-only, under the server's action lock), for the
 * picked repo. One at a time: a second call while one runs does nothing.
 * refresh drops the kept answer (Check again, Retry); btn shows it runs.
 */
async function saLookup(repo, refresh, btn) {
  if (SA_LOOKING || SNAPSHOT) return;
  SA_LOOKING = repo.id;
  SA_LOOK_ERR.delete(repo.id);
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  let r;
  try { r = await api('/api/security-agent/spaces', { repo: repo.id, refresh: !!refresh }); } catch (e) { r = { ok: false, json: { error: e.message } }; }
  SA_LOOKING = null;
  if (!r.ok) SA_LOOK_ERR.set(repo.id, txt((r.json || {}).error) || 'the check was refused');
  await renderSecurity();
}

/** Step 3 starts by itself once per repo, profile and region on this page load, and only while the page is on screen. */
function saAuto(repo) {
  const t = repo.target || {}, key = repo.id + '|' + txt(t.profile) + '|' + txt(t.region);
  if (SNAPSHOT || !repo.gate || repo.gate.state !== 'checking' || SA_AUTO.has(key) || SA_LOOKING || currentView() !== 'security') return;
  SA_AUTO.add(key);
  saLookup(repo, false);
}

/** Steps 1 and 2 check again every SA_POLL_MS while their card is on screen: GET /api/security-agent, local files only. */
function saSchedule(g) {
  if (SA_TIMER) { clearTimeout(SA_TIMER); SA_TIMER = null; }
  if (SNAPSHOT || !g || !SA_POLL_STATES.includes(g.state) || currentView() !== 'security') return;
  SA_TIMER = setTimeout(() => { SA_TIMER = null; if (document.visibilityState === 'visible') renderSecurity(); else saSchedule(g); }, SA_POLL_MS);
}

const saCheckAgain = (label) => {
  const b = el('button', { type: 'button', class: 'run' }, label);
  b.addEventListener('click', () => { b.disabled = true; renderSecurity(); });
  return b;
};
const saRetry = (repo, label) => {
  const b = el('button', { type: 'button', class: 'run', disabled: SA_LOOKING ? '' : null }, label || 'Retry');
  b.addEventListener('click', () => saLookup(repo, true, b));
  return b;
};
const saSettingsLink = () => el('a', { href: '#settings/aws' }, 'Open Settings › AWS →');
const SA_POLL_NOTE = 'This card checks again by itself every 10 s while it is open (local files only; no AWS call).';

/** The gate: the first step not met, as "step n of 3" with a bar and the step list, then what to do. */
function saGateCard(repo) {
  const g = repo.gate, n = g.step || 3;
  const bad = ['profile', 'mismatch', 'sso', 'denied', 'nospace', 'error'].includes(g.state);
  const marks = SA_STEPS.map((_, i) => (i < n - 1 ? 'done' : i === n - 1 ? (bad ? 'bad' : 'now') : null));
  const top = el('div', { class: 'gate-top' },
    el('div', { class: 'gate-step' }, el('span', {}, 'Set up Security Agent · step ' + n + ' of 3'), el('span', {}, (n - 1) + ' of 3 done')),
    el('div', { class: 'gbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '3', 'aria-valuenow': String(n - 1), 'aria-label': 'Setup progress' }, ...marks.map((m) => el('i', { class: m }))),
    el('ol', { class: 'gsteps' }, ...SA_STEPS.map((s, i) => el('li', { class: marks[i] }, s))));
  const body = [el('h3', { id: 'gate-title' }, txt(g.title))];
  const err = SA_LOOK_ERR.get(repo.id);
  if (g.state === 'checking' && err) body.push(el('div', { class: 'callout warn', role: 'note' }, 'The check could not start: ' + txt(err)));
  body.push(...(g.detail || []).map((p) => el('p', {}, txt(p))));
  if (g.using && n === 3) body.push(el('p', { class: 'fix' }, 'AWS: ' + txt(g.using.label) + (g.account4 ? ', account ' + txt(g.account4) : '') + (g.region ? ', ' + txt(g.region) : '')));
  if (g.precedence) body.push(el('div', { class: 'callout', role: 'note' }, txt(g.precedence)));
  const c = g.copy || {};
  const actions = (...kids) => el('div', { class: 'actions' }, ...kids);
  if (g.state === 'connect' || g.state === 'profile') {
    body.push(actions(saSettingsLink(), el('span', { class: 'recheck' }, SA_POLL_NOTE)));
  } else if (g.state === 'setup') {
    body.push(copyOnly(txt(c.setup), 'terminal'),
      el('details', {}, el('summary', {}, 'What it creates in that account'),
        el('ul', {}, el('li', {}, 'a CloudFormation stack, PrismD1SecurityAgent'), el('li', {}, 'an agent space, prism-d1-security'), el('li', {}, 'an IAM service role for the agent'),
          el('li', {}, 'an encrypted S3 bucket for code snapshots'), el('li', {}, 'SSM parameters that point prism-cli and CI at them')),
        el('p', { class: 'fix' }, 'It may incur AWS charges. Each repo gets its code review on its first code review run; there is nothing to set up per repo here.')),
      actions(saCheckAgain('I ran it, check again'), el('span', { class: 'recheck' }, SA_POLL_NOTE)));
  } else if (g.state === 'mismatch') {
    const s = g.setup || {};
    body.push(kv([['Set up', 'account ' + txt(s.account4) + ', ' + txt(s.region) + ' (' + txt(s.file) + ')'], ['In use now', txt(g.using && g.using.label) + ', account ' + txt(g.account4)]]),
      el('div', { class: 'gchoice' },
        el('div', { class: 'gopt' }, el('b', {}, 'Only for this repo'), el('div', { class: 'fix' }, 'Keeps the machine setup for every other repo. Run in ' + txt(repo.name) + ':'), copyOnly(txt(c.repo), null)),
        el('div', { class: 'gopt' }, el('b', {}, 'Change the machine default'), el('div', { class: 'fix' }, 'Every repo on this machine then uses this account:'), copyOnly(txt(c.replace), null))),
      el('p', { class: 'fix' }, 'Or switch back in ', el('a', { href: '#settings/aws' }, 'Settings › AWS'), '.'),
      actions(saCheckAgain('I ran it, check again'), el('span', { class: 'recheck' }, SA_POLL_NOTE)));
  } else if (g.state === 'checking') {
    if (err) body.push(actions(saRetry(repo)));
  } else if (g.state === 'sso') {
    if (c.login) body.push(copyOnly(txt(c.login), 'terminal'));
    body.push(actions(saRetry(repo), saSettingsLink()));
  } else if (g.state === 'denied' || g.state === 'error') {
    body.push(actions(saRetry(repo), saSettingsLink()));
  } else if (g.state === 'nospace') {
    body.push(copyOnly(txt(c.setup || c.repo), 'terminal'), actions(saRetry(repo, 'I ran it, check again')));
  }
  if (SA.repos.length > 1) body.push(el('div', { class: 'srow-ctl' }, el('label', { for: 'sa-repo' }, 'Repo'), saSelect(repo)));
  return el('section', { class: 'gate', id: 'sa-gate', 'data-state': txt(g.state), 'aria-labelledby': 'gate-title' }, top, el('div', { class: 'gate-body' }, ...body));
}

/** All three steps pass: one line with what was checked, and Check again (a fresh lookup). */
function saReadyStrip(repo) {
  const g = repo.gate, l = repo.lookup, s = g.setup || {};
  const space = l && l.ok ? (l.spaces.find((x) => x.inUse) || {}).name || l.inUse : null;
  const again = el('button', { type: 'button', disabled: SA_LOOKING ? '' : null }, SA_LOOKING ? 'Checking…' : 'Check again');
  again.addEventListener('click', () => saLookup(repo, true, again));
  return el('div', { class: 'okstrip', role: 'status', id: 'sa-ready' }, el('b', {}, 'Security Agent ready'),
    el('span', { class: 'ok' }, 'AWS: ' + txt(g.using && g.using.label) + ', account ' + txt(g.account4) + ', ' + txt(g.region)),
    el('span', { class: 'ok' }, 'Setup: ' + (s.source === 'repo' ? 'repo override (' + txt(s.file) + ')' : 'this machine (~/.prism/security.json)')),
    el('span', { class: 'ok' }, 'Agent space ' + txt(space) + (l && l.at ? ', checked ' + when(l.at) : '')),
    again);
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
  const route = securityRoute();
  // A run's drill-down (#security/run/<repo>/<run>) reads its own API and needs nothing else on this page.
  if (route && route.run) { saSchedule(null); drawRunDetail(root, route.run); return; }
  if (typeof runLeave === 'function') runLeave();
  if (!SA_LOADED) { root.replaceChildren(el('p', { class: 'loading' }, 'loading...')); return; }
  const openState = new Map([...root.querySelectorAll('details[data-key]')].map((d) => [d.getAttribute('data-key'), d.open]));
  root.replaceChildren(el('h2', { class: 'sr-only' }, 'Security Agent'));
  if (SNAPSHOT) { root.append(el('section', { class: 'card' }, el('p', { class: 'empty' }, 'The Security Agent page runs on the live dashboard only (prism-cli dashboard). The saved results are on the Dashboard under Security findings.'))); return; }
  if (!SA) { root.append(el('section', { class: 'card' }, pill('error'), ' could not load the Security Agent data')); return; }
  const repo = saRepo();
  if (!repo) { root.append(el('section', { class: 'card' }, el('p', { class: 'empty' }, 'No git repositories found under ' + txt(LAST && LAST.scope && LAST.scope.root_display) + '.'))); return; }
  SA_PICK = repo.id;
  const g = repo.gate;
  saSchedule(g);
  // Nothing else until the three steps pass: runs, results and Start buttons need a working setup.
  if (!g || g.state !== 'ready') {
    if (g) root.append(saGateCard(repo));
    else root.append(el('section', { class: 'card' }, pill('error'), ' the setup check is missing from the Security Agent data'));
    saAuto(repo);
    return;
  }
  root.append(saReadyStrip(repo));
  if (g.precedence) root.append(el('div', { class: 'callout', role: 'note' }, txt(g.precedence)));
  for (const line of g.info || []) root.append(el('div', { class: 'callout', role: 'note' }, txt(line)));
  const left = [saPicker(repo), saResultsCard(repo), saStartCard(repo), saSetupCard(repo, 'Set up already? Re-running enable security is safe: it shows what would change and asks first.')];
  const right = [saAccountCard(repo), saSpacesCard(repo), saHealthCard(repo), saWhichCard()];
  root.append(allRunsCard(), el('div', { class: 'sa-grid' }, el('div', { class: 'sa-col' }, ...left), el('div', { class: 'sa-col' }, ...right)));
  for (const d of root.querySelectorAll('details[data-key]')) { const k = d.getAttribute('data-key'); if (openState.has(k)) d.open = openState.get(k); }
}
`;
