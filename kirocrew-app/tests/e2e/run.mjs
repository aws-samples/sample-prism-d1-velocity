// e2e run for the PRISM Kiro Crew page: the app's real ui/index.mjs and scripts/page_routes.py
// (routes, on_startup, on_shutdown) on a stand-in gateway (fake_gateway.py, 127.0.0.1 only, token
// cookie, Origin check), against a real `prism-cli dashboard --serve-stdio` on demo data. Kiro Crew
// itself is not run: installing the app into a live Kiro Crew would change that install.
// Demo data in a throwaway HOME (cli/test/e2e/seed.mjs), the fake aws first on PATH and
// AWS_EC2_METADATA_DISABLED=true (cli/test/e2e/start-dashboard.mjs demoEnv, which refuses otherwise).
//
//   (cd tests/e2e && npm ci) && node tests/e2e/run.mjs        the local build (../cli/dist; npm run build in cli/ first)
//   PRISM_CLI=/path/to/prism-cli          another prism-cli, e.g. one installed from npm
//   PRISM_CLI_OLD=/path/to/old/prism-cli  also checks the update page against an older prism-cli
//   PRISM_CLI_OTHER=/path/to/prism-cli    another 1.21.0+ version: an open tab redraws from its bundle by itself
//   KC_PYTHON=/path/to/python3            a Python with aiohttp (default: python3)
//   PRISM_E2E_THEME=light                 Kiro Crew's light theme (default: dark)
// Writes results.json and shots/*.png to $PRISM_E2E_OUT (default: <tmp>/prism-kirocrew-e2e); exits 1 when a verdict fails.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..', '..');
const CLI_DIR = resolve(APP, '..', 'cli');
const { demoEnv, ENTRY } = await import(join(CLI_DIR, 'test', 'e2e', 'start-dashboard.mjs'));
const OUT = process.env.PRISM_E2E_OUT || join(tmpdir(), 'prism-kirocrew-e2e');
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PY = process.env.KC_PYTHON || 'python3';
/** The origin the page is served from, as the real gateway serves it (https, page under /apps/prism). */
const HOST = 'https://kirocrew.test';
/** PRISM_E2E_THEME=light: the host page and the PRISM page in Kiro Crew's light theme. */
const THEME = process.env.PRISM_E2E_THEME === 'light' ? 'light' : 'dark';
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

