/**
 * Loopback-only HTTP server for `prism-cli dashboard`.
 *
 * Access control, all enforced on every request:
 *   - bound to 127.0.0.1 only (the host is a constant, not an option);
 *   - a per-run 256-bit random token, accepted once from `/?token=` and
 *     exchanged for an HttpOnly, SameSite=Strict cookie, then required as that
 *     cookie on every request (compared in constant time);
 *   - the Host header must be 127.0.0.1:<port> or localhost:<port>, which
 *     defeats DNS rebinding (a rebound name arrives with its own Host);
 *   - GET for every read route; no CORS headers; strict CSP.
 *   - POST only for the Setup page's action routes (postApi), and each POST
 *     also needs: an Origin (or, without one, a Referer) of this server; the
 *     per-run anti-CSRF token embedded in the page, in the X-Prism-CSRF header;
 *     and Content-Type application/json with a body of at most 16 KB.
 *
 * Why a minted token and not a platform auth mechanism: the server is
 * reachable only from this machine, the audience is the developer running it,
 * and the CLI ships as public sample code, so it uses the loopback-plus-token
 * pattern native to local developer tools (Jupyter, VS Code server) rather
 * than any hosted identity provider. It must never be bound beyond loopback.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { renderPage } from './page.js';
import { renderReportHtml, renderReportMarkdown, type ScanReport } from './report.js';

export const BIND_HOST = '127.0.0.1';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function cookieName(port: number): string {
  // Cookies are scoped by host, not port: two dashboards on different ports
  // would otherwise overwrite each other's cookie.
  return `prism_dash_${port}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function baseHeaders(nonce?: string): Record<string, string> {
  const csp = nonce
    ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    : "default-src 'none'; frame-ancestors 'none'";
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}, nonce?: string) {
  res.writeHead(status, { ...baseHeaders(nonce), 'Content-Type': type, ...extra });
  res.end(body);
}

export interface HandlerOptions {
  token: string;
  /** Per-run anti-CSRF token, embedded in the page and required on every POST. */
  csrf?: string;
  /** Read at request time: the real port is known only after listen(). */
  getPort: () => number;
  getPayload: () => Promise<unknown>;
  /**
   * Looks a report up by result id among the dashboard's repos. The id is
   * matched against directory listings only; it is never turned into a path.
   */
  getReport?: (id: string) => Promise<ScanReport | null>;
  /** Extra read-only JSON routes (GET), by exact path. */
  getApi?: Record<string, () => Promise<unknown>>;
  /** Action routes (POST only), by exact path; receive the parsed JSON body. */
  postApi?: Record<string, (body: unknown) => Promise<{ status: number; json: unknown }>>;
}

/** /report/<id> or /report/<id>.md; anything else (slashes, dots, %-escapes) does not match. */
const REPORT_ROUTE = /^\/report\/([A-Za-z0-9_-]{1,120})(\.md)?$/;

export const CSRF_HEADER = 'x-prism-csrf';
export const MAX_BODY = 16 * 1024;

const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined =>
  o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => {
      size += c.length;
      // Too big: stop buffering and answer 413 (sent with Connection: close); the rest is drained, not kept.
      if (size > MAX_BODY) { req.off('data', onData); req.resume(); resolve(null); return; }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The request's Origin, else its Referer, must be this server (either Host spelling). */
function sameOrigin(req: IncomingMessage, port: number): boolean {
  const allowed = [`http://${BIND_HOST}:${port}`, `http://localhost:${port}`];
  const origin = req.headers.origin;
  if (typeof origin === 'string') return allowed.includes(origin);
  const ref = req.headers.referer;
  return typeof ref === 'string' && allowed.some((a) => ref === a || ref.startsWith(a + '/'));
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));

