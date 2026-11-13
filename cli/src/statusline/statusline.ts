/**
 * `prism-cli statusline`: the Claude Code status line.
 *
 * Claude Code runs the command on every update and writes its status JSON
 * (https://code.claude.com/docs/en/statusline) to stdin. This prints one or
 * two lines:
 *
 *   PRISM <repo> · 2 high 1 med · today $34.08 · month $480
 *   session $1.20 · +156/−23 · ctx 42% · cache 91%
 *
 * It must be fast and never block, so it reads only two cached files: the
 * dashboard's usage cache (~/.prism/cache/usage.json) and the newest
 * pre-push review under .prism/results/ of the repo that contains
 * workspace.current_dir (found by walking up for .git, no git subprocess).
 * It never runs codeburn, git or anything else, and makes no network call.
 *
 * Imports are node built-ins only: every module loaded here is paid on each
 * status line update.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Same values as usage-cache.ts (USAGE_CACHE_SCHEMA, USAGE_TTL_MS); a test keeps them in step. */
export const USAGE_SCHEMA = 'prism.usage-cache.v1';
export const USAGE_TTL_MS = 5 * 60_000;
/** Same as results.ts RESULTS_DIR. */
export const RESULTS_SUBDIR = join('.prism', 'results');
export const REVIEW_SUFFIX = '-pre-push-review.json';
/** How far up from current_dir to look for .git. */
export const MAX_WALK_UP = 40;
/** Result files larger than this are not parsed (a status line must stay cheap). */
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const MAX_USAGE_BYTES = 1024 * 1024;
/** Longest repo or branch name printed. */
export const MAX_NAME_CHARS = 40;
export const DEFAULT_COLUMNS = 120;
export const USAGE_HINT = 'usage: run prism-cli dashboard';

const SEP = ' · ';

// ------------------------------------------------------------ text safety

/**
 * Removes C0/C1 control characters (ESC, BEL, CR, LF, DEL and 0x80-0x9f) and
 * bidi overrides, so text from result files or paths cannot inject escape
 * sequences into the terminal. Result files hold reviewer-model output.
 */
export function stripControl(s: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

const clip = (s: string, n: number) => {
  const cps = [...s];
  return cps.length > n ? cps.slice(0, n - 1).join('') + '…' : s;
};

/** Visible width: ANSI SGR and OSC 8 sequences removed, one column per code point. */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return [...s.replace(/\u001b\]8;;[^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;]*m/g, '')].length;
}

// ------------------------------------------------------------ input

