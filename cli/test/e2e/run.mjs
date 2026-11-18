// Playwright e2e run over the prism-cli dashboard: the live server and the static snapshot, on DEMO
// data in throwaway HOMEs, with a fake aws CLI (nothing reaches AWS) and a fake codeburn.
//   npm run test:e2e                 every suite (cli/, after npm run build)
//   npm run test:e2e -- auth nav     only the named suites
// Needs a Chromium: CHROME=/path/to/chrome, else the newest Playwright headless shell under
// ~/.cache/ms-playwright (npx playwright-core install chromium-headless-shell). Not part of npm test or CI.
// Writes results.json, verdicts and shots/*.png to $PRISM_E2E_OUT (default: <tmp>/prism-dashboard-e2e);
// exits 1 when a verdict fails.
import { chromium } from 'playwright-core';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboard, demoEnv, ENTRY, CLI } from './start-dashboard.mjs';
// The same account-id rule the dashboard masks with: ARNs, Account lines, account fields and bare runs,
// but not a commit prefix, result id or UUID group that happens to be 12 digits.
const { accountIdsIn } = await import(join(CLI, 'dist', 'src', 'utils', 'redact.js'));
const DEMO_ACCOUNT = '111122223333';
/** Account ids left in `text`: the demo account anywhere, or any 12-digit run in an account context. */
const accountLeaks = (text) => [...new Set([...(String(text).includes(DEMO_ACCOUNT) ? [DEMO_ACCOUNT] : []), ...accountIdsIn(String(text))])];

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.PRISM_E2E_OUT || join(tmpdir(), 'prism-dashboard-e2e');
const SHOTS = join(OUT, 'shots');
const SCRATCH = join(OUT, 'homes');
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  const d = existsSync(base) ? readdirSync(base).filter((x) => x.startsWith('chromium_headless_shell-')).sort().pop() : null;
  const exe = d ? join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell') : null;
  if (!exe || !existsSync(exe)) throw new Error('no Chromium found: set CHROME=/path/to/chrome, or run npx playwright-core install chromium-headless-shell');
  return exe;
}
const CHROME = findChrome();
mkdirSync(SHOTS, { recursive: true });
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
const R = { chrome: CHROME, started: new Date().toISOString(), suites: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seed(name, scenario, extra) {
  const home = join(SCRATCH, 'e2e-' + name);
  rmSync(home, { recursive: true, force: true });
  execFileSync(process.execPath, [join(HERE, 'seed.mjs'), home, scenario], { encoding: 'utf8' });
  if (extra) extra(home);
  return home;
}

/** demo-shop's seeded pending review (job-demo-2): removed, so the dashboard has nothing to auto-check. */
function dropPending(home) {
  const dir = join(home, 'src', 'demo-shop', '.prism', 'results');
  for (const f of readdirSync(dir)) if (f.endsWith('.json') && JSON.parse(readFileSync(join(dir, f), 'utf8')).status === 'pending') rmSync(join(dir, f));
}
/** The same record started `h` hours ago: past the stale window, so only an auto-check can show it running or complete. */
function agePending(home, h) {
  const dir = join(home, 'src', 'demo-shop', '.prism', 'results');
  const t = new Date(Date.now() - h * 3600e3).toISOString();
  for (const f of readdirSync(dir)) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (r.status === 'pending') writeFileSync(join(dir, f), JSON.stringify({ ...r, started_at: t, finished_at: t }, null, 2) + '\n');
  }
}
/** Switches the fake aws of a running dashboard (fakebin/aws reads $HOME/fake-aws-mode). */
const fakeMode = (home, mode) => writeFileSync(join(home, 'fake-aws-mode'), mode);

/** A page that records console errors/warnings, page errors, failed requests and 4xx/5xx. */
function watch(page, log, tag) {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push({ tag: tag(), type: 'console.' + m.type(), text: m.text().slice(0, 300) }); });
  page.on('pageerror', (e) => log.push({ tag: tag(), type: 'pageerror', text: String(e).slice(0, 300) }));
  page.on('requestfailed', (q) => log.push({ tag: tag(), type: 'requestfailed', text: q.method() + ' ' + q.url().replace(/token=[^&]+/, 'token=…') + ' ' + (q.failure()?.errorText || '') }));
  page.on('response', (s) => { if (s.status() >= 400) log.push({ tag: tag(), type: 'http' + s.status(), text: s.request().method() + ' ' + s.url().replace(/token=[^&]+/, 'token=…') }); });
}

/** Which <main> is shown, which nav tab is marked, headings and visible error text. */
const viewState = (page) => page.evaluate(() => {
  const vis = [...document.querySelectorAll('main')].filter((m) => !m.hidden && getComputedStyle(m).display !== 'none').map((m) => m.id);
  const nav = [...document.querySelectorAll('nav.tabs a')].map((a) => ({ view: a.dataset.view, current: a.getAttribute('aria-current'), cls: a.className }));
  const shown = vis.map((id) => document.getElementById(id));
  const heads = shown.flatMap((m) => [...m.querySelectorAll('h2,h3,summary')].filter((h) => h.offsetParent !== null).map((h) => h.textContent.trim().slice(0, 60)));
  const text = shown.map((m) => m.innerText).join('\n');
  const errs = (text.match(/[^\n]*(could not|failed|error|undefined|NaN|\[object Object\]|null)[^\n]*/gi) || []).slice(0, 12).map((s) => s.slice(0, 160));
  return { hash: location.hash, visible: vis, nav, heads: heads.slice(0, 25), errs, meta: document.getElementById('meta')?.textContent };
});

/** Horizontal overflow, elements past the right edge, clipped text, low-contrast text. */
const layoutCheck = (page) => page.evaluate(() => {
  const W = document.documentElement.clientWidth;
  const out = { width: W, scrollWidth: document.documentElement.scrollWidth, bodyScroll: document.body.scrollWidth, offRight: [], clipped: [], lowContrast: [] };
  const describe = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ' "' + (e.innerText || e.textContent || '').trim().slice(0, 50).replace(/\s+/g, ' ') + '"';
  const visible = (e) => { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none') return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('[hidden]') && !e.closest('dialog:not([open])'); };
  const scrollableAncestor = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth) return p; } return null; };
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (e) => { for (let p = e; p; p = p.parentElement) { const c = parse(getComputedStyle(p).backgroundColor); if (c && c.a > 0.5) return c; } return parse(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255 }; };
  for (const e of document.querySelectorAll('body *')) {
    if (!visible(e) || e.closest('svg') || e.closest('pre')) continue;
    const r = e.getBoundingClientRect();
    if (r.right > W + 1 && !scrollableAncestor(e) && getComputedStyle(e).position !== 'fixed') out.offRight.push(describe(e) + ' right=' + Math.round(r.right));
    const s = getComputedStyle(e);
    if (e.children.length === 0 && (e.textContent || '').trim() && (s.overflow === 'hidden' || s.overflowX === 'hidden' || s.textOverflow === 'ellipsis') && e.scrollWidth > e.clientWidth + 1) out.clipped.push(describe(e));
    const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own && !e.closest('[aria-hidden="true"]')) {
      const fg = parse(s.color), bg = bgOf(e);
      if (fg && bg) {
        const a = fg.a ?? 1, mix = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
        const L1 = lum(mix), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const big = parseFloat(s.fontSize) >= 18.6 || (parseFloat(s.fontSize) >= 14 && Number(s.fontWeight) >= 700);
        if (ratio < (big ? 3 : 4.5) && !e.closest('button:disabled')) out.lowContrast.push(describe(e) + ' ratio=' + ratio.toFixed(2));
      }
    }
  }
  out.offRight = out.offRight.slice(0, 15); out.clipped = out.clipped.slice(0, 15);
  out.lowContrastCount = out.lowContrast.length; out.lowContrast = [...new Set(out.lowContrast)].slice(0, 20);
  return out;
});

/** Waits until the Security Agent gate passes (the "ready" strip), or 30 s. */
const saReady = (page) => page.waitForSelector('#sa-ready', { timeout: 30000 }).then(() => sleep(300), () => {});