export function createHandler(opts: HandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const port = opts.getPort();
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== `${BIND_HOST}:${port}` && host !== `localhost:${port}`) {
        return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden: unexpected Host header\n');
      }
      const url = new URL(req.url || '/', `http://${BIND_HOST}:${port}`);
      const post = own(opts.postApi, url.pathname);
      if (post ? req.method !== 'POST' : req.method !== 'GET') {
        return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed\n', { Allow: post ? 'POST' : 'GET' });
      }
      const name = cookieName(port);
      const cookie = readCookie(req, name);
      const cookieOk = cookie !== null && safeEqual(cookie, opts.token);

      // First load: exchange the URL token for the cookie, then drop it from the URL.
      const qToken = url.searchParams.get('token');
      if (!post && url.pathname === '/' && qToken !== null) {
        if (!safeEqual(qToken, opts.token)) return send(res, 401, 'text/plain; charset=utf-8', 'Unauthorized\n');
        return send(res, 303, 'text/plain; charset=utf-8', 'See Other\n', {
          Location: '/',
          'Set-Cookie': `${name}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!cookieOk) {
        return send(res, 401, 'text/plain; charset=utf-8', 'Unauthorized: open the URL printed by prism-cli dashboard\n');
      }

      if (post) {
        if (!sameOrigin(req, port)) return json(res, 403, { error: 'Forbidden: missing or foreign Origin' });
        const csrf = req.headers[CSRF_HEADER];
        if (!opts.csrf || typeof csrf !== 'string' || !safeEqual(csrf, opts.csrf)) return json(res, 403, { error: 'Forbidden: missing or wrong CSRF token' });
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') return json(res, 415, { error: 'Content-Type must be application/json' });
        const raw = await readBody(req);
        if (raw === null) return send(res, 413, 'application/json; charset=utf-8', JSON.stringify({ error: 'request body too large' }), { Connection: 'close' });
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
        const r = await post(body);
        return json(res, r.status, r.json);
      }

      if (url.pathname === '/') {
        const nonce = randomBytes(16).toString('base64');
        return send(res, 200, 'text/html; charset=utf-8', renderPage(nonce, opts.csrf), {}, nonce);
      }
      if (url.pathname === '/api/data') {
        const payload = await opts.getPayload();
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload));
      }
      const extra = own(opts.getApi, url.pathname);
      if (extra) return json(res, 200, await extra());
      const m = REPORT_ROUTE.exec(url.pathname);
      if (m && opts.getReport) {
        const report = await opts.getReport(m[1]);
        if (!report) return send(res, 404, 'text/plain; charset=utf-8', 'Report not found\n');
        if (m[2]) {
          return send(res, 200, 'text/markdown; charset=utf-8', renderReportMarkdown(report), {
            'Content-Disposition': `attachment; filename="codewatch-report-${m[1]}.md"`,
          });
        }
        const nonce = randomBytes(16).toString('base64');
        return send(res, 200, 'text/html; charset=utf-8',
          renderReportHtml(report, { nonce, links: { back: '/', markdown: `/report/${m[1]}.md` } }), {}, nonce);
      }
      return send(res, 404, 'text/plain; charset=utf-8', 'Not Found\n');
    } catch (e: any) {
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal Server Error\n');
      else res.end();
      process.stderr.write(`prism dashboard: request failed: ${e?.message || e}\n`);
    }
  };
}

export interface RunningServer {
  server: Server;
  port: number;
  token: string;
  csrf: string;
  url: string;
  close: () => Promise<void>;
}

export interface StartOptions {
  port?: number;
  token?: string;
  getPayload: () => Promise<unknown>;
  getReport?: (id: string) => Promise<ScanReport | null>;
  getApi?: HandlerOptions['getApi'];
  postApi?: HandlerOptions['postApi'];
}

/** Starts the server on 127.0.0.1. `port` 0 (default) picks a free port. */
export function startServer(opts: StartOptions): Promise<RunningServer> {
  const token = opts.token || newToken();
  const csrf = newToken();
  let port = 0;
  const server = createServer(createHandler({ token, csrf, getPort: () => port, getPayload: opts.getPayload, getReport: opts.getReport, getApi: opts.getApi, postApi: opts.postApi }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, BIND_HOST, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string' || addr.address !== BIND_HOST) {
        server.close();
        return reject(new Error(`refusing to serve: bound to ${JSON.stringify(addr)}, expected ${BIND_HOST}`));
      }
      port = addr.port;
      resolve({
        server, port, token, csrf,
        url: `http://${BIND_HOST}:${port}/?token=${token}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Memoises the payload for `ttlMs` and shares one in-flight build between requests. `invalidate()` forces the next build. */
export function cachedPayload(build: () => Promise<unknown>, ttlMs = 30_000): (() => Promise<unknown>) & { invalidate(): void } {
  let at = 0;
  let pending: Promise<unknown> | null = null;
  let value: unknown;
  const get = () => {
    if (value !== undefined && Date.now() - at < ttlMs) return Promise.resolve(value);
    if (!pending) {
      pending = build().then((v) => { value = v; at = Date.now(); return v; }).finally(() => { pending = null; });
    }
    return pending;
  };
  return Object.assign(get, { invalidate: () => { at = 0; } });
}