export interface StatusInput {
  cwd: string | null;
  sessionCost: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  ctxPct: number | null;
  cacheHit: number | null;
  model: string | null;
  sessionId: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The fields this uses from Claude Code's status JSON; null when stdin is not a JSON object. */
export function parseInput(raw: string): StatusInput | null {
  let j: any; // any: untrusted JSON, every field is checked below.
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = (v: unknown): any => (v && typeof v === 'object' ? v : {});
  const cwd = str(o(j.workspace).current_dir) ?? str(j.cwd);
  return {
    cwd: cwd && isAbsolute(cwd) ? cwd : null,
    sessionCost: num(o(j.cost).total_cost_usd),
    linesAdded: num(o(j.cost).total_lines_added),
    linesRemoved: num(o(j.cost).total_lines_removed),
    ctxPct: num(o(j.context_window).used_percentage),
    cacheHit: num(o(j.prompt_cache).hit_ratio),
    model: str(o(j.model).display_name),
    sessionId: str(j.session_id),
  };
}

// ------------------------------------------------------------ cached files

export interface UsageInfo {
  state: 'fresh' | 'stale' | 'missing';
  path: string;
  currency: string;
  today: number | null;
  month: number | null;
  /** Age of the cache in ms; null when missing. */
  ageMs: number | null;
}

/** Local YYYY-MM-DD, as usage.ts localDate. */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readSmall(file: string, max: number): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

/**
 * Today's spend from the dashboard's usage cache. A cache from an earlier day
 * counts as missing, as in UsageCache.peek.
 * shortcut: a cache younger than the TTL is taken as today's without the local
 * date check, because the first local-time call loads the time zone (about
 * 6 ms, an eighth of the budget). Up to 5 minutes after midnight it can show
 * yesterday's "today"; do the check always if that matters more than 6 ms.
 */
export function readUsage(home: string, now: Date): UsageInfo {
  const path = join(home, '.prism', 'cache', 'usage.json');
  const missing: UsageInfo = { state: 'missing', path, currency: 'USD', today: null, month: null, ageMs: null };
  const raw = readSmall(path, MAX_USAGE_BYTES);
  if (raw === null) return missing;
  let c: any; // any: local JSON, checked below.
  try { c = JSON.parse(raw); } catch { return missing; }
  const p = c?.panel;
  if (c?.schema !== USAGE_SCHEMA || typeof c.savedAt !== 'number' || !p || (p.status !== 'ok' && p.status !== 'no-data')) return missing;
  const ageMs = Math.max(0, now.getTime() - c.savedAt);
  const stale = ageMs >= USAGE_TTL_MS;
  if (stale && c.day !== localDay(now)) return missing;
  return {
    state: stale ? 'stale' : 'fresh',
    path,
    currency: typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? p.currency : 'USD',
    today: num(p.today?.cost) ?? 0,
    month: num(p.month?.cost) ?? 0,
    ageMs,
  };
}

/** The repo top level containing `dir` (the nearest parent with .git), and its .git path. */
export function findRepo(dir: string): { top: string; gitPath: string } | null {
  let d = resolve(dir);
  for (let i = 0; i < MAX_WALK_UP; i++) {
    const g = join(d, '.git');
    try { statSync(g); return { top: d, gitPath: g }; } catch { /* keep walking */ }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** The checked-out branch from .git/HEAD (worktrees: the gitdir file), without running git; null when detached or unreadable. */
export function readBranch(gitPath: string): string | null {
  let head = readSmall(join(gitPath, 'HEAD'), 4096);
  if (head === null) {
    const link = readSmall(gitPath, 4096);
    const m = link && /^gitdir:\s*(.+)$/m.exec(link);
    if (!m) return null;
    const gd = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dirname(gitPath), m[1].trim());
    head = readSmall(join(gd, 'HEAD'), 4096);
  }
  const m = head && /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  return m ? m[1].trim() : null;
}

export interface ReviewInfo {
  file: string;
  status: string;
  branch: string | null;
  /** The review is for another branch than the one checked out. */
  otherBranch: boolean;
  high: number;
  medium: number;
  low: number;
}

/** `<id>-<20261112T120000000Z>-pre-push-review.json` -> the timestamp, for ordering newest first. */
const stampOf = (name: string) => /-(\d{8}T\d+Z)-pre-push-review\.json$/.exec(name)?.[1] ?? '';

function parseReview(file: string): any | null {
  const raw = readSmall(file, MAX_RESULT_BYTES);
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw);
    return r && typeof r === 'object' && r.kind === 'review' ? r : null;
  } catch { return null; }
}

/**
 * The newest pre-push review of the checked-out branch, else the newest
 * review of any branch (flagged otherBranch). Files are ordered by the
 * timestamp in their names; only the files needed are parsed.
 */
export function readReview(top: string, branch: string | null): ReviewInfo | null {
  const dir = join(top, RESULTS_SUBDIR);
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(REVIEW_SUFFIX)); } catch { return null; }
  names.sort((a, b) => (stampOf(b) < stampOf(a) ? -1 : stampOf(b) > stampOf(a) ? 1 : 0));
  let fallback: { file: string; r: any } | null = null;
  for (const n of names) {
    const file = join(dir, n);
    const r = parseReview(file);
    if (!r) continue;
    if (!fallback) fallback = { file, r };
    if (!branch || r.branch === branch) return toReview(file, r, false);
  }
  return fallback ? toReview(fallback.file, fallback.r, true) : null;
}

function toReview(file: string, r: any, otherBranch: boolean): ReviewInfo {
  const c = { high: 0, medium: 0, low: 0 };
  for (const f of Array.isArray(r.findings) ? r.findings : []) {
    if (f && Object.hasOwn(c, f.severity)) c[f.severity as keyof typeof c]++;
  }
  return { file, status: stripControl(r.status), branch: typeof r.branch === 'string' ? clip(stripControl(r.branch), MAX_NAME_CHARS) : null, otherBranch, ...c };
}

// ------------------------------------------------------------ render