async function setTheme(page, theme) {
  await page.click(`[data-theme-set="${theme}"]`);
  await sleep(150);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const running = [];
async function live(name, scenario, envExtra = {}, seedExtra, opt) {
  const home = seed(name, scenario, seedExtra);
  const s = await startDashboard(home, envExtra, [], opt);
  running.push(s.proc);
  const base = `http://127.0.0.1:${s.port}`;
  const ss = execFileSync('sh', ['-c', `ss -ltn | grep ':${s.port} ' || true`], { encoding: 'utf8' }).trim();
  return { ...s, home, base, listen: ss };
}
async function openCtx(srv, viewport = { width: 1280, height: 900 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  const log = [];
  let tag = 'open';
  watch(page, log, () => tag);
  await page.goto(srv.url);
  await page.waitForSelector('#meta:not(:empty)');
  await page.waitForFunction(() => !/loading/.test(document.getElementById('meta').textContent), null, { timeout: 15000 }).catch(() => {});
  return { ctx, page, log, setTag: (t) => { tag = t; } };
}
const routesFor = (data) => [
  '#', ...data.repos.map((r) => '#repo/' + r.id), '#security', ...data.repos.slice(0, 2).map((r) => '#security/' + r.id), '#accountguard',
  '#settings', ...['overview', 'machine', 'repos', 'agents', 'sync', 'aws', 'updates'].map((t) => '#settings/' + t), '#setup',
  '#repo/0000000000000000', '#security/0000000000000000', '#settings/bogus', '#nonsense'];
const shotName = (s) => s.replace(/[#/]+/g, '_').replace(/^_|_$/g, '') || 'dashboard';

try {
  // ---------- 1. auth, token, Host, Origin, CSRF (raw HTTP, no browser) ----------
  if (want('auth')) {
    const srv = await live('auth', 'full', { PRISM_NO_UPDATE_CHECK: '1' });
    const out = { listen: srv.listen, checks: [] };
    const tok = new URL(srv.url).searchParams.get('token');
    const r0 = await fetch(srv.url, { redirect: 'manual' });
    const cookie = r0.headers.get('set-cookie');
    const ck = cookie.split(';')[0];
    out.setCookie = cookie.replace(tok, '<token>');
    const page = await (await fetch(srv.base + '/', { headers: { cookie: ck } })).text();
    const csrf = /name="prism-csrf" content="([^"]+)"/.exec(page)[1];
    const H = (h = {}) => ({ cookie: ck, ...h });
    const post = (path, body, h = {}) => fetch(srv.base + path, { method: 'POST', headers: H({ 'content-type': 'application/json', origin: srv.base, 'x-prism-csrf': csrf, ...h }), body: typeof body === 'string' ? body : JSON.stringify(body) });
    const cases = [
      ['GET / no cookie', () => fetch(srv.base + '/'), 401],
      ['GET /api/data no cookie', () => fetch(srv.base + '/api/data'), 401],
      ['GET /api/data wrong cookie', () => fetch(srv.base + '/api/data', { headers: { cookie: `prism_dash_${srv.port}=${'x'.repeat(tok.length)}` } }), 401],
      ['GET /api/data token in query only', () => fetch(srv.base + '/api/data?token=' + tok), 401],
      ['GET /api/data cookie of another port', () => fetch(srv.base + '/api/data', { headers: { cookie: `prism_dash_1=${tok}` } }), 401],
      ['GET /?token=wrong', () => fetch(srv.base + '/?token=wrong', { redirect: 'manual' }), 401],
      ['GET /?token=<empty>', () => fetch(srv.base + '/?token=', { redirect: 'manual' }), 401],
      ['GET /api/data good cookie', () => fetch(srv.base + '/api/data', { headers: H() }), 200],
      ['Host: evil.example', () => rawGet(srv.port, '/api/data', { Host: 'evil.example', Cookie: ck }), 403],
      ['Host: 127.0.0.1 (no port)', () => rawGet(srv.port, '/api/data', { Host: '127.0.0.1', Cookie: ck }), 403],
      ['Host: localhost:<port>', () => rawGet(srv.port, '/api/data', { Host: `localhost:${srv.port}`, Cookie: ck }), 200],
      ['POST /api/data (GET route)', () => fetch(srv.base + '/api/data', { method: 'POST', headers: H() }), 405],
      ['GET /api/action (POST route)', () => fetch(srv.base + '/api/action', { headers: H() }), 405],
      ['POST /api/action no CSRF', () => post('/api/action', { action: 'codeburn-status' }, { 'x-prism-csrf': '' }), 403],
      ['POST /api/action wrong CSRF', () => post('/api/action', { action: 'codeburn-status' }, { 'x-prism-csrf': 'nope' }), 403],
      ['POST /api/action foreign Origin', () => post('/api/action', { action: 'codeburn-status' }, { origin: 'https://evil.example' }), 403],
      ['POST /api/action Origin null', () => post('/api/action', { action: 'codeburn-status' }, { origin: 'null' }), 403],
      ['POST /api/action no cookie', () => fetch(srv.base + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json', origin: srv.base, 'x-prism-csrf': csrf }, body: '{}' }), 401],
      ['POST /api/action text/plain', () => post('/api/action', '{"action":"codeburn-status"}', { 'content-type': 'text/plain' }), 415],
      ['POST /api/action bad JSON', () => post('/api/action', '{nope'), 400],
      ['POST /api/action 20 KB body', () => post('/api/action', JSON.stringify({ action: 'x'.repeat(20000) })), 413],
      ['POST /api/action unknown id', () => post('/api/action', { action: 'rm-rf' }), 400],
      ['POST /api/action confirm-needed without confirm', () => post('/api/action', { action: 'aws-disconnect' }), 400],
      ['POST /api/action code-review without lookup', () => post('/api/action', { action: 'security-code-review', repo: '0000000000000000', confirm: true }), 400],
      ['POST /api/action aws-connect profile not in list', () => post('/api/action', { action: 'aws-connect', profile: 'evil;rm', region: 'us-west-2' }), 400],
      ['POST /api/action codeburn-team http URL', () => post('/api/action', { action: 'codeburn-team', url: 'http://x.example' }), 400],
      ['GET /report/../../etc/passwd', () => fetch(srv.base + '/report/../../etc/passwd', { headers: H() }), 404],
      ['GET /report/%2e%2e%2fx', () => fetch(srv.base + '/report/%2e%2e%2fx', { headers: H() }), 404],
      ['GET /report/nope', () => fetch(srv.base + '/report/nope', { headers: H() }), 404],
      ['GET /api/__proto__', () => fetch(srv.base + '/__proto__', { headers: H() }), 404],
      ['GET /api/constructor', () => fetch(srv.base + '/constructor', { headers: H() }), 404],
    ];
    for (const [name, fn, expect] of cases) {
      let status, body = '';
      try { const r = await fn(); status = r.status; body = (await r.text()).slice(0, 160); } catch (e) { status = 'ERR ' + e.message; }
      out.checks.push({ name, expect, status, pass: status === expect, body });
    }
    // Security headers on the page.
    const hp = await fetch(srv.base + '/', { headers: H() });
    out.headers = Object.fromEntries(['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'cache-control', 'cross-origin-resource-policy'].map((k) => [k, hp.headers.get(k)]));
    const ad = await fetch(srv.base + '/api/data', { headers: H() });
    out.apiHeaders = Object.fromEntries(['content-type', 'access-control-allow-origin', 'cache-control'].map((k) => [k, ad.headers.get(k)]));
    // A browser on another origin cannot read the API (no CORS): try from about:blank page.
    R.suites.auth = out;
  }

  // ---------- 2. navigation, deep links, back/forward, console (full data, update check off) ----------
  if (want('nav')) {
    const srv = await live('nav', 'full', { PRISM_NO_UPDATE_CHECK: '1' });
    const { ctx, page, log, setTag } = await openCtx(srv);
    const data = await page.evaluate(() => fetch('/api/data').then((r) => r.json()));
    const out = { repos: data.repos.map((r) => ({ id: r.id, label: r.label })), deep: [], clicks: [], history: [], log };
    for (const route of routesFor(data)) {
      setTag('deep ' + route);
      await page.goto(srv.base + '/' + route);
      await page.waitForSelector('#meta:not(:empty)');
      await sleep(900);
      const st = await viewState(page);
      out.deep.push({ route, ...st });
      await page.screenshot({ path: join(SHOTS, `deep-${shotName(route)}-1280-dark.png`), fullPage: true });
    }
    // Clicks through the nav from the dashboard.
    await page.goto(srv.base + '/#'); await sleep(800);
    for (const v of ['security', 'accountguard', 'settings', 'dashboard']) {
      setTag('click nav ' + v);
      await page.click(`nav.tabs a[data-view="${v}"]`); await sleep(500);
      out.clicks.push({ click: 'nav ' + v, ...(await viewState(page)) });
    }
    // A repo link from the dashboard, then each Settings tab, then the Security picker.
    setTag('click repo link');
    const repoLink = page.locator('#main a[href^="#repo/"]').first();
    out.clicks.push({ click: 'first repo link', href: await repoLink.getAttribute('href').catch(() => null) });
    await repoLink.click().catch((e) => out.clicks.push({ error: 'repo link: ' + e.message }));
    await sleep(500); out.clicks.push({ click: 'after repo link', ...(await viewState(page)) });
    await page.click('nav.tabs a[data-view="settings"]'); await sleep(600);
    const tabs = await page.$$eval('#settings [role="tab"], #settings nav a, #settings .stabs a, #settings .tabs a', (as) => as.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })));
    out.settingsTabs = tabs;
    for (const t of tabs) {
      setTag('click settings tab ' + t.text);
      await page.click(`#settings >> text="${t.text}"`).catch((e) => out.clicks.push({ error: 'tab ' + t.text + ': ' + e.message.split('\n')[0] }));
      await sleep(400);
      out.clicks.push({ click: 'settings tab ' + t.text, ...(await viewState(page)) });
    }
    setTag('security picker');
    await page.click('nav.tabs a[data-view="security"]'); await sleep(600);
    const opts = await page.$$eval('#sa-repo option', (o) => o.map((x) => x.value));
    if (opts[1]) { await page.selectOption('#sa-repo', opts[1]); await sleep(600); out.clicks.push({ click: 'picker → second repo', ...(await viewState(page)) }); }
    // Back / forward over the visited entries.
    for (let i = 0; i < 4; i++) { setTag('back ' + i); await page.goBack(); await sleep(500); out.history.push({ op: 'back', ...(await viewState(page)) }); }
    for (let i = 0; i < 2; i++) { setTag('fwd ' + i); await page.goForward(); await sleep(500); out.history.push({ op: 'forward', ...(await viewState(page)) }); }
    // Reload on a deep route keeps it.
    await page.goto(srv.base + '/#settings/aws'); await sleep(600); await page.reload(); await page.waitForSelector('#meta:not(:empty)'); await sleep(900);
    out.reload = await viewState(page);
    // Codewatch report link.
    setTag('report');
    await page.goto(srv.base + '/#'); await sleep(900);
    const rep = await page.$$eval('a[href^="/report/"]', (a) => a.map((x) => x.getAttribute('href')));
    out.reportLinks = rep.slice(0, 5);
    if (rep[0]) {
      const r = await page.goto(srv.base + rep[0]); out.report = { status: r.status(), title: await page.title() };
      await page.screenshot({ path: join(SHOTS, 'report-1280-dark.png'), fullPage: true });
      const md = await page.evaluate((u) => fetch(u).then((r) => ({ s: r.status, cd: r.headers.get('content-disposition') })), rep[0] + '.md');
      out.reportMd = md;
    }
    out.log = log;
    out.awsCalls = existsSync(join(srv.home, 'aws-calls.log')) ? readFileSync(join(srv.home, 'aws-calls.log'), 'utf8').split('\n').filter(Boolean) : [];
    R.suites.nav = out;
    await ctx.close();
  }

  // ---------- 3. layout: widths x themes x main routes ----------
  if (want('layout')) {
    const srv = await live('layout', 'full', { PRISM_NO_UPDATE_CHECK: '1' });
    const out = { rows: [] };
    for (const width of [1280, 768, 390, 320]) {
      const { ctx, page, log, setTag } = await openCtx(srv, { width, height: 900 });
      const data = await page.evaluate(() => fetch('/api/data').then((r) => r.json()));
      const routes = ['#', '#repo/' + data.repos[0].id, '#security', '#accountguard', '#settings', '#settings/machine', '#settings/repos', '#settings/agents', '#settings/sync', '#settings/aws', '#settings/updates'];
      for (const theme of ['dark', 'light']) {
        await setTheme(page, theme);
        for (const route of routes) {
          setTag(`${width} ${theme} ${route}`);
          await page.goto(srv.base + '/' + route); await page.waitForSelector('#meta:not(:empty)'); await sleep(700);
          const l = await layoutCheck(page);
          const navBox = await page.evaluate(() => { const n = document.querySelector('nav.tabs'); const r = n.getBoundingClientRect(); return { right: Math.round(r.right), height: Math.round(r.height), sw: n.scrollWidth, cw: n.clientWidth }; });
          out.rows.push({ width, theme, route, hscroll: l.scrollWidth > l.width, ...l, nav: navBox });
          if (['#', '#security', '#accountguard', '#settings', '#settings/aws', '#repo/' + data.repos[0].id].includes(route) && (theme === 'dark' || width === 390 || width === 1280))
            await page.screenshot({ path: join(SHOTS, `layout-${shotName(route.replace(/repo\/.*/, 'repo'))}-${width}-${theme}.png`), fullPage: true });
        }
      }
      out.rows.push({ width, log });
      await ctx.close();
    }
    R.suites.layout = out;
  }

  // ---------- 4. actions: dialogs, confirm, cancel, Esc, drawer, AWS-calling actions without creds ----------
  if (want('actions')) {
    const srv = await live('actions', 'full', { PRISM_NO_UPDATE_CHECK: '1' });
    const { ctx, page, log, setTag } = await openCtx(srv);
    const out = { steps: [], log };
    R.suites.actions = out;
    const dialogState = () => page.evaluate(() => {
      const d = document.querySelector('dialog.confirm');
      if (!d) return { open: false };
      const run = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() !== 'Cancel');
      return { open: d.open, title: d.querySelector('h2')?.textContent, cmd: d.querySelector('pre')?.textContent, runText: run?.textContent, runDisabled: run?.disabled, hasCheckbox: !!d.querySelector('input[type=checkbox]'), focused: document.activeElement?.textContent?.trim().slice(0, 30) };
    });
    const drawer = () => page.evaluate(() => { const d = document.getElementById('action-drawer'); return d ? { hidden: d.hidden, status: d.querySelector('.srow-head')?.innerText.replace(/\s+/g, ' ').slice(0, 200), out: d.querySelector('pre')?.innerText.slice(-600) } : null; });
    const waitDone = async (maxMs) => { const t0 = Date.now(); for (;;) { const d = await drawer(); if (d && !d.hidden && !/running|starting/.test(d.status || '')) return { ms: Date.now() - t0, ...d }; if (Date.now() - t0 > maxMs) return { ms: Date.now() - t0, hung: true, ...d }; await sleep(500); } };

    // Settings › AWS: the buttons there.
    setTag('settings aws');
    await page.goto(srv.base + '/#settings/aws'); await sleep(900);
    out.awsButtons = await page.$$eval('#settings button', (b) => b.filter((x) => x.offsetParent).map((x) => x.textContent.trim()));
    out.awsSelects = await page.$$eval('#settings select', (s) => s.map((x) => ({ label: x.getAttribute('aria-label') || x.id, options: [...x.options].map((o) => o.value) })));
    await page.screenshot({ path: join(SHOTS, 'actions-settings-aws.png'), fullPage: true });
    // Disconnect: a confirm action with a checkbox. Open, check gating, cancel, reopen, Esc.
    const disc = page.locator('#settings button', { hasText: /disconnect/i }).first();
    if (await disc.count()) {
      await disc.click(); await sleep(300);
      out.steps.push({ step: 'disconnect: dialog opened', ...(await dialogState()) });
      await page.screenshot({ path: join(SHOTS, 'actions-dialog-disconnect.png') });
      await page.keyboard.press('Enter'); await sleep(300);
      out.steps.push({ step: 'disconnect: Enter with Cancel focused', ...(await dialogState()), drawer: await drawer() });
      await disc.click(); await sleep(300);
      await page.click('dialog.confirm button:has-text("Cancel")'); await sleep(300);
      out.steps.push({ step: 'disconnect: after Cancel', ...(await dialogState()), connFile: existsSync(join(srv.home, '.prism', 'aws.json')) });
      await disc.click(); await sleep(300);
      await page.keyboard.press('Escape'); await sleep(300);
      out.steps.push({ step: 'disconnect: after Esc', ...(await dialogState()) });
      await disc.click(); await sleep(300);
      const cb = page.locator('dialog.confirm input[type=checkbox]');
      out.steps.push({ step: 'disconnect: run disabled before checkbox', ...(await dialogState()) });
      if (await cb.count()) { await cb.check(); out.steps.push({ step: 'disconnect: after checkbox', ...(await dialogState()) }); await cb.uncheck(); }
      await page.keyboard.press('Escape'); await sleep(200);
      // Tab order inside the dialog.
      await disc.click(); await sleep(300);
      const order = [];
      for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => { const a = document.activeElement; return (a.tagName + ' ' + (a.textContent || a.type || '').trim()).slice(0, 40) + (a.closest('dialog') ? '' : ' [OUTSIDE DIALOG]'); })); }
      out.steps.push({ step: 'disconnect dialog: Tab order', order });
      await page.keyboard.press('Escape');
    } else out.steps.push({ step: 'no Disconnect button found on #settings/aws' });

    // aws connect with a profile from the fake ~/.aws/config: must fail with the no-credentials error, not hang.
    setTag('aws connect');
    const conn = page.locator('#settings button', { hasText: /^(connect|verify|re-verify|connect the aws account|check and save)/i }).first();
    out.connectButton = await conn.count() ? await conn.textContent() : null;
    if (await conn.count()) {
      await conn.click(); await sleep(300);
      out.steps.push({ step: 'connect: dialog', ...(await dialogState()) });
      await page.screenshot({ path: join(SHOTS, 'actions-dialog-connect.png') });
      await page.click('dialog.confirm button:not(:has-text("Cancel"))');
      const done = await waitDone(60000);
      out.steps.push({ step: 'connect: result', ...done });
      await page.screenshot({ path: join(SHOTS, 'actions-connect-result.png'), fullPage: true });
      await sleep(1500);
      out.steps.push({ step: 'connect: settings after', text: (await page.innerText('#settings')).slice(0, 1500) });
    }

    // AccountGuard: Run aws check (read-only AWS) without credentials.
    setTag('accountguard check');
    await page.goto(srv.base + '/#accountguard'); await sleep(900);
    out.agButtons = await page.$$eval('#accountguard button', (b) => b.filter((x) => x.offsetParent).map((x) => x.textContent.trim()));
    const chk = page.locator('#accountguard button', { hasText: /aws check/i }).first();
    if (await chk.count()) {
      await chk.click(); await sleep(300);
      out.steps.push({ step: 'ag check: dialog', ...(await dialogState()) });
      await page.screenshot({ path: join(SHOTS, 'actions-dialog-awscheck.png') });
      await page.click('dialog.confirm button:not(:has-text("Cancel"))');
      const done = await waitDone(120000);
      out.steps.push({ step: 'ag check: result', ...done });
      await page.screenshot({ path: join(SHOTS, 'actions-awscheck-result.png'), fullPage: true });
    }
    // Baseline marking button(s) on AccountGuard.
    const bl = page.locator('#accountguard button', { hasText: /baseline/i }).first();
    if (await bl.count()) { await bl.click(); await sleep(800); out.steps.push({ step: 'ag baseline click', text: (await page.innerText('#accountguard')).slice(0, 600), file: existsSync(join(srv.home, '.prism', 'accountguard.json')) }); }

    // Security Agent: the gate's step 3 runs the read-only lookup by itself; without credentials it stops at the sign-in card.
    setTag('security');
    const t0 = Date.now();
    await page.goto(srv.base + '/#security');
    await page.waitForSelector('#sa-gate[data-state]:not([data-state="checking"])', { timeout: 90000 }).catch(() => {});
    out.steps.push({ step: 'sa lookup', ms: Date.now() - t0, state: await page.getAttribute('#sa-gate', 'data-state').catch(() => null), text: (await page.innerText('#security')).slice(0, 1600) });
    await page.screenshot({ path: join(SHOTS, 'actions-sa-lookup.png'), fullPage: true });
    out.saButtons = await page.$$eval('#security button', (b) => b.filter((x) => x.offsetParent).map((x) => x.textContent.trim()));
    out.badgeAfterLookup = await page.textContent('#security-badge');
    // Drawer close and keyboard reach.
    const d0 = await drawer();
    await page.click('#action-drawer button:has-text("Close")').catch(() => {});
    out.drawerClose = { before: d0?.hidden, after: (await drawer())?.hidden };
    // Esc on the drawer?
    out.awsCalls = existsSync(join(srv.home, 'aws-calls.log')) ? readFileSync(join(srv.home, 'aws-calls.log'), 'utf8').split('\n').filter(Boolean) : [];
    out.actionLog = existsSync(join(srv.home, '.prism/logs/dashboard-actions.log')) ? readFileSync(join(srv.home, '.prism/logs/dashboard-actions.log'), 'utf8').split('\n').filter(Boolean) : [];
    R.suites.actions = out;
    await ctx.close();
  }

  // ---------- 5. keyboard ----------
  if (want('keyboard')) {
    const srv = await live('kbd', 'full', { PRISM_NO_UPDATE_CHECK: '1' });
    const { ctx, page, log } = await openCtx(srv);
    const out = { log, routes: [] };
    for (const route of ['#', '#settings', '#security', '#accountguard']) {
      await page.goto(srv.base + '/' + route); await sleep(800);
      await page.evaluate(() => document.activeElement?.blur());
      const seq = [];
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press('Tab');
        seq.push(await page.evaluate(() => { const a = document.activeElement; const s = getComputedStyle(a); return { el: (a.tagName + ' ' + (a.textContent || '').trim()).slice(0, 36), outline: s.outlineStyle !== 'none' && s.outlineWidth !== '0px' || s.boxShadow !== 'none' }; }));
      }
      out.routes.push({ route, seq });
    }
    // Enter on a focused nav link switches view.
    await page.goto(srv.base + '/#'); await sleep(600);
    await page.focus('nav.tabs a[data-view="settings"]'); await page.keyboard.press('Enter'); await sleep(500);
    out.enterNav = await viewState(page);
    R.suites.keyboard = out;
    await ctx.close();
  }

  // ---------- 6. empty / partial / loading / error states ----------
  if (want('states')) {
    const out = {};
    const cases = [
      ['empty-nocb', 'empty', { PRISM_NO_UPDATE_CHECK: '1' }, null, { noCodeburn: true }],
      ['empty-cberror', 'empty', { PRISM_NO_UPDATE_CHECK: '1', FAKE_CB: 'none' }],
      ['partial-slowhist', 'partial', { PRISM_NO_UPDATE_CHECK: '1', FAKE_CB_HISTORY: 'slow', FAKE_CB_DELAY_MS: '25000' }],
      ['partial-failhist', 'partial', { PRISM_NO_UPDATE_CHECK: '1', FAKE_CB_HISTORY: 'fail' }],
    ];
    for (const [name, scenario, env, , opt] of cases) {
      const home = seed('st-' + name, scenario);
      const s = await startDashboard(home, env, [], opt);
      running.push(s.proc);
      const base = `http://127.0.0.1:${s.port}`;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage(); const log = []; let tag = name; watch(page, log, () => tag);
      await page.goto(s.url); await page.waitForSelector('#meta:not(:empty)');
      // First paint (before /api/usage answers).
      await sleep(150);
      const first = { meta: await page.textContent('#meta'), spend: await page.evaluate(() => { const c = [...document.querySelectorAll('#main section')].find((x) => /spend|usage|codeburn/i.test(x.innerText)); return c ? c.innerText.slice(0, 400) : null; }) };
      await page.screenshot({ path: join(SHOTS, `state-${name}-firstpaint.png`), fullPage: true });
      await sleep(4000);
      const r = { first, routes: [] };
      for (const route of ['#', '#security', '#accountguard', '#settings', '#settings/aws', '#settings/machine', '#settings/repos']) {
        tag = name + ' ' + route;
        await page.goto(base + '/' + route); await page.waitForSelector('#meta:not(:empty)'); await sleep(900);
        r.routes.push({ route, ...(await viewState(page)), text: (await page.evaluate(() => [...document.querySelectorAll('main')].filter((m) => !m.hidden).map((m) => m.innerText).join('\n'))).slice(0, 1200) });
        await page.screenshot({ path: join(SHOTS, `state-${name}-${shotName(route)}.png`), fullPage: true });
      }
      if (name === 'partial-slowhist') {
        await page.goto(base + '/#'); await sleep(500);
        r.heatPending = await page.evaluate(() => { const h = document.querySelector('#main [class*=heat], #main svg'); return (h?.closest('section')?.innerText || '').slice(0, 500); });
        await page.screenshot({ path: join(SHOTS, `state-${name}-heatmap-pending.png`), fullPage: true });
        await sleep(30000);
        r.heatAfter = await page.evaluate(() => { const h = document.querySelector('#main [class*=heat], #main svg'); return (h?.closest('section')?.innerText || '').slice(0, 500); });
        await page.screenshot({ path: join(SHOTS, `state-${name}-heatmap-after.png`), fullPage: true });
      }
      r.log = log;
      out[name] = r;
      await ctx.close();
    }
    R.suites.states = out;
  }

  // ---------- 7. update pill with and without PRISM_NO_UPDATE_CHECK ----------
  if (want('update')) {
    const out = {};
    const seedUpdate = (home) => { mkdirSync(join(home, '.prism', 'cache'), { recursive: true }); writeFileSync(join(home, '.prism', 'cache', 'update-check.json'), JSON.stringify({ schema: 'prism.update-check.v1', checkedAt: Date.now(), latest: '1.99.0', publishedAt: new Date().toISOString() })); };
    for (const [name, env, extra] of [['off', { PRISM_NO_UPDATE_CHECK: '1' }], ['on-nocache', {}], ['on-cached-newer', {}, seedUpdate], ['off-cached-newer', { PRISM_NO_UPDATE_CHECK: '1' }, seedUpdate]]) {
      const home = seed('up-' + name, 'full', extra);
      const s = await startDashboard(home, env); running.push(s.proc);
      const base = `http://127.0.0.1:${s.port}`;
      const r = {};
      for (const width of [1280, 320]) {
        const ctx = await browser.newContext({ viewport: { width, height: 800 } });
        const page = await ctx.newPage(); const log = []; watch(page, log, () => name);
        await page.goto(s.url); await page.waitForSelector('#meta:not(:empty)'); await sleep(4500);
        await page.reload(); await page.waitForSelector('#meta:not(:empty)'); await sleep(1500);
        r[width] = { pill: await page.evaluate(() => { const a = document.querySelector('#ver a'); return a ? { text: a.textContent, title: a.title, href: a.getAttribute('href') } : null; }), hscroll: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), log };
        if (width === 1280) {
          await page.click('#ver a').catch(() => {}); await sleep(600);
          r.updatesTab = (await page.evaluate(() => [...document.querySelectorAll('main')].filter((m) => !m.hidden).map((m) => m.innerText).join('\n'))).slice(0, 1000);
          r.updateButtons = await page.$$eval('#settings button', (b) => b.filter((x) => x.offsetParent).map((x) => x.textContent.trim()));
          await page.screenshot({ path: join(SHOTS, `update-${name}-settings-updates.png`), fullPage: true });
        }
        await page.screenshot({ path: join(SHOTS, `update-${name}-${width}.png`) });
        await ctx.close();
      }
      r.cache = existsSync(join(home, '.prism/cache/update-check.json')) ? JSON.parse(readFileSync(join(home, '.prism/cache/update-check.json'), 'utf8')) : null;
      out[name] = r;
    }
    R.suites.update = out;
  }

  // ---------- 8. static snapshot ----------
  if (want('snapshot')) {
    const home = seed('snap', 'full');
    const file = join(SCRATCH, 'e2e-snapshot.html');
    const cwd = readFileSync(join(home, '.start-dir'), 'utf8').trim();
    const t0 = Date.now();
    const sp = spawnSync(process.execPath, [ENTRY, 'dashboard', '--snapshot', file], { cwd, encoding: 'utf8', timeout: 120000, env: demoEnv(home, { PRISM_NO_UPDATE_CHECK: '1' }) });
    const out = { exit: sp.status, ms: Date.now() - t0, stdout: sp.stdout.trim().replace(SCRATCH, '$SCRATCH'), stderr: sp.stderr.trim().slice(0, 400), routes: [] };
    if (existsSync(file)) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage(); const log = []; let tag = 'snapshot'; watch(page, log, () => tag);
      out.checkRequests = [];
      page.on('request', (q) => { if (/security-check/.test(q.url())) out.checkRequests.push(q.url()); });
      await page.goto('file://' + file); await sleep(1200);
      const data = await page.evaluate(() => JSON.parse(document.getElementById('prism-snapshot').textContent).data);
      for (const route of ['#', '#repo/' + data.repos[0].id, '#security', '#accountguard', '#settings', '#settings/aws', '#settings/machine', '#settings/updates']) {
        tag = 'snapshot ' + route;
        await page.goto('file://' + file + route); await sleep(900);
        const st = await viewState(page);
        const btns = await page.$$eval('main:not([hidden]) button', (b) => b.filter((x) => x.offsetParent && !x.disabled).map((x) => x.textContent.trim()));
        out.routes.push({ route, ...st, buttons: [...new Set(btns)] });
        await page.screenshot({ path: join(SHOTS, `snapshot-${shotName(route.replace(/repo\/.*/, 'repo'))}-1280.png`), fullPage: true });
      }
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('file://' + file + '#'); await sleep(800);
        const l = await layoutCheck(page);
        out['layout' + width] = { hscroll: l.scrollWidth > l.width, offRight: l.offRight };
        await page.screenshot({ path: join(SHOTS, `snapshot-dashboard-${width}.png`), fullPage: true });
      }
      out.log = log;
      await ctx.close();
    }
    R.suites.snapshot = out;
  }
  // ---------- 9. the 1.15.1 fixes, read straight off the page ----------
  if (want('fixes')) {
    const out = {};
    R.suites.fixes = out;
    const srv = await live('fixes', 'full', { PRISM_NO_UPDATE_CHECK: '1' });
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    const data = await page.evaluate(() => fetch('/api/data').then((r) => r.json()));
    const shop = data.repos.find((r) => r.current);
    const mainText = () => page.evaluate(() => [...document.querySelectorAll('main')].filter((m) => !m.hidden).map((m) => m.innerText).join('\n'));
    await page.goto(srv.base + '/#'); await sleep(900);
    out.dashboardSecurity = await page.evaluate(() => document.getElementById('security-runs')?.innerText || '');
    out.meta = await page.textContent('#meta');
    out.codewatchCard = await page.evaluate(() => document.querySelector('#codewatch h2')?.textContent || '');
    await page.goto(srv.base + '/#repo/' + shop.id); await sleep(900);
    out.repoSecurity = await page.evaluate(() => { const h = [...document.querySelectorAll('#repo h2')].find((x) => /Security Agent/.test(x.textContent)); return h ? h.closest('section').innerText : ''; });
    out.repoText = await mainText();
    await page.locator('#repo section', { has: page.locator('h2', { hasText: 'Security Agent' }) }).screenshot({ path: join(SHOTS, 'fixes-repo-security-card.png') }).catch(() => {});
    await page.goto(srv.base + '/#settings/repos'); await sleep(900);
    out.settingsReposText = await mainText();
    await page.goto(srv.base + '/#security'); await sleep(900);
    out.pickerOptions = await page.$$eval('#sa-repo option', (o) => o.map((x) => x.textContent));
    out.securityText = await mainText();
    // 1.16.0: AccountGuard says why each check could not run; no full account id in the APIs or the page.
    out.apiJson = await page.evaluate(() => Promise.all(['/api/data', '/api/accountguard', '/api/setup'].map((u) => fetch(u).then((r) => r.text()))).then((x) => x.join('\n')));
    await page.goto(srv.base + '/#accountguard'); await sleep(900);
    out.accountguardText = await mainText();
    await page.screenshot({ path: join(SHOTS, 'fixes-accountguard-reasons.png'), fullPage: true });
    await page.goto(srv.base + '/#settings/updates'); await sleep(900);
    out.updates = await page.evaluate(() => {
      const b = [...document.querySelectorAll('#settings button')].filter((x) => x.offsetParent && x.textContent.trim() === 'Check now').pop();
      return { disabled: !!(b && b.disabled), text: document.getElementById('settings').innerText.slice(0, 900), pillTitle: document.querySelector('#ver a')?.title || '' };
    });
    await page.screenshot({ path: join(SHOTS, 'fixes-updates-off.png'), fullPage: true });
    await ctx.close();
    // codeburn failing: the month export (empty HOME) and the earlier weeks (partial).
    for (const [name, scenario, env] of [['cb-month', 'empty', { FAKE_CB: 'none' }], ['cb-history', 'partial', { FAKE_CB_HISTORY: 'fail' }]]) {
      const s2 = await live('fixes-' + name, scenario, { PRISM_NO_UPDATE_CHECK: '1', ...env });
      const c2 = await openCtx(s2);
      await sleep(3000); await c2.page.reload(); await c2.page.waitForSelector('#meta:not(:empty)'); await sleep(1500);
      out[name] = { text: await c2.page.evaluate(() => document.getElementById('main').innerText), home: s2.home, tmp: tmpdir() };
      await c2.page.screenshot({ path: join(SHOTS, `fixes-${name}.png`), fullPage: true });
      await c2.ctx.close();
    }
  }
  // ---------- 10. a fetch while the Security Agent job is still running (FAKE_AWS=in-progress) ----------
  if (want('pending')) {
    const out = { steps: [] };
    R.suites.pending = out;
    const srv = await live('pending', 'full', { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'in-progress', FAKE_SA: 'ready' });
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    await page.goto(srv.base + '/#security'); await saReady(page);
    const btn = page.locator('#security button:visible', { hasText: /^Fetch findings$/ }).first();
    out.found = await btn.count();
    if (out.found) {
      await btn.click(); await sleep(300);
      await page.click('dialog.confirm button:not(:has-text("Cancel"))');
      const t0 = Date.now();
      let d;
      for (;;) {
        d = await page.evaluate(() => { const s = document.querySelector('#action-drawer .srow-head'); const p = s?.querySelector('.pill'); return { status: s?.innerText.replace(/\s+/g, ' ') || '', pillClass: p?.className || '', pillText: p?.textContent || '', out: document.querySelector('#action-drawer pre')?.innerText || '' }; });
        if (d.status && !/^(running|starting)/.test(d.pillText)) break;
        if (Date.now() - t0 > 60000) { d.hung = true; break; }
        await sleep(400);
      }
      out.drawer = d;
      out.drawerLink = await page.evaluate(() => !!document.querySelector('#action-drawer [data-run-link]'));
      await sleep(1500);
      out.row = await page.evaluate(() => { const tr = [...document.querySelectorAll('#security tr')].find((x) => /Code review/.test(x.innerText)); return tr ? tr.innerText.replace(/\s+/g, ' ') : ''; });
      await page.screenshot({ path: join(SHOTS, 'pending-fetch-findings.png'), fullPage: true });
    }
    out.home = srv.home;
    await ctx.close();
  }
  // ---------- 11. a second action starts once the first is done (no stuck "another action is running") ----------
  if (want('rerun')) {
    const out = { steps: [] };
    R.suites.rerun = out;
    const srv = await live('rerun', 'full', { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'in-progress', FAKE_SA: 'ready' });
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    const posts = [];
    page.on('response', async (r) => { if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/action') posts.push({ status: r.status(), body: (await r.text().catch(() => '')).slice(0, 200) }); });
    const pill = () => page.evaluate(() => document.querySelector('#action-drawer .srow-head .pill')?.textContent || '');
    const runOne = async (label) => {
      await page.goto(srv.base + '/#security'); await saReady(page);
      const b = page.locator('#security button:visible', { hasText: new RegExp('^' + label + '$') }).first();
      const step = { label, found: await b.count() };
      if (step.found) {
        step.enabled = await b.isEnabled();
        await b.click(); await sleep(300);
        await page.click('dialog.confirm button:not(:has-text("Cancel"))');
        const t0 = Date.now();
        for (;;) { const p = await pill(); if (p && !/^(running|starting)/.test(p)) { step.pill = p; break; } if (Date.now() - t0 > 60000) { step.hung = true; break; } await sleep(400); }
        step.post = posts[posts.length - 1];
        step.serverState = await page.evaluate(() => fetch('/api/action/status').then((r) => r.json()).then((j) => j.state));
      }
      out.steps.push(step);
    };
    await runOne('Fetch findings');
    await runOne('Fetch threats');
    await runOne('Fetch findings');
    // Right after the third run is done, a direct start must answer 202 too.
    const csrf = await page.evaluate(() => document.querySelector('meta[name="prism-csrf"]')?.content || '');
    out.direct = await page.evaluate(async (csrf) => {
      const data = await fetch('/api/data').then((r) => r.json());
      const repo = data.repos.find((r) => r.current);
      const r = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-prism-csrf': csrf }, body: JSON.stringify({ action: 'security-threats', repo: repo.id }) });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    }, csrf);
    await ctx.close();
  }
  // ---------- 14. a run opened while running shows its findings once it finishes, without a reload ----------
  if (want('rundetail')) {
    const out = {};
    R.suites.rundetail = out;
    const srv = await live('rundetail', 'full', { PRISM_NO_UPDATE_CHECK: '1' });
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    const data = await page.evaluate(() => fetch('/api/data').then((r) => r.json()));
    const run = (data.security_runs || []).find((r) => r.status === 'running' && r.type === 'code-review');
    out.found = !!run;
    if (run) {
      const hash = '#security/run/' + run.repo_id + '/' + run.run_id;
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector('[data-run-detail]', { timeout: 15000 }).catch(() => {});
      out.before = await page.evaluate(() => document.getElementById('security').innerText.slice(0, 600));
      // The job finishes: the CLI fetches it with the fake aws answering COMPLETED (no AWS call).
      const cwd = readFileSync(join(srv.home, '.start-dir'), 'utf8').trim();
      const sp = spawnSync(process.execPath, [ENTRY, 'security', 'findings'], { cwd, encoding: 'utf8', timeout: 120000, env: demoEnv(srv.home, { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'complete' }) });
      out.cliExit = sp.status;
      // Away and back, in the same page: no reload.
      out.marker = await page.evaluate(() => { window.__noReload = 1; return 1; });
      await page.evaluate(() => { location.hash = '#'; }); await sleep(400);
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector('[data-run-findings]', { timeout: 15000 }).catch(() => {});
      out.after = await page.evaluate(() => ({ text: document.getElementById('security').innerText.slice(0, 1500), sameDoc: window.__noReload === 1 }));
    }
    await ctx.close();
  }
  // ---------- 13. security runs (1.18): Dashboard list, full table, drill-down, completion link, phone width ----------
  if (want('runs')) {
    const out = {};
    R.suites.runs = out;
    // The auto-check sees job-demo-2 still running; the job "finishes" just before the manual fetch below.
    const srv = await live('runs', 'full', { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'complete', FAKE_SA: 'ready' }, (h) => fakeMode(h, 'in-progress'));
    const { ctx, page, log, setTag } = await openCtx(srv);
    out.log = log;
    const data = await page.evaluate(() => fetch('/api/data').then((r) => r.json()));
    out.total = (data.security_runs || []).length;
    await page.goto(srv.base + '/#'); await sleep(900);
    out.dash = await page.evaluate(() => {
      const c = document.getElementById('security-runs');
      const all = c && c.querySelector('[data-all-runs]');
      return { rows: c ? c.querySelectorAll('tr[data-run]').length : -1, all: all ? all.textContent : null, href: all ? all.getAttribute('href') : null, oldList: !!document.getElementById('security-findings'),
        chips: c ? c.querySelectorAll('.runchips .pill').length : 0 };
    });
    await page.locator('#security-runs').screenshot({ path: join(SHOTS, 'runs-dashboard-card.png') }).catch(() => {});
    // The full table on the Security Agent page, and its filters.
    await page.goto(srv.base + '/#security'); await saReady(page);
    const types = () => page.$$eval('#security-runs-all tr[data-run] .runtype', (x) => x.map((e) => e.textContent));
    out.allRows = (await types()).length;
    await page.selectOption('#security-runs-all select[data-filter="type"]', 'threat-model'); await sleep(200);
    out.filteredTypes = await types();
    await page.selectOption('#security-runs-all select[data-filter="type"]', ''); await sleep(200);
    await page.selectOption('#security-runs-all select[data-filter="status"]', 'running'); await sleep(200);
    out.filteredStatus = await page.$$eval('#security-runs-all tr[data-run] .st', (x) => x.map((e) => e.textContent));
    await page.selectOption('#security-runs-all select[data-filter="status"]', ''); await sleep(200);
    // Fetch the pending review: it completes (FAKE_AWS=complete), and the drawer links to its findings.
    fakeMode(srv.home, 'complete');
    const fetchBtn = page.locator('#security button:visible', { hasText: /^Fetch findings$/ }).first();
    out.fetchFound = await fetchBtn.count();
    if (out.fetchFound) {
      await fetchBtn.click(); await sleep(300);
      await page.click('dialog.confirm button:not(:has-text("Cancel"))');
      await page.waitForSelector('#action-drawer [data-run-link] a', { timeout: 60000 }).catch(() => {});
      out.drawer = await page.evaluate(() => { const b = document.querySelector('#action-drawer [data-run-link]'); return b ? { text: b.textContent, href: b.querySelector('a').getAttribute('href') } : null; });
      await page.locator('#action-drawer').screenshot({ path: join(SHOTS, 'runs-drawer-complete.png') }).catch(() => {});
      if (out.drawer) {
        out.drawerNull = await page.evaluate(() => /\bnull\b/.test(document.querySelector('#action-drawer .drawer-head').innerText));
        await page.click('#action-drawer [data-run-link] a');
        await page.waitForSelector('[data-run-findings]', { timeout: 15000 }).catch(() => {});
        await page.click('#action-drawer .drawer-head button:has-text("Close")').catch(() => {});
        await sleep(300);
        out.detail = await page.evaluate(() => {
          const sec = document.getElementById('security');
          return { hash: location.hash, findings: sec.querySelectorAll('details.rf').length, text: sec.innerText.slice(0, 3000), imgs: sec.querySelectorAll('img').length };
        });
        await page.screenshot({ path: join(SHOTS, 'runs-drilldown-1280.png'), fullPage: true });
        out.resultsRow = null;
        await page.goto(srv.base + '/#security'); await saReady(page);
        out.resultsRow = await page.evaluate(() => { const tr = [...document.querySelectorAll('#security tr')].find((x) => /^Code review/.test(x.innerText) && !x.hasAttribute('data-run')); return tr ? tr.innerText.replace(/\s+/g, ' ') : ''; });
        await page.screenshot({ path: join(SHOTS, 'runs-security-agent-1280.png'), fullPage: true });
      }
    }
    // Light theme: the runs card and the drill-down keep 4.5:1 text contrast (3:1 for large text).
    await setTheme(page, 'light');
    out.contrast = {};
    for (const [k, route] of [['dashboard', '#'], ['detail', out.drawer ? out.drawer.href : '#security']]) {
      await page.goto(srv.base + '/' + route); await sleep(1200);
      out.contrast[k] = (await layoutCheck(page)).lowContrast;
    }
    await page.screenshot({ path: join(SHOTS, 'runs-drilldown-1280-light.png'), fullPage: true });
    await setTheme(page, 'dark');
    // An unknown run id: the API answers 404 on purpose (the console verdict expects exactly that request).
    setTag('expected-404');
    await page.goto(srv.base + '/#security/run/0000000000000000/nope'); await sleep(900);
    out.missing = await page.evaluate(() => document.getElementById('security').innerText.slice(0, 400));
    setTag('runs');
    await ctx.close();
    // Phone width: the Dashboard card and a drill-down stack, no sideways scroll.
    const phone = await openCtx(srv, { width: 390, height: 844 });
    out.phone = {};
    for (const [k, route] of [['dashboard', '#'], ['detail', out.drawer ? out.drawer.href : '#security']]) {
      await phone.page.goto(srv.base + '/' + route); await sleep(1200);
      out.phone[k] = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await phone.page.screenshot({ path: join(SHOTS, 'runs-' + k + '-390.png'), fullPage: true });
    }
    out.log.push(...phone.log);
    await phone.ctx.close();
  }
  // ---------- 12. enable security once per machine (1.17): the page and the CLI read the same setup ----------
  if (want('machine')) {
    const out = {};
    R.suites.machine = out;
    const srv = await live('machine', 'full', { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'in-progress', FAKE_SA: 'ready' });
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    const sa = await page.evaluate(() => fetch('/api/security-agent').then((r) => r.json()));
    out.setupCommand = sa.setupCommand;
    out.repos = sa.repos.map((r) => ({ name: r.name, setup: r.setup && r.setup.source, region: r.target.region }));
    const texts = {};
    for (const r of sa.repos) {
      const k = r.setup ? r.setup.source : 'none';
      if (texts[k]) continue;
      await page.goto(srv.base + '/#security/' + r.id); await saReady(page);
      texts[k] = await page.innerText('#security');
    }
    out.texts = texts;
    await page.screenshot({ path: join(SHOTS, 'machine-security-page.png'), fullPage: true });
    await ctx.close();
    // The CLI, with the fake aws first on PATH: --status names the source; from outside a repo, the machine setup.
    const home = srv.home;
    const callLog = (h) => join(h, 'aws-calls.log');
    const cli = (h, cwd, args, env = {}) => {
      rmSync(callLog(h), { force: true });
      const sp = spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: 'utf8', timeout: 120000, env: demoEnv(h, { PRISM_NO_UPDATE_CHECK: '1', ...env }) });
      const calls = existsSync(callLog(h)) ? readFileSync(callLog(h), 'utf8').trim().split('\n').filter(Boolean) : [];
      return { code: sp.status, out: (sp.stdout || '') + (sp.stderr || ''), calls };
    };
    out.whichAws = spawnSync('sh', ['-c', 'command -v aws'], { encoding: 'utf8', env: demoEnv(home) }).stdout.trim();
    out.statusOutside = cli(home, home, ['enable', 'security', '--status'], { FAKE_AWS: 'in-progress' });
    out.statusShop = cli(home, readFileSync(join(home, '.start-dir'), 'utf8').trim(), ['enable', 'security', '--status'], { FAKE_AWS: 'in-progress' });
    // No setup at all: the security commands stop with the hint and make no AWS call.
    const bare = seed('machine-none', 'partial');
    out.noSetup = cli(bare, readFileSync(join(bare, '.start-dir'), 'utf8').trim(), ['security', 'findings']);
    out.home = home;
  }
  // ---------- 15. the Security Agent setup gate (1.19): every state at 1280 and 390 px, the automatic check, the guards ----------
  if (want('gate')) {
    const out = { states: {} };
    R.suites.gate = out;
    out.log = [];
    const rmConn = (h) => rmSync(join(h, '.prism', 'aws.json'), { force: true });
    const rmSetup = (h) => rmSync(join(h, '.prism', 'security.json'), { force: true });
    const machineSetup = (account, region) => JSON.stringify({ agentSpaceId: 'as-0demo0000000001', applicationId: 'app-demo', region, account, setupAt: new Date().toISOString() }) + '\n';
    const otherSetup = (h) => writeFileSync(join(h, '.prism', 'security.json'), machineSetup('444455556666', 'eu-west-1'));
    const calls = (h) => (existsSync(join(h, 'aws-calls.log')) ? readFileSync(join(h, 'aws-calls.log'), 'utf8').split('\n').filter(Boolean) : []);
    const settled = (page) => page.waitForFunction(() => document.getElementById('sa-ready') || document.querySelector('#sa-gate[data-state]:not([data-state="checking"])'), null, { timeout: 30000 }).catch(() => {});
    const snap = (page) => page.evaluate(() => {
      const g = document.getElementById('sa-gate');
      const words = [...document.querySelectorAll('#security .cmdw .w:not(.long)')].filter((w) => w.offsetParent);
      return {
        state: g ? g.getAttribute('data-state') : document.getElementById('sa-ready') ? 'ready' : null,
        text: document.getElementById('security').innerText.slice(0, 2500),
        scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        brokenWords: words.filter((w) => w.getClientRects().length > 1).map((w) => w.textContent),
        words: words.length,
      };
    });
    // [name, expected state, seed change, env, repo]: payments-api uses the machine setup, src/demo-shop its repo override.
    const cases = [
      ['connect', 'connect', rmConn, {}, 'payments-api'],
      ['profile', 'profile', null, { AWS_PROFILE: 'prism-typo' }, 'payments-api'],
      // Nothing pending: an auto-check of demo-shop's running review would call AWS while the card waits.
      ['setup', 'setup', (h) => { rmSetup(h); dropPending(h); }, {}, 'payments-api'],
      ['mismatch', 'mismatch', otherSetup, {}, 'payments-api'],
      ['checking', 'checking', null, { FAKE_AWS: 'in-progress', FAKE_SA: 'slow' }, 'payments-api'],
      ['sso', 'sso', null, { FAKE_SA: 'sso' }, 'payments-api'],
      ['denied', 'denied', null, { FAKE_AWS: 'in-progress', FAKE_SA: 'denied' }, 'payments-api'],
      ['nospace', 'nospace', null, { FAKE_AWS: 'in-progress', FAKE_SA: 'nospace' }, 'payments-api'],
      ['ready', 'ready', null, { FAKE_AWS: 'in-progress', FAKE_SA: 'ready' }, 'payments-api'],
      ['envprofile', 'ready', null, { FAKE_AWS: 'in-progress', FAKE_SA: 'ready', AWS_PROFILE: 'prism-readonly' }, 'payments-api'],
      ['override', 'ready', null, { FAKE_AWS: 'in-progress', FAKE_SA: 'ready' }, 'src/demo-shop'],
    ];
    for (const [name, want, change, env, repoName] of cases) {
      const srv = await live('gate-' + name, 'full', { PRISM_NO_UPDATE_CHECK: '1', ...env }, change || undefined);
      const o = out.states[name] = { want };
      const desk = await openCtx(srv);
      const sa = await desk.page.evaluate(() => fetch('/api/security-agent').then((r) => r.text()));
      o.homeLeak = sa.includes(srv.home);
      const repo = JSON.parse(sa).repos.find((r) => r.path.endsWith('/' + repoName));
      const hash = '#security/' + repo.id;
      await desk.page.goto(srv.base + '/' + hash);
      if (name === 'checking') await desk.page.waitForSelector('#sa-gate[data-state="checking"]', { timeout: 15000 }).catch(() => {});
      else await settled(desk.page);
      o.desk = await snap(desk.page);
      await desk.page.screenshot({ path: join(SHOTS, `gate-${name}-1280.png`), fullPage: true });
      if (name === 'checking') { await settled(desk.page); o.after = (await snap(desk.page)).state; }
      if (name === 'ready') {
        // Loads, refreshes and a second tab: the kept answer, no second lookup.
        await desk.page.click('#refresh'); await sleep(800); await desk.page.click('#refresh'); await sleep(800);
        await desk.page.reload(); await saReady(desk.page);
        o.lookupsAfterLoads = calls(srv.home).filter((c) => /^securityagent list-agent-spaces/.test(c)).length;
        await desk.page.click('#sa-ready button:has-text("Check again")');
        await desk.page.waitForFunction(() => { const b = document.querySelector('#sa-ready button'); return b && b.textContent === 'Check again'; }, null, { timeout: 30000 }).catch(() => {});
        o.lookupsAfterCheckAgain = calls(srv.home).filter((c) => /^securityagent list-agent-spaces/.test(c)).length;
      }
      if (name === 'setup') {
        // While the card waits, its 10 s re-check is the light gate endpoint, never the full answer (which scans every repo).
        // A full answer comes only with a page load (/api/data: the heatmap's polls, the minute refresh).
        const seen = [];
        const onReq = (q) => { const u = new URL(q.url()); if (/^\/api\/(security-agent|data$)/.test(u.pathname)) seen.push(u.pathname); };
        desk.page.on('request', onReq);
        await sleep(11500);
        desk.page.off('request', onReq);
        o.pollRequests = seen;
        // Run enable security elsewhere: the card notices the new file within ~10 s, with no click and no AWS call before it.
        o.callsWhileSetup = calls(srv.home).filter((c) => !/^(--version|configure )/.test(c));
        writeFileSync(join(srv.home, '.prism', 'security.json'), machineSetup('111122223333', 'us-west-2'));
        const t0 = Date.now();
        await desk.page.waitForFunction(() => { const g = document.getElementById('sa-gate'); return !g || g.getAttribute('data-state') !== 'setup'; }, null, { timeout: 20000 }).catch(() => {});
        o.recheck = { ms: Date.now() - t0, state: (await snap(desk.page)).state };
      }
      if (name === 'override') {
        // Guards: demo-shop's job-demo-2 is still running (seeded 20 min ago).
        const cmd = (env2) => spawnSync(process.execPath, [ENTRY, 'security', 'code-review', '--no-wait'], { cwd: join(srv.home, 'src', 'demo-shop'), encoding: 'utf8', timeout: 120000, env: demoEnv(srv.home, { PRISM_NO_UPDATE_CHECK: '1', ...env2 }) });
        const before = calls(srv.home).length;
        const cli = cmd({ FAKE_AWS: 'in-progress', FAKE_SA: 'ready' });
        o.cliGuard = { code: cli.status, out: ((cli.stdout || '') + (cli.stderr || '')).slice(-600), writes: calls(srv.home).slice(before).filter((c) => /^(s3api put-object|securityagent start|securityagent create)/.test(c)) };
        const dialog = async (page, label) => {
          await page.locator('#security button:visible', { hasText: new RegExp('^' + label + '$') }).first().click(); await sleep(300);
          return page.evaluate(() => { const d = document.querySelector('dialog.confirm'); return { open: !!d?.open, text: d?.innerText || '', buttons: [...(d?.querySelectorAll('button') || [])].map((b) => b.textContent), focused: document.activeElement?.textContent || '' }; });
        };
        o.running = await dialog(desk.page, 'Review the whole repo');
        await desk.page.screenshot({ path: join(SHOTS, 'gate-running-1280.png') });
        await desk.page.click('dialog.confirm button:has-text("View it")'); await sleep(500);
        o.runningView = await desk.page.evaluate(() => location.hash);
        const phone = await openCtx(srv, { width: 390, height: 844 });
        await phone.page.goto(srv.base + '/' + hash); await saReady(phone.page);
        o.runningPhone = (await dialog(phone.page, 'Review the whole repo')).open;
        await phone.page.screenshot({ path: join(SHOTS, 'gate-running-390.png') });
        // The job finishes (the CLI fetches it; the fake answers COMPLETED): HEAD now has a finished review.
        const fin = spawnSync(process.execPath, [ENTRY, 'security', 'findings'], { cwd: join(srv.home, 'src', 'demo-shop'), encoding: 'utf8', timeout: 120000, env: demoEnv(srv.home, { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'complete', FAKE_SA: 'ready' }) });
        o.finished = fin.status;
        await desk.page.goto(srv.base + '/' + hash); await desk.page.reload(); await saReady(desk.page);
        o.reviewed = await dialog(desk.page, 'Review the whole repo');
        await desk.page.screenshot({ path: join(SHOTS, 'gate-reviewed-1280.png') });
        await desk.page.click('dialog.confirm button:has-text("Open those findings")'); await sleep(500);
        o.reviewedOpen = await desk.page.evaluate(() => location.hash);
        await phone.page.reload(); await saReady(phone.page);
        o.reviewedPhone = (await dialog(phone.page, 'Review the whole repo')).open;
        await phone.page.screenshot({ path: join(SHOTS, 'gate-reviewed-390.png') });
        out.log.push(...phone.log);
        await phone.ctx.close();
      }
      const phone = await openCtx(srv, { width: 390, height: 844 });
      await phone.page.goto(srv.base + '/' + hash);
      if (name === 'checking') await phone.page.waitForSelector('#sa-gate', { timeout: 15000 }).catch(() => {}); else await settled(phone.page);
      o.phone = await snap(phone.page);
      await phone.page.screenshot({ path: join(SHOTS, `gate-${name}-390.png`), fullPage: true });
      o.calls = calls(srv.home);
      out.log.push(...desk.log, ...phone.log);
      await desk.ctx.close(); await phone.ctx.close();
    }
  }
  // ---------- 16. a branch with nothing new since its upstream (1.19.2): disabled branch Start, the whole-repo offer, a neutral drawer ----------
  if (want('branch')) {
    const out = {};
    R.suites.branch = out;
    const BR = 'feat/receiver-tool-usage';
    // demo-shop on a feature branch pushed to a local bare origin: its upstream has every commit.
    const upstream = (h) => {
      const env = { ...process.env, HOME: h, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo Dev', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo Dev', GIT_COMMITTER_EMAIL: 'demo@example.com' };
      const g = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const shop = join(h, 'src', 'demo-shop');
      g(h, 'init', '-q', '--bare', join(h, 'remotes', 'demo-shop.git'));
      // Pushes go to the local bare repo; the origin URL stays the github one, which names the repo for the code review.
      g(shop, 'config', 'url.' + join(h, 'remotes', 'demo-shop.git') + '.pushInsteadOf', 'https://github.com/example/demo-shop.git');
      g(shop, 'switch', '-q', '-c', BR);
      g(shop, 'push', '-q', '-u', 'origin', BR);
      writeFileSync(join(shop, 'scratch.txt'), 'not committed\n');
    };
    const srv = await live('branch', 'full', { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'in-progress', FAKE_SA: 'ready' }, upstream);
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    const sa = await page.evaluate(() => fetch('/api/security-agent').then((r) => r.json()));
    const repo = sa.repos.find((r) => r.path.endsWith('/src/demo-shop'));
    await page.goto(srv.base + '/#security/' + repo.id); await saReady(page);
    await page.waitForSelector('[data-branch-review="blocked"]', { timeout: 15000 }).catch(() => {});
    out.card = await page.evaluate(() => {
      const li = document.querySelector('[data-branch-review]');
      const start = li && [...li.querySelectorAll('button')].find((b) => b.textContent === 'Review this branch');
      return { state: li?.getAttribute('data-branch-review'), text: li?.innerText || '', startDisabled: !!start?.disabled, offer: !!li?.querySelector('[data-full-start]') };
    });
    await page.locator('[data-branch-review]').screenshot({ path: join(SHOTS, 'branch-nothing-card-1280.png') }).catch(() => {});
    // The offer opens the whole-repo review's own guard (demo-shop's job-demo-2 is still running).
    await page.click('[data-branch-review] [data-full-start]'); await sleep(300);
    out.offerDialog = await page.evaluate(() => { const d = document.querySelector('dialog.confirm'); return { open: !!d?.open, title: d?.querySelector('h2')?.textContent || '', buttons: [...(d?.querySelectorAll('button') || [])].map((b) => b.textContent) }; });
    await page.click('dialog.confirm button:has-text("Cancel")');
    // What the user did before: Start another anyway on the branch review. The CLI runs, finds no changes and starts nothing.
    await page.evaluate((id) => startAction(actionDef('security-code-review-force'), { repo: id }), repo.id);
    await page.waitForFunction(() => /nothing to review|exit|refused/.test(document.querySelector('#action-drawer .srow-head .pill')?.textContent || ''), null, { timeout: 90000 }).catch(() => {});
    await sleep(500);
    out.drawer = await page.evaluate(() => {
      const d = document.getElementById('action-drawer');
      return { pill: d?.querySelector('.srow-head .pill')?.textContent || '', pillClass: d?.querySelector('.srow-head .pill')?.className || '', hint: !!d?.querySelector('[data-nothing-hint]'), offer: !!d?.querySelector('[data-full-offer]'), out: d?.querySelector('pre')?.innerText || '' };
    });
    await page.locator('#action-drawer').screenshot({ path: join(SHOTS, 'branch-nothing-drawer-1280.png') }).catch(() => {});
    out.calls = existsSync(join(srv.home, 'aws-calls.log')) ? readFileSync(join(srv.home, 'aws-calls.log'), 'utf8').split('\n').filter(Boolean) : [];
    await ctx.close();
    const phone = await openCtx(srv, { width: 390, height: 844 });
    await phone.page.goto(srv.base + '/#security/' + repo.id); await saReady(phone.page);
    await phone.page.waitForSelector('[data-branch-review="blocked"]', { timeout: 15000 }).catch(() => {});
    out.phoneScroll = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await phone.page.locator('[data-branch-review]').screenshot({ path: join(SHOTS, 'branch-nothing-card-390.png') }).catch(() => {});
    out.log.push(...phone.log);
    await phone.ctx.close();
  }
  // ---------- 16b. auto-check of a pending run (1.21.3): running -> complete without a reload; a failed check says why; over stdio too ----------
  if (want('autocheck')) {
    const out = {};
    R.suites.autocheck = out;
    // job-demo-2 started 3 h ago: without a check it would read "no verdict yet".
    const srv = await live('autocheck', 'full', { PRISM_NO_UPDATE_CHECK: '1', FAKE_SA: 'ready' }, (h) => { agePending(h, 3); fakeMode(h, 'in-progress'); });
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    const checks = [];
    page.on('request', (q) => { if (new URL(q.url()).pathname === '/api/security-check') checks.push(Date.now()); });
    await page.goto(srv.base + '/#security'); await saReady(page);
    const row = () => page.evaluate(() => { const tr = document.querySelector('#security-runs-all tr.run-running'); return tr ? { cls: tr.className, text: tr.innerText.replace(/\s+/g, ' ') } : null; });
    await page.waitForFunction(() => /Checked with AWS/.test(document.getElementById('security-runs-all')?.innerText || ''), null, { timeout: 30000 }).catch(() => {});
    out.running = await row();
    await page.locator('#security-runs-all').screenshot({ path: join(SHOTS, 'autocheck-running-1280.png') }).catch(() => {});
    await page.evaluate(() => { window.__noReload = 1; });
    // The job finishes in AWS. The next check (about a minute later, the page's own refresh) saves its findings.
    fakeMode(srv.home, 'complete');
    const t0 = Date.now();
    await page.waitForFunction(() => [...document.querySelectorAll('#security-runs-all tr.run-complete')].some((x) => /SQL injection in order lookup/.test(x.innerText)), null, { timeout: 120000 }).catch(() => {});
    out.completeMs = Date.now() - t0;
    out.complete = await page.evaluate(() => {
      const tr = [...document.querySelectorAll('#security-runs-all tr.run-complete')].find((x) => /SQL injection in order lookup/.test(x.innerText));
      return { text: tr ? tr.innerText.replace(/\s+/g, ' ') : '', sameDoc: window.__noReload === 1, noverdict: document.querySelectorAll('#security-runs-all tr.run-noverdict').length };
    });
    await page.locator('#security-runs-all').screenshot({ path: join(SHOTS, 'autocheck-complete-1280.png') }).catch(() => {});
    out.checkRequests = checks.length;
    out.calls = existsSync(join(srv.home, 'aws-calls.log')) ? readFileSync(join(srv.home, 'aws-calls.log'), 'utf8').split('\n').filter(Boolean) : [];
    await ctx.close();

    // No credentials: the check fails, the run keeps "no verdict yet" with the reason and the command.
    const bad = await live('autocheck-nocreds', 'full', { PRISM_NO_UPDATE_CHECK: '1' }, (h) => agePending(h, 3));
    const b = await openCtx(bad);
    await b.page.goto(bad.base + '/#');
    await b.page.waitForSelector('#security-runs [data-run-check="error"]', { timeout: 30000 }).catch(() => {});
    out.failed = await b.page.evaluate(() => { const tr = document.querySelector('#security-runs tr.run-noverdict'); return tr ? tr.innerText.replace(/\s+/g, ' ') : ''; });
    out.failedHome = bad.home;
    await b.page.locator('#security-runs').screenshot({ path: join(SHOTS, 'autocheck-failed-1280.png') }).catch(() => {});
    const bp = await openCtx(bad, { width: 390, height: 844 });
    await bp.page.goto(bad.base + '/#'); await bp.page.waitForSelector('#security-runs [data-run-check="error"]', { timeout: 30000 }).catch(() => {});
    out.failedPhoneScroll = await bp.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await bp.page.locator('#security-runs').screenshot({ path: join(SHOTS, 'autocheck-failed-390.png') }).catch(() => {});
    out.log.push(...b.log, ...bp.log);
    await b.ctx.close(); await bp.ctx.close();

    // Over `dashboard --serve-stdio` (the VS Code and Kiro Crew hosts): the same route, the same completion.
    const home = seed('autocheck-stdio', 'full', (h) => { agePending(h, 3); fakeMode(h, 'complete'); });
    const child = spawn(process.execPath, [ENTRY, 'dashboard', '--serve-stdio'], { cwd: readFileSync(join(home, '.start-dir'), 'utf8').trim(), env: demoEnv(home, { PRISM_NO_UPDATE_CHECK: '1', FAKE_SA: 'ready' }), stdio: ['pipe', 'pipe', 'pipe'] });
    running.push(child);
    const waiting = new Map();
    let buf = '', seq = 0;
    child.stdout.on('data', (d) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0;) { const o = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (!o.hello) { waiting.get(o.id)?.(o); waiting.delete(o.id); } } });
    const ask = (m) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); child.stdin.write(JSON.stringify({ id, ...m }) + '\n'); });
    await sleep(1500);
    const s = { answers: [] };
    for (let i = 0; i < 40; i++) {
      const a = await ask({ op: 'get', path: '/api/security-check' });
      s.answers.push(a.json);
      if (a.json && a.json.generation > 0) break;
      await sleep(1000);
    }
    const data = (await ask({ op: 'get', path: '/api/data' })).json;
    const run = (data.security_runs || []).find((r) => r.job_id === 'job-demo-2');
    s.status = run && run.status; s.total = run && run.total;
    child.stdin.end();
    out.stdio = s;
  }
  // ---------- 17. codewatch reviewer and model (1.20): your default in Settings, a repo's override, the team file; a fake claude on PATH ----------
  if (want('reviewer')) {
    const out = { steps: [] };
    R.suites.reviewer = out;
    // The team picked kiro, which is not installed here: the card must say claude runs instead.
    // Nothing pending (dropPending): this suite checks that no AWS call happens, and an auto-check would make one.
    const team = (h) => { const p = join(h, 'src', 'demo-shop', '.prism', 'config.json'); writeFileSync(p, JSON.stringify({ team_id: 'demo', eval: { reviewer: 'kiro' } }, null, 2) + '\n'); dropPending(h); };
    const srv = await live('reviewer', 'full', { PRISM_NO_UPDATE_CHECK: '1' }, team, { reviewers: ['claude'] });
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    const data = await page.evaluate(() => fetch('/api/data').then((r) => r.json()));
    const shop = data.repos.find((r) => r.path.endsWith('/src/demo-shop'));
    const pay = data.repos.find((r) => r.path.endsWith('/src/payments-api'));
    const shopDir = join(srv.home, 'src', 'demo-shop'), payDir = join(srv.home, 'src', 'payments-api');
    const card = () => page.evaluate(() => (document.querySelector('[data-cwrev]')?.innerText || '').replace(/\s+/g, ' '));
    const waitFor = (sel, re) => page.waitForFunction(([s, src]) => new RegExp(src).test((document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ')), [sel, re.source], { timeout: 30000 }).catch(() => {});
    const waitCard = (re) => waitFor('[data-cwrev]', re);
    const runConfirmed = async () => {
      const cb = page.locator('dialog.confirm input[type=checkbox]');
      if (await cb.count()) await cb.check();
      await page.click('dialog.confirm button:has-text("Run")');
      await page.waitForFunction(() => /exit/.test(document.querySelector('#action-drawer .srow-head .pill')?.textContent || ''), null, { timeout: 60000 }).catch(() => {});
      const r = await page.evaluate(() => ({ pill: document.querySelector('#action-drawer .srow-head .pill')?.textContent || '', out: document.querySelector('#action-drawer pre')?.innerText || '' }));
      await page.click('#action-drawer button:has-text("Close")').catch(() => {});
      return r;
    };
    const repoCard = async (r, re) => { await page.goto(srv.base + '/#repo/' + r.id); await waitCard(re || /Reviewer/); return card(); };
    const openForm = async (scope, model) => {
      await page.click('[data-cwrev] [data-cw-change]');
      await page.waitForSelector('[data-cw-form]');
      await page.check(`[data-cwrev] input[name=cw-scope][value=${scope}]`);
      await sleep(300);
      if (model !== undefined) { await page.fill('#cw-model', model); await page.press('#cw-model', 'Tab'); await sleep(500); }
    };
    const settings = async () => { await page.goto(srv.base + '/#settings/repos'); await waitFor('#cw-defaults', /Repos that override it/); return page.evaluate(() => (document.getElementById('cw-defaults')?.innerText || '').replace(/\s+/g, ' ')); };

    out.initial = await repoCard(shop, /Reviewer Claude Code/);
    // 1. Your default, in Settings › Repos: claude with sonnet. Every repo card follows it.
    await settings();
    await page.click('#cw-defaults [data-cwd-change]');
    await page.selectOption('#cwd-reviewer', 'claude');
    await page.fill('#cwd-model', 'sonnet');
    await page.click('#cw-defaults [data-cwd-save]'); await sleep(300);
    out.defaultDialog = await page.evaluate(() => document.querySelector('dialog.confirm pre.cmd')?.textContent || '');
    out.steps.push({ step: 'default', ...(await runConfirmed()) });
    out.settingsAfterDefault = await settings();
    out.globalConfig = existsSync(join(srv.home, '.gitconfig')) ? readFileSync(join(srv.home, '.gitconfig'), 'utf8') : '';
    out.shopFollows = await repoCard(shop, /Model sonnet From your default/);
    out.payFollows = await repoCard(pay, /Model sonnet From your default/);
    // 2. Override demo-shop: haiku for this repo only.
    await repoCard(shop, /Change/);
    await openForm('clone', 'haiku');
    await page.click('[data-cwrev] [data-cw-save]'); await sleep(300);
    out.cloneDialog = await page.evaluate(() => document.querySelector('dialog.confirm pre.cmd')?.textContent || '');
    out.steps.push({ step: 'clone', ...(await runConfirmed()) });
    await waitCard(/Model haiku From overridden for this repo/);
    out.afterClone = await card();
    out.localConfig = readFileSync(join(shopDir, '.git', 'config'), 'utf8');
    out.settingsWithOverride = await settings();
    out.overrideLink = await page.evaluate((id) => !!document.querySelector(`#cw-defaults [data-cwd-repo="${id}"][href="#repo/${id}"]`), shop.id);
    await page.locator('#cw-defaults').screenshot({ path: join(SHOTS, 'reviewer-settings-default-1280.png') }).catch(() => {});
    // 3. The team default: a diff first, a checkbox in the dialog, then the file.
    await repoCard(shop, /Change/);
    await openForm('team', 'opus');
    await page.waitForSelector('[data-cwrev] [data-diff]', { timeout: 15000 }).catch(() => {});
    out.teamDiff = await page.evaluate(() => [...document.querySelectorAll('[data-cwrev] [data-diff] span')].map((s) => s.className + '|' + s.textContent.trimEnd()));
    out.teamWarn = await page.evaluate(() => /is a repo file\. Commit it to share the change; the CI eval gate reads it/.test(document.querySelector('[data-cwrev]')?.innerText || ''));
    await page.locator('[data-cwrev]').screenshot({ path: join(SHOTS, 'reviewer-team-diff-1280.png') }).catch(() => {});
    const phone = await openCtx(srv, { width: 390, height: 844 });
    await phone.page.goto(srv.base + '/#repo/' + shop.id);
    await phone.page.waitForSelector('[data-cwrev] [data-cw-change]', { timeout: 30000 }).catch(() => {});
    await phone.page.click('[data-cwrev] [data-cw-change]').catch(() => {});
    await phone.page.check('[data-cwrev] input[name=cw-scope][value=team]').catch(() => {});
    await phone.page.fill('#cw-model', 'claude-sonnet-4-5-20250929').catch(() => {});
    await phone.page.press('#cw-model', 'Tab').catch(() => {});
    await phone.page.waitForSelector('[data-cwrev] [data-diff]', { timeout: 15000 }).catch(() => {});
    out.phoneScroll = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await phone.page.locator('[data-cwrev]').screenshot({ path: join(SHOTS, 'reviewer-team-diff-390.png') }).catch(() => {});
    await phone.page.goto(srv.base + '/#settings/repos');
    await phone.page.waitForFunction(() => /Repos that override it/.test(document.getElementById('cw-defaults')?.innerText || ''), null, { timeout: 30000 }).catch(() => {});
    out.phoneSettingsScroll = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    out.log.push(...phone.log);
    await phone.ctx.close();
    await page.click('[data-cwrev] [data-cw-save]'); await sleep(300);
    out.teamDialog = await page.evaluate(() => ({ cmd: document.querySelector('dialog.confirm pre.cmd')?.textContent || '', diff: !!document.querySelector('dialog.confirm [data-diff]'), runDisabled: !![...document.querySelectorAll('dialog.confirm button')].find((b) => b.textContent === 'Run')?.disabled }));
    out.steps.push({ step: 'team', ...(await runConfirmed()) });
    await waitCard(/Model opus From team file/);
    out.afterTeam = await card();
    out.teamFile = JSON.parse(readFileSync(join(shopDir, '.prism', 'config.json'), 'utf8'));
    // 4. A personal model under the team pin: said plainly, with the team scope offered.
    await openForm('clone', 'mine-1');
    await page.waitForSelector('[data-cwrev] [data-pin-warning]', { timeout: 15000 }).catch(() => {});
    out.pinWarning = await page.evaluate(() => document.querySelector('[data-cwrev] [data-pin-warning]')?.textContent || '');
    // 5. Reset the team default: this repo's override applies again.
    await page.check('[data-cwrev] input[name=cw-scope][value=team]'); await sleep(300);
    await page.click('[data-cwrev] [data-cw-reset]'); await sleep(300);
    out.steps.push({ step: 'team-reset', ...(await runConfirmed()) });
    await waitCard(/Model haiku From overridden for this repo/);
    out.afterTeamReset = await card();
    out.teamFileAfterReset = readFileSync(join(shopDir, '.prism', 'config.json'), 'utf8');
    // 6. Reset to my default on the card.
    await page.click('[data-cwrev] button:has-text("Reset to my default")'); await sleep(300);
    out.steps.push({ step: 'reset-to-default', ...(await runConfirmed()) });
    await waitCard(/Model sonnet From your default/);
    out.afterResetToDefault = await card();
    await page.locator('[data-cwrev]').screenshot({ path: join(SHOTS, 'reviewer-card-1280.png') }).catch(() => {});
    // 7. Override two repos, then Apply my default to all repos: the dialog lists them; both follow the default.
    for (const r of [shop, pay]) {
      await repoCard(r, /Change/);
      await openForm('clone', 'haiku');
      await page.click('[data-cwrev] [data-cw-save]'); await sleep(300);
      out.steps.push({ step: 'override-' + r.name, ...(await runConfirmed()) });
      await waitCard(/From overridden for this repo/);
    }
    await settings();
    await page.click('#cw-defaults [data-cwd-apply-all]'); await sleep(300);
    out.applyDialog = await page.evaluate(() => ({ list: [...document.querySelectorAll('dialog.confirm [data-confirm-list] li')].map((l) => l.textContent), runDisabled: !![...document.querySelectorAll('dialog.confirm button')].find((b) => b.textContent === 'Run')?.disabled }));
    out.steps.push({ step: 'apply-all', ...(await runConfirmed()) });
    out.settingsAfterApply = await settings();
    out.shopAfterApply = await repoCard(shop, /Model sonnet From your default/);
    out.payAfterApply = await repoCard(pay, /Model sonnet From your default/);
    out.teamFileAfterApply = readFileSync(join(shopDir, '.prism', 'config.json'), 'utf8');
    out.payLocal = readFileSync(join(payDir, '.git', 'config'), 'utf8');
    await page.goto(srv.base + '/#settings/repos'); await sleep(900);
    out.settingsLink = await page.evaluate((id) => !!document.querySelector(`[data-cw-link][href="#repo/${id}"]`), shop.id);
    out.reviewerCalls = existsSync(join(srv.home, 'reviewer-calls.log')) ? readFileSync(join(srv.home, 'reviewer-calls.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
    out.awsCalls = existsSync(join(srv.home, 'aws-calls.log')) ? readFileSync(join(srv.home, 'aws-calls.log'), 'utf8').trim().split('\n').filter(Boolean) : [];
    await ctx.close();
  }
  // ---------- 18. a threat model's drill-down (1.20.1): header fields, the overview card, 18 threats ----------
  if (want('tmdetail')) {
    const out = {};
    R.suites.tmdetail = out;
    const { makeResult, writeResult } = await import(join(CLI, 'dist', 'src', 'codewatch', 'results.js'));
    let runId = null;
    // Shaped like a real result: a long markdown overview (headings, lists, a table, hostile markup) and 7 critical, 10 high, 1 medium.
    const seedTm = (h) => {
      const shop = join(h, 'src', 'demo-shop');
      const commit = execFileSync('git', ['-C', shop, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const sev = [...Array(7).fill('CRITICAL'), ...Array(10).fill('HIGH'), 'MEDIUM'];
      const overview = ['# Demo Shop', '', 'A demo web shop with a `payments` webhook and an **admin** console.', '', '## Purpose', '',
        ...Array.from({ length: 40 }, (_, i) => `- Component ${i}: handles part ${i} of the checkout <img src=x onerror=alert(1)> [docs](javascript:alert(1))`), '',
        '## Data flows', '', ...Array.from({ length: 20 }, (_, i) => `${i + 1}. Flow ${i} from the browser to the API`), '', '| Asset | Owner |', '| --- | --- |', '| orders | shop |', '',
        ...Array.from({ length: 60 }, (_, i) => `Paragraph ${i} describes the system at length so the overview is long, as a real one is.`)].join('\n');
      const p = writeResult(shop, makeResult({ kind: 'security-threat-model', hook: 'manual', tool: 'security-agent', status: 'findings', commit, branch: 'main', started_at: new Date(Date.now() - 5 * 3600e3).toISOString(), finished_at: new Date(Date.now() - 4 * 3600e3).toISOString(),
        summary: '18 threats: 7 critical, 10 high, 1 medium, 0 low, 0 info',
        findings: sev.map((s, i) => ({ severity: s === 'MEDIUM' ? 'medium' : 'high', category: 'security', rule: 'TAMPERING', file: '', line: null, message: `Threat ${i}: statement`, description: `The full threat statement number ${i}, which is long enough to wrap across lines on a phone screen without scrolling sideways.`,
          risk_level: s, title: `Demo threat ${i}`, threat_id: `t-${i}`, stride: ['TAMPERING'], recommendation: `Recommendation ${i}.`, evidence: [`src/file${i}.ts`], ...(i < 3 ? { assets: ['payments webhook', 'admin console'] } : {}) })),
        threat_model: { job_id: 'tj-demo-18', threat_model_id: 'tm-demo', agent_space_id: 'as-0demo0000000001', region: 'us-west-2', account: '111122223333', job_status: 'COMPLETED',
          counts: { CRITICAL: 7, HIGH: 10, MEDIUM: 1, LOW: 0, INFO: 0 }, stride_counts: { TAMPERING: 18 }, scope_docs: [], system_overview: overview,
          service_created_at: new Date(Date.now() - 5 * 3600e3).toISOString(), service_updated_at: new Date(Date.now() - 4 * 3600e3).toISOString(), service_duration_s: 3869, wall_s: null } }));
      runId = p.split('/').pop().replace(/\.json$/, '');
    };
    const srv = await live('tmdetail', 'full', { PRISM_NO_UPDATE_CHECK: '1' }, seedTm);
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    const data = await page.evaluate(() => fetch('/api/data').then((r) => r.json()));
    const shop = data.repos.find((r) => r.path.endsWith('/src/demo-shop'));
    const hash = '#security/run/' + shop.id + '/' + runId;
    const state = () => page.evaluate(() => {
      const sec = document.getElementById('security');
      const dl = sec.querySelector('.rundl');
      const dts = [...(dl?.querySelectorAll('dt') || [])];
      const ov = sec.querySelector('[data-run-overview]');
      return {
        dts: dts.map((d) => d.textContent), dds: [...(dl?.querySelectorAll('dd') || [])].map((d) => d.innerText.replace(/\s+/g, ' ')),
        // Every header row sits close under the previous one: the bug spread them over the overview's height.
        spread: dts.length ? dts[dts.length - 1].getBoundingClientRect().top - dts[0].getBoundingClientRect().top : -1,
        ov: ov ? { mode: ov.getAttribute('data-run-overview'), text: ov.innerText.slice(0, 300), lis: ov.querySelectorAll('li').length, tags: [...new Set([...ov.querySelectorAll('*')].map((e) => e.tagName))], attrs: [...ov.querySelectorAll('*')].some((e) => e.attributes.length) } : null,
        findings: sec.querySelectorAll('details[data-fid]').length, chips: [...sec.querySelectorAll('[data-sev]')].map((b) => b.textContent),
        scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    await page.goto(srv.base + '/' + hash);
    await page.waitForSelector('[data-run-findings]', { timeout: 15000 }).catch(() => {});
    out.before = await state();
    await page.screenshot({ path: join(SHOTS, 'tm-drilldown-1280-dark.png'), fullPage: false });
    await page.click('[data-overview-toggle]'); await sleep(300);
    out.full = await state();
    await page.click('[data-overview-toggle]'); await sleep(200);
    out.collapsedAgain = (await state()).ov?.mode;
    await page.click('[data-sev="critical"]'); await sleep(200);
    out.critical = (await state()).findings;
    await page.click('[data-sev=""]'); await sleep(200);
    out.firstThreat = await page.evaluate(() => document.querySelector('details[data-fid]')?.innerText.replace(/\s+/g, ' ') || '');
    await setTheme(page, 'light');
    await page.goto(srv.base + '/' + hash); await page.waitForSelector('[data-run-findings]', { timeout: 15000 }).catch(() => {});
    out.contrast = (await layoutCheck(page)).lowContrast;
    await page.screenshot({ path: join(SHOTS, 'tm-drilldown-1280-light.png'), fullPage: false });
    await setTheme(page, 'dark');
    await ctx.close();
    const phone = await openCtx(srv, { width: 390, height: 844 });
    await phone.page.goto(srv.base + '/' + hash);
    await phone.page.waitForSelector('[data-run-findings]', { timeout: 15000 }).catch(() => {});
    await phone.page.click('[data-overview-toggle]').catch(() => {}); await sleep(300);
    out.phone = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await phone.page.screenshot({ path: join(SHOTS, 'tm-drilldown-390-dark.png'), fullPage: false });
    out.log.push(...phone.log);
    await phone.ctx.close();
  }

  // ---------- 19. the pentest Dockerfile picker (1.21.5): tracked Dockerfiles, pentest.json preselected, typed paths checked, commands follow; over stdio too ----------
  if (want('pentest')) {
    const out = { log: [] };
    R.suites.pentest = out;
    const D = 'FROM scratch\n';
    // demo-shop gets four tracked Dockerfiles (one in a folder with a space), a committed pentest.json and a
    // tracked symlink to a folder outside the repo. Only these paths are added: the seeded repo override stays untracked.
    const dockerfiles = (h) => {
      const env = { ...process.env, HOME: h, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo Dev', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo Dev', GIT_COMMITTER_EMAIL: 'demo@example.com' };
      const shop = join(h, 'src', 'demo-shop');
      const w = (p, c) => { mkdirSync(dirname(join(shop, p)), { recursive: true }); writeFileSync(join(shop, p), c); };
      w('Dockerfile', D); w('services/api/Dockerfile.prod', D); w('docker/web.Dockerfile', D); w('my app/Dockerfile', D); w('docs/README.md', 'docs\n');
      w('.prism/pentest.json', JSON.stringify({ path: 'services/api', dockerfile: 'services/api/Dockerfile.prod', port: 3000, healthPath: '/healthz' }, null, 2));
      mkdirSync(join(h, 'outside')); writeFileSync(join(h, 'outside', 'Dockerfile'), D);
      symlinkSync(join(h, 'outside'), join(shop, 'escape'));
      execFileSync('git', ['add', 'Dockerfile', 'services', 'docker', 'my app', 'docs', '.prism/pentest.json', 'escape'], { cwd: shop, env });
      execFileSync('git', ['commit', '-q', '-m', 'Dockerfiles'], { cwd: shop, env });
    };
    const srv = await live('pentest', 'full', { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'in-progress', FAKE_SA: 'ready' }, dockerfiles);
    const shop = join(srv.home, 'src', 'demo-shop');
    const tree = () => execFileSync('git', ['-C', shop, 'status', '--porcelain', '--', '.', ':!.prism/results'], { encoding: 'utf8' });
    const before = { tree: tree(), config: readFileSync(join(shop, '.prism', 'pentest.json'), 'utf8') };
    const { ctx, page, log } = await openCtx(srv, { width: 1280, height: 900 }, { permissions: ['clipboard-read', 'clipboard-write'] });
    out.log = log;
    await setTheme(page, 'dark');
    const sa = await page.evaluate(() => fetch('/api/security-agent').then((r) => r.json()));
    const repo = sa.repos.find((r) => r.path.endsWith('/src/demo-shop'));
    const other = sa.repos.find((r) => r.path.endsWith('/src/payments-api'));
    await page.goto(srv.base + '/#security/' + repo.id); await saReady(page);
    await page.waitForSelector('[data-pt-repo]', { timeout: 15000 }).catch(() => {});
    const cmdOf = (key) => `[data-pt-cmd="${key}"]`;
    const waitCmd = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-pt-cmd="pentest"] code')?.innerText || ''), re.source, { timeout: 15000 }).catch(() => {});
    const pt = () => page.evaluate(() => {
      const root = document.querySelector('[data-pt-repo]');
      if (!root) return null;
      const cmd = (k) => { const d = document.querySelector('[data-pt-cmd="' + k + '"]'); return { text: d?.querySelector('code')?.innerText || '', copy: !!d && !d.querySelector('button')?.disabled, badge: d?.querySelector('.badge')?.innerText || '' }; };
      return {
        radios: [...root.querySelectorAll('input[type=radio]')].map((r) => ({ v: r.value, on: r.checked, label: r.closest('label')?.innerText.trim() || '' })),
        fields: ['dir', 'port', 'health'].map((k) => root.querySelector('[id^="sa-pt-' + k + '-"]')?.value),
        errs: [...root.querySelectorAll('[data-pt-err]')].map((e) => e.getAttribute('data-pt-err') + ': ' + e.innerText),
        dry: document.querySelector('[data-pt-cmd="pentestDryRun"]') ? cmd('pentestDryRun') : null, run: cmd('pentest'), text: root.innerText, runButtons: [...document.querySelectorAll('#security li')].filter((li) => /^Pentest/.test(li.querySelector('b')?.innerText || '')).flatMap((li) => [...li.querySelectorAll('button')].map((b) => b.innerText)).filter((t) => t !== 'Copy'),
      };
    });
    await waitCmd(/--dockerfile/);
    out.initial = await pt();
    await page.locator('section.card', { has: page.locator('[data-pt-repo]') }).screenshot({ path: join(SHOTS, 'pentest-picker-1280.png') }).catch(() => {});
    // The docs screenshot: the whole Security Agent page, dark, at 1280.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(SHOTS, 'dashboard-security-agent-dark.png'), fullPage: true }).catch(() => {});
    // Pick docker/web.Dockerfile: the build folder follows it and the commands change.
    await page.check('[data-pt-repo] input[type=radio][value="docker/web.Dockerfile"]');
    await waitCmd(/--dockerfile docker\/web\.Dockerfile/);
    out.web = await pt();
    // The folder with a space: quoted for the shell.
    await page.check('[data-pt-repo] input[type=radio][value="my app/Dockerfile"]');
    await waitCmd(/--dockerfile 'my app\/Dockerfile'/);
    out.space = await pt();
    // Typing keeps the focus across the redraws: every key lands.
    await page.click('[id^="sa-pt-port-"]'); await page.keyboard.press('End');
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    await page.keyboard.type('9090', { delay: 120 });
    await waitCmd(/--port 9090/);
    out.typed = await pt();
    out.focus = await page.evaluate(() => document.activeElement?.id || '');
    // Copy puts the exact command on the clipboard.
    await page.locator(cmdOf('pentest') + ' button', { hasText: 'Copy' }).click(); await sleep(200);
    out.clipboard = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'unreadable: ' + e.message));
    // Other folder…: a path out of the repo, a symlink out of it, a folder with no Dockerfile, then a good folder.
    await page.check('[data-pt-repo] input[type=radio][value="__other__"]');
    const typeOther = async (v) => { await page.fill('[id^="sa-pt-other-"]', v); await sleep(700); return pt(); };
    out.bad = { dotdot: await typeOther('../outside'), abs: await typeOther(srv.home + '/outside'), link: await typeOther('escape'), none: await typeOther('docs'), good: await typeOther('my app'), file: await typeOther('services/api/Dockerfile.prod') };
    await typeOther('../outside');
    await page.locator('section.card', { has: page.locator('[data-pt-repo]') }).screenshot({ path: join(SHOTS, 'pentest-picker-error-1280.png') }).catch(() => {});
    await typeOther('my app');
    // Another repo, then back: the choice is page memory.
    await page.selectOption('#sa-repo', other.id); await sleep(800);
    out.otherRepo = await pt();
    await page.selectOption('#sa-repo', repo.id); await sleep(800);
    out.back = { ...(await pt()), other: await page.inputValue('[id^="sa-pt-other-"]').catch(() => null) };
    await ctx.close();
    // A reload forgets it: pentest.json's choice again.
    const fresh = await openCtx(srv);
    await fresh.page.goto(srv.base + '/#security/' + repo.id); await saReady(fresh.page);
    await fresh.page.waitForSelector('[data-pt-repo]', { timeout: 15000 }).catch(() => {});
    await fresh.page.waitForFunction(() => /--dockerfile/.test(document.querySelector('[data-pt-cmd="pentest"] code')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
    out.reloaded = await fresh.page.evaluate(() => [...document.querySelectorAll('[data-pt-repo] input[type=radio]')].filter((r) => r.checked).map((r) => r.value));
    out.log.push(...fresh.log);
    await fresh.ctx.close();
    const phone = await openCtx(srv, { width: 390, height: 844 });
    await setTheme(phone.page, 'dark');
    await phone.page.goto(srv.base + '/#security/' + repo.id); await saReady(phone.page);
    await phone.page.waitForSelector('[data-pt-repo]', { timeout: 15000 }).catch(() => {});
    await sleep(600);
    out.phoneScroll = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await phone.page.locator('section.card', { has: phone.page.locator('[data-pt-repo]') }).screenshot({ path: join(SHOTS, 'pentest-picker-390.png') }).catch(() => {});
    out.log.push(...phone.log);
    await phone.ctx.close();
    out.after = { tree: tree(), config: readFileSync(join(shop, '.prism', 'pentest.json'), 'utf8') };
    out.before = before;
    out.calls = existsSync(join(srv.home, 'aws-calls.log')) ? readFileSync(join(srv.home, 'aws-calls.log'), 'utf8').split('\n').filter(Boolean) : [];
    out.home = srv.home;

    // Over `dashboard --serve-stdio` (the VS Code and Kiro Crew hosts): the shared dist/ui bundle draws the same picker.
    const home = seed('pentest-stdio', 'full', (h) => { dockerfiles(h); dropPending(h); });
    const child = spawn(process.execPath, [ENTRY, 'dashboard', '--serve-stdio'], { cwd: readFileSync(join(home, '.start-dir'), 'utf8').trim(), env: demoEnv(home, { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'in-progress', FAKE_SA: 'ready' }), stdio: ['pipe', 'pipe', 'pipe'] });
    running.push(child);
    const waiting = new Map();
    let buf = '', hello = null, seq = 0, helloOk;
    const helloP = new Promise((r) => { helloOk = r; });
    child.stdout.on('data', (b) => { buf += b; for (let i; (i = buf.indexOf('\n')) >= 0;) { const o = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (o.hello) { hello = o; helloOk(o); continue; } waiting.get(o.id)?.(o); waiting.delete(o.id); } });
    await Promise.race([helloP, sleep(20000)]);
    const ask = (m) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); child.stdin.write(JSON.stringify({ id, ...m }) + '\n'); });
    const s = { relayed: [], routes: hello ? hello.routes.get.filter((r) => /pentest/.test(r)) : [] };
    out.stdio = s;
    const ORIGIN = 'https://prism-ui.test', nonce = 'bm9uY2Vub25jZQ==';
    const files = JSON.parse(readFileSync(join(hello.uiDir, 'manifest.json'), 'utf8')).files;
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${ORIGIN}; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
    const html = `<!DOCTYPE html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${ORIGIN}/prism-ui.css"></head>`
      + `<body><div class="wrap">${readFileSync(join(hello.uiDir, 'body.html'), 'utf8')}</div><script nonce="${nonce}" src="${ORIGIN}/bridge.js"></script><script nonce="${nonce}" src="${ORIGIN}/prism-ui.js"></script></body></html>`;
    const sctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const sp = await sctx.newPage();
    sp.on('pageerror', (e) => out.log.push({ tag: 'pentest stdio', type: 'pageerror', text: String(e).slice(0, 300) }));
    await sp.route(`${ORIGIN}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      if (!files.includes(name)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ status: 200, contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(join(hello.uiDir, name)) });
    });
    await sp.exposeBinding('__hostPost', async (_s, m) => {
      if (!m || m.type !== 'prism-ui:request' || !(m.op === 'get' ? hello.routes.get : hello.routes.act).includes(m.path)) return;
      s.relayed.push(m.op + ' ' + m.path);
      const a = await ask(m.op === 'get' ? { op: 'get', path: m.path, query: m.query || {} } : { op: 'act', path: m.path, body: m.body });
      await sp.evaluate((msg) => window.dispatchEvent(new MessageEvent('message', { data: msg })), { type: 'prism-ui:response', id: m.id, status: a.status, json: a.json });
    });
    await sp.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__hostPost(m), getState: () => undefined, setState: () => {} }); });
    await sp.goto(`${ORIGIN}/index.html#security`);
    await sp.waitForSelector('#sa-ready', { timeout: 30000 }).catch(() => {});
    await sp.waitForSelector('[data-pt-repo]', { timeout: 15000 }).catch(() => {});
    await sp.waitForFunction(() => /--dockerfile/.test(document.querySelector('[data-pt-cmd="pentest"] code')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
    s.kind = await sp.evaluate(() => TRANSPORT.kind);
    s.initial = await sp.evaluate(() => document.querySelector('[data-pt-cmd="pentest"] code')?.innerText || '');
    await sp.check('[data-pt-repo] input[type=radio][value="docker/web.Dockerfile"]');
    await sp.waitForFunction(() => /--dockerfile docker\/web\.Dockerfile/.test(document.querySelector('[data-pt-cmd="pentest"] code')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
    s.picked = await sp.evaluate(() => document.querySelector('[data-pt-cmd="pentest"] code')?.innerText || '');
    // 1.21.7: the Start pentest dialog, drawn by the bundle, lists what it deploys; Cancel sends nothing.
    await sp.waitForSelector('[data-pt-run="security-pentest-start"]:not([disabled])', { timeout: 15000 }).catch(() => {});
    await sp.click('[data-pt-run="security-pentest-start"]').catch(() => {}); await sleep(300);
    s.dialog = await sp.evaluate(() => { const d = document.querySelector('dialog.confirm'); return d && d.open ? { text: d.innerText.replace(/\s+/g, ' '), items: d.querySelectorAll('[data-pt-resources] li').length, box: !!d.querySelector('input[type=checkbox]') } : null; });
    await sp.locator('dialog.confirm').screenshot({ path: join(SHOTS, 'pentest-start-dialog-stdio.png') }).catch(() => {});
    await sp.locator('dialog.confirm button', { hasText: 'Cancel' }).click().catch(() => {}); await sleep(200);
    s.actsAfterDialog = s.relayed.filter((r) => r === 'act /api/action').length;
    await sp.check('[data-pt-repo] input[type=radio][value="__other__"]');
    await sp.fill('[id^="sa-pt-other-"]', 'escape'); await sleep(900);
    s.err = await sp.evaluate(() => document.querySelector('[data-pt-err="dockerfile"]')?.innerText || '');
    await sp.locator('section.card', { has: sp.locator('[data-pt-repo]') }).screenshot({ path: join(SHOTS, 'pentest-picker-stdio.png') }).catch(() => {});
    await sctx.close();
    child.stdin.end();
  }
  // ---------- 20. the pentest Run buttons (1.21.6; 1.21.7: no plan, the start dialog lists what it deploys): start, the background --status teardown, Clean up; over stdio too ----------
  // The real `security pentest` runs end to end against fakes: fakebin/aws (FAKE_PT), fakebin/docker on PATH, and
  // fakebin/cdk as PRISM_PENTEST_CDK_DIR's node_modules/.bin/cdk. Nothing reaches AWS, Docker or the network.
  if (want('pentestrun')) {
    const out = { log: [], steps: {} };
    R.suites.pentestrun = out;
    const D = 'FROM scratch\n';
    const prep = (h) => {
      const env = { ...process.env, HOME: h, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Demo Dev', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo Dev', GIT_COMMITTER_EMAIL: 'demo@example.com' };
      const shop = join(h, 'src', 'demo-shop');
      const w = (p, c) => { mkdirSync(dirname(join(shop, p)), { recursive: true }); writeFileSync(join(shop, p), c); };
      w('Dockerfile', D); w('services/api/Dockerfile.prod', D);
      w('.prism/pentest.json', JSON.stringify({ path: 'services/api', dockerfile: 'services/api/Dockerfile.prod', port: 3000, healthPath: '/healthz' }, null, 2));
      execFileSync('git', ['add', 'Dockerfile', 'services', '.prism/pentest.json'], { cwd: shop, env });
      execFileSync('git', ['commit', '-q', '-m', 'Dockerfiles'], { cwd: shop, env });
      dropPending(h);
      const bin = join(h, 'pentest-cdk', 'node_modules', '.bin');
      mkdirSync(bin, { recursive: true });
      symlinkSync(join(HERE, 'fakebin', 'cdk'), join(bin, 'cdk'));
    };
    const name = 'pentestrun';
    const home = seed(name, 'full', prep);
    const ENV = { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'in-progress', FAKE_SA: 'ready', FAKE_PT: '1', PRISM_PENTEST_CDK_DIR: join(home, 'pentest-cdk') };
    const shop = join(home, 'src', 'demo-shop');
    const lines = (f) => (existsSync(join(home, f)) ? readFileSync(join(home, f), 'utf8').split('\n').filter(Boolean) : []);
    const results = () => readdirSync(join(shop, '.prism', 'results')).filter((f) => f.endsWith('.json')).map((f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(shop, '.prism', 'results', f), 'utf8')) })).filter((r) => r.kind === 'security-pentest' && r.pentest?.stack !== undefined && r.pentest?.job_id?.startsWith('ptj-run-'));
    const serve = async () => { const s = await startDashboard(home, ENV); running.push(s.proc); return { ...s, base: `http://127.0.0.1:${s.port}` }; };
    // 1.21.7: every pentest record (a deploying one has no job yet), and waiting for one to reach a state.
    const readRec = (f) => { try { return { id: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(shop, '.prism', 'results', f), 'utf8')) }; } catch { return null; } };
    const allPt = () => { try { return readdirSync(join(shop, '.prism', 'results')).filter((f) => f.endsWith('.json')).map(readRec).filter((r) => r && r.kind === 'security-pentest'); } catch { return []; } };
    const actionDone = async (id, maxMs) => { const t0 = Date.now(); for (;;) { const st = await page.evaluate(() => api('/api/action/status').then((r) => r.json)); if (st.action === id && st.state === 'done') return st; if (Date.now() - t0 > maxMs) return st; await sleep(400); } };
    const recOf = (id) => allPt().find((r) => r.id === id) || null;
    const waitRec = async (id, pred, maxMs = 90000) => { const t0 = Date.now(); for (;;) { const r = recOf(id); if (r && pred(r)) return r; if (Date.now() - t0 > maxMs) return r; await sleep(250); } };
    const ptPick = { dockerfile: 'services/api/Dockerfile.prod', app_dir: 'services/api', port: '3000', health_path: '/healthz' };
    const startApi = () => page.evaluate((b) => api('/api/action', b).then((r) => ({ status: r.status, json: r.json })), { action: 'security-pentest-start', repo: repo.id, ...ptPick, confirm: true });
    let srv = await serve();
    let { ctx, page, log } = await openCtx(srv, { width: 1280, height: 900 });
    out.log = log;
    await setTheme(page, 'dark');
    const sa = await page.evaluate(() => fetch('/api/security-agent').then((r) => r.json()));
    const repo = sa.repos.find((r) => r.path.endsWith('/src/demo-shop'));
    const drawer = () => page.evaluate(() => { const d = document.getElementById('action-drawer'); return d ? { hidden: d.hidden, status: d.querySelector('.srow-head')?.innerText.replace(/\s+/g, ' ').slice(0, 300), out: d.querySelector('pre')?.innerText.slice(-1500) } : null; });
    const waitDone = async (maxMs = 120000) => { const t0 = Date.now(); for (;;) { const d = await drawer(); if (d && !d.hidden && !/running|starting/.test(d.status || '')) return d; if (Date.now() - t0 > maxMs) return { hung: true, ...d }; await sleep(500); } };
    const dialog = () => page.evaluate(() => { const d = document.querySelector('dialog.confirm'); return d && d.open ? { text: d.innerText.replace(/\s+/g, ' '), buttons: [...d.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), dis: b.disabled })), box: !!d.querySelector('input[type=checkbox]'),
      resources: [...d.querySelectorAll('[data-pt-resources] li')].map((l) => l.innerText), target: d.querySelector('[data-pt-target]')?.innerText.replace(/\s+/g, ' ') || null, cmds: [...d.querySelectorAll('pre.cmd')].map((x) => x.innerText.replace(/\s+/g, ' ')),
      overflow: d.scrollWidth - d.clientWidth } : null; });
    const callMark = () => ({ aws: lines('aws-calls.log').length, cdk: lines('cdk-calls.log').length, docker: lines('docker-calls.log').length });
    const callsSince = (m) => ({ aws: lines('aws-calls.log').slice(m.aws), cdk: lines('cdk-calls.log').slice(m.cdk), docker: lines('docker-calls.log').slice(m.docker) });
    const openPage = async () => {
      // A reload, not only a hash change: the Security Agent answer is read again.
      await page.goto(srv.base + '/#security/' + repo.id); await saReady(page);
      await page.waitForFunction(() => !!document.querySelector('[data-pt-run="security-pentest-start"]:not([disabled])'), null, { timeout: 15000 }).catch(() => {});
    };
    await openPage();
    out.steps.page = await page.evaluate(() => ({
      text: document.getElementById('security').innerText,
      buttons: [...document.querySelectorAll('[data-pt-run]')].map((b) => ({ id: b.getAttribute('data-pt-run'), label: b.textContent, disabled: b.disabled })),
      copy: [...document.querySelectorAll('[data-pt-cmd] code')].map((c) => c.innerText),
    }));
    // 1. 1.21.7: the plan (dry run) is gone from the page and from the server's actions; nothing runs for it.
    const before = callMark();
    out.steps.plan = await page.evaluate((id) => api('/api/action', { action: 'security-pentest-plan', repo: id, dockerfile: 'services/api/Dockerfile.prod', app_dir: 'services/api', port: '3000', health_path: '/healthz' }).then((r) => ({ status: r.status, error: r.json && r.json.error })), repo.id);
    await sleep(300);
    out.steps.planCalls = callsSince(before);
    // 2. A bad choice sent straight to the server is refused before anything runs.
    const mark = lines('cdk-calls.log').length;
    out.steps.bad = await page.evaluate((id) => api('/api/action', { action: 'security-pentest-start', repo: id, dockerfile: '../../etc/passwd', port: '3000', health_path: '/healthz', confirm: true }).then((r) => ({ status: r.status, error: r.json && r.json.error })), repo.id);
    out.steps.badSpawned = lines('cdk-calls.log').length !== mark;
    // That 400 is the answer under test; the browser logs it too.
    await sleep(300);
    out.log.splice(0, out.log.length, ...out.log.filter((l) => !(/POST .*\/api\/action$/.test(l.text) || /status of 400/.test(l.text))));
    // 3. Start pentest: the confirm dialog lists what it deploys; opening it, Cancel and the tick box run nothing. Then --yes with the flags; no --wait, no --keep.
    const b1 = callMark();
    await page.click('[data-pt-run="security-pentest-start"]'); await sleep(300);
    await page.locator('dialog.confirm button', { hasText: 'Cancel' }).click(); await sleep(200);
    out.steps.cancelled = await page.evaluate(() => !document.querySelector('dialog.confirm')?.open);
    await page.click('[data-pt-run="security-pentest-start"]'); await sleep(300);
    out.steps.startDialog = await dialog();
    await page.screenshot({ path: join(SHOTS, 'pentest-start-dialog-1280.png') }).catch(() => {});
    // The docs screenshot: the dialog from its top (Cancel has the focus, which scrolls it to the end).
    await page.evaluate(() => { document.querySelector('dialog.confirm').scrollTop = 0; }); await sleep(100);
    await page.locator('dialog.confirm').screenshot({ path: join(SHOTS, 'pentest-start-dialog-dark.png') }).catch(() => {});
    await page.check('dialog.confirm input[type=checkbox]');
    out.steps.ticked = await dialog();
    out.steps.beforeConfirm = callsSince(b1);
    const b2 = { aws: lines('aws-calls.log').length, docker: lines('docker-calls.log').length };
    // 1.21.7: the deploy runs detached. Slow fake cdk steps, so the phases and the Bootstrapping views can be seen.
    writeFileSync(join(home, 'fake-cdk-slow'), '3');
    const t3 = Date.now();
    await page.locator('dialog.confirm button', { hasText: 'Deploy and start' }).click();
    out.steps.start = await waitDone(20000);
    out.steps.startMs = Date.now() - t3;
    out.steps.startLink = await page.evaluate(() => document.querySelector('#action-drawer [data-run-boot] a')?.getAttribute('href') || null);
    await page.locator('#action-drawer').screenshot({ path: join(SHOTS, 'pentest-bootstrapping-drawer.png') }).catch(() => {});
    const boot = allPt().find((r) => r.status === 'deploying');
    const runId = boot?.id;
    out.steps.boot = boot ? { phase: boot.pentest.deploy.phase, log: boot.pentest.deploy.log, stack: boot.pentest.stack, choice: [boot.pentest.deploy.app_dir, boot.pentest.deploy.dockerfile, boot.pentest.deploy.port, boot.pentest.deploy.health_path] } : null;
    out.steps.lockState = await page.evaluate(() => api('/api/action/status').then((r) => r.json.state));
    // The lock is free while it deploys: a read-only action runs; a second Start is refused.
    out.steps.second = await startApi();
    // The deliberate 409 is the answer under test; the browser logs it too.
    await sleep(200);
    out.log.splice(0, out.log.length, ...out.log.filter((l) => !(/POST .*\/api\/action$/.test(l.text) || /status of 409/.test(l.text))));
    out.steps.other = await page.evaluate((id) => api('/api/action', { action: 'security-status', repo: id }).then((r) => r.status), repo.id);
    const od = await actionDone('security-status', 60000);
    out.steps.otherDone = { status: od.state + ' exit ' + od.exitCode };
    // The phases, as the record says them, until the job starts.
    const phases = [];
    const watch = (async () => { const t0 = Date.now(); for (;;) { const r = recOf(runId); if (r?.pentest?.deploy && phases[phases.length - 1] !== r.pentest.deploy.phase) phases.push(r.pentest.deploy.phase); if (!r || r.status !== 'deploying' || Date.now() - t0 > 120000) return r; await sleep(150); } })();
    // The Bootstrapping row and the run's page, with its log, while it deploys (the docs screenshots).
    await sleep(1500);
    await openPage();
    await page.waitForSelector('#security-runs-all tr.run-bootstrapping', { timeout: 15000 }).catch(() => {});
    out.steps.bootRow = await page.evaluate(() => document.querySelector('#security-runs-all tr.run-bootstrapping')?.innerText.replace(/\s+/g, ' ') || null);
    await page.locator('#security-runs-all').screenshot({ path: join(SHOTS, 'dashboard-security-runs-bootstrapping-dark.png') }).catch(() => {});
    await page.goto(srv.base + '/#security/run/' + repo.id + '/' + runId);
    await page.waitForSelector('[data-run-deploy="bootstrapping"]', { timeout: 15000 }).catch(() => {});
    await page.click('[data-run-log-open]').catch(() => {});
    await page.waitForSelector('[data-run-log]:not([hidden])', { timeout: 10000 }).catch(() => {});
    await sleep(300);
    out.steps.bootPage = await page.evaluate(() => ({ card: document.querySelector('[data-run-deploy]')?.innerText.replace(/\s+/g, ' ') || null, log: document.querySelector('[data-run-log]')?.innerText || null,
      now: document.querySelector('[data-deploy-steps] li.now')?.innerText || null, status: document.querySelector('[data-run-detail] .st')?.innerText || null }));
    // The docs screenshot without the action drawer (the read-only action above) over it.
    await page.locator('#action-drawer button', { hasText: 'Close' }).click().catch(() => {}); await sleep(200);
    await page.screenshot({ path: join(SHOTS, 'dashboard-security-run-bootstrapping-dark.png'), fullPage: true }).catch(() => {});
    const done3 = await watch;
    writeFileSync(join(home, 'fake-cdk-slow'), '0');
    out.steps.phases = phases;
    out.steps.sameId = done3 ? { id: done3.id === runId, status: done3.status, job: done3.pentest.job_id, phase: done3.pentest.deploy?.phase } : null;
    out.steps.history = (done3?.pentest?.deploy?.history || []).map((h) => h.phase);
    out.steps.startCalls = { aws: lines('aws-calls.log').slice(b2.aws), docker: lines('docker-calls.log').slice(b2.docker) };
    const callsNow = out.steps.startCalls.aws;
    const startAt = callsNow.findIndex((c) => c.startsWith('securityagent start-pentest-job'));
    out.steps.checkedBeforeStart = callsNow.slice(0, startAt < 0 ? callsNow.length : startAt).filter((c) => c.includes('batch-get-pentest-jobs')).length;
    out.steps.afterStart = results().map((r) => ({ status: r.status, job: r.pentest.job_id, stack: r.pentest.stack, keep: r.pentest.keep ?? null }));
    out.steps.logFile = runId ? existsSync(join(shop, '.prism', 'results', runId + '.log')) : false;
    // 4. Start again while it is pending: the guard dialog, with no Start another. A fresh page load: it reads the Security Agent answer again.
    await page.goto('about:blank');
    await openPage();
    await page.click('[data-pt-run="security-pentest-start"]'); await sleep(300);
    out.steps.guard = await dialog();
    await page.screenshot({ path: join(SHOTS, 'pentest-running-guard-1280.png') }).catch(() => {});
    await page.keyboard.press('Escape');
    // The background check: the job is still running, so --status saves nothing and tears nothing down.
    await page.evaluate(() => api('/api/security-check')); await sleep(6000);
    out.steps.runningCheck = { deletes: lines('aws-calls.log').filter((c) => c.startsWith('cloudformation delete-stack')).length, rows: results().map((r) => r.status) };
    // 5. The job finishes. A dashboard opened later checks it at once: pentest --status tears the run's own stack down, once.
    writeFileSync(join(home, 'fake-pt-job'), 'COMPLETED');
    await ctx.close(); srv.proc.kill('SIGTERM'); await sleep(500);
    const b5 = lines('aws-calls.log').length;
    srv = await serve();
    ({ ctx, page, log } = await openCtx(srv)); out.log.push(...log);
    await setTheme(page, 'dark');
    await page.goto(srv.base + '/#security/' + repo.id); await saReady(page);
    for (let i = 0; i < 40 && results().some((r) => r.status === 'pending'); i++) { await page.evaluate(() => api('/api/security-check')); await sleep(1000); }
    await sleep(1500);
    for (let i = 0; i < 3; i++) { await page.evaluate(() => api('/api/security-check')); await sleep(800); }
    const after5 = lines('aws-calls.log').slice(b5);
    out.steps.teardown = { calls: after5, deletes: after5.filter((c) => c.startsWith('cloudformation delete-stack')), rows: results().map((r) => ({ status: r.status, stack: r.pentest.stack })) };
    // 6. A second run whose teardown fails: the drill-down shows the reason and Clean up.
    writeFileSync(join(home, 'fake-pt-job'), 'IN_PROGRESS');
    await openPage();
    await page.click('[data-pt-run="security-pentest-start"]'); await sleep(300);
    await page.check('dialog.confirm input[type=checkbox]');
    await page.locator('dialog.confirm button', { hasText: 'Deploy and start' }).click();
    out.steps.start2 = await waitDone();
    { const b = allPt().find((r) => r.status === 'deploying'); if (b) await waitRec(b.id, (r) => r.status !== 'deploying'); }
    writeFileSync(join(home, 'fake-pt-job'), 'COMPLETED'); writeFileSync(join(home, 'fake-pt-teardown'), 'fail');
    await ctx.close(); srv.proc.kill('SIGTERM'); await sleep(500);
    srv = await serve();
    ({ ctx, page, log } = await openCtx(srv)); out.log.push(...log);
    await setTheme(page, 'dark');
    await page.goto(srv.base + '/#security/' + repo.id); await saReady(page);
    for (let i = 0; i < 60 && results().some((r) => r.status === 'pending'); i++) { await page.evaluate(() => api('/api/security-check')); await sleep(1000); }
    await sleep(1500);
    const failed = results().find((r) => r.pentest.teardown_failed);
    out.steps.failedRecord = failed ? { reason: failed.pentest.teardown_failed.reason, stack: failed.pentest.stack } : null;
    if (failed) {
      await page.goto(srv.base + '/#security/run/' + repo.id + '/' + failed.id);
      await page.waitForSelector('[data-cleanup]', { timeout: 15000 }).catch(() => {});
      out.steps.card = await page.evaluate(() => { const c = document.querySelector('[data-run-cleanup]'); return c ? { kind: c.getAttribute('data-run-cleanup'), text: c.innerText.replace(/\s+/g, ' '), button: !!c.querySelector('[data-cleanup]') } : null; });
      await page.locator('[data-run-cleanup]').screenshot({ path: join(SHOTS, 'pentest-teardown-failed-1280.png') }).catch(() => {});
      await page.screenshot({ path: join(SHOTS, 'pentest-run-cleanup-1280-dark.png'), fullPage: false }).catch(() => {});
      // Clean up while deletion still fails: exit 1, the card stays. Then it works: exit 0, the card goes.
      await page.click('[data-cleanup]'); await sleep(300);
      out.steps.cleanupDialog = await dialog();
      await page.locator('dialog.confirm button', { hasText: 'Tear down' }).click();
      out.steps.cleanup1 = await waitDone(180000);
      rmSync(join(home, 'fake-pt-teardown'));
      await page.goto(srv.base + '/#security/run/' + repo.id + '/' + failed.id);
      await page.waitForSelector('[data-cleanup]', { timeout: 15000 }).catch(() => {});
      await page.click('[data-cleanup]'); await sleep(300);
      await page.locator('dialog.confirm button', { hasText: 'Tear down' }).click();
      out.steps.cleanup2 = await waitDone(180000);
      await sleep(1500);
      await page.goto(srv.base + '/#'); await sleep(300);
      await page.goto(srv.base + '/#security/run/' + repo.id + '/' + failed.id); await sleep(2500);
      out.steps.cardAfter = await page.evaluate(() => !!document.querySelector('[data-run-cleanup]'));
      const fin = results().find((r) => r.id === failed.id);
      out.steps.cleanedRecord = fin ? { stack: fin.pentest.stack, teardown_failed: fin.pentest.teardown_failed ?? null } : null;
    }
    // 7. 1.21.7: a deploy that fails: the record becomes an error that keeps its stack, and its page offers Clean up.
    writeFileSync(join(home, 'fake-cdk-deploy'), 'fail');
    await openPage();
    const f7 = await startApi();
    const fid = f7.json?.result?.run;
    const frec = fid ? await waitRec(fid, (r) => r.status !== 'deploying') : null;
    out.steps.deployFail = { start: f7.status, status: frec?.status, reason: frec?.reason, stack: frec?.pentest?.stack, phase: frec?.pentest?.deploy?.phase };
    if (fid) {
      await page.goto(srv.base + '/#security/run/' + repo.id + '/' + fid);
      await page.waitForSelector('[data-run-cleanup]', { timeout: 15000 }).catch(() => {});
      out.steps.deployFailPage = await page.evaluate(() => ({ kind: document.querySelector('[data-run-cleanup]')?.getAttribute('data-run-cleanup') || null, button: !!document.querySelector('[data-cleanup]'), deploy: document.querySelector('[data-run-deploy]')?.innerText.replace(/\s+/g, ' ') || null }));
      await page.click('[data-cleanup]').catch(() => {}); await sleep(300);
      await page.locator('dialog.confirm button', { hasText: 'Tear down' }).click().catch(() => {});
      out.steps.deployFailCleanup = await waitDone(180000);
      const fr = recOf(fid);
      out.steps.deployFailAfter = fr ? fr.pentest.stack : 'missing';
    }
    // 8. A deploy whose process is killed: the dashboard's check (local, no AWS) marks it interrupted, with Clean up.
    writeFileSync(join(home, 'fake-cdk-deploy'), 'hang');
    await openPage();
    const k8 = await startApi();
    const kid = k8.json?.result?.run;
    const krec = kid ? await waitRec(kid, (r) => r.pentest?.deploy?.phase === 'deploying' && !!r.pentest.deploy.pid) : null;
    const kpid = krec?.pentest?.deploy?.pid;
    out.steps.killed = { start: k8.status, phase: krec?.pentest?.deploy?.phase, pid: !!kpid };
    if (kpid) {
      try { process.kill(-kpid, 'SIGKILL'); } catch { try { process.kill(kpid, 'SIGKILL'); } catch { /* gone */ } }
      const k0 = lines('aws-calls.log').length;
      await openPage();
      let r8 = null;
      for (let i = 0; i < 90; i++) { await page.evaluate(() => api('/api/security-check')); r8 = recOf(kid); if (r8 && r8.status !== 'deploying') break; await sleep(1000); }
      out.steps.interrupted = { status: r8?.status, reason: r8?.reason, flag: !!r8?.pentest?.deploy?.interrupted, stack: r8?.pentest?.stack, awsWhileDeploying: lines('aws-calls.log').slice(k0) };
      await page.goto(srv.base + '/#security/run/' + repo.id + '/' + kid);
      await page.waitForSelector('[data-run-cleanup]', { timeout: 15000 }).catch(() => {});
      out.steps.interruptedPage = await page.evaluate(() => ({ kind: document.querySelector('[data-run-cleanup]')?.getAttribute('data-run-cleanup') || null, button: !!document.querySelector('[data-cleanup]'), deploy: document.querySelector('[data-run-deploy]')?.innerText.replace(/\s+/g, ' ') || null }));
      await page.locator('#action-drawer button', { hasText: 'Close' }).click().catch(() => {}); await sleep(200);
      await page.screenshot({ path: join(SHOTS, 'dashboard-security-run-interrupted-dark.png'), fullPage: true }).catch(() => {});
      await page.click('[data-cleanup]').catch(() => {}); await sleep(300);
      await page.locator('dialog.confirm button', { hasText: 'Tear down' }).click().catch(() => {});
      out.steps.interruptedCleanup = await waitDone(180000);
    }
    rmSync(join(home, 'fake-cdk-deploy'), { force: true });
    // The docs screenshot: the whole Security Agent page with the buttons, dark, at 1280.
    await openPage();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(SHOTS, 'dashboard-security-agent-buttons-dark.png'), fullPage: true }).catch(() => {});
    await page.locator('section.card', { has: page.locator('[data-pt-repo]') }).screenshot({ path: join(SHOTS, 'pentest-buttons-1280.png') }).catch(() => {});
    await ctx.close();
    const phone = await openCtx(srv, { width: 390, height: 844 });
    await phone.page.goto(srv.base + '/#security/' + repo.id); await saReady(phone.page);
    await phone.page.waitForSelector('[data-pt-run]', { timeout: 15000 }).catch(() => {});
    await sleep(600);
    out.steps.phoneScroll = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await phone.page.locator('section.card', { has: phone.page.locator('[data-pt-repo]') }).screenshot({ path: join(SHOTS, 'pentest-buttons-390.png') }).catch(() => {});
    // The start dialog at 390 px, light and dark: it fits (no sideways scroll inside it) and scrolls down to the tick box.
    out.steps.phoneDialog = {};
    for (const theme of ['light', 'dark']) {
      await setTheme(phone.page, theme);
      await phone.page.waitForSelector('[data-pt-run="security-pentest-start"]:not([disabled])', { timeout: 15000 }).catch(() => {});
      await phone.page.click('[data-pt-run="security-pentest-start"]'); await sleep(300);
      out.steps.phoneDialog[theme] = await phone.page.evaluate(() => { const d = document.querySelector('dialog.confirm'); if (!d || !d.open) return null; const r = d.getBoundingClientRect();
        return { overflow: d.scrollWidth - d.clientWidth, width: Math.round(r.width), items: d.querySelectorAll('[data-pt-resources] li').length, running: !!d.querySelector('[data-pt-running]'), clipped: [...d.querySelectorAll('[data-pt-target] dd, pre.cmd')].filter((x) => x.scrollWidth > x.clientWidth + 1).map((x) => x.innerText.slice(0, 60)), fg: getComputedStyle(d).color, bg: getComputedStyle(d).backgroundColor }; });
      await phone.page.screenshot({ path: join(SHOTS, `pentest-start-dialog-390-${theme}-end.png`) }).catch(() => {});
      await phone.page.evaluate(() => { document.querySelector('dialog.confirm').scrollTop = 0; }); await sleep(100);
      await phone.page.screenshot({ path: join(SHOTS, `pentest-start-dialog-390-${theme}.png`) }).catch(() => {});
      await phone.page.keyboard.press('Escape'); await sleep(150);
    }
    out.log.push(...phone.log);
    await phone.ctx.close();
    out.calls = lines('aws-calls.log');
    out.home = home;
    out.repoId = repo.id; out.runId = runId;

    // Over --serve-stdio: the same action route answers the same way (VS Code, Kiro Crew).
    const shome = seed('pentestrun-stdio', 'full', prep);
    const child = spawn(process.execPath, [ENTRY, 'dashboard', '--serve-stdio'], { cwd: readFileSync(join(shome, '.start-dir'), 'utf8').trim(), env: demoEnv(shome, { ...ENV, PRISM_PENTEST_CDK_DIR: join(shome, 'pentest-cdk') }), stdio: ['pipe', 'pipe', 'pipe'] });
    running.push(child);
    const waiting = new Map();
    let buf = '', seq = 0, helloOk;
    const helloP = new Promise((r) => { helloOk = r; });
    child.stdout.on('data', (b) => { buf += b; for (let i; (i = buf.indexOf('\n')) >= 0;) { const o = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (o.hello) { helloOk(o); continue; } waiting.get(o.id)?.(o); waiting.delete(o.id); } });
    await Promise.race([helloP, sleep(20000)]);
    const ask = (m) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); child.stdin.write(JSON.stringify({ id, ...m }) + '\n'); });
    const sv = (await ask({ op: 'get', path: '/api/security-agent' })).json;
    const sid = sv.repos.find((r) => r.path.endsWith('/src/demo-shop')).id;
    await ask({ op: 'act', path: '/api/security-agent/spaces', body: { repo: sid } });
    const pick = { dockerfile: 'services/api/Dockerfile.prod', app_dir: 'services/api', port: '3000', health_path: '/healthz' };
    const st = { badStart: await ask({ op: 'act', path: '/api/action', body: { action: 'security-pentest-start', repo: sid, ...pick, health_path: 'no-slash', confirm: true } }) };
    st.plan = await ask({ op: 'act', path: '/api/action', body: { action: 'security-pentest-plan', repo: sid, ...pick } });
    st.check = await ask({ op: 'get', path: '/api/security-agent/pentest/check', query: { repo: sid, dockerfile: pick.dockerfile, app_dir: pick.app_dir, port: pick.port, health_path: pick.health_path } });
    st.start = await ask({ op: 'act', path: '/api/action', body: { action: 'security-pentest-start', repo: sid, ...pick, confirm: true } });
    for (let i = 0; i < 240; i++) { const s = (await ask({ op: 'get', path: '/api/action/status' })).json; if (s.state === 'done') { st.startDone = s; break; } await sleep(500); }
    st.again = await ask({ op: 'act', path: '/api/action', body: { action: 'security-pentest-start', repo: sid, ...pick, confirm: true } });
    out.stdio = { badStart: { status: st.badStart.status, error: st.badStart.json?.error }, plan: st.plan.status, planError: st.plan.json?.error, start0: st.check.json?.start,
      start: st.start.status, startExit: st.startDone?.exitCode, startCmd: st.startDone?.command, startOutcome: st.startDone?.outcome, again: { status: st.again.status, error: st.again.json?.error } };
    child.stdin.end();
  }
  // ---------- stdio: the shared UI bundle (dist/ui) over dashboard --serve-stdio, as an editor or Kiro Crew host loads it ----------
  // No server: Chromium serves only the bundle's files from a made-up origin (page.route), the page posts through
  // bridge.js to a stand-in host here, and the host relays each request to a real --serve-stdio child.
  if (want('stdio')) {
    const home = seed('stdio', 'full');
    const cwd = readFileSync(join(home, '.start-dir'), 'utf8').trim();
    const env = demoEnv(home, { PRISM_NO_UPDATE_CHECK: '1' });
    const out = { log: [], relayed: [], dropped: [], reports: [] };
    R.suites.stdio = out;
    const child = spawn(process.execPath, [ENTRY, 'dashboard', '--serve-stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    running.push(child);
    const waiting = new Map();
    let buf = '', hello = null, seq = 0, helloOk;
    const helloP = new Promise((r) => { helloOk = r; });
    child.stdout.on('data', (b) => {
      buf += b;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const o = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (o.hello) { hello = o; helloOk(o); continue; }
        waiting.get(o.id)?.(o); waiting.delete(o.id);
      }
    });
    await Promise.race([helloP, sleep(20000)]);
    out.hello = hello && { hello: hello.hello, api: hello.api, version: hello.version, ui: existsSync(join(hello.uiDir, 'prism-ui.js')) };
    const ask = (m) => new Promise((ok) => { const id = ++seq; waiting.set(id, ok); child.stdin.write(JSON.stringify({ id, ...m }) + '\n'); });
    const ORIGIN = 'https://prism-ui.test';
    const files = JSON.parse(readFileSync(join(hello.uiDir, 'manifest.json'), 'utf8')).files;
    const nonce = 'bm9uY2Vub25jZQ==';
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${ORIGIN}; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
    const html = `<!DOCTYPE html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${ORIGIN}/prism-ui.css"></head>`
      + `<body><div class="wrap">${readFileSync(join(hello.uiDir, 'body.html'), 'utf8')}</div><script nonce="${nonce}" src="${ORIGIN}/bridge.js"></script><script nonce="${nonce}" src="${ORIGIN}/prism-ui.js"></script></body></html>`;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    let tag = 'stdio';
    const csps = [];
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csps.push(m.text().slice(0, 200)); });
    // Page errors count in the console verdict; the deliberate fetch probe below logs a CSP error, so console messages are not collected here.
    page.on('pageerror', (e) => out.log.push({ tag, type: 'pageerror', text: String(e).slice(0, 300) }));
    await page.route(`${ORIGIN}/**`, (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      if (name === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      if (!files.includes(name)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ status: 200, contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: readFileSync(join(hello.uiDir, name)) });
    });
    await page.exposeBinding('__hostPost', async (_s, m) => {
      if (m && m.type === 'prism-ui:open-report') { out.reports.push(m.id); return; }
      const ok = m && m.type === 'prism-ui:request' && (m.op === 'get' ? hello.routes.get : hello.routes.act).includes(m.path);
      if (!ok) { out.dropped.push(JSON.stringify(m).slice(0, 80)); return; }
      out.relayed.push(m.op + ' ' + m.path);
      const a = await ask(m.op === 'get' ? { op: 'get', path: m.path, query: m.query || {} } : { op: 'act', path: m.path, body: m.body });
      await page.evaluate((msg) => window.dispatchEvent(new MessageEvent('message', { data: msg })), { type: 'prism-ui:response', id: m.id, status: a.status, json: a.json });
    });
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__hostPost(m), getState: () => undefined, setState: () => {} }); });
    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForSelector('#summary', { timeout: 30000 }).catch(() => {});
    await sleep(1200);
    out.kind = await page.evaluate(() => TRANSPORT.kind);
    out.dashboard = { cards: await page.$$eval('#summary .scard', (n) => n.length), repos: await page.$$eval('#codewatch tbody tr', (n) => n.length) };
    await page.screenshot({ path: join(SHOTS, 'stdio-dashboard.png') });
    // A report link: the page asks the host, and /api/report answers its HTML.
    tag = 'stdio report';
    const link = page.locator('#codewatch a.rlink').first();
    if (await link.count()) { await link.click(); await sleep(300); }
    out.reportHashAfter = await page.evaluate(() => location.hash);
    if (out.reports[0]) { const r = await ask({ op: 'get', path: '/api/report', query: { id: out.reports[0] } }); out.report = { status: r.status, html: /<html/i.test(r.json.html || ''), script: /<script/i.test(r.json.html || ''), md: typeof r.json.markdown === 'string' }; }
    tag = 'stdio findings';
    const href = await page.$eval('a[href^="#security/run/"]', (a) => a.getAttribute('href')).catch(() => null);
    if (href) {
      await page.evaluate((h) => { location.hash = h; }, href);
      await page.waitForSelector('[data-run-findings]', { timeout: 15000 }).catch(() => {});
      await sleep(500);
      out.findings = await page.$$eval('[data-run-findings] details, [data-run-findings] li', (n) => n.length).catch(() => 0);
      await page.screenshot({ path: join(SHOTS, 'stdio-findings.png') });
    }
    tag = 'stdio refusals';
    out.noConfirm = await page.evaluate(() => api('/api/action', { action: 'aws-disconnect' }).then((x) => ({ status: x.status, error: x.json.error })));
    out.writeGate = await page.evaluate(() => api('/api/action', { action: 'security-code-review', repo: Object.values(SETUP.repoIds)[0], confirm: true }).then((x) => x.status));
    out.cspBeforeProbe = csps.length;
    out.fetch = await page.evaluate(() => fetch('/api/data').then(() => 'allowed', () => 'blocked'));
    tag = 'stdio action';
    await page.evaluate(() => { location.hash = '#settings/aws'; }); await sleep(1000);
    await page.locator('#settings button', { hasText: /disconnect/i }).first().click(); await sleep(300);
    out.runDisabled = await page.evaluate(() => [...document.querySelectorAll('dialog.confirm button')].find((b) => b.textContent === 'Run')?.disabled);
    await page.locator('dialog.confirm input[type=checkbox]').check();
    await page.click('dialog.confirm button:has-text("Run")');
    for (let i = 0; i < 100; i++) { const t = await page.evaluate(() => document.querySelector('#action-drawer .srow-head')?.innerText || ''); if (/exit \d+|refused/.test(t)) { out.actionResult = t.replace(/\s+/g, ' ').slice(0, 120); break; } await sleep(300); }
    out.connectionFileGone = !existsSync(join(home, '.prism', 'aws.json'));
    await page.screenshot({ path: join(SHOTS, 'stdio-action-done.png') });
    out.listen = execFileSync('sh', ['-c', `ss -ltnp 2>/dev/null | grep 'pid=${child.pid},' || true`], { encoding: 'utf8' }).trim();
    await ctx.close();
    child.stdin.end();
    out.exitedOnStdinClose = await new Promise((ok) => { child.on('exit', () => ok(true)); setTimeout(() => ok(false), 5000); });
    const callLog = join(home, 'aws-calls.log');
    out.fakeAwsCalls = existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  }
} catch (e) {
  R.fatal = String(e.stack || e);
} finally {
  for (const p of running) p.kill();
  await browser.close();
  R.finished = new Date().toISOString();
  R.verdicts = verdicts(R);
  const file = join(OUT, only.length ? `results-${only.join('-')}.json` : 'results.json');
  writeFileSync(file, JSON.stringify(R, null, 2));
  for (const v of R.verdicts) console.log((v.pass ? 'PASS ' : 'FAIL ') + v.id + ' ' + v.name + (v.pass ? '' : ': ' + v.why));
  const failed = R.verdicts.filter((v) => !v.pass).length + (R.fatal ? 1 : 0);
  console.log(`${R.verdicts.length - R.verdicts.filter((v) => !v.pass).length}/${R.verdicts.length} verdicts pass; results ${file}; screenshots ${SHOTS}` + (R.fatal ? '\nFATAL: ' + R.fatal : ''));
  process.exitCode = failed ? 1 : 0;
}

