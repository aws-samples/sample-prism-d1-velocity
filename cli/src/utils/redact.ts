/**
 * The one masking pass for text that leaves this machine's terminal: the dashboard's Action
 * output drawer, /api/accountguard check text, and aws connect --json errors.
 */

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * Masks secrets in command output: AWS key ids, key=value secrets, bearer
 * tokens, JWTs, URL userinfo and token-like query parameters.
 * shortcut: pattern-based, so an unusual secret format can slip through; add its pattern when one is seen.
 */
export function redact(s: string): string {
  return s
    .replace(ANSI_RE, '')
    // A 12-digit AWS account id (aws check, aws connect and ARNs print it) leaves as its last 4 digits, as the pages show it.
    .replace(/\b\d{12}\b/g, (m) => '••••' + m.slice(-4))
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
