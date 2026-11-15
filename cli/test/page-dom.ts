/**
 * Just enough DOM to run the dashboard page script in a test: elements, text,
 * attributes, details.open, inline style, the hash router's location and
 * hashchange, and two selector shapes. No browser, no network.
 */
import { renderPage } from '../src/dashboard/page.js';

export class FakeNode {
  childNodes: FakeNode[] = []; parent: FakeNode | null = null; nodeName = '#node';
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.childNodes = [new FakeText(String(v))]; }
  append(...kids: (FakeNode | string)[]) { for (const k of kids) { const n = typeof k === 'string' ? new FakeText(k) : k; n.parent = this; this.childNodes.push(n); } }
  replaceChildren(...kids: FakeNode[]) { this.childNodes = []; this.append(...kids); }
}
export class FakeText extends FakeNode {
  constructor(public data: string) { super(); this.nodeName = '#text'; }
  get textContent() { return this.data; } set textContent(v: string) { this.data = v; }
}
export class FakeElement extends FakeNode {
  attrs = new Map<string, string>(); listeners: Record<string, (e?: unknown) => void> = {}; style: Record<string, string> = {};
  constructor(tag: string) { super(); this.nodeName = tag.toUpperCase(); }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.has(k) ? this.attrs.get(k)! : null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  get hidden() { return this.attrs.has('hidden'); } set hidden(v: boolean) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
  get open() { return this.attrs.has('open'); } set open(v: boolean) { if (v) this.attrs.set('open', ''); else this.attrs.delete('open'); }
  get classList() { return { add: (c: string) => this.setAttribute('class', ((this.getAttribute('class') || '') + ' ' + c).trim()) }; }
  addEventListener(t: string, f: (e?: unknown) => void) { this.listeners[t] = f; }
  closest(tag: string): FakeElement | null {
    for (let n: FakeNode | null = this; n; n = n.parent) if (n instanceof FakeElement && n.nodeName === tag.toUpperCase()) return n;
    return null;
  }
  scrollIntoView() { /* no layout here */ }
  /** <select>/<input> value and <dialog>, as far as the page uses them. */
  value = ''; disabled = false; focused = false; modal = false;
  showModal() { this.modal = true; } close() { this.modal = false; } focus() { this.focused = true; }
  all(): FakeElement[] { return this.childNodes.flatMap((c) => (c instanceof FakeElement ? [c, ...c.all()] : [])); }
  querySelectorAll(sel: string): FakeElement[] {
    const m = /^([a-z0-9]*)((?:\[[a-z-]+\])*)$/.exec(sel)!;
    const attrs = [...m[2].matchAll(/\[([a-z-]+)\]/g)].map((x) => x[1]);
    return this.all().filter((e) => (!m[1] || e.nodeName === m[1].toUpperCase()) && attrs.every((a) => e.hasAttribute(a)));
  }
  /** Elements whose class list has `cls`. */
  byClass(cls: string): FakeElement[] { return this.all().filter((e) => (e.getAttribute('class') || '').split(/\s+/).includes(cls)); }
}

export function fakeDom() {
  const ids = ['main', 'repo', 'security', 'accountguard', 'settings', 'meta', 'refresh', 'ver', 'settings-badge', 'security-badge', 'accountguard-badge'];
  const byId: Record<string, FakeElement> = Object.fromEntries(ids.map((id) => [id, new FakeElement(id === 'meta' ? 'p' : id === 'refresh' ? 'button' : id === 'ver' || id.endsWith('-badge') ? 'span' : 'main')]));
  byId.repo.hidden = true; byId.settings.hidden = true; byId.security.hidden = true; byId['security-badge'].hidden = true; byId.accountguard.hidden = true; byId['accountguard-badge'].hidden = true;
  const document = {
    visibilityState: 'visible',
    createElement: (t: string) => new FakeElement(t),
    createElementNS: (_: string, t: string) => new FakeElement(t),
    createTextNode: (s: string) => new FakeText(s),
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: () => null,
    querySelectorAll: (sel: string) => Object.values(byId).flatMap((e) => e.querySelectorAll(sel)),
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    addEventListener: () => {},
  };
  return { document, byId };
}

/** A minimal /api/setup answer: no actions, so the Setup view draws its rows with Copy commands only. */
export const SETUP_STUB = { actions: [], repoIds: {}, repoCd: {}, cwd: '~', copy: {}, aws: { steps: [], warnings: [] } };

/**
 * Runs the live page's script over `payloads` (one per /api/data call); `hash`
 * is the starting location. `setup` answers /api/setup (default: 404).
 */
export async function runPage(payloads: unknown[], hash = '', setup: unknown = null, routes: Record<string, unknown> = {}) {
  const html = renderPage('N');
  // The last script is the page; the first (in <head>) only applies a saved theme.
  const js = html.slice(html.lastIndexOf('<script nonce="N">') + '<script nonce="N">'.length, html.lastIndexOf('</script>'));
  const dom = fakeDom();
  let i = 0;
  // /api/data gets the payloads in turn; the Setup view's routes answer 404 here (tested in dashboard-setup.test.ts).
  // `routes`: more answers by path (GET or POST); every request is recorded in `requests`.
  const requests: { url: string; method: string; body: unknown }[] = [];
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    requests.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (url === '/api/data') return { ok: true, json: async () => JSON.parse(JSON.stringify(payloads[Math.min(i++, payloads.length - 1)])) };
    if (url === '/api/setup' && setup) return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(setup)) };
    if (Object.prototype.hasOwnProperty.call(routes, url)) {
      const v = routes[url];
      const answer = typeof v === 'function' ? (v as (b: unknown) => unknown)(requests[requests.length - 1].body) : v;
      // { __status, body }: an answer with another HTTP status (a 404 from the server).
      if (answer && typeof answer === 'object' && '__status' in (answer as object)) {
        const a = answer as { __status: number; body: unknown };
        return { ok: a.__status >= 200 && a.__status < 300, status: a.__status, json: async () => JSON.parse(JSON.stringify(a.body)) };
      }
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(answer)) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const handlers: Record<string, () => void> = {};
  const window = { addEventListener: (t: string, f: () => void) => { handlers[t] = f; }, scrollTo: () => {} };
  const location = { hash };
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  new Function('document', 'Node', 'Element', 'fetch', 'setInterval', 'window', 'location', 'localStorage', js)(
    dom.document, FakeNode, FakeElement, fetch, () => 0, window, location, localStorage);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  return {
    dom,
    reload: async () => { dom.byId.refresh.listeners.click(); await settle(); },
    /** Moves to `h` as a link or Back would: sets the hash and fires hashchange. */
    go: (h: string) => { location.hash = h; handlers.hashchange?.(); },
    location,
    requests,
    settle,
    text: () => dom.byId.main.textContent,
    settingsText: () => dom.byId.settings.textContent,
    meta: () => dom.byId.meta.textContent,
  };
}
