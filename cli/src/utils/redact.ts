/**
 * The one masking pass for text that leaves this machine's terminal: the dashboard's Action
 * output drawer, /api/accountguard check text, and aws connect --json errors.
 */

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * A 12-digit run that is an account id. Account ids appear in ARNs, `Account:` lines, account
 * fields (`"Account"`, `AccountId`, `--account-id`), CDK-style names (`...-<account>-<region>`)
 * and plain prose, so every 12-digit run is masked EXCEPT where its shape says it is an id the
 * user copies. Those are 12 digits only by chance (a hex prefix with no letter in it, about 1 in
 * 280 commits), and masking them breaks copy-paste:
 * - a git commit or tree prefix, as prism-cli prints it: `HEAD <12>`, `commit <12>`, `job <12>`,
 *   `repo at <12>`, `<upstream>...<12>`, `.../local/<12>-<12>.patch`, `threat-model/<slug>/<12>`;
 * - a result id or threat-model title: `<12>-<compact UTC time>` (`123456789012-20261115T123406301Z-...`);
 * - the last group of a UUID (Security Agent and other AWS ids);
 * - a JSON id field (`"id"`, `"job_id"`, `"codeReviewJobId"`, `"commit"`, ...).
 * shortcut: the exempt shapes are the ones prism-cli prints today; a new id printed bare gets masked
 * (the safe side), so add its shape here when one shows up.
 */
const ACCOUNT_ID_RE = new RegExp(
  String.raw`(?<!(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-|\b(?:HEAD|commit|job|repo at)\s+|\.\.\.|/local/|threat-model/[^/\s]+/|"(?:id|job_id|jobId|codeReviewJobId|code_review_id|codeReviewId|findingId|threatModelId|commit|lastReviewId|run_id)"\s*:\s*"))`
  + String.raw`\b\d{12}\b(?!-\d{8}T\d+Z|\.patch\b)`,
  'gi',
);

/** The 12-digit runs in `text` that redact masks as account ids (for tests and leak checks). */
export function accountIdsIn(text: string): string[] {
  return text.match(ACCOUNT_ID_RE) ?? [];
}

/**
 * Masks secrets in command output: AWS key ids, key=value secrets, bearer
 * tokens, JWTs, URL userinfo and token-like query parameters.
 * shortcut: pattern-based, so an unusual secret format can slip through; add its pattern when one is seen.
 */
export function redact(s: string): string {
  return s
    .replace(ANSI_RE, '')
    // A 12-digit AWS account id (aws check, aws connect and ARNs print it) leaves as its last 4 digits, as the pages show it;
    // a commit prefix, result id or UUID that happens to be 12 digits stays whole (ACCOUNT_ID_RE).
    .replace(ACCOUNT_ID_RE, (m) => '••••' + m.slice(-4))
    // An assumed-role ARN keeps its role name; the session name (often a user name or email) is dropped.
    .replace(/(:assumed-role\/[\w+=,.@-]+)\/[^\s"',)]+/g, '$1/…')
    .replace(/\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b((?:aws_)?(?:secret_access_key|session_token|security_token|secret|password|passwd|api[_-]?key|access_token|refresh_token|id_token|client_secret)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&#](?:token|access_token|id_token|code|signature|sig|key|x-amz-[a-z-]+)=)[^&\s#"']+/gi, '$1[REDACTED]');
}

/**
 * `home` (an absolute directory) as `~`: followed by `/`, or on its own at the end of the text,
 * a line or before a space, quote or punctuation. A longer path that only starts with the same
 * characters (`/home/demo2`) is left alone.
 */
export function maskHome(text: string, home: string): string {
  if (!home || home === '/') return text;
  const h = home.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${h}(?=$|[/\\s"'\`),;:.!?\\]])`, 'gm'), '~');
}