const wrapper = (bin, name, target) => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\nexec ${target} "$@"\n`); chmodSync(p, 0o755); return p; };

function demoHome(tag) {
  const home = join(OUT, 'homes', tag);
  rmSync(home, { recursive: true, force: true });
  execFileSync(process.execPath, [join(CLI_DIR, 'test', 'e2e', 'seed.mjs'), home, 'full'], { stdio: 'ignore' });
  const env = demoEnv(home, { PRISM_NO_UPDATE_CHECK: '1', PYTHONDONTWRITEBYTECODE: '1' });
  const bin = env.PATH.split(':')[0];
  let cli = process.env.PRISM_CLI;
  if (!cli) {
    if (!existsSync(ENTRY)) throw new Error(`${ENTRY} is missing: run npm run build in cli/ first, or set PRISM_CLI`);
    cli = wrapper(bin, 'prism-cli', `node ${JSON.stringify(ENTRY)}`);
  }
  const data = join(home, '.kc-app-data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ cliPath: cli }));
  return { home, env, bin, cli, data, cwd: readFileSync(join(home, '.start-dir'), 'utf8').trim() };
}

function gateway(d) {
  const gw = spawn(PY, [join(HERE, 'fake_gateway.py'), '--app', APP, '--data', d.data, '--react', join(HERE, 'node_modules'), '--theme', THEME], { cwd: d.cwd, env: d.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '';
  const url = new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('the stand-in gateway did not start\n' + log)), 30000);
    gw.stdout.on('data', (b) => { log += b; const m = /READY (\S+)/.exec(log); if (m) { clearTimeout(t); ok(m[1]); } });
    gw.stderr.on('data', (b) => { log += b; });
    gw.on('exit', (c) => { clearTimeout(t); fail(new Error(`the stand-in gateway exited ${c}\n${log}`)); });
  });
  return { gw, url, log: () => log };
}

const childPid = (d) => { try { return Number(readFileSync(join(d.data, 'serve-stdio.pid'), 'utf8').trim()) || null; } catch { return null; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const serveStdioChildren = (ppid) => execFileSync('sh', ['-c', `ps -o pid=,args= --ppid ${ppid} 2>/dev/null | grep -c -- '--serve-stdio' || true`], { encoding: 'utf8' }).trim();

const R = { started: new Date().toISOString(), cli: process.env.PRISM_CLI || 'local build', checks: {} };
const browser = await chromium.launch({ executablePath: chrome(), headless: true });
const stops = [];
try {
  const d = demoHome('page');
  const g = gateway(d);
  stops.push(g.gw);
  const url = await g.url;
  // on_startup ran before the gateway served: the child is up before any page asks for it.
  for (let i = 0; i < 40 && !alive(childPid(d)); i++) await sleep(250);
  R.checks.K7 = { childBeforeFirstRequest: alive(childPid(d)), children: serveStdioChildren(g.gw.pid) };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: THEME });
  const page = await ctx.newPage();
  const csp = [], errors = [], relayed = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('request', (q) => { const u = new URL(q.url()); if (u.pathname.startsWith('/api/apps/prism/ui/')) relayed.push(`${q.method()} ${u.pathname}${u.searchParams.get('path') ? ' ' + u.searchParams.get('path') : ''}${q.postData() ? ' ' + q.postData().slice(0, 120) : ''}`); });
  // Hosted the way the real gateway hosts it: the page at an https URL under /apps/prism, the bundle in a
  // sandboxed srcdoc iframe whose base URL is that https URL. Every request to the https origin is answered
  // by the stand-in gateway (with its session cookie, and its own Origin on a POST).
  const gw = new URL(url), token = gw.searchParams.get('token');
  await page.route(`${HOST}/**`, async (route) => {
    const q = new URL(route.request().url());
    const target = new URL((q.pathname === '/apps/prism' ? '/' : q.pathname) + q.search, gw.origin);
    const headers = { ...route.request().headers(), cookie: `kc_stand_in=${token}` };
    if (headers.origin) headers.origin = gw.origin;
    try { await route.fulfill({ response: await route.fetch({ url: target.href, headers }) }); } catch { await route.abort(); }
  });
  let pageNavigations = 0;
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) pageNavigations++; });
  await page.goto(`${HOST}/apps/prism`);
  await page.waitForSelector('iframe[title=PRISM]', { timeout: 60000 });
  const frame = () => page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame() && f.name() !== 'report');
  let f = frame();
  await f.waitForSelector('#summary', { timeout: 60000 });
  await sleep(1500);
  R.checks.K1 = { kind: await f.evaluate(() => TRANSPORT.kind), cards: await f.$$eval('#summary .scard', (n) => n.length), repos: await f.$$eval('#codewatch tbody tr', (n) => n.length),
    sandbox: await page.$eval('iframe[title=PRISM]', (x) => x.getAttribute('sandbox')) };
  await page.screenshot({ path: join(SHOTS, 'page-dashboard.png') });

  // Real clicks on every kind of in-app link. The frame must stay on its own document (about:srcdoc),
  // the view must change, and the page must not be blank; no new tab may open.
  const clicks = [];
  const state = async () => {
    const fr = frame();
    if (!fr) return { url: 'no frame' };
    return { url: fr.url(), ...(await fr.evaluate(() => {
      const shown = [...document.querySelectorAll('main')].find((m) => !m.hidden && getComputedStyle(m).display !== 'none');
      return { hash: location.hash, view: shown ? shown.id : null, text: shown ? shown.innerText.trim().length : 0, bg: getComputedStyle(document.body).backgroundColor };
    }).catch((e) => ({ error: String(e).slice(0, 120) }))) };
  };
  const tabsBefore = ctx.pages().length;
  const click = async (name, selector, opts = {}, how = 'click') => {
    const fr = frame();
    const loc = fr.locator(selector).first();
    if (!(await loc.count())) { clicks.push({ name, missing: selector }); return; }
    if (how === 'enter') { await loc.focus(); await page.keyboard.press('Enter'); } else await loc.click(opts);
    await sleep(900);
    clicks.push({ name, ...(await state()), tabs: ctx.pages().length - tabsBefore });
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
  await click('nav: Security Agent by middle click (stays in the frame)', 'nav.tabs a[data-view="security"]', { button: 'middle' });
  await click('nav: Dashboard by ctrl+click (stays in the frame)', 'nav.tabs a[data-view="dashboard"]', { modifiers: ['Control'] });
  R.checks.K12 = clicks;
  await page.screenshot({ path: join(SHOTS, 'page-after-clicks.png') });

  // A report link: the page reads /api/report and shows it in an empty-sandbox overlay.
  await f.locator('#codewatch a.rlink').first().click();
  await page.waitForSelector('iframe[title="Codewatch report"]', { timeout: 20000 }).catch(() => {});
  await sleep(800);
  R.checks.K3 = { overlay: await page.$eval('iframe[title="Codewatch report"]', (x) => ({ sandbox: x.getAttribute('sandbox'), csp: /Content-Security-Policy/.test(x.getAttribute('srcdoc') || ''), script: /<script/i.test(x.getAttribute('srcdoc') || '') })).catch(() => null),
    hash: await f.evaluate(() => location.hash) };
  await page.screenshot({ path: join(SHOTS, 'page-report.png') });
  await page.click('button:has-text("Close")').catch(() => {});

  const href = await f.$eval('a[href^="#security/run/"]', (a) => a.getAttribute('href'));
  await f.evaluate((h) => { location.hash = h; }, href);
  await f.waitForSelector('[data-run-findings]', { timeout: 20000 }).catch(() => {});
  await sleep(600);
  R.checks.K2 = { findings: await f.$$eval('[data-run-findings] details', (n) => n.length).catch(() => 0) };
  await page.screenshot({ path: join(SHOTS, 'page-findings.png') });

  // A confirmed local action: Settings › AWS › Disconnect.
  await f.evaluate(() => { location.hash = '#settings/aws'; }); await sleep(1200);
  await f.locator('#settings button', { hasText: /disconnect/i }).first().click(); await sleep(400);
  const runDisabled = await f.evaluate(() => [...document.querySelectorAll('dialog.confirm button')].find((b) => b.textContent === 'Run')?.disabled);
  await f.locator('dialog.confirm input[type=checkbox]').check();
  await page.screenshot({ path: join(SHOTS, 'page-confirm.png') });
  await f.click('dialog.confirm button:has-text("Run")');
  let result = '';
  for (let i = 0; i < 120 && !/exit \d+|refused/.test(result); i++) { await sleep(300); result = await f.evaluate(() => document.querySelector('#action-drawer .srow-head')?.innerText || ''); }
  R.checks.K4 = { runDisabled, result: result.replace(/\s+/g, ' ').slice(0, 120), fileGone: !existsSync(join(d.home, '.prism', 'aws.json')) };
  await sleep(1500);
  await page.screenshot({ path: join(SHOTS, 'page-action-done.png') });

  // An AWS-writing start goes through the same dialog and reaches prism-cli, whose write gate refuses it here (no agent-space lookup).
  await f.evaluate(() => { location.hash = '#security'; }); await sleep(1500);
  R.checks.K5 = await f.evaluate(() => api('/api/action', { action: 'security-code-review', repo: Object.values(SETUP.repoIds)[0], confirm: true }).then((x) => ({ status: x.status, error: x.json.error })));
  R.checks.K5.relayed = relayed.some((x) => /POST \/api\/apps\/prism\/ui\/act .*security-code-review/.test(x));
  R.checks.K5.noConfirm = await f.evaluate(() => api('/api/action', { action: 'aws-disconnect' }).then((x) => x.status));

  R.checks.K6 = { csp: csp.length, errors,
    fetch: await f.evaluate(() => fetch('/api/apps/prism/ui/bundle').then(() => 'allowed', () => 'blocked')),
    parent: await f.evaluate(() => { try { return 'readable ' + window.parent.document.title; } catch (e) { return 'blocked'; } }),
    cookie: await f.evaluate(() => { try { return 'readable ' + document.cookie; } catch (e) { return 'blocked'; } }),
    listen: execFileSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep 'pid=${childPid(d)},' || true`], { encoding: 'utf8' }).trim(),
    gatewayListen: execFileSync('sh', ['-c', `ss -ltn 2>/dev/null | grep ':${new URL(url).port} ' || true`], { encoding: 'utf8' }).trim() };

  // A crash: the next request is answered by a restarted child.
  const before = childPid(d);
  process.kill(before, 'SIGKILL');
  await sleep(1500);
  await page.reload(); await page.waitForSelector('iframe[title=PRISM]', { timeout: 60000 }); f = frame();
  await f.waitForSelector('#summary', { timeout: 60000 }).catch(() => {});
  R.checks.K8 = { before, after: childPid(d), drawn: !!(await f.$('#summary')), children: serveStdioChildren(g.gw.pid) };

  // A new prism-cli (another resolved path): picked up before the next request.
  const prev = childPid(d);
  const moved = wrapper(d.bin, 'prism-cli-new', d.cli);
  writeFileSync(join(d.data, 'config.json'), JSON.stringify({ cliPath: moved }));
  await page.reload(); await page.waitForSelector('iframe[title=PRISM]', { timeout: 60000 }); f = frame();
  await f.waitForSelector('#summary', { timeout: 60000 }).catch(() => {});
  R.checks.K9 = { before: prev, after: childPid(d), prevGone: !alive(prev), drawn: !!(await f.$('#summary')), children: serveStdioChildren(g.gw.pid) };

  // prism-cli updated while the tab is open: the next answer carries the new version and the page redraws from
  // the new bundle by itself (no reload of the tab).
  if (process.env.PRISM_CLI_OTHER) {
    const navBefore = pageNavigations;
    // The bundle on screen, not the data: the version pill follows /api/data, which the new CLI answers either way.
    const srcdoc = () => page.$eval('iframe[title=PRISM]', (x) => x.getAttribute('srcdoc') || '').catch(() => '');
    const docBefore = await srcdoc();
    const shownBefore = await f.evaluate(() => document.querySelector('.verpill')?.textContent || '');
    writeFileSync(join(d.data, 'config.json'), JSON.stringify({ cliPath: process.env.PRISM_CLI_OTHER }));
    const want = execFileSync(process.env.PRISM_CLI_OTHER, ['--version'], { env: d.env, encoding: 'utf8' }).trim();
    await f.click('#refresh');
    let shownAfter = '';
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const fr = frame();
      shownAfter = fr ? await fr.evaluate(() => document.querySelector('.verpill')?.textContent || '').catch(() => '') : '';
      if (shownAfter.includes(want) && (await srcdoc()) !== docBefore) break;
    }
    const docAfter = await srcdoc();
    f = frame();
    R.checks.K13 = { shownBefore, want, shownAfter, url: f ? f.url() : null, tabReloads: pageNavigations - navBefore, bundleRedrawn: docAfter !== docBefore && docAfter.length > 1000 };
    await page.screenshot({ path: join(SHOTS, 'page-after-cli-update.png') });
  }

  // An older prism-cli: the page shows only how to update.
  if (process.env.PRISM_CLI_OLD) {
    writeFileSync(join(d.data, 'config.json'), JSON.stringify({ cliPath: process.env.PRISM_CLI_OLD }));
    await page.reload();
    await page.waitForSelector('text=Update prism-cli to 1.21.0 or later', { timeout: 30000 }).catch(() => {});
    R.checks.K10 = { text: (await page.innerText('#root')).replace(/\s+/g, ' ').slice(0, 300), iframe: !!(await page.$('iframe[title=PRISM]')) };
    await page.screenshot({ path: join(SHOTS, 'page-update-prism-cli.png') });
  }
  await ctx.close();

  // on_shutdown (app disabled / gateway stopping) stops the child.
  const last = childPid(d);
  const exited = new Promise((ok) => { g.gw.on('exit', ok); setTimeout(ok, 15000); });
  g.gw.stdin.end();
  await exited;
  R.checks.K11 = { stopped: !alive(last), pidFile: existsSync(join(d.data, 'serve-stdio.pid')) };
  R.checks.aws = existsSync(join(d.home, 'aws-calls.log')) ? readFileSync(join(d.home, 'aws-calls.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
} catch (e) {
  R.fatal = String(e.stack || e);
} finally {
  for (const p of stops) { try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill(); } catch {} }, 5000).unref(); }
  await browser.close();
}

const C = R.checks, v = [];
const add = (id, name, pass, why) => v.push({ id, name, pass: !!pass, why: pass ? '' : String(JSON.stringify(why)).slice(0, 400) });
add('K1', 'the page draws the Dashboard from prism-cli\'s own bundle in an allow-scripts-only sandbox', C.K1 && C.K1.kind === 'embedded' && C.K1.cards === 4 && C.K1.repos >= 3 && C.K1.sandbox === 'allow-scripts', C.K1);
add('K2', 'a Security Agent findings page', C.K2?.findings > 0, C.K2);
add('K3', 'a report link opens the report in an empty-sandbox overlay with its CSP and no script, no navigation', C.K3?.overlay?.sandbox === '' && C.K3.overlay.csp && !C.K3.overlay.script && C.K3.hash === '', C.K3);
add('K4', 'a confirmed action runs from the page: Run disabled until the checkbox, exit 0, the file removed', C.K4?.runDisabled === true && /exit 0/.test(C.K4.result) && C.K4.fileGone, C.K4);
add('K5', 'an AWS-writing start reaches prism-cli through /ui/act and gets its write gate (409); no confirm gets 400', C.K5?.status === 409 && C.K5.relayed && C.K5.noConfirm === 400, C.K5);
add('K6', 'the frame cannot fetch, read the parent or the cookie; 0 CSP violations before those probes; no listener but the gateway\'s on 127.0.0.1',
  C.K6 && C.K6.csp === 0 && !C.K6.errors.length && C.K6.fetch === 'blocked' && C.K6.parent === 'blocked' && C.K6.cookie === 'blocked' && !C.K6.listen && /127\.0\.0\.1:/.test(C.K6.gatewayListen), C.K6);
add('K7', 'on_startup starts the one child before any request', C.K7?.childBeforeFirstRequest && C.K7.children === '1', C.K7);
add('K8', 'a crashed child is restarted and the page draws again, still one child', C.K8 && C.K8.after && C.K8.after !== C.K8.before && C.K8.drawn && C.K8.children === '1', C.K8);
add('K9', 'a new prism-cli is picked up before the next request: the old child stops, one new child', C.K9 && C.K9.after !== C.K9.before && C.K9.prevGone && C.K9.drawn && C.K9.children === '1', C.K9);
if (process.env.PRISM_CLI_OTHER) add('K13', 'after prism-cli changes version, the open tab redraws from the new bundle on its next request, without a reload of the tab',
  C.K13 && C.K13.shownAfter.includes(C.K13.want) && !C.K13.shownBefore.includes(C.K13.want) && /^about:srcdoc/.test(C.K13.url || '') && C.K13.tabReloads === 0 && C.K13.bundleRedrawn, C.K13);
const EXPECT_VIEW = { 'nav: Security Agent': 'security', 'nav: AccountGuard': 'accountguard', 'nav: Settings': 'settings', 'Settings tab: AWS': 'settings', 'nav: Dashboard': 'main',
  'repo link': 'repo', 'crumb back to Dashboard': 'main', 'findings link': 'security', 'nav: Settings by keyboard (Enter)': 'settings',
  'nav: Security Agent by middle click (stays in the frame)': 'security', 'nav: Dashboard by ctrl+click (stays in the frame)': 'main' };
const badClick = (c) => c.missing || !/^about:srcdoc/.test(c.url || '') || c.view !== EXPECT_VIEW[c.name] || !(c.text > 50) || /rgba?\(255, 255, 255/.test(c.bg || '') || c.tabs !== 0;
add('K12', 'clicking every kind of in-app link (top nav, a Settings tab, a repo, a crumb, a findings link; Enter, middle and ctrl click) keeps the frame on about:srcdoc, changes the view and opens no tab',
  Array.isArray(C.K12) && C.K12.length === Object.keys(EXPECT_VIEW).length && !C.K12.some(badClick), (C.K12 || []).filter(badClick));
add('K11', 'on_shutdown stops the child and removes its pid file', C.K11?.stopped && !C.K11.pidFile, C.K11);
add('aws', 'the fake aws saw read-only calls only', Array.isArray(C.aws) && C.aws.every((x) => READ_ONLY_AWS.test(x)), C.aws);
if (process.env.PRISM_CLI_OLD) add('K10', 'an older prism-cli: only "Update prism-cli to 1.21.0 or later" and the npm command, no frame',
  C.K10 && /Update prism-cli to 1\.21\.0 or later/.test(C.K10.text) && /npm install -g @prism-d1\/cli@latest/.test(C.K10.text) && !C.K10.iframe, C.K10);
R.verdicts = v;
writeFileSync(join(OUT, 'results.json'), JSON.stringify(R, null, 2));
for (const x of v) console.log((x.pass ? 'PASS ' : 'FAIL ') + x.id + ' ' + x.name + (x.pass ? '' : ': ' + x.why));
console.log(`${v.filter((x) => x.pass).length}/${v.length} verdicts pass (prism-cli: ${R.cli}); results ${join(OUT, 'results.json')}; screenshots ${SHOTS}` + (R.fatal ? '\nFATAL: ' + R.fatal : ''));
process.exitCode = v.every((x) => x.pass) && !R.fatal ? 0 : 1;