/** A GET with arbitrary headers (fetch forbids setting Host). */
function rawGet(port, path, headers) {
  return import('node:http').then(({ request }) => new Promise((resolve, reject) => {
    const q = request({ host: '127.0.0.1', port, path, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, text: async () => b })); });
    q.on('error', reject); q.end();
  }));
}

/** Pass/fail per check, from what the suites recorded. A suite that did not run gives no verdicts. */
function verdicts(R) {
  const S = R.suites, out = [];
  const add = (id, name, pass, why = '') => out.push({ id, name, pass: !!pass, why: pass ? '' : String(why).slice(0, 400) });
  const READ_ONLY_AWS = /^(--version|configure list-profiles|sts get-caller-identity|iam list-account-aliases|organizations describe-organization|iam list-attached|securityagent list-agent-spaces|securityagent batch-get-agent-spaces|ssm get-parameter)/;
  if (S.auth) {
    const bad = S.auth.checks.filter((c) => !c.pass);
    add('auth', 'token, Host, Origin, CSRF and method checks refuse what they should', !bad.length, bad.map((c) => `${c.name}: ${c.status} (want ${c.expect})`).join('; '));
    add('bind', 'the server listens on 127.0.0.1 only', /^LISTEN\s+\d+\s+\d+\s+127\.0\.0\.1:\d+\s/.test(S.auth.listen), S.auth.listen);
  }
  // Console errors, page errors, failed requests and 4xx/5xx anywhere but the deliberate auth probes.
  const logs = [];
  const collect = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x.log)) logs.push(...x.log); for (const v of Object.values(x)) if (v && typeof v === 'object') collect(v); };
  for (const [k, v] of Object.entries(S)) if (k !== 'auth') collect(v);
  // The unknown-run probe's 404 is the answer under test, and the browser logs it too.
  const expected = (l) => l.tag === 'expected-404' && (/\/api\/security-run\?repo=0000000000000000&run=nope/.test(l.text) || /status of 404/.test(l.text));
  logs.splice(0, logs.length, ...logs.filter((l) => !expected(l)));
  add('console', 'no console errors, page errors, failed requests or 4xx/5xx', !logs.length, logs.slice(0, 5).map((l) => `${l.tag}: ${l.type} ${l.text}`).join('; '));
  if (S.nav) {
    const wrong = S.nav.deep.filter((d) => d.route.startsWith('#settings') || d.route === '#setup' ? !d.visible.includes('settings') : d.route.startsWith('#security') ? !d.visible.includes('security')
      : d.route === '#accountguard' ? !d.visible.includes('accountguard') : d.route.startsWith('#repo/') ? !d.visible.includes('repo') : !d.visible.includes('main'));
    add('routes', 'every route deep-links to its view', !wrong.length, wrong.map((d) => d.route + ' -> ' + d.visible).join('; '));
    add('report', 'the codewatch report and its .md download open', S.nav.report?.status === 200 && S.nav.reportMd?.s === 200, JSON.stringify([S.nav.report, S.nav.reportMd]));
  }
  if (S.layout) {
    const rows = S.layout.rows.filter((r) => r.route);
    const scroll = rows.filter((r) => r.hscroll);
    add('B2/B3/B8', 'no horizontal scroll at 1280, 768, 390 or 320 px, either theme', !scroll.length, scroll.slice(0, 6).map((r) => `${r.width} ${r.theme} ${r.route}: ${r.scrollWidth}px ${r.offRight[0] || ''}`).join('; '));
    const low = rows.filter((r) => r.theme === 'light' && r.lowContrastCount);
    add('B11', 'light theme text keeps 4.5:1 (3:1 for large text)', !low.length, low.slice(0, 4).map((r) => `${r.width} ${r.route}: ${r.lowContrast.slice(0, 2).join(', ')}`).join('; '));
    const dark = rows.filter((r) => r.theme === 'dark' && r.lowContrastCount);
    add('dark-contrast', 'dark theme text keeps 4.5:1', !dark.length, dark.slice(0, 3).map((r) => `${r.width} ${r.route}: ${r.lowContrast[0]}`).join('; '));
    const nav = rows.filter((r) => r.nav.right > r.width || r.nav.sw > r.nav.cw);
    add('nav-wrap', 'the top nav wraps inside the viewport', !nav.length, nav.slice(0, 3).map((r) => `${r.width} ${r.route}`).join('; '));
  }
  if (S.actions) {
    const st = (name) => S.actions.steps.find((x) => x.step === name) || {};
    add('dialog', 'Disconnect: Cancel focused, Run disabled until the checkbox, Enter/Cancel/Esc close without running',
      st('disconnect: dialog opened').focused === 'Cancel' && st('disconnect: dialog opened').runDisabled && st('disconnect: after checkbox').runDisabled === false
      && st('disconnect: Enter with Cancel focused').open === false && st('disconnect: after Cancel').open === false && st('disconnect: after Cancel').connFile && st('disconnect: after Esc').open === false,
      JSON.stringify(S.actions.steps.slice(0, 6)));
    const results = ['connect: result', 'ag check: result'].map(st);
    add('no-hang', 'AWS actions without credentials finish with an error in the drawer, no hang', results.every((r) => r.status && !r.hung && /exit 1/.test(r.status)), JSON.stringify(results.map((r) => [r.status, r.ms])));
    add('B12', 'no doubled period in the AWS error text', results.every((r) => !/\.\./.test(r.out || '')), results.map((r) => r.out).join(' | '));
    const lookup = st('sa lookup');
    add('sa-lookup', 'the automatic agent-space check without credentials stops at the sign-in card, with Retry and no Start button',
      lookup.state === 'sso' && /credentials did not work/.test(lookup.text || '') && (S.actions.saButtons || []).includes('Retry') && !(S.actions.saButtons || []).some((b) => /^Start /.test(b)), lookup.state + ' ' + (lookup.text || '').slice(0, 200));
    const writes = (S.actions.awsCalls || []).filter((c) => !READ_ONLY_AWS.test(c));
    add('aws-readonly', 'the fake aws saw read-only calls only', !writes.length, writes.join('; '));
  }
  if (S.keyboard) {
    const first = S.keyboard.routes.find((r) => r.route === '#');
    add('keyboard', 'Tab from the top reaches every nav link, each with a focus ring', first && ['Dashboard', 'Security Agent', 'AccountGuard', 'Settings'].every((n) => first.seq.some((x) => x.el.startsWith('A ' + n) && x.outline)), JSON.stringify(first?.seq?.slice(0, 5)));
  }
  if (S.update) {
    add('update-off', 'PRISM_NO_UPDATE_CHECK=1: plain pill, nothing written', S.update.off?.['1280']?.pill?.text?.startsWith('prism-cli ') && !S.update.off.cache, JSON.stringify(S.update.off?.['1280']));
    add('update-pill', 'a cached newer version shows the Update pill and fits at 320 px', /^Update: /.test(S.update['on-cached-newer']?.['320']?.pill?.text || '') && !S.update['on-cached-newer']['320'].hscroll, JSON.stringify(S.update['on-cached-newer']?.['320']));
  }
  if (S.snapshot) {
    const live = (S.snapshot.routes || []).flatMap((r) => r.buttons.filter((b) => /^(Run|Re-verify|Disconnect|Upload|Start)/.test(b)).map((b) => r.route + ' ' + b));
    add('snapshot-nocheck', 'a static snapshot asks for no check of its pending run', !(S.snapshot.checkRequests || []).length, (S.snapshot.checkRequests || []).join(' '));
    add('snapshot', 'the snapshot is written and draws every route', S.snapshot.exit === 0 && S.snapshot.routes.length >= 8 && !S.snapshot.layout320?.hscroll, JSON.stringify({ exit: S.snapshot.exit, stderr: S.snapshot.stderr }));
    add('snapshot-copy-only', 'nothing runs from the snapshot (Run buttons are Copy)', !live.length, live.join('; '));
  }
  if (S.rerun) {
    const st = S.rerun.steps || [];
    add('rerun', 'after an action is done, the next one starts (202, not 409), its button enabled, three in a row',
      st.length === 3 && st.every((x) => x.found && x.enabled && !x.hung && x.post?.status === 202 && x.serverState === 'done') && S.rerun.direct?.status === 202,
      JSON.stringify(st.map((x) => [x.label, x.enabled, x.pill, x.post?.status, x.serverState])) + ' direct ' + S.rerun.direct?.status);
    add('rerun-mask', 'the start answer shows the repo path under ~, not the home directory', st.every((x) => !/"cwd":"\//.test(x.post?.body || '')), st.map((x) => (x.post?.body || '').slice(140, 220)).join(' | '));
  }
  if (S.pending) {
    const d = S.pending.drawer || {};
    add('pending', 'Fetch findings on a running job: amber "still running" pill with a hint, not a red exit pill', S.pending.found && !d.hung && /s-warn/.test(d.pillClass) && !/s-error/.test(d.pillClass)
      && /still running \(exit 2\)/.test(d.pillText) && /Check back later, or run the same command with --wait/.test(d.status) && /still IN_PROGRESS/.test(d.out), JSON.stringify(d).slice(0, 400));
    add('pending-row', 'the code review row still reads "running" after the fetch', /running/i.test(S.pending.row || ''), S.pending.row);
    const leak = [...accountLeaks(d.out || ''), ...((d.out || '').match(/demo-session/g) || [])];
    add('pending-mask', 'the drawer shows ••••3333, the role name only, and no home path', !leak.length && /••••3333/.test(d.out || '') && /assumed-role\/PrismDemoReadOnly\/…/.test(d.out || '') && !(d.out || '').includes(S.pending.home), leak.join(', ') || (d.out || '').slice(0, 300));
  }
  if (S.runs) {
    const U = S.runs;
    add('R1', 'Dashboard: the latest 5 runs with four severity chips each, and See all N runs → to the Security Agent page; no long findings list',
      U.dash.rows === Math.min(5, U.total) && U.dash.all === 'See all ' + U.total + ' runs →' && U.dash.href === '#security' && !U.dash.oldList && U.dash.chips > 0, JSON.stringify(U.dash) + ' total ' + U.total);
    add('R2', 'Security Agent page: the full table, filtered by type and by status',
      U.allRows === U.total && U.filteredTypes.length > 0 && U.filteredTypes.every((t) => t === 'Threat model') && U.filteredStatus.every((t) => t === 'running'),
      JSON.stringify({ all: U.allRows, total: U.total, types: U.filteredTypes, status: U.filteredStatus }));
    add('R3', 'a run that completes: the drawer says Complete. View findings → and links to the drill-down',
      !!U.drawer && /^Complete\./.test(U.drawer.text) && /^#security\/run\/[a-f0-9]{16}\/[A-Za-z0-9_-]+$/.test(U.drawer.href) && U.drawerNull === false, JSON.stringify(U.drawer) + ' null shown: ' + U.drawerNull);
    const t = (U.detail && U.detail.text) || '';
    add('R4', 'drill-down: the fetched findings load in full, markup in them stays text, and the CLI command and result file (~) are shown',
      !!U.detail && U.detail.findings === 2 && /SQL injection in order lookup/.test(t) && t.includes('<img src=x onerror=alert(1)>') && U.detail.imgs === 0
        && /rather than the first two hundred characters only/.test(t) && /No remediation provided by this run type/.test(t) && /prism-cli security findings --job job-demo-2 --path ~\/src\/demo-shop/.test(t) && /Result file: ~\//.test(t),
      JSON.stringify(U.detail || {}).slice(0, 400));
    add('R5', 'the Security Agent results row links the completed review to its findings', /Complete\. ?View findings →/.test(U.resultsRow || ''), U.resultsRow);
    add('R6', 'an unknown run id says Run not found with a way back', /Run not found/.test(U.missing) && /Back to Security runs/.test(U.missing), U.missing);
    add('R7', 'at 390 px the Dashboard and the drill-down do not scroll sideways', U.phone.dashboard <= 1 && U.phone.detail <= 1, JSON.stringify(U.phone));
    add('R8', 'light theme: no text below 4.5:1 on the Dashboard or the drill-down', U.contrast && !U.contrast.dashboard.length && !U.contrast.detail.length, JSON.stringify(U.contrast).slice(0, 400));
  }
  if (S.rundetail) {
    const D = S.rundetail;
    add('R9', 'a run opened while running shows its findings after it finishes, on coming back, without a reload',
      D.found && /Still running/.test(D.before || '') && D.cliExit === 0 && !!D.after && D.after.sameDoc && /SQL injection in order lookup/.test(D.after.text) && !/Still running/.test(D.after.text),
      JSON.stringify({ found: D.found, cli: D.cliExit, before: (D.before || '').slice(0, 120), after: D.after && D.after.text.slice(0, 200), same: D.after && D.after.sameDoc }));
  }
  if (S.pending) {
    add('pending-nolink', 'a run still running has no View findings link in the drawer', S.pending.drawerLink === false, String(S.pending.drawerLink));
  }
  if (S.machine) {
    const M = S.machine;
    const t = M.texts || {};
    const both = (t.machine || '') + (t.repo || '');
    add('M1', 'one machine-wide setup card; enable security is copied with no cd', /^prism-cli enable security( |$)/.test(M.setupCommand || '') && /Set up Security Agent on this machine/.test(t.machine || '') && !/cd \S+ && prism-cli enable security/.test(both), (M.setupCommand || '') + ' | ' + (t.machine || '').slice(0, 300));
    add('M2', 'each repo says "uses the machine setup" or "repo override", never "has not run in this repo"', M.repos.some((r) => r.setup === 'repo') && M.repos.some((r) => r.setup === 'machine')
      && /Uses the machine setup \(~\/\.prism\/security\.json\): account ••••3333 \/ us-west-2/.test(t.machine || '') && /Repo override: \.prism\/security\.local\.json/.test(t.repo || '')
      && !/has not run in this repo/.test(both), JSON.stringify(M.repos));
    const so = M.statusOutside || {}, ss = M.statusShop || {}, n = M.noSetup || {};
    const all = [...(so.calls || []), ...(ss.calls || [])];
    add('M3', 'the CLI used the fake aws from the demo HOME, and made only read calls', (M.whichAws || '').startsWith(M.home) && /\/aws$/.test(M.whichAws || '')
      && all.every((c) => READ_ONLY_AWS.test(c) || /^cloudformation describe-stacks/.test(c)), M.whichAws + ' | ' + all.filter((c) => !READ_ONLY_AWS.test(c)).join('; '));
    add('M4', 'enable security --status outside any repo names the machine setup, masked', /\[ok\] Setup: machine setup ~\/\.prism\/security\.json \(account ••••3333, region us-west-2/.test(so.out || '') && !/Repo override/.test(so.out || ''), (so.out || '').slice(0, 500));
    add('M5', 'in a repo with an old repo-only setup, --status names the repo override', /\[ok\] Setup: repo override \.prism\/security\.local\.json/.test(ss.out || ''), (ss.out || '').slice(0, 500));
    add('M6', 'no setup on the machine: security findings prints the one-line hint and makes no AWS call', n.code === 1 && /Security Agent is not set up on this machine: run prism-cli enable security \(once, from any directory\)\./.test(n.out || '') && !(n.calls || []).length, (n.out || '').slice(0, 300) + ' | calls: ' + (n.calls || []).join('; '));
    // The terminal's Account line shows the full id on purpose (as before); the Setup rows and the page never do.
    const setupRows = [so.out, ss.out].join('\n').split('\n').filter((l) => /Setup:|Repo override:/.test(l)).join('\n');
    const leak = accountLeaks(setupRows + (n.out || '') + both);
    add('M7', 'no full account id in the Setup rows, the hint or the page', setupRows && !leak.length, (setupRows ? leak : ['no Setup rows']).join(', '));
  }
  if (S.gate) {
    const G = S.gate.states;
    const st = (k) => G[k] || {};
    const wrong = Object.entries(G).filter(([, o]) => o.desk?.state !== o.want).map(([k, o]) => `${k}: ${o.desk?.state} (want ${o.want})`);
    add('GATE1', 'Security Agent gate: each case shows its state, and only that card (connect, profile, setup, mismatch, checking, sso, denied, nospace, ready, override)', !wrong.length && st('checking').after === 'ready', wrong.join('; ') + ' checking then ' + st('checking').after);
    const wide = Object.entries(G).flatMap(([k, o]) => [['1280', o.desk], ['390', o.phone]].filter(([, x]) => !x || x.scroll > 1).map(([w, x]) => `${k}@${w}: ${x?.scroll}`));
    add('GATE2', 'no sideways scroll in any gate state at 1280 or 390 px', !wide.length, wide.join('; '));
    const broken = Object.entries(G).flatMap(([k, o]) => (o.phone?.brokenWords || []).map((w) => `${k}: ${w}`));
    add('GATE3', 'at 390 px, commands wrap only at spaces (no --repo -/-profile split)', !broken.length && (st('mismatch').phone?.words || 0) > 10, broken.join('; ') + ' words ' + st('mismatch').phone?.words);
    add('GATE4', 'step 1: AWS_PROFILE naming no configured profile is said; AWS_PROFILE over aws connect is named, with why',
      /AWS_PROFILE: prism-typo names a profile that is not in ~\/\.aws\/config or ~\/\.aws\/credentials/.test(st('profile').desk?.text || '')
      && /AWS: AWS_PROFILE: prism-readonly/.test(st('envprofile').desk?.text || '') && /AWS_PROFILE \(prism-readonly\) wins over the saved aws connect profile prism-demo: prism-cli reads the environment before/.test(st('envprofile').desk?.text || '')
      && /Open Settings › AWS/.test(st('connect').desk?.text || ''), (st('profile').desk?.text || '').slice(0, 200) + ' | ' + (st('envprofile').desk?.text || '').slice(0, 300));
    add('GATE5', 'step 3 runs once by itself: loads, refreshes and a second tab reuse the kept answer; Check again runs it again',
      st('ready').lookupsAfterLoads === 1 && st('ready').lookupsAfterCheckAgain === 2, JSON.stringify([st('ready').lookupsAfterLoads, st('ready').lookupsAfterCheckAgain]));
    add('GATE6', 'step 2: enable security copy-only, no AWS call while waiting, the 10 s re-check uses only the light gate endpoint, and the card moves on once the setup file appears',
      /prism-cli enable security --profile prism-demo --region us-west-2/.test(st('setup').desk?.text || '') && !/cd \S+ && prism-cli enable security --profile/.test(st('setup').desk?.text || '')
      && !(st('setup').callsWhileSetup || []).length && st('setup').recheck?.state && st('setup').recheck.state !== 'setup'
      && (st('setup').pollRequests || []).includes('/api/security-agent/gate')
      // (+1: a load whose /api/data went out just before the window opened)
      && st('setup').pollRequests.filter((p) => p === '/api/security-agent').length <= st('setup').pollRequests.filter((p) => p === '/api/data').length + 1,
      JSON.stringify(st('setup').recheck) + ' polls ' + JSON.stringify(st('setup').pollRequests) + ' calls ' + (st('setup').callsWhileSetup || []).join('; '));
    add('GATE7', 'step 3 cards: aws sso login --profile, the denied action, enable security for a missing space, mismatch with --repo and --replace',
      /aws sso login --profile prism-demo/.test(st('sso').desk?.text || '') && /securityagent:ListAgentSpaces/.test(st('denied').desk?.text || '')
      && /prism-cli enable security --profile prism-demo --region us-west-2/.test(st('nospace').desk?.text || '')
      && /cd ~\/src\/payments-api && prism-cli enable security --repo --profile prism-demo --region us-west-2/.test(st('mismatch').desk?.text || '') && /prism-cli enable security --replace --profile prism-demo --region us-west-2/.test(st('mismatch').desk?.text || ''),
      ['sso', 'denied', 'nospace', 'mismatch'].map((k) => k + ': ' + (st(k).desk?.text || '').slice(0, 160)).join(' | '));
    const o = st('override');
    add('GATE8', 'start guards: a running review offers View it / Start another anyway (Cancel focused); a reviewed HEAD offers Open those findings first',
      o.running?.open && JSON.stringify(o.running.buttons) === '["Cancel","View it →","Start another anyway"]' && o.running.focused === 'Cancel' && /^#security\/run\/[a-f0-9]{16}\//.test(o.runningView || '')
      && o.finished === 0 && o.reviewed?.open && JSON.stringify(o.reviewed.buttons) === '["Cancel","Open those findings →","Review it again"]' && /^#security\/run\/[a-f0-9]{16}\//.test(o.reviewedOpen || '') && o.runningPhone && o.reviewedPhone
      && /repo override/.test(o.desk?.text || ''), JSON.stringify({ running: o.running, view: o.runningView, finished: o.finished, reviewed: o.reviewed, open: o.reviewedOpen }).slice(0, 400));
    add('GATE9', 'the CLI refuses to replace latest.zip while a job of that code review is pending (no upload, no start)',
      o.cliGuard?.code === 1 && /still pending.*pass --force to start another anyway/s.test(o.cliGuard.out || '') && !(o.cliGuard.writes || []).length, JSON.stringify(o.cliGuard));
    const leaks = Object.entries(G).flatMap(([k, x]) => [...accountLeaks((x.desk?.text || '') + (x.phone?.text || '')), ...(x.homeLeak ? ['home path in /api/security-agent'] : [])].map((l) => `${k}: ${l}`));
    add('GATE10', 'no full account id on the gate cards, and no home path in /api/security-agent', !leaks.length, leaks.join('; '));
    const writes = Object.entries(G).flatMap(([k, x]) => (x.calls || []).filter((c) => !READ_ONLY_AWS.test(c) && !/^(cloudformation describe|securityagent batch-get-code-review-jobs|securityagent list-findings|securityagent batch-get-findings|securityagent list-code-reviews|s3api head-object)/.test(c)).map((c) => `${k}: ${c}`));
    add('GATE11', 'the gate suite made read calls only (the fake aws)', !writes.length, writes.join('; '));
  }
  if (S.autocheck) {
    const A = S.autocheck;
    const writes = (A.calls || []).filter((c) => /^(s3api put-object|securityagent (start|create|delete|update|stop)|ssm put-parameter)/.test(c));
    add('AC1', 'a pending run past the stale window that AWS reports still running shows running and when it was checked, not no verdict yet',
      /^run-running/.test(A.running?.cls || '') && /Checked with AWS/.test(A.running?.text || '') && !/no verdict yet/.test(A.running?.text || ''), JSON.stringify(A.running));
    add('AC2', 'when the job finishes, the run turns complete with its findings without a reload or a manual fetch',
      /complete/.test(A.complete?.text || '') && /SQL injection in order lookup/.test(A.complete.text) && A.complete.sameDoc && A.complete.noverdict === 0, JSON.stringify(A.complete) + ' after ' + A.completeMs + ' ms');
    add('AC3', 'the auto-check is bounded and read-only: a few check requests, no AWS write call',
      !writes.length && (A.checkRequests || 0) >= 1 && (A.checkRequests || 0) <= 40 && (A.calls || []).some((c) => /^securityagent batch-get-code-review-jobs/.test(c)), 'checks ' + A.checkRequests + ' writes ' + writes.join('; '));
    const leak = accountLeaks(A.failed || '');
    add('AC4', 'a check that cannot run (no credentials) keeps no verdict yet, says why (no account id or home path) and gives the fetch command',
      /could not check with AWS/.test(A.failed || '') && /Check your AWS credentials/.test(A.failed) && /prism-cli security findings --job job-demo-2/.test(A.failed)
      && !leak.length && !(A.failed || '').includes(A.failedHome || '\u0000') && A.failedPhoneScroll <= 1, (A.failed || '').slice(0, 400) + ' scroll ' + A.failedPhoneScroll);
    add('AC5', 'over dashboard --serve-stdio the same route completes the run', A.stdio?.status === 'complete' && A.stdio.total === 2, JSON.stringify(A.stdio).slice(0, 400));
  }
  if (S.branch) {
    const B = S.branch;
    add('BR1', 'a branch with nothing new since its upstream: the card says so, counts uncommitted changes, disables the branch Start and offers the whole repo',
      B.card?.state === 'blocked' && /Nothing new on feat\/receiver-tool-usage since origin\/feat\/receiver-tool-usage; a branch review would have nothing to check\./.test(B.card.text)
      && /\d+ uncommitted changes? here will not be reviewed: commit them first\./.test(B.card.text) && B.card.startDisabled && B.card.offer && B.phoneScroll <= 1, JSON.stringify(B.card) + ' scroll ' + B.phoneScroll);
    add('BR2', 'the whole-repo offer goes through the full review\'s own guard (a review is already running)',
      B.offerDialog?.open && /whole repo/.test(B.offerDialog.title) && JSON.stringify(B.offerDialog.buttons) === '["Cancel","View it →","Start another anyway"]', JSON.stringify(B.offerDialog));
    const writes = (B.calls || []).filter((c) => /^(s3api put-object|securityagent start|securityagent create)/.test(c));
    add('BR3', 'a branch review that finds nothing: the drawer shows a neutral "nothing to review", the next step and the whole-repo offer; the CLI says to use --full and uploads nothing',
      B.drawer?.pill === 'nothing to review' && !/s-error|s-ok/.test(B.drawer.pillClass) && B.drawer.hint && B.drawer.offer
      && /No changes against origin\/feat\/receiver-tool-usage; nothing to review\. To review the whole repo at HEAD, run with --full\./.test(B.drawer.out) && !writes.length, JSON.stringify({ ...B.drawer, out: (B.drawer?.out || '').slice(-300) }) + ' writes ' + writes.join('; '));
  }
  if (S.reviewer) {
    const V = S.reviewer;
    const st = (n) => (V.steps || []).find((x) => x.step === n) || {};
    const ok = (...n) => n.every((x) => /exit 0/.test(st(x).pill || ''));
    add('CWR1', 'the card names the reviewer that runs and why: the team chose kiro, kiro-cli is not installed, claude runs instead',
      /Reviewer Claude Code claude installed From the installed tool/.test(V.initial || '') && /kiro-cli was chosen \(team file \(\.prism\/config\.json\)\), but kiro-cli is not on PATH; used claude instead/.test(V.initial || ''), V.initial);
    add('CWR2', 'your default in Settings › Repos (git config --global prism.reviewer and prism.claudeModel): every repo card follows it',
      ok('default') && /prism-cli codewatch reviewer --scope global --reviewer claude --model sonnet/.test(V.defaultDialog || '') && /reviewer = claude/.test(V.globalConfig || '') && /claudeModel = sonnet/.test(V.globalConfig || '')
      && /Reviewer Claude Code.*Model for Claude Code sonnet/.test(V.settingsAfterDefault || '') && [V.shopFollows, V.payFollows].every((c) => /Reviewer Claude Code claude installed From your default .*Model sonnet From your default.*This repo follows your default/.test(c || '')),
      JSON.stringify({ s: st('default'), shop: V.shopFollows, pay: V.payFollows }).slice(0, 500));
    add('CWR3', 'override one repo (git config --local): its card says overridden, Settings lists it with a link',
      ok('clone') && /--scope clone --reviewer claude --model haiku/.test(V.cloneDialog || '') && /claudeModel = haiku/.test(V.localConfig || '') && /Model haiku From overridden for this repo.*This repo overrides your default/.test(V.afterClone || '')
      && /Repos that override it 1 of \d+/i.test(V.settingsWithOverride || '') && V.overrideLink, JSON.stringify({ d: V.cloneDialog, c: V.afterClone, s: V.settingsWithOverride }).slice(0, 500));
    add('CWR4', 'team default: a repo-file warning and a diff before saving, a checkbox in the dialog; other keys kept; the card says team file',
      V.teamWarn && (V.teamDiff || []).some((l) => l === 'add|+    "reviewer": "claude",') && (V.teamDiff || []).some((l) => l.startsWith('del|')) && V.teamDialog?.diff && V.teamDialog.runDisabled
      && ok('team') && V.teamFile?.team_id === 'demo' && V.teamFile?.eval?.reviewer === 'claude' && V.teamFile?.eval?.model === 'opus' && /Model opus From team file/.test(V.afterTeam || ''),
      JSON.stringify({ diff: V.teamDiff, dlg: V.teamDialog, file: V.teamFile, card: V.afterTeam }).slice(0, 500));
    add('CWR5', 'a personal model under the team pin: the card says the team pin wins and offers the team default',
      /The team pins model opus for claude in \.prism\/config\.json, and that wins over a personal model/.test(V.pinWarning || '') && /Use the team default instead/.test(V.pinWarning || ''), V.pinWarning);
    add('CWR6', 'reset the team default (other keys kept), then Reset to my default on the card: back to your default',
      ok('team-reset', 'reset-to-default') && /"team_id": "demo"/.test(V.teamFileAfterReset || '') && !/"model"|"reviewer"/.test(V.teamFileAfterReset || '')
      && /Model haiku From overridden for this repo/.test(V.afterTeamReset || '') && /Model sonnet From your default/.test(V.afterResetToDefault || ''), JSON.stringify({ t: V.teamFileAfterReset, a: V.afterTeamReset, b: V.afterResetToDefault }).slice(0, 400));
    add('CWR7', 'Apply my default to all repos: the dialog lists the overriding repos; afterwards none override and both cards follow; the team file is untouched',
      ok('apply-all') && (V.applyDialog?.list || []).length === 2 && V.applyDialog.runDisabled && /None: every repo follows your default/.test(V.settingsAfterApply || '')
      && [V.shopAfterApply, V.payAfterApply].every((c) => /Model sonnet From your default/.test(c || '')) && V.teamFileAfterApply === V.teamFileAfterReset && !/claudeModel/.test(V.payLocal || ''),
      JSON.stringify({ s: st('apply-all'), d: V.applyDialog, after: V.settingsAfterApply }).slice(0, 500));
    add('CWR8', 'at 390 px the open form with the team diff and Settings › Repos do not scroll sideways; Settings › Repos links each repo; no review ran and no AWS call',
      V.phoneScroll <= 1 && V.phoneSettingsScroll <= 1 && V.settingsLink && !(V.reviewerCalls || []).length && !(V.awsCalls || []).filter((c) => !/^(--version|configure )/.test(c)).length,
      JSON.stringify({ scroll: V.phoneScroll, s2: V.phoneSettingsScroll, link: V.settingsLink, rev: V.reviewerCalls, aws: V.awsCalls }).slice(0, 300));
  }
  if (S.tmdetail) {
    const T = S.tmdetail, b = T.before || {};
    add('TM1', 'threat-model drill-down header: repo, branch and commit, masked account and region, started, duration, job with Copy, all at the top',
      JSON.stringify(b.dts) === '["Repo","Branch, commit","Account, region","Started","Duration","Job"]' && /^main @ [0-9a-f]{12}$/.test(b.dds?.[1] || '') && b.dds?.[2] === 'account ••••3333 / us-west-2'
      && b.dds?.[4] === '1 h 4 min' && /tj-demo-18/.test(b.dds?.[5] || '') && b.spread >= 0 && b.spread < 200, JSON.stringify({ dts: b.dts, dds: b.dds, spread: b.spread }));
    add('TM2', 'the overview is its own card, collapsed to the first paragraph, expandable, and drawn as text (no links, images or attributes)',
      b.ov?.mode === 'short' && /^A demo web shop with a payments webhook and an admin console\.$/.test(b.ov.text) && T.full?.ov?.mode === 'full' && T.full.ov.lis === 60
      && T.full.ov.tags.every((t) => ['H3', 'H4', 'P', 'UL', 'OL', 'LI', 'CODE', 'STRONG', 'PRE'].includes(t)) && !T.full.ov.attrs && /<img src=x onerror=alert\(1\)> docs/.test(T.full.ov.text) && T.collapsedAgain === 'short',
      JSON.stringify({ b: b.ov, f: T.full?.ov, again: T.collapsedAgain }).slice(0, 500));
    add('TM3', 'all 18 threats are listed with the counts 7 critical, 10 high, 1 medium; the filter works; a threat shows statement, recommendation, assets and evidence',
      b.findings === 18 && JSON.stringify(b.chips) === '["All 18","Critical 7","High 10","Medium 1"]' && T.critical === 7
      && /The full threat statement number 0.*Recommendation 0\..*payments webhook, admin console.*src\/file0\.ts/.test(T.firstThreat || ''), JSON.stringify({ n: b.findings, chips: b.chips, crit: T.critical, first: (T.firstThreat || '').slice(0, 300) }));
    add('TM4', 'no sideways scroll at 1280 or 390 px (overview open), and the light theme keeps 4.5:1', b.scroll <= 1 && T.phone <= 1 && !(T.contrast || []).length, JSON.stringify({ s: b.scroll, phone: T.phone, c: T.contrast }).slice(0, 300));
  }
  if (S.fixes) {
    const F = S.fixes;
    add('B1', 'repo page: the running review reads "running", never "no findings"', /running/.test(F.repoSecurity) && !/no findings/.test(F.repoSecurity), F.repoSecurity);
    add('B4', 'Dashboard Security runs: the completed review with its chips and the newer review still running', /1 critical/.test(F.dashboardSecurity) && /running/.test(F.dashboardSecurity), F.dashboardSecurity.slice(0, 400));
    add('B6', 'the Security Agent picker shows distinct labels for same-named repos', new Set(F.pickerOptions).size === F.pickerOptions.length, F.pickerOptions.join(' | '));
    add('B7', 'footer and Codewatch card name the same counts', /with codewatch hooks installed/.test(F.meta) && /with hooks installed/.test(F.codewatchCard), F.meta + ' | ' + F.codewatchCard);
    const ids = accountLeaks(F.repoText + F.settingsReposText + F.securityText);
    add('B9', 'no full 12-digit account id on the repo, Settings › Repos or Security Agent pages', !ids.length, ids.join(', '));
    const apiIds = accountLeaks((F.apiJson || '') + (F.accountguardText || ''));
    add('G3', 'no full 12-digit account id in /api/data, /api/accountguard, /api/setup or on AccountGuard', F.apiJson && !apiIds.length, (F.apiJson ? apiIds : ['no API text']).join(', '));
    // The seeded review whose commit prefix is 12 digits: its id reaches the API whole, and is not counted as an account.
    add('G3b', 'a 12-digit result id stays whole in /api/data and is not taken for an account id', /"123456789012-\d{8}T\d+Z-pre-push-review"/.test(F.apiJson || ''), (F.apiJson || '').match(/.{40}123456789012.{40}/)?.[0] || 'the seeded id is not in /api/data');
    const ag = F.accountguardText || '';
    add('G1', 'AccountGuard names why each check could not run (throttled, not enabled, access denied)', /throttled/.test(ag) && /not enabled here/.test(ag) && /access denied/.test(ag) && /nothing to grant/.test(ag), ag.slice(0, 400));
    add('B10', 'update check off: Check now disabled and the reason shown', F.updates.disabled && /The update check is off/.test(F.updates.text) && /off \(PRISM_NO_UPDATE_CHECK=1\)/.test(F.updates.pillTitle), JSON.stringify(F.updates).slice(0, 300));
    for (const k of ['cb-month', 'cb-history']) {
      // The failure lines only: the rest of the page shows repo paths on purpose.
      const t = (F[k]?.text || '').split('\n').filter((l) => /codeburn|Earlier weeks/.test(l)).join('\n');
      const leaks = ['Command failed', F[k]?.home, F[k]?.tmp, '/fakebin/'].filter((x) => x && t.includes(x));
      const reason = k === 'cb-month' ? /codeburn: no data directory found/.test(t) : /Earlier weeks unavailable: codeburn: history store is locked/.test(t);
      add('B5 ' + k, 'a codeburn failure shows codeburn\'s own line, no argv or paths', reason && !leaks.length, leaks.length ? 'leaks ' + leaks.join(', ') : t.slice(0, 300));
    }
  }
  if (S.pentest) {
    const P = S.pentest, i = P.initial || {}, base = 'cd ~/src/demo-shop && prism-cli security pentest';
    const tail = ' --profile prism-demo --region us-west-2';
    add('PT1', 'the picker lists the tracked Dockerfiles (not the symlink out of the repo), preselects pentest.json\'s and fills its build folder, port and health path',
      JSON.stringify((i.radios || []).map((r) => r.v)) === '["Dockerfile","docker/web.Dockerfile","my app/Dockerfile","services/api/Dockerfile.prod","__other__"]'
      && (i.radios || []).find((r) => r.on)?.v === 'services/api/Dockerfile.prod' && /from \.prism\/pentest\.json/.test((i.radios || []).find((r) => r.on)?.label || '')
      && JSON.stringify(i.fields) === '["services/api","3000","/healthz"]' && /Asked each time: nothing here is saved/.test(i.text || ''),
      JSON.stringify({ r: i.radios, f: i.fields }));
    add('PT2', 'the Pentest command carries the choice and stays visible to copy under Start pentest (no Pentest plan item since 1.21.7), and Copy puts the exact command on the clipboard',
      i.dry === null
      && i.run?.text === base + ' --app-dir services/api --dockerfile services/api/Dockerfile.prod --port 3000 --health-path /healthz' + tail
      && i.run.badge === 'AWS write' && JSON.stringify(i.runButtons) === '["Start pentest"]' && P.clipboard === P.typed?.run?.text,
      JSON.stringify({ dry: i.dry, run: i.run, b: i.runButtons, clip: P.clipboard }));
    add('PT3', 'picking another Dockerfile moves the build folder to its folder and changes both commands; a folder with a space is shell-quoted; typing keeps the focus',
      JSON.stringify(P.web?.fields) === '["docker","3000","/healthz"]' && P.web.run.text === base + ' --app-dir docker --dockerfile docker/web.Dockerfile --port 3000 --health-path /healthz' + tail
      && P.space?.run?.text === base + ` --app-dir 'my app' --dockerfile 'my app/Dockerfile' --port 3000 --health-path /healthz` + tail
      && P.typed?.fields?.[1] === '9090' && /--port 9090/.test(P.typed.run.text) && /^sa-pt-port-/.test(P.focus || ''),
      JSON.stringify({ web: P.web?.run, space: P.space?.run, typed: P.typed?.fields, focus: P.focus }));
    const b = P.bad || {};
    const refused = (x, re) => !!x && !x.run.copy && !x.run.text && x.errs.some((e) => re.test(e));
    add('PT4', 'a typed path is checked on the server: .., an absolute path, a symlink out of the repo and a folder with no Dockerfile are refused inline with no command; a good folder works',
      refused(b.dotdot, /^dockerfile: the path must stay inside the repo/) && refused(b.abs, /^dockerfile: use a path relative to the repo root/) && refused(b.link, /^dockerfile: escape points outside the repo/)
      && refused(b.none, /^dockerfile: no Dockerfile in docs/) && b.good?.run?.copy && b.good.run.text.includes(` --app-dir 'my app' --dockerfile 'my app/Dockerfile' --port 9090`)
      && b.file?.run?.copy && b.file.run.text.includes(' --app-dir services/api --dockerfile services/api/Dockerfile.prod --port 9090')
      && !accountLeaks(JSON.stringify(b)).length && !JSON.stringify(b).includes(P.home + '/'),
      JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, x]) => [k, x && { e: x.errs, r: x.run }]))).slice(0, 600));
    add('PT5', 'the choice survives a repo switch (page memory), a reload goes back to pentest.json, nothing is written to the repo and no AWS write call is made',
      P.back?.other === 'my app' && JSON.stringify(P.reloaded) === '["services/api/Dockerfile.prod"]' && P.before?.tree === P.after?.tree && P.before?.config === P.after?.config
      && !(P.calls || []).some((c) => /^(s3api put-object|securityagent (start|create|delete|update|stop)|ssm put-parameter|cloudformation (create|update|delete|deploy)|ecr )/.test(c)),
      JSON.stringify({ other: P.back?.other, reloaded: P.reloaded, tree: [P.before?.tree, P.after?.tree] }));
    add('PT6', 'at 390 px the page with the picker has no sideways scroll', P.phoneScroll <= 1, String(P.phoneScroll));
    const s = P.stdio || {};
    add('PT8', 'over --serve-stdio the bundle\'s Start pentest dialog lists the resources, the picked Dockerfile, the teardown and the cleanup command; Cancel posts no action',
      s.dialog?.items === 7 && s.dialog.box && /built from docker\/web\.Dockerfile/.test(s.dialog.text) && /torn down automatically when the job finishes/.test(s.dialog.text)
      && /prism-cli security pentest --cleanup --job JOB_ID/.test(s.dialog.text) && s.actsAfterDialog === 0, JSON.stringify({ d: s.dialog?.text?.slice(0, 300), n: s.dialog?.items, a: s.actsAfterDialog }));
    add('PT7', 'over --serve-stdio the shared bundle draws the picker, a pick changes the command, and a symlink out of the repo is refused',
      s.kind !== 'browser' && JSON.stringify(s.routes) === '["/api/security-agent/pentest","/api/security-agent/pentest/check"]' && /--dockerfile services\/api\/Dockerfile\.prod/.test(s.initial || '')
      && /--app-dir docker --dockerfile docker\/web\.Dockerfile/.test(s.picked || '') && /escape points outside the repo/.test(s.err || '')
      && s.relayed.includes('get /api/security-agent/pentest') && s.relayed.includes('get /api/security-agent/pentest/check'),
      JSON.stringify({ k: s.kind, r: s.routes, i: s.initial, p: s.picked, e: s.err, rel: (s.relayed || []).filter((x) => /pentest/.test(x)) }));
  }
  if (S.pentestrun) {
    const Q = S.pentestrun, s = Q.steps || {};
    const FLAGS = '--app-dir services/api --dockerfile services/api/Dockerfile.prod --port 3000 --health-path /healthz';
    const WRITE = /^(s3api put-object|securityagent (start|create|delete|update|stop|batch-delete|verify)|ssm put-parameter|cloudformation (create|update|delete|deploy)|ecr )/;
    add('PR1', 'Start new work: Start pentest only (no Pentest plan item or Show the plan button since 1.21.7), its command still shown to copy, and no Pentest status item',
      JSON.stringify((s.page?.buttons || []).map((b) => [b.id, b.label, b.disabled])) === '[["security-pentest-start","Start pentest",false]]'
      && (s.page?.copy || []).some((c) => c.includes('security pentest ' + FLAGS)) && !(s.page?.copy || []).some((c) => /--dry-run/.test(c))
      && !/Pentest status|Pentest plan|Show the plan/.test(s.page?.text || ''), JSON.stringify({ b: s.page?.buttons, c: s.page?.copy }));
    const pc = s.planCalls || {};
    add('PR2', 'the removed plan action is refused by the server (400) and runs nothing: no cdk, docker or AWS call',
      s.plan?.status === 400 && !(pc.cdk || []).length && !(pc.docker || []).length && !(pc.aws || []).some((c) => WRITE.test(c)), JSON.stringify({ p: s.plan, c: pc }));
    add('PR3', 'a bad picker value sent to the server is refused (400) with the field, and nothing is spawned',
      s.bad?.status === 400 && /the pentest target is not valid: dockerfile:/.test(s.bad.error || '') && !s.badSpawned, JSON.stringify(s.bad));
    const sd = s.startDialog || {}, sc = s.startCalls || {};
    const bc = s.beforeConfirm || {};
    add('PR10', 'the Start pentest dialog says what it deploys before the confirm: the account and region, the stack\'s resources, the picked Dockerfile, build folder, port and health path, the automatic teardown, Clean up and the cleanup command, hours and cost',
      /This deploys a temporary private environment for demo-shop into account ••••3333 \/ us-west-2 and runs the pentest against it\./.test(sd.text || '')
      && (sd.resources || []).length === 7 && /^A VPC with private subnets only/.test(sd.resources[0]) && /no internet gateway/.test(sd.resources[0]) && /no public endpoint/.test(sd.resources[0])
      && /^A Fargate service running your app, built from services\/api\/Dockerfile\.prod \(build folder services\/api\)/.test(sd.resources[1]) && /Docker must be running/.test(sd.resources[1])
      && ['internal Application Load Balancer', 'VPC endpoints for ECR, S3 and CloudWatch Logs', 'IAM service role', 'S3 source bucket', 'CloudWatch log groups', 'agent space for this run, a private target domain, and the pentest and its job'].every((w) => sd.resources.join(' ').includes(w))
      && sd.target === 'Dockerfile services/api/Dockerfile.prod Build folder services/api Port 3000 Health path /healthz'
      && /torn down automatically when the job finishes: while the dashboard is open, it checks the job every 5 minutes/.test(sd.text || '') && /a Clean up button appears on the run's page/.test(sd.text || '')
      && (sd.cmds || []).includes('cd ~/src/demo-shop && prism-cli security pentest --cleanup --job JOB_ID --profile prism-demo --region us-west-2')
      && /runs for hours/.test(sd.text || '') && /costs money while it runs/.test(sd.text || '') && /\$50 per task-hour/.test(sd.text || '') && sd.overflow <= 1,
      JSON.stringify({ t: sd.text?.slice(0, 600), r: sd.resources, tg: sd.target, c: sd.cmds }));
    add('PR11', 'the tick box is still required, and opening the dialog, Cancel and ticking the box make no AWS write, no cdk and no docker call; only Deploy and start runs',
      s.cancelled === true && sd.box && sd.buttons?.find((b) => b.t === 'Deploy and start')?.dis === true && s.ticked?.buttons?.find((b) => b.t === 'Deploy and start')?.dis === false
      && !(bc.aws || []).some((c) => WRITE.test(c)) && !(bc.cdk || []).length && !(bc.docker || []).length, JSON.stringify({ c: s.cancelled, bc }));
    const PD = s.phoneDialog || {};
    add('PR12', 'at 390 px the start dialog fits in light and dark (no sideways scroll, all 7 resources, no target value or command cut off) with themed text on a themed surface',
      ['light', 'dark'].every((t) => PD[t] && PD[t].overflow <= 1 && PD[t].width <= 390 && PD[t].items === 7 && !PD[t].running && !(PD[t].clipped || ['?']).length) && PD.light.bg !== PD.dark.bg && PD.light.fg !== PD.dark.fg, JSON.stringify(PD));
    add('PR4', 'Start pentest confirms with the account and region, Docker, hours, cost and automatic teardown, needs the box; it runs --yes with the flags (no --wait, no --keep) detached, builds and pushes with docker, deploys, starts the job, and the same record becomes pending',
      ['account ••••3333 / us-west-2', 'Docker must be running', 'runs for hours', 'costs money', 'torn down automatically when the job finishes'].every((w) => (sd.text || '').includes(w)) && sd.box
      && sd.buttons?.find((b) => b.t === 'Deploy and start')?.dis === true && /Bootstrapping started/.test(s.start?.status || '') && s.start.status.includes('security pentest --yes ' + FLAGS) && !/--wait|--keep/.test(s.start.status)
      && (sc.docker || []).some((c) => c.startsWith('build')) && (sc.docker || []).some((c) => c.startsWith('push')) && (sc.aws || []).some((c) => c.startsWith('securityagent start-pentest-job'))
      && JSON.stringify(s.afterStart) === '[{"status":"pending","job":"ptj-run-1","stack":' + JSON.stringify((s.afterStart || [])[0]?.stack) + ',"keep":null}]' && /^PrismPentest-demo-shop-/.test((s.afterStart || [])[0]?.stack || '')
      && s.sameId?.id === true && s.sameId.status === 'pending' && s.logFile === true,
      JSON.stringify({ d: sd.text?.slice(0, 200), st: s.start?.status, docker: sc.docker, after: s.afterStart, same: s.sameId }));
    const ph = s.phases || [];
    const ORDER = ['preparing', 'building', 'pushing', 'deploying', 'health', 'registering', 'starting'];
    add('PR13', 'Start pentest returns at once (Bootstrapping started, a link to the run) with the record already written (deploying, the stack, the picked target); the lock stays free (another action runs) and a second Start is refused while it deploys',
      s.startMs < 8000 && s.startLink === '#security/run/' + Q.repoId + '/' + (s.boot ? Q.runId : '') && !!s.boot && ['preparing', 'building'].includes(s.boot.phase) && /^PrismPentest-demo-shop-/.test(s.boot.stack || '')
      && s.boot.log === Q.runId + '.log' && JSON.stringify(s.boot.choice) === '["services/api","services/api/Dockerfile.prod",3000,"/healthz"]'
      && s.lockState === 'done' && s.other === 202 && /^done exit \d+$/.test(s.otherDone?.status || '') && s.second?.status === 409 && /already bootstrapping/.test(s.second.json?.error || ''),
      JSON.stringify({ ms: s.startMs, link: s.startLink, boot: s.boot, lock: s.lockState, other: s.other, second: s.second }));
    add('PR14', 'the record\'s phase advances in order through every step (its history: preparing, building, pushing, deploying, health, registering, starting), seen live as it goes, and no job check runs against AWS before the job has started',
      JSON.stringify(s.history) === JSON.stringify(ORDER) && ph.length >= 3 && ph.every((x, k) => k === 0 || ORDER.indexOf(x) > ORDER.indexOf(ph[k - 1])) && ['pushing', 'deploying'].every((x) => ph.includes(x)) && s.checkedBeforeStart === 0,
      JSON.stringify({ ph, h: s.history, checked: s.checkedBeforeStart }));
    add('PR15', 'while it deploys, the runs table shows Bootstrapping with its step, and the run page lists the steps with the current one, and View log shows the redacted log',
      /Bootstrapping/.test(s.bootRow || '') && /Step \d of 7: /.test(s.bootRow || '') && /View progress/.test(s.bootRow || '') && s.bootPage?.status === 'Bootstrapping' && !!s.bootPage.now
      && /Deploying the private target environment/.test(s.bootPage.log || '') && !accountLeaks(s.bootPage.log || '').length && !(s.bootPage.log || '').includes(Q.home + '/'),
      JSON.stringify({ row: s.bootRow, page: s.bootPage && { ...s.bootPage, log: (s.bootPage.log || '').slice(-300) } }));
    const df = s.deployFail || {}, ki = s.interrupted || {};
    add('PR16', 'a deploy that fails becomes an error that keeps its stack; its page shows Deploy stopped and Clean up, which removes the stack',
      df.start === 202 && df.status === 'error' && /cdk deploy of the pentest target/.test(df.reason || '') && /^PrismPentest-/.test(df.stack || '') && s.deployFailPage?.kind === 'deploy_stopped' && s.deployFailPage.button
      && /Deploy stopped/.test(s.deployFailPage.deploy || '') && /exit 0/.test(s.deployFailCleanup?.status || '') && s.deployFailAfter === null, JSON.stringify({ df, p: s.deployFailPage, c: s.deployFailCleanup?.status, a: s.deployFailAfter }));
    add('PR17', 'a deploy whose process is killed is marked interrupted by the dashboard\'s local check (no AWS call), keeps its stack, and its page offers Clean up',
      s.killed?.start === 202 && s.killed.phase === 'deploying' && s.killed.pid && ki.status === 'error' && /^deploy interrupted: its process \(pid \d+\) stopped during "Deploying the environment"/.test(ki.reason || '') && ki.flag
      && /^PrismPentest-/.test(ki.stack || '') && !(ki.awsWhileDeploying || []).length && s.interruptedPage?.kind === 'deploy_stopped' && s.interruptedPage.button && /Interrupted at step 4 of 7/.test(s.interruptedPage.deploy || '')
      && /exit 0/.test(s.interruptedCleanup?.status || ''), JSON.stringify({ k: s.killed, ki, p: s.interruptedPage, c: s.interruptedCleanup?.status }));
    add('PR5', 'while it is pending, Start pentest warns that a pentest is already running, with View it and no Start another; the running check tears nothing down',
      /A pentest of demo-shop is already running/.test(s.guard?.text || '') && JSON.stringify((s.guard?.buttons || []).map((b) => b.t)) === '["Cancel","View it →"]'
      && s.runningCheck?.deletes === 0 && JSON.stringify(s.runningCheck.rows) === '["pending"]', JSON.stringify({ g: s.guard, r: s.runningCheck }));
    const t = s.teardown || {};
    add('PR6', 'once the job has finished, the background pentest --status --job saves the verdict and deletes the run\'s own recorded stack exactly once; asking again deletes nothing more',
      (t.deletes || []).length === 1 && t.deletes[0].includes('--stack-name ' + (s.afterStart || [])[0]?.stack) && (t.calls || []).some((c) => c.includes('batch-get-pentest-jobs') && c.includes('--pentest-job-ids ptj-run-1'))
      && JSON.stringify(t.rows) === '[{"status":"ok","stack":null}]', JSON.stringify({ d: t.deletes, rows: t.rows }));
    add('PR7', 'a run whose teardown failed: its page shows Teardown failed with the reason (redacted) and Clean up; Clean up confirms in the account and region, keeps the card while deletion fails, and clears it once it works',
      !!s.failedRecord?.stack && s.card?.kind === 'teardown_failed' && s.card.button && /Reason: DELETE_FAILED/.test(s.card.text) && !accountLeaks(s.card.text).length
      && /Tears down this run's pentest environment in account ••••3333 \/ us-west-2/.test(s.cleanupDialog?.text || '') && /--cleanup --job ptj-run-2/.test(s.cleanupDialog?.text || '')
      && /exit 1/.test(s.cleanup1?.status || '') && /exit 0/.test(s.cleanup2?.status || '') && s.cardAfter === false && s.cleanedRecord?.stack === null && s.cleanedRecord.teardown_failed === null,
      JSON.stringify({ f: s.failedRecord, c: s.card, d: s.cleanupDialog?.text?.slice(0, 300), c1: s.cleanup1?.status, c2: s.cleanup2?.status, after: s.cardAfter, rec: s.cleanedRecord }));
    const U = Q.stdio || {};
    add('PR8', 'over --serve-stdio: a bad health path is refused (400), the removed plan action is refused (400), the check route carries the dialog\'s resource list, the start runs with the same argv (exit 0), and a second start is refused while the first is pending (409)',
      U.badStart?.status === 400 && /healthPath:/.test(U.badStart.error || '') && U.plan === 400 && (U.start0?.resources || []).length === 7 && /--cleanup --job JOB_ID/.test(U.start0?.cleanup || '')
      && U.start === 202 && U.startExit === 0 && (U.startCmd || '').includes('--yes ' + FLAGS) && U.startOutcome === 'detached' && U.again?.status === 409 && /already (bootstrapping|running)/.test(U.again.error || ''), JSON.stringify(U));
    add('PR9', 'at 390 px the page with the buttons has no sideways scroll, and no account id or home path leaks into what the page showed', s.phoneScroll <= 1
      && !accountLeaks(JSON.stringify([s.page?.text, s.card, s.guard, s.startDialog])).length && !JSON.stringify([s.page?.text, s.card, s.startDialog]).includes(Q.home + '/'), String(s.phoneScroll));
  }
  if (S.stdio) {
    const U = S.stdio;
    add('U1', 'dashboard --serve-stdio says hello (api 1, the dist/ui bundle) and the bundle draws the Dashboard through the embedded transport',
      U.hello?.hello === 'prism.dashboard.stdio' && U.hello.api === 1 && U.hello.ui && U.kind === 'vscode' && U.dashboard?.cards === 4 && U.dashboard.repos >= 3, JSON.stringify({ h: U.hello, k: U.kind, d: U.dashboard }));
    add('U2', 'a Security Agent findings page reads /api/security-run over stdio', U.findings > 0 && U.relayed.includes('get /api/security-run'), JSON.stringify({ f: U.findings, r: U.relayed.slice(-5) }));
    add('U3', 'a report link asks the host (no navigation) and /api/report answers its HTML, without script, and its Markdown',
      U.reports.length === 1 && U.reportHashAfter === '' && U.report?.status === 200 && U.report.html && !U.report.script && U.report.md, JSON.stringify({ r: U.reports, h: U.reportHashAfter, rep: U.report }));
    add('U4', 'the same refusals as over HTTP: confirm needed (400), the AWS write gate (409)', U.noConfirm?.status === 400 && /confirm: true/.test(U.noConfirm.error) && U.writeGate === 409, JSON.stringify({ n: U.noConfirm, w: U.writeGate }));
    add('U5', 'a confirmed action runs over stdio: Run disabled until the checkbox, exit 0, the saved connection file removed', U.runDisabled === true && /exit 0/.test(U.actionResult || '') && U.connectionFileGone, JSON.stringify({ d: U.runDisabled, a: U.actionResult, g: U.connectionFileGone }));
    add('U6', 'the embedded page cannot fetch (connect-src none), breaks no CSP rule before that probe, and only allowlisted routes were relayed', U.fetch === 'blocked' && U.cspBeforeProbe === 0 && !U.dropped.length, JSON.stringify({ f: U.fetch, c: U.cspBeforeProbe, d: U.dropped }));
    add('U7', 'the stdio child listens on no port, exits when stdin closes, and the fake aws saw no write call', !U.listen && U.exitedOnStdinClose && U.fakeAwsCalls.every((c) => READ_ONLY_AWS.test(c)), JSON.stringify({ l: U.listen, e: U.exitedOnStdinClose, a: U.fakeAwsCalls }));
  }
  return out;
}