export interface RenderOptions {
  color: boolean;
  columns: number;
  session: boolean;
  /** OSC 8 link on the findings segment to the review's result file. */
  links: boolean;
}

export interface Segment {
  /** Lower is kept longer; the repo segment (0) is never dropped. */
  priority: number;
  text: string;
  plain: string;
}

export interface StatusModel {
  repo: string | null;
  branch: string | null;
  review: ReviewInfo | null;
  usage: UsageInfo;
  input: StatusInput | null;
  rows: { segments: Segment[]; dropped: string[]; line: string }[];
}

const SGR = { red: '31', amber: '33', green: '32', dim: '2', bold: '1' } as const;

function paint(on: boolean, code: string, s: string): string {
  return on ? `\u001b[${code}m${s}\u001b[0m` : s;
}

function link(on: boolean, file: string, s: string): string {
  // pathToFileURL percent-encodes, so the URL holds no control characters.
  return on ? `\u001b]8;;${pathToFileURL(file).href}\u0007${s}\u001b]8;;\u0007` : s;
}

function money(n: number, cur: string): string {
  const sym = cur === 'USD' ? '$' : `${cur} `;
  return n >= 100 ? `${sym}${Math.round(n)}` : `${sym}${n.toFixed(2)}`;
}

const seg = (priority: number, text: string, plain = text): Segment => ({ priority, text, plain });

function reviewSegment(r: ReviewInfo, o: RenderOptions): Segment {
  const on = o.color;
  let text: string;
  let plain: string;
  if (r.status === 'error') { plain = 'review failed'; text = paint(on, SGR.red, plain); }
  else if (r.status === 'skipped') { plain = 'review skipped'; text = paint(on, SGR.dim, plain); }
  else if (!r.high && !r.medium && !r.low) { plain = 'clean'; text = paint(on, SGR.green, plain); }
  else {
    const parts: [number, string, string][] = [[r.high, 'high', SGR.red], [r.medium, 'med', SGR.amber], [r.low, 'low', SGR.dim]];
    const shown = parts.filter(([n]) => n > 0);
    plain = shown.map(([n, w]) => `${n} ${w}`).join(' ');
    text = shown.map(([n, w, c]) => paint(on, c, `${n} ${w}`)).join(' ');
  }
  if (r.otherBranch && r.branch) { plain += ` (${r.branch})`; text += paint(on, SGR.dim, ` (${r.branch})`); }
  return seg(1, link(o.links, r.file, text), plain);
}

/** Drops the highest-priority-number segments until the line fits `columns`. */
export function fit(segments: Segment[], columns: number): { line: string; kept: Segment[]; dropped: string[] } {
  const kept = [...segments];
  const dropped: string[] = [];
  const width = (s: Segment[]) => s.reduce((w, x, i) => w + visibleWidth(x.text) + (i ? SEP.length : 0), 0);
  while (kept.length > 1 && width(kept) > columns) {
    let worst = 0;
    for (let i = 1; i < kept.length; i++) if (kept[i].priority >= kept[worst].priority) worst = i;
    if (kept[worst].priority === 0) break;
    dropped.push(kept[worst].plain);
    kept.splice(worst, 1);
  }
  return { line: kept.map((s) => s.text).join(SEP), kept, dropped };
}

