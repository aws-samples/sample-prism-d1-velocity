import type { Finding, FindingCategory, Severity } from '../results.js';

export const REVIEWER_IDS = ['kiro', 'claude'] as const;
export type ReviewerId = typeof REVIEWER_IDS[number];

export function isReviewerId(v: unknown): v is ReviewerId {
  return typeof v === 'string' && (REVIEWER_IDS as readonly string[]).includes(v);
}

export interface ReviewRequest {
  repoRoot: string;
  /** Repo-relative path of the shared rule set (`.prism/review/rules.md`). */
  rulesPath: string;
  /** Contents of the rule set, for adapters that pass it inline. */
  rulesText: string;
  /** Absolute path of the diff file on disk. */
  diffPath: string;
  /** The diff text itself, for adapters that pass it inline. */
  diff: string;
  /** Requested model, if the team pinned one. */
  model?: string;
}

export interface Invocation {
  args: string[];
  /** Written to the child's stdin. */
  input?: string;
}

export interface ParsedReview {
  findings: Finding[];
  summary: string | null;
  score: number | null;
  /** Model the tool reported using, if its output says. */
  model: string | null;
}

/**
 * One adapter per reviewer tool. An adapter only builds argv and parses
 * output; running the process, timeouts and error handling are shared
 * (see runReview in index.ts), so adding a tool is one small file.
 */
export interface ReviewerAdapter {
  id: ReviewerId;
  /** Executable looked up on PATH. */
  binary: string;
  displayName: string;
  invocation(req: ReviewRequest): Invocation;
  /** Throws when the output holds no usable review. */
  parse(stdout: string): ParsedReview;
}

/** Output contract both adapters ask for. Matches the CI gate's JSON plus a `rule` field. */
export const OUTPUT_CONTRACT =
  'Output ONLY one JSON object, no prose and no code fences: ' +
  '{"findings":[{"file":"path","line":1,"severity":"high|medium|low","category":"security|correctness|performance|maintainability|reliability","rule":"name of the rule from the rules file","message":"str"}],"score":0.0,"summary":"str"}. ' +
  'Use an empty findings array when nothing applies.';

/** Strips ANSI escape sequences and carriage returns. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
}

/**
 * Finds the last balanced top-level JSON object in free text that parses and
 * has a `findings` array. Models wrap JSON in prose or fences; scanning for
 * balanced braces (string-aware) is more reliable than one greedy regex.
 */
export function extractReviewJson(text: string): any {
  const candidates: string[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { candidates.push(text.slice(start, i + 1)); break; }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (obj && Array.isArray(obj.findings)) return obj;
    } catch { /* try the next one */ }
  }
  throw new Error('no JSON object with a "findings" array in reviewer output');
}

function normSeverity(v: unknown): Severity {
  const s = String(v ?? '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'high';
  if (s === 'medium' || s === 'moderate') return 'medium';
  return 'low';
}

/** The rules file uses five categories; the result schema keeps two. */
function normCategory(v: unknown): FindingCategory {
  return String(v ?? '').toLowerCase().includes('secur') ? 'security' : 'quality';
}

function normLine(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Converts the model's JSON into the shared schema. Tolerates missing fields. */
export function normalizeReview(obj: any, model: string | null): ParsedReview {
  const findings: Finding[] = (obj.findings as any[])
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      severity: normSeverity(f.severity),
      category: normCategory(f.category),
      rule: String(f.rule || f.category || 'unspecified').slice(0, 200),
      file: String(f.file || ''),
      line: normLine(f.line),
      message: String(f.message || '').slice(0, 2000),
    }));
  const score = typeof obj.score === 'number' && Number.isFinite(obj.score) ? obj.score : null;
  const summary = typeof obj.summary === 'string' ? obj.summary.slice(0, 500) : null;
  return { findings, summary, score, model };
}
