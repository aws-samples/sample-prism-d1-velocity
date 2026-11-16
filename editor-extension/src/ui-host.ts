/**
 * The PRISM panel: the browser dashboard's own UI (prism-cli's dist/ui bundle) in a webview, with
 * every read and action relayed to `prism-cli dashboard --serve-stdio`, which answers with the same
 * handlers and checks as the browser dashboard. No vscode import, so the unit tests and the webview
 * harness run it as is.
 *
 * Trust: the webview draws recorded text (finding messages, repo names). It can only post
 * {op, path, query | body}; parseUiRequest checks the shape and that the path is one of the routes
 * the CLI listed in its hello, and the CLI checks again (exact route keys, the action allowlist,
 * confirm, the AWS write gate). AWS-writing actions also need a native modal here (nativeConfirm),
 * decided from the CLI's own action catalog (GET /api/setup), never from webview text.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute } from 'node:path';

export const STDIO_PROTOCOL = 'prism.dashboard.stdio';
/** The stdio API this extension speaks, and the first prism-cli that serves it. */
export const MIN_UI_API = 1;
export const MIN_CLI_VERSION = '1.21.0';
export const UPDATE_CMD = 'npm install -g @prism-d1/cli@latest';
export const UPDATE_TEXT = `Update prism-cli to ${MIN_CLI_VERSION} or later: ${UPDATE_CMD}`;
/** A webview message: a 16 KB action body plus the envelope (the CLI refuses longer lines). */
export const MAX_MESSAGE = 16 * 1024 + 4096;
const HELLO_TIMEOUT_MS = 15_000;
export const REQUEST_TIMEOUT_MS = 125_000;
/** server.ts REPORT_ROUTE: a result id, never a path. */
export const REPORT_ID = /^[A-Za-z0-9_-]{1,120}$/;