export function buildModel(input: StatusInput | null, deps: { home: string; now: Date }, o: RenderOptions): StatusModel {
  const usage = readUsage(deps.home, deps.now);
  const repoRef = input?.cwd ? findRepo(input.cwd) : null;
  const branch = repoRef ? readBranch(repoRef.gitPath) : null;
  const review = repoRef ? readReview(repoRef.top, branch) : null;
  const repo = repoRef ? clip(stripControl(basename(repoRef.top)), MAX_NAME_CHARS) : null;
  const on = o.color;

  const top: Segment[] = [seg(0, paint(on, SGR.bold, 'PRISM') + (repo ? ` ${repo}` : ''), `PRISM${repo ? ` ${repo}` : ''}`)];
  if (review) top.push(reviewSegment(review, o));
  if (usage.state === 'missing') {
    top.push(seg(3, paint(on, SGR.dim, USAGE_HINT), USAGE_HINT));
  } else {
    const stale = usage.state === 'stale';
    const t = `today ${money(usage.today ?? 0, usage.currency)}`;
    const m = `month ${money(usage.month ?? 0, usage.currency)}`;
    top.push(seg(2, stale ? paint(on, SGR.dim, t) : t, t), seg(3, stale ? paint(on, SGR.dim, m) : m, m));
    if (stale) top.push(seg(4, paint(on, SGR.dim, USAGE_HINT), USAGE_HINT));
  }
  const rows = [fit(top, o.columns)];

  if (o.session && input) {
    const s: Segment[] = [];
    if (input.sessionCost !== null) s.push(seg(0, `session ${money(input.sessionCost, 'USD')}`));
    if (input.linesAdded !== null || input.linesRemoved !== null) {
      const a = `+${input.linesAdded ?? 0}`, r = `−${input.linesRemoved ?? 0}`;
      s.push(seg(1, `${paint(on, SGR.green, a)}/${paint(on, SGR.red, r)}`, `${a}/${r}`));
    }
    if (input.ctxPct !== null) {
      const pct = Math.round(input.ctxPct);
      const t = `ctx ${pct}%`;
      s.push(seg(2, pct >= 80 ? paint(on, SGR.red, t) : pct >= 60 ? paint(on, SGR.amber, t) : t, t));
    }
    if (input.cacheHit !== null) s.push(seg(3, `cache ${Math.round(input.cacheHit * 100)}%`));
    if (input.model) { const t = clip(stripControl(input.model), MAX_NAME_CHARS); s.push(seg(4, paint(on, SGR.dim, t), t)); }
    if (s.length) {
      // Every session segment can be dropped except the first.
      s[0] = { ...s[0], priority: 0 };
      rows.push(fit(s, o.columns));
    }
  }
  return {
    repo, branch: branch ? clip(stripControl(branch), MAX_NAME_CHARS) : null, review, usage, input,
    rows: rows.map((r) => ({ segments: r.kept, dropped: r.dropped, line: r.line })),
  };
}

// ------------------------------------------------------------ run

/** Reads stdin without blocking: a TTY or no data within `timeoutMs` gives ''. */
export function readStdin(timeoutMs: number, max = 256 * 1024): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      done(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c: Buffer) => { size += c.length; if (size <= max) chunks.push(c); else finish(); });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

export interface RunOptions { session?: boolean; json?: boolean }

export interface RunDeps {
  stdin: string;
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  write: (s: string) => void;
}

/** One status update. Never throws: on any failure it prints "PRISM". */
export function runStatusline(opts: RunOptions, d: RunDeps): void {
  const t0 = performance.now();
  try {
    const color = !('NO_COLOR' in d.env) || d.env.NO_COLOR === '';
    const cols = Number.parseInt(String(d.env.COLUMNS ?? ''), 10);
    const columns = Number.isFinite(cols) && cols > 0 ? cols : DEFAULT_COLUMNS;
    const input = d.stdin.trim() ? parseInput(d.stdin) : null;
    if (!input && !opts.json) { d.write('PRISM\n'); return; }
    const o: RenderOptions = { color: opts.json ? false : color, columns, session: opts.session !== false, links: !opts.json && color };
    const m = buildModel(input, { home: d.home, now: d.now }, o);
    if (opts.json) {
      d.write(JSON.stringify({
        input: input ? 'ok' : 'missing or not JSON',
        columns, color,
        repo: m.repo, branch: m.branch,
        review: m.review, usage: m.usage,
        rows: m.rows.map((r) => ({ line: r.line, segments: r.segments.map((s) => s.plain), dropped: r.dropped })),
        ms: Math.round((performance.now() - t0) * 100) / 100,
      }, null, 2) + '\n');
      return;
    }
    d.write(m.rows.map((r) => r.line).join('\n') + '\n');
  } catch {
    d.write('PRISM\n');
  }
}

/** Entry for bin/prism-cli.js's fast path and the commander action. */
export async function main(opts: RunOptions): Promise<void> {
  const stdin = await readStdin(STDIN_TIMEOUT_MS);
  runStatusline(opts, { stdin, env: process.env, home: homedir(), now: new Date(), write: (s) => process.stdout.write(s) });
}

/** Claude Code writes the JSON and closes stdin at once; this only guards a caller that leaves it open. */
export const STDIN_TIMEOUT_MS = 500;
