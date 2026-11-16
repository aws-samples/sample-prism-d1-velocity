/**
 * `prism-cli dashboard --serve-stdio`: the dashboard API as JSON lines on
 * stdin/stdout, for hosts that own this process (the VS Code extension host,
 * the Kiro Crew app backend). There is no listener: only the parent that
 * spawned the process can talk to it, so there is no token, cookie or Origin
 * to check. The parent is already able to run any prism-cli command itself;
 * what this mode adds is that the UI it embeds can reach ONLY the routes the
 * browser page can reach, through the same handlers (api-core.ts).
 *
 * Protocol (one JSON object per line, UTF-8):
 *   first line out:  {"hello":"prism.dashboard.stdio","api":1,"version":"1.21.0","uiDir":"/abs/dist/ui","routes":{"get":[...],"act":[...]}}
 *   request in:      {"id":1,"op":"get","path":"/api/data","query":{"fresh":"1"}}
 *                    {"id":2,"op":"act","path":"/api/action","body":{"action":"aws-disconnect","confirm":true}}
 *   response out:    {"id":1,"status":200,"json":{...}}
 * Requests run concurrently and answer by id. A malformed request answers 400
 * (with its id when it has one); nothing it carries is turned into a path,
 * argv or code: `path` is only looked up as an exact key of the route table.
 */
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { ApiAnswer, MAX_BODY } from './server.js';
import type { DashboardApi } from './api-core.js';

export const STDIO_PROTOCOL = 'prism.dashboard.stdio';
/** Bumped when a request or response shape changes incompatibly; hosts refuse a lower one and say "update prism-cli". */
export const STDIO_API = 1;
/** A request line: a 16 KB body (server.ts MAX_BODY) plus the envelope. A longer line is dropped unread and answered 413. */
export const MAX_LINE = MAX_BODY + 4096;
const MAX_QUERY_KEYS = 16;
const MAX_QUERY_VALUE = 512;

/** dist/ui beside dist/src/dashboard: the shared UI bundle (scripts/build-ui.mjs). */
export function uiDir(): string {
  return fileURLToPath(new URL('../../ui/', import.meta.url));
}

export interface StdioReply { id: number | null; status: number; json: unknown }

const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** One request, answered by the same handlers server.ts calls. Never throws. */
export async function dispatch(api: DashboardApi, raw: unknown): Promise<StdioReply> {
  const id = plainObject(raw) && Number.isSafeInteger(raw.id) ? (raw.id as number) : null;
  const bad = (error: string, status = 400): StdioReply => ({ id, status, json: { error } });
  if (!plainObject(raw) || id === null) return bad('expected {id, op, path}');
  const extra = Object.keys(raw).filter((k) => !['id', 'op', 'path', 'query', 'body'].includes(k));
  if (extra.length) return bad(`unexpected field ${extra[0]}`);
  if (typeof raw.path !== 'string' || raw.path.length > 200 || !raw.path.startsWith('/api/')) return bad('path must be an /api/ route');
  try {
    if (raw.op === 'get') {
      if (raw.body !== undefined) return bad('a get takes no body');
      const handler = own(api.getApi, raw.path);
      if (!handler) return bad('unknown route', 404);
      const url = new URL(raw.path, 'http://stdio.invalid');
      if (raw.query !== undefined) {
        if (!plainObject(raw.query)) return bad('query must be an object of strings');
        const entries = Object.entries(raw.query);
        if (entries.length > MAX_QUERY_KEYS) return bad('too many query parameters');
        for (const [k, v] of entries) {
          if (typeof v !== 'string' || v.length > MAX_QUERY_VALUE) return bad('query values must be strings');
          url.searchParams.set(k, v);
        }
      }
      const out = await handler(url);
      return out instanceof ApiAnswer ? { id, status: out.status, json: out.json } : { id, status: 200, json: out };
    }
    if (raw.op === 'act') {
      if (raw.query !== undefined) return bad('an act takes no query');
      const handler = own(api.postApi, raw.path);
      if (!handler) return bad('unknown route', 404);
      const r = await handler(raw.body);
      return { id, status: r.status, json: r.json };
    }
    return bad('op must be get or act');
  } catch (e) {
    process.stderr.write(`prism dashboard (stdio): request failed: ${(e as Error)?.message || e}\n`);
    return { id, status: 500, json: { error: 'internal error' } };
  }
}

export interface StdioInfo { version: string }

/** At most this many requests at once; more answer 429 (the UI makes about 8 per load). */
export const MAX_INFLIGHT = 32;

/**
 * Splits `input` into lines without ever holding more than MAX_LINE bytes: an oversized line is
 * dropped as it streams in (one 413 for it), never buffered whole.
 */
function lines(input: Readable, onLine: (line: string) => void, onOversized: () => void, onEnd: () => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;
  input.on('data', (chunk: Buffer | string) => {
    let b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (;;) {
      const nl = b.indexOf(0x0a);
      const piece = nl < 0 ? b : b.subarray(0, nl);
      if (!dropping) {
        size += piece.length;
        if (size > MAX_LINE) { dropping = true; parts = []; onOversized(); } else parts.push(piece);
      }
      if (nl < 0) return;
      if (!dropping) onLine(Buffer.concat(parts).toString('utf8'));
      parts = []; size = 0; dropping = false;
      b = b.subarray(nl + 1);
    }
  });
  // A last request with no newline is still a request.
  const end = () => { if (!dropping && size) { const line = Buffer.concat(parts).toString('utf8'); parts = []; size = 0; onLine(line); } onEnd(); };
  input.on('end', end);
  input.on('close', end);
}

/** Serves until `input` ends. stdout carries the protocol only; diagnostics go to stderr. */
export function serveStdio(api: DashboardApi, input: Readable, output: Writable, info: StdioInfo): Promise<void> {
  const write = (o: unknown): void => { output.write(JSON.stringify(o) + '\n'); };
  write({
    hello: STDIO_PROTOCOL, api: STDIO_API, version: info.version, uiDir: uiDir(),
    routes: { get: Object.keys(api.getApi).sort(), act: Object.keys(api.postApi).sort() },
  });
  const inflight = new Set<Promise<void>>();
  return new Promise((resolve) => {
    let ended = false;
    // The host closed our stdout (EPIPE): nobody can read answers any more, so stop serving instead of crashing.
    output.on('error', () => { if (!ended) { ended = true; resolve(); } });
    lines(input, (line) => {
      if (!line.trim()) return;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { write({ id: null, status: 400, json: { error: 'invalid JSON' } }); return; }
      if (inflight.size >= MAX_INFLIGHT) {
        const id = msg && typeof msg === 'object' && Number.isSafeInteger((msg as { id?: unknown }).id) ? (msg as { id: number }).id : null;
        write({ id, status: 429, json: { error: 'too many requests at once' } });
        return;
      }
      const p = dispatch(api, msg).then((r) => { write(r); }, () => {});
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }, () => write({ id: null, status: 413, json: { error: 'request too large' } }), () => {
      if (ended) return;
      ended = true;
      Promise.allSettled([...inflight]).then(() => resolve());
    });
  });
}