export interface Hello { hello: string; api: number; version: string; uiDir: string; routes: { get: string[]; act: string[] } }
export interface UiRequest { id: number; op: 'get' | 'act'; path: string; query?: Record<string, string>; body?: Record<string, unknown> }
export interface UiAnswer { status: number; json: unknown }

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** -1, 0 or 1 for two x.y.z versions; a prerelease or build suffix is ignored. Not a version: -1 (older). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const x = parse(a), y = parse(b);
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** True when `version` (from `dashboard --json`'s version.installed, or the stdio hello) is new enough. */
export const cliIsCurrent = (version: unknown): boolean => typeof version === 'string' && compareVersions(version, MIN_CLI_VERSION) >= 0;

/** The webview's request, or null when it is not a well-formed request for one of the CLI's routes. */
export function parseUiRequest(m: unknown, hello: Pick<Hello, 'routes'>): UiRequest | null {
  if (!plain(m) || m.type !== 'prism-ui:request' || !Number.isSafeInteger(m.id)) return null;
  if (m.op !== 'get' && m.op !== 'act') return null;
  if (typeof m.path !== 'string' || !(m.op === 'get' ? hello.routes.get : hello.routes.act).includes(m.path)) return null;
  let size = 0;
  try { size = JSON.stringify(m).length; } catch { return null; }
  if (size > MAX_MESSAGE) return null;
  if (m.op === 'get') {
    if (m.body !== undefined) return null;
    const q = m.query ?? {};
    if (!plain(q) || !Object.values(q).every((v) => typeof v === 'string')) return null;
    return { id: m.id as number, op: 'get', path: m.path, query: q as Record<string, string> };
  }
  if (!plain(m.body) || m.query !== undefined) return null;
  return { id: m.id as number, op: 'act', path: m.path, body: m.body };
}

/** The report id of a {type:'prism-ui:open-report', id} message, or null. */
export function parseOpenReport(m: unknown): string | null {
  return plain(m) && m.type === 'prism-ui:open-report' && typeof m.id === 'string' && REPORT_ID.test(m.id) ? m.id : null;
}

/** Checks the first line of --serve-stdio. A string: why this prism-cli cannot serve the panel. */
export function checkHello(o: unknown): Hello | string {
  if (!plain(o) || o.hello !== STDIO_PROTOCOL) return UPDATE_TEXT;
  if (typeof o.api !== 'number' || o.api < MIN_UI_API || !cliIsCurrent(o.version)) return UPDATE_TEXT;
  if (typeof o.uiDir !== 'string' || !isAbsolute(o.uiDir) || !plain(o.routes)) return 'prism-cli sent an unexpected hello';
  const r = o.routes as Record<string, unknown>;
  if (!Array.isArray(r.get) || !Array.isArray(r.act) || ![...r.get, ...r.act].every((x) => typeof x === 'string')) return 'prism-cli sent an unexpected hello';
  return o as unknown as Hello;
}

/** One action of the CLI's catalog (GET /api/setup .actions), as far as the native confirm needs it. */
export interface CatalogAction { id: string; label: string; command: string; writesAws: boolean }
export interface Catalog { actions: CatalogAction[]; repoNames: Map<string, string> }

/** The catalog from a /api/setup answer: only well-formed entries; repo ids mapped to their paths. */
export function catalogFrom(setup: unknown): Catalog {
  const s = plain(setup) ? setup : {};
  const actions = (Array.isArray(s.actions) ? s.actions : []).filter((a): a is Record<string, unknown> => plain(a) && typeof a.id === 'string')
    .map((a) => ({ id: a.id as string, label: typeof a.label === 'string' ? a.label : (a.id as string), command: typeof a.command === 'string' ? a.command : '', writesAws: a.writesAws === true }));
  const repoNames = new Map<string, string>();
  if (plain(s.repoIds)) for (const [path, id] of Object.entries(s.repoIds)) if (typeof id === 'string') repoNames.set(id, path);
  return { actions, repoNames };
}

export interface NativeConfirm { title: string; detail: string; button: string }

/**
 * The native modal an action needs before it is relayed, or null. AWS-writing actions only, as the
 * CLI's catalog marks them (writesAws); an action id the catalog does not know also asks, so a
 * catalog that failed to load never lets a write through unasked.
 */
export function nativeConfirm(r: UiRequest, catalog: Catalog | null): NativeConfirm | null {
  if (r.op !== 'act' || r.path !== '/api/action' || !r.body) return null;
  const id = r.body.action;
  const a = catalog?.actions.find((x) => x.id === id);
  if (a && !a.writesAws) return null;
  const repo = typeof r.body.repo === 'string' ? catalog?.repoNames.get(r.body.repo) : undefined;
  return {
    title: `PRISM: ${a ? a.label : 'run an action'}? This writes to AWS.`,
    detail: [
      a ? `prism-cli runs: ${a.command}` : `Action: ${typeof id === 'string' ? id.slice(0, 80) : 'unknown'}`,
      repo ? `In: ${repo}` : null,
      'It uploads the repository at HEAD to the Security Agent scan bucket and starts a job in your AWS account. The dialog in the panel named the account and region.',
    ].filter(Boolean).join('\n'),
    button: 'Start in AWS',
  };
}

/** What the panel gets when the modal was dismissed: a refusal it shows in its action drawer. */
export const DECLINED: UiAnswer = { status: 409, json: { error: 'Cancelled in VS Code: nothing was started and nothing was uploaded.' } };

/** The editor side of the panel, so handlePanelMessage runs without vscode (the harness passes its own). */
export interface PanelDeps {
  /** The native modal; true when the user picked the button. */
  confirm(c: NativeConfirm): Promise<boolean>;
  /** Shows a report's HTML (scripts off). */
  showReport(html: string): void;
  /** No report for that id. */
  noReport(status: number): void;
  /** Posts an answer back into the webview. */
  post(msg: { type: 'prism-ui:response'; id: number; status: number; json: unknown }): void;
}

/**
 * One webview message: a read or an action relayed to the CLI (AWS writes after the native modal),
 * or a report to show. Anything else is dropped without an answer.
 */
export async function handlePanelMessage(m: unknown, client: StdioClient, deps: PanelDeps): Promise<void> {
  const reportId = parseOpenReport(m);
  if (reportId) {
    const a = await client.request({ op: 'get', path: '/api/report', query: { id: reportId } });
    const html = a.status === 200 && plain(a.json) && typeof a.json.html === 'string' ? a.json.html : null;
    if (html) deps.showReport(html); else deps.noReport(a.status);
    return;
  }
  const r = client.hello && parseUiRequest(m, client.hello);
  if (!r) return;
  const ask = nativeConfirm(r, r.op === 'act' && r.path === '/api/action' ? await client.loadCatalog() : null);
  const a = ask && !(await deps.confirm(ask)) ? DECLINED : await client.request(r);
  deps.post({ type: 'prism-ui:response', id: r.id, status: a.status, json: a.json });
}

export type SpawnFn = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;

/** One long-lived `prism-cli dashboard --serve-stdio` child, owned by the extension host; restarted on the next request if it stopped. */
export class StdioClient {
  private proc: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { done: (a: UiAnswer) => void; timer: NodeJS.Timeout }>();
  private starting: Promise<Hello> | null = null;
  private disposed = false;
  hello: Hello | null = null;
  catalog: Catalog | null = null;

  constructor(private readonly cli: string, private readonly cwd: string, private readonly env: NodeJS.ProcessEnv, private readonly spawnFn: SpawnFn = spawn as SpawnFn) {}

  start(): Promise<Hello> {
    if (this.starting) return this.starting;
    this.starting = new Promise<Hello>((resolve, reject) => {
      // argv only, no shell; stdin is the request pipe. stderr is drained (diagnostics only).
      const p = this.spawnFn(this.cli, ['dashboard', '--serve-stdio'], { cwd: this.cwd, env: this.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.proc = p;
      let first = true;
      let buf = '';
      const fail = (e: Error) => { this.starting = null; reject(e); };
      const timer = setTimeout(() => { if (first) { fail(new Error(UPDATE_TEXT)); p.kill(); } }, HELLO_TIMEOUT_MS);
      p.stderr?.on('data', () => { /* diagnostics only */ });
      p.stdout?.on('data', (b: Buffer) => {
        buf += b.toString('utf8');
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let o: unknown;
          try { o = JSON.parse(line); } catch { continue; }
          if (first) {
            first = false;
            clearTimeout(timer);
            const h = checkHello(o);
            if (typeof h === 'string') { fail(new Error(h)); p.kill(); return; }
            this.hello = h;
            resolve(h);
            continue;
          }
          if (!plain(o) || !Number.isSafeInteger(o.id)) continue;
          const w = this.pending.get(o.id as number);
          if (!w) continue;
          this.pending.delete(o.id as number);
          clearTimeout(w.timer);
          w.done({ status: typeof o.status === 'number' ? o.status : 500, json: o.json });
        }
      });
      p.on('error', (e) => { clearTimeout(timer); if (first) { first = false; fail(e); } });
      p.on('exit', (code) => {
        clearTimeout(timer);
        // An old prism-cli exits at once on the unknown option: say update, not "crashed".
        if (first) { first = false; fail(new Error(UPDATE_TEXT + (code ? ` (prism-cli exited ${code})` : ''))); }
        for (const [, w] of this.pending) { clearTimeout(w.timer); w.done({ status: 503, json: { error: 'prism-cli stopped; it restarts on the next request' } }); }
        this.pending.clear();
        if (this.proc === p) { this.proc = null; this.starting = null; this.catalog = null; }
      });
    });
    return this.starting;
  }

  /** Relays one checked request. The webview's id stays with the webview; the child gets its own. */
  async request(r: Omit<UiRequest, 'id'>): Promise<UiAnswer> {
    if (this.disposed) return { status: 503, json: { error: 'the panel was closed' } };
    if (!this.proc) {
      try { await this.start(); } catch (e) { return { status: 503, json: { error: (e as Error).message } }; }
    }
    const proc = this.proc;
    if (!proc?.stdin) return { status: 503, json: { error: 'prism-cli is not running; reopen the panel' } };
    const id = ++this.seq;
    return new Promise((done) => {
      const timer = setTimeout(() => { this.pending.delete(id); done({ status: 504, json: { error: 'prism-cli did not answer in time' } }); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { done, timer });
      const msg: Record<string, unknown> = { id, op: r.op, path: r.path };
      if (r.op === 'get') msg.query = r.query ?? {}; else msg.body = r.body;
      proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  /** The CLI's action catalog, read once per child from GET /api/setup. null when it cannot be read. */
  async loadCatalog(): Promise<Catalog | null> {
    if (this.catalog) return this.catalog;
    const a = await this.request({ op: 'get', path: '/api/setup', query: {} });
    this.catalog = a.status === 200 ? catalogFrom(a.json) : null;
    return this.catalog;
  }

  dispose(): void {
    this.disposed = true;
    const p = this.proc;
    this.proc = null;
    // Closing stdin is the stop signal: the CLI stops a running action and exits. Killed if it has not after 2 s.
    if (p) { p.stdin?.end(); setTimeout(() => { if (p.exitCode === null && p.signalCode === null) p.kill(); }, 2000).unref(); }
  }
}

/**
 * The webview document: the bundle by webview URI (inside localResourceRoots = the CLI's uiDir), a
 * nonce'd bridge and UI script, nothing remote, no inline handler. body is the CLI's static markup
 * (body.html: no data, no token). theme: from the editor's colour theme.
 */
export function uiHtml(o: { nonce: string; cspSource: string; cssUri: string; bridgeUri: string; jsUri: string; body: string; theme: 'light' | 'dark' }): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(o.nonce)) throw new Error('bad nonce');
  const csp = [`default-src 'none'`, `script-src 'nonce-${o.nonce}'`, `style-src ${o.cspSource}`, `img-src ${o.cspSource} data:`, `font-src ${o.cspSource}`, `connect-src 'none'`, `base-uri 'none'`, `form-action 'none'`].join('; ');
  return `<!DOCTYPE html>
<html lang="en" data-theme="${o.theme === 'light' ? 'light' : 'dark'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${o.cssUri}">
<title>PRISM</title>
</head>
<body><div class="wrap">${o.body}</div>
<script nonce="${o.nonce}" src="${o.bridgeUri}"></script>
<script nonce="${o.nonce}" src="${o.jsUri}"></script>
</body>
</html>`;
}

/** The panel when prism-cli is missing or older than 1.21.0: the message and the command, nothing else. No script. */
export function updateHtml(o: { reason: string; command: string }): string {
  const e = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const csp = `default-src 'none'; style-src 'unsafe-inline'`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>PRISM</title>
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:720px}code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:2px 6px;border-radius:4px;user-select:all}</style></head>
<body><h2>Update prism-cli to ${MIN_CLI_VERSION} or later</h2>
<p>${e(o.reason)}</p>
<p>Run this in a terminal, then reopen the PRISM panel:</p>
<p><code>${e(o.command)}</code></p></body></html>`;
}

/** A CSP for the CLI-rendered report: its inline styles only, no script, nothing remote. */
export const REPORT_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:`;

export function withReportCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`;
  const m = /<head[^>]*>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + meta + html.slice(m.index + m[0].length) : `<!DOCTYPE html><html><head>${meta}</head><body>${html}</body></html>`;
}
