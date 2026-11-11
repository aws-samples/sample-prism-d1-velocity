/**
 * Findings and reasons are model output or file content: untrusted text.
 * Everything shown from them goes through plainText first.
 */

/** Longest finding text kept; reviewers occasionally return whole files. */
export const MAX_TEXT = 2000;

// C0/C1 controls (except tab and newline) and the bidi controls used to make text read differently from what it is.
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Controls and bidi overrides removed, length capped. Newlines are kept unless oneLine. */
export function plainText(s: unknown, opts: { oneLine?: boolean; max?: number } = {}): string {
  let t = (typeof s === 'string' ? s : s == null ? '' : String(s)).replace(/\r\n?/g, '\n').replace(UNSAFE, '');
  if (opts.oneLine) t = t.replace(/\s*\n\s*/g, ' ');
  const max = opts.max ?? MAX_TEXT;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** $12.40 for USD, else 12.40 EUR. */
export function money(n: number, currency: string): string {
  const v = n.toFixed(2);
  return currency === 'USD' ? `$${v}` : `${v} ${plainText(currency, { oneLine: true, max: 8 })}`;
}
