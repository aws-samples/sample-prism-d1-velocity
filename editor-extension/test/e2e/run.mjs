// Webview harness for the PRISM panel: the extension's own ui-host.js (uiHtml, StdioClient,
// handlePanelMessage, updateHtml) with Chromium standing in for the VS Code webview. VS Code itself is
// not run (it needs a display); what stands in for it here:
//   - localResourceRoots = [uiDir]: page.route serves only the bundle's own files, by name;
//   - acquireVsCodeApi().postMessage -> handlePanelMessage, and webview.postMessage -> a message event;
//   - the native modal (showWarningMessage) -> a recorded answer.
// Demo data in a throwaway HOME (cli/test/e2e/seed.mjs), the fake aws first on PATH and
// AWS_EC2_METADATA_DISABLED=true (cli/test/e2e/start-dashboard.mjs demoEnv, which refuses otherwise).
//
//   npm run test:e2e                      the local build (../cli/dist; run npm run build in cli/ first)
//   PRISM_CLI=/path/to/prism-cli npm run test:e2e        another prism-cli, e.g. one installed from npm
//   PRISM_CLI_OLD=/path/to/old/prism-cli  also checks the update panel against an older prism-cli
// Writes results.json and shots/*.png to $PRISM_E2E_OUT (default: <tmp>/prism-editor-e2e); exits 1 when a verdict fails.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '..', '..');
const CLI_DIR = resolve(EXT, '..', 'cli');
const host = createRequire(import.meta.url)(join(EXT, 'out', 'src', 'ui-host.js'));
const { demoEnv, ENTRY } = await import(join(CLI_DIR, 'test', 'e2e', 'start-dashboard.mjs'));
const OUT = process.env.PRISM_E2E_OUT || join(tmpdir(), 'prism-editor-e2e');
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ_ONLY_AWS = /^(--version|configure list-profiles|sts get-caller-identity|iam list-account-aliases|organizations describe-organization|iam list-attached|securityagent list-agent-spaces|securityagent batch-get-agent-spaces|ssm get-parameter)/;

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  const d = existsSync(base) ? readdirSync(base).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null;
  const exe = d ? join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell') : null;
  if (!exe || !existsSync(exe)) throw new Error('no Chromium: set CHROME, or npx playwright-core install chromium-headless-shell');
  return exe;
}

/** A seeded demo HOME and the prism-cli to run there (PRISM_CLI, else a wrapper around the local build, as npm -g links it). */
function demoHome(tag) {
  const home = join(OUT, 'homes', tag);
  rmSync(home, { recursive: true, force: true });
  execFileSync(process.execPath, [join(CLI_DIR, 'test', 'e2e', 'seed.mjs'), home, 'full'], { stdio: 'ignore' });
  const env = demoEnv(home, { PRISM_NO_UPDATE_CHECK: '1' });
  let cli = process.env.PRISM_CLI;
  if (!cli) {
    if (!existsSync(ENTRY)) throw new Error(`${ENTRY} is missing: run npm run build in cli/ first, or set PRISM_CLI`);
    cli = join(env.PATH.split(':')[0], 'prism-cli');
    writeFileSync(cli, `#!/bin/sh\nexec node ${JSON.stringify(ENTRY)} "$@"\n`);
    chmodSync(cli, 0o755);
  }
  return { home, env, cwd: readFileSync(join(home, '.start-dir'), 'utf8').trim(), cli };
}

