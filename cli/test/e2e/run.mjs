// Playwright e2e run over the prism-cli dashboard: the live server and the static snapshot, on DEMO
// data in throwaway HOMEs, with a fake aws CLI (nothing reaches AWS) and a fake codeburn.
//   npm run test:e2e                 every suite (cli/, after npm run build)
//   npm run test:e2e -- auth nav     only the named suites
// Needs a Chromium: CHROME=/path/to/chrome, else the newest Playwright headless shell under
// ~/.cache/ms-playwright (npx playwright-core install chromium-headless-shell). Not part of npm test or CI.
// Writes results.json, verdicts and shots/*.png to $PRISM_E2E_OUT (default: <tmp>/prism-dashboard-e2e);
// exits 1 when a verdict fails.
import { chromium } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboard, demoEnv, ENTRY } from './start-dashboard.mjs';

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

    // Security Agent: look up agent spaces (read-only AWS) and the AWS-writing buttons.
    setTag('security');
    await page.goto(srv.base + '/#security'); await sleep(900);
    out.saButtons = await page.$$eval('#security button', (b) => b.filter((x) => x.offsetParent).map((x) => x.textContent.trim()));
    out.saWriteRows = await page.$$eval('#security .salist li', (l) => l.slice(0, 3).map((x) => x.innerText.replace(/\s+/g, ' ').slice(0, 200)));
    const lk = page.locator('#security button', { hasText: /look up/i }).first();
    if (await lk.count()) {
      const t0 = Date.now(); await lk.click();
      await page.waitForFunction(() => { const b = [...document.querySelectorAll('#security button')].find((x) => /look up/i.test(x.textContent)); return b && !b.disabled; }, null, { timeout: 90000 }).catch(() => {});
      await sleep(600);
      out.steps.push({ step: 'sa lookup', ms: Date.now() - t0, text: (await page.innerText('#security')).slice(0, 1600) });
      await page.screenshot({ path: join(SHOTS, 'actions-sa-lookup.png'), fullPage: true });
      out.badgeAfterLookup = await page.textContent('#security-badge');
    }
    const st = page.locator('#security button:visible', { hasText: /status check/i }).first();
    if (await st.count()) {
      await st.click(); await sleep(300);
      out.steps.push({ step: 'sa status: dialog', ...(await dialogState()) });
      await page.click('dialog.confirm button:not(:has-text("Cancel"))');
      const done = await waitDone(200000);
      out.steps.push({ step: 'sa status: result', ...done });
      await page.screenshot({ path: join(SHOTS, 'actions-sa-status-result.png'), fullPage: true });
    }
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
    out.dashboardSecurity = await page.evaluate(() => document.getElementById('security-findings')?.innerText || '');
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
    const srv = await live('pending', 'full', { PRISM_NO_UPDATE_CHECK: '1', FAKE_AWS: 'in-progress' });
    const { ctx, page, log } = await openCtx(srv);
    out.log = log;
    await page.goto(srv.base + '/#security'); await sleep(900);
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
      await sleep(1500);
      out.row = await page.evaluate(() => { const tr = [...document.querySelectorAll('#security tr')].find((x) => /Code review/.test(x.innerText)); return tr ? tr.innerText.replace(/\s+/g, ' ') : ''; });
      await page.screenshot({ path: join(SHOTS, 'pending-fetch-findings.png'), fullPage: true });
    }
    out.home = srv.home;
    await ctx.close();
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
    const results = ['connect: result', 'ag check: result', 'sa status: result'].map(st);
    add('no-hang', 'AWS actions without credentials finish with an error in the drawer, no hang', results.every((r) => r.status && !r.hung && /exit 1/.test(r.status)), JSON.stringify(results.map((r) => [r.status, r.ms])));
    add('B12', 'no doubled period in the AWS error text', results.every((r) => !/\.\./.test(r.out || '')), results.map((r) => r.out).join(' | '));
    const lookup = st('sa lookup');
    add('sa-lookup', 'the agent-space lookup without credentials shows the sign-in callout', /The AWS credentials did not work/.test(lookup.text || ''), (lookup.text || '').slice(0, 200));
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
    add('snapshot', 'the snapshot is written and draws every route', S.snapshot.exit === 0 && S.snapshot.routes.length >= 8 && !S.snapshot.layout320?.hscroll, JSON.stringify({ exit: S.snapshot.exit, stderr: S.snapshot.stderr }));
    add('snapshot-copy-only', 'nothing runs from the snapshot (Run buttons are Copy)', !live.length, live.join('; '));
  }
  if (S.pending) {
    const d = S.pending.drawer || {};
    add('pending', 'Fetch findings on a running job: amber "still running" pill with a hint, not a red exit pill', S.pending.found && !d.hung && /s-warn/.test(d.pillClass) && !/s-error/.test(d.pillClass)
      && /still running \(exit 2\)/.test(d.pillText) && /Check back later, or run the same command with --wait/.test(d.status) && /still IN_PROGRESS/.test(d.out), JSON.stringify(d).slice(0, 400));
    add('pending-row', 'the code review row still reads "running" after the fetch', /running/i.test(S.pending.row || ''), S.pending.row);
    const leak = (d.out || '').match(/\b\d{12}\b|demo-session/g) || [];
    add('pending-mask', 'the drawer shows ••••3333, the role name only, and no home path', !leak.length && /••••3333/.test(d.out || '') && /assumed-role\/PrismDemoReadOnly\/…/.test(d.out || '') && !(d.out || '').includes(S.pending.home), leak.join(', ') || (d.out || '').slice(0, 300));
  }
  if (S.fixes) {
    const F = S.fixes;
    add('B1', 'repo page: the running review reads "running", never "no findings"', /running/.test(F.repoSecurity) && !/no findings/.test(F.repoSecurity), F.repoSecurity);
    add('B4', 'Dashboard keeps the last completed review\'s findings with a "new review running" note', /1 critical/.test(F.dashboardSecurity) && /new review running/.test(F.dashboardSecurity), F.dashboardSecurity.slice(0, 400));
    add('B6', 'the Security Agent picker shows distinct labels for same-named repos', new Set(F.pickerOptions).size === F.pickerOptions.length, F.pickerOptions.join(' | '));
    add('B7', 'footer and Codewatch card name the same counts', /with codewatch hooks installed/.test(F.meta) && /with hooks installed/.test(F.codewatchCard), F.meta + ' | ' + F.codewatchCard);
    const ids = (F.repoText + F.settingsReposText + F.securityText).match(/\b\d{12}\b/g);
    add('B9', 'no full 12-digit account id on the repo, Settings › Repos or Security Agent pages', !ids, (ids || []).join(', '));
    const apiIds = ((F.apiJson || '') + (F.accountguardText || '')).match(/\b\d{12}\b/g);
    add('G3', 'no full 12-digit account id in /api/data, /api/accountguard, /api/setup or on AccountGuard', F.apiJson && !apiIds, (apiIds || ['no API text']).join(', '));
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
  return out;
}