const R = { started: new Date().toISOString(), cli: process.env.PRISM_CLI || 'local build', checks: {} };
const browser = await chromium.launch({ executablePath: chrome(), headless: true });
const RES = 'https://file+.vscode-resource.vscode-cdn.net';
const WEBVIEW = 'https://webview.vscode.test/index.html';
let client;
try {
  const d = demoHome('panel');
  client = new host.StdioClient(d.cli, d.cwd, d.env);
  const hello = await client.start();
  const relayed = [];
  const request = client.request.bind(client);
  client.request = (r) => { relayed.push(r.op + ' ' + r.path + (r.body?.action ? ' ' + r.body.action : '')); return request(r); };
  const files = JSON.parse(readFileSync(join(hello.uiDir, 'manifest.json'), 'utf8')).files;
  const html = host.uiHtml({ nonce: randomBytes(16).toString('base64'), cspSource: 'https://*.vscode-cdn.net', cssUri: `${RES}/ui/prism-ui.css`, bridgeUri: `${RES}/ui/bridge.js`, jsUri: `${RES}/ui/prism-ui.js`,
    body: readFileSync(join(hello.uiDir, 'body.html'), 'utf8'), theme: 'dark' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const csp = [], errors = [], asked = [], reports = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.route(`${RES}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.replace(/^\/ui\//, '');
    if (!files.includes(name)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(join(hello.uiDir, name)) });
  });
  await page.route(WEBVIEW, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  let modalAnswer = false;
  await page.exposeBinding('__vscodePost', (_s, m) => host.handlePanelMessage(m, client, {
    confirm: async (c) => { asked.push(c); return modalAnswer; },
    showReport: (h) => reports.push(h),
    noReport: (s) => reports.push('NO REPORT ' + s),
    post: (msg) => page.evaluate((x) => window.dispatchEvent(new MessageEvent('message', { data: x })), msg),
  }));
  await page.addInitScript(() => { let used = false; window.acquireVsCodeApi = () => { if (used) throw new Error('acquireVsCodeApi called twice'); used = true; return { postMessage: (m) => window.__vscodePost(m), getState: () => undefined, setState: () => {} }; }; });
  // VS Code's webview host script handles link clicks itself (a window click listener, after the page's own
  // handlers): an href="#x" only scrolls to the element and is cancelled, any other link is cancelled and
  // handed to the editor ("did-click-link"). Modelled here so an in-app link that relies on the default
  // fragment navigation fails in the harness as it does in VS Code.
  // shortcut: a model of VS Code's handleInnerClick written from its documented behaviour; check it if VS Code changes it.
  const external = [];
  await page.exposeBinding('__vscodeDidClickLink', (_s, href) => { external.push(href); });
  await page.addInitScript(() => {
    window.addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!a || e.defaultPrevented) return;
      const href = a.getAttribute('href');
      if (href === '#') window.scrollTo(0, 0);
      else if (href.startsWith('#')) document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView();
      else window.__vscodeDidClickLink(a.href);
      e.preventDefault();
    });
  });
  await page.goto(WEBVIEW);
  await page.waitForSelector('#summary', { timeout: 60000 });
  await sleep(1500);
  R.checks.V1 = { hello: { api: hello.api, version: hello.version }, kind: await page.evaluate(() => TRANSPORT.kind), cards: await page.$$eval('#summary .scard', (n) => n.length), repos: await page.$$eval('#codewatch tbody tr', (n) => n.length) };
  await page.screenshot({ path: join(SHOTS, 'panel-dashboard.png') });

  // Real clicks on every kind of in-app link: the webview stays on its document, the view changes, nothing opens outside.
  const clicks = [];
  const tabsBefore = ctx.pages().length;
  const click = async (name, selector, opts = {}, how = 'click') => {
    const loc = page.locator(selector).first();
    if (!(await loc.count())) { clicks.push({ name, missing: selector }); return; }
    if (how === 'enter') { await loc.focus(); await page.keyboard.press('Enter'); } else await loc.click(opts);
    await sleep(900);
    clicks.push({ name, url: page.url().split('#')[0], ...(await page.evaluate(() => {
      const shown = [...document.querySelectorAll('main')].find((m) => !m.hidden && getComputedStyle(m).display !== 'none');
      return { hash: location.hash, view: shown ? shown.id : null, text: shown ? shown.innerText.trim().length : 0 };
    })), tabs: ctx.pages().length - tabsBefore, external: external.length });
  };
  await click('nav: Security Agent', 'nav.tabs a[data-view="security"]');
  await click('nav: AccountGuard', 'nav.tabs a[data-view="accountguard"]');
  await click('nav: Settings', 'nav.tabs a[data-view="settings"]');
  await click('Settings tab: AWS', '#settings a[data-tab="aws"]');
  await click('nav: Dashboard', 'nav.tabs a[data-view="dashboard"]');
  await click('repo link', '#codewatch tbody a[href^="#repo/"]');
  await click('crumb back to Dashboard', '#repo .crumbs a[href="#"]');
  await click('findings link', '#main a[href^="#security/run/"]');
  await click('nav: Settings by keyboard (Enter)', 'nav.tabs a[data-view="settings"]', {}, 'enter');
  await click('nav: Security Agent by middle click (stays in the panel)', 'nav.tabs a[data-view="security"]', { button: 'middle' });
  await click('nav: Dashboard by ctrl+click (stays in the panel)', 'nav.tabs a[data-view="dashboard"]', { modifiers: ['Control'] });
  R.checks.V9 = clicks;

  // A report link: the panel asks the extension, which reads /api/report and shows it with scripts off.
  await page.locator('#codewatch a.rlink').first().click();
  for (let i = 0; i < 40 && !reports.length; i++) await sleep(250);
  R.checks.V3 = { reports: reports.length, html: /<html/i.test(reports[0] || ''), script: /<script/i.test(reports[0] || ''), hash: await page.evaluate(() => location.hash) };
  if (reports[0] && !reports[0].startsWith('NO')) {
    const rp = await ctx.newPage();
    await rp.setContent(host.withReportCsp(reports[0]));
    await rp.screenshot({ path: join(SHOTS, 'panel-report.png') });
    await rp.close();
  }

  const href = await page.$eval('a[href^="#security/run/"]', (a) => a.getAttribute('href'));
  await page.evaluate((h) => { location.hash = h; }, href);
  await page.waitForSelector('[data-run-findings]', { timeout: 20000 }).catch(() => {});
  await sleep(600);
  R.checks.V2 = { route: href, findings: await page.$$eval('[data-run-findings] details', (n) => n.length).catch(() => 0) };
  await page.screenshot({ path: join(SHOTS, 'panel-findings.png') });

  // A local confirm action: the panel's dialog only (no native modal), then it runs.
  await page.evaluate(() => { location.hash = '#settings/aws'; }); await sleep(1200);
  await page.locator('#settings button', { hasText: /disconnect/i }).first().click(); await sleep(400);
  const runDisabled = await page.evaluate(() => [...document.querySelectorAll('dialog.confirm button')].find((b) => b.textContent === 'Run')?.disabled);
  await page.locator('dialog.confirm input[type=checkbox]').check();
  await page.screenshot({ path: join(SHOTS, 'panel-confirm.png') });
  await page.click('dialog.confirm button:has-text("Run")');
  let result = '';
  for (let i = 0; i < 120 && !/exit \d+|refused/.test(result); i++) { await sleep(300); result = await page.evaluate(() => document.querySelector('#action-drawer .srow-head')?.innerText || ''); }
  R.checks.V4 = { runDisabled, result: result.replace(/\s+/g, ' ').slice(0, 120), fileGone: !existsSync(join(d.home, '.prism', 'aws.json')), asked: asked.length };
  await sleep(1500);
  await page.screenshot({ path: join(SHOTS, 'panel-action-done.png') });

  // An AWS write: the native modal first. Declined, the request never reaches prism-cli.
  const before = relayed.filter((x) => /security-code-review/.test(x)).length;
  modalAnswer = false;
  await page.evaluate(() => startAction(actionDef('security-code-review'), { repo: Object.values(SETUP.repoIds)[0] }));
  for (let i = 0; i < 40 && !/refused/.test(result = await page.evaluate(() => document.querySelector('#action-drawer .srow-head')?.innerText || '')); i++) await sleep(250);
  R.checks.V5 = { asked: asked.map((a) => a.title), detail: asked[0]?.detail, drawer: result.replace(/\s+/g, ' ').slice(0, 160), relayed: relayed.filter((x) => /security-code-review/.test(x)).length - before };
  await page.screenshot({ path: join(SHOTS, 'panel-aws-write-declined.png') });

  R.checks.V6 = { csp: csp.length, errors, fetch: await page.evaluate(() => fetch('/api/data').then(() => 'allowed', () => 'blocked')),
    listen: execFileSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep 'pid=${client.proc?.pid},' || true`], { encoding: 'utf8' }).trim() };
  const pid = client.proc?.pid;
  client.dispose();
  await sleep(2500);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  R.checks.V7 = { exited: !alive };
  R.checks.aws = (existsSync(join(d.home, 'aws-calls.log')) ? readFileSync(join(d.home, 'aws-calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []);
  await ctx.close();

  // An older prism-cli: the panel shows only how to update it.
  if (process.env.PRISM_CLI_OLD) {
    const o = demoHome('old');
    const old = new host.StdioClient(process.env.PRISM_CLI_OLD, o.cwd, o.env);
    let err = '';
    try { await old.start(); } catch (e) { err = e.message; }
    old.dispose();
    const version = execFileSync(process.env.PRISM_CLI_OLD, ['--version'], { env: o.env, encoding: 'utf8' }).trim();
    const up = await browser.newPage({ viewport: { width: 1280, height: 500 } });
    await up.setContent(host.updateHtml({ reason: `The prism-cli at ${process.env.PRISM_CLI_OLD} (${version}) is older than this panel needs.`, command: host.UPDATE_CMD }));
    R.checks.V8 = { version, err, text: (await up.innerText('body')).replace(/\s+/g, ' ') };
    await up.screenshot({ path: join(SHOTS, 'panel-update-prism-cli.png') });
    await up.close();
  }
} catch (e) {
  R.fatal = String(e.stack || e);
} finally {
  client?.dispose();
  await browser.close();
}

const C = R.checks, v = [];
const add = (id, name, pass, why) => v.push({ id, name, pass: !!pass, why: pass ? '' : String(JSON.stringify(why)).slice(0, 400) });
add('V1', 'the panel draws the Dashboard from prism-cli\'s own bundle over --serve-stdio (1.21.0 or later)', C.V1 && host.cliIsCurrent(C.V1.hello.version) && C.V1.kind === 'vscode' && C.V1.cards === 4 && C.V1.repos >= 3, C.V1);
add('V2', 'a Security Agent findings page', C.V2?.findings > 0, C.V2);
add('V3', 'a report link opens the report in the extension (no navigation), HTML without script', C.V3?.reports === 1 && C.V3.html && !C.V3.script && C.V3.hash === '', C.V3);
add('V4', 'a local confirm action: the panel dialog only, Run disabled until the checkbox, exit 0, the file removed', C.V4?.runDisabled === true && /exit 0/.test(C.V4.result) && C.V4.fileGone && C.V4.asked === 0, C.V4);
add('V5', 'an AWS write asks the native modal first; declined, it never reaches prism-cli and the drawer says so',
  C.V5?.asked.length === 1 && /Start a code review of this branch\? This writes to AWS/.test(C.V5.asked[0]) && /Cancelled in VS Code/.test(C.V5.drawer) && C.V5.relayed === 0, C.V5);
add('V6', 'no CSP violation before the fetch probe, no page error, fetch blocked, the child listens on no port', C.V6 && C.V6.csp === 0 && !C.V6.errors.length && C.V6.fetch === 'blocked' && !C.V6.listen, C.V6);
const EXPECT_VIEW = { 'nav: Security Agent': 'security', 'nav: AccountGuard': 'accountguard', 'nav: Settings': 'settings', 'Settings tab: AWS': 'settings', 'nav: Dashboard': 'main',
  'repo link': 'repo', 'crumb back to Dashboard': 'main', 'findings link': 'security', 'nav: Settings by keyboard (Enter)': 'settings',
  'nav: Security Agent by middle click (stays in the panel)': 'security', 'nav: Dashboard by ctrl+click (stays in the panel)': 'main' };
const badClick = (c) => c.missing || c.url !== WEBVIEW || c.view !== EXPECT_VIEW[c.name] || !(c.text > 50) || c.tabs !== 0 || c.external !== 0;
add('V9', 'clicking every kind of in-app link (top nav, a Settings tab, a repo, a crumb, a findings link; Enter, middle and ctrl click) keeps the webview on its document, changes the view and hands nothing to the editor',
  Array.isArray(C.V9) && C.V9.length === Object.keys(EXPECT_VIEW).length && !C.V9.some(badClick), (C.V9 || []).filter(badClick));
add('V7', 'closing the panel stops the child', C.V7?.exited, C.V7);
add('aws', 'the fake aws saw read-only calls only', Array.isArray(C.aws) && C.aws.every((x) => READ_ONLY_AWS.test(x)), C.aws);
if (process.env.PRISM_CLI_OLD) add('V8', 'an older prism-cli: the panel shows only "Update prism-cli to 1.21.0 or later" and the npm command',
  C.V8 && C.V8.err.startsWith(host.UPDATE_TEXT) && /Update prism-cli to 1\.21\.0 or later/.test(C.V8.text) && /npm install -g @prism-d1\/cli@latest/.test(C.V8.text), C.V8);
R.verdicts = v;
writeFileSync(join(OUT, 'results.json'), JSON.stringify(R, null, 2));
for (const x of v) console.log((x.pass ? 'PASS ' : 'FAIL ') + x.id + ' ' + x.name + (x.pass ? '' : ': ' + x.why));
console.log(`${v.filter((x) => x.pass).length}/${v.length} verdicts pass (prism-cli: ${R.cli}); results ${join(OUT, 'results.json')}; screenshots ${SHOTS}` + (R.fatal ? '\nFATAL: ' + R.fatal : ''));
process.exitCode = v.every((x) => x.pass) && !R.fatal ? 0 : 1;
