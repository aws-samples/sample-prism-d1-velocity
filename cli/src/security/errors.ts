/**
 * Turns AWS CLI failures into messages a developer can act on.
 *
 * Three cases get their own wording because the raw CLI output does not say
 * what to do: no usable credentials, an AWS CLI too old to know the
 * `securityagent` commands, and an AccessDenied (which API, and which IAM
 * action it needed). Everything printed goes through redact() first, so a
 * credential that ends up in an error string is never echoed.
 */

/** First AWS CLI release with the Security Agent code review commands (matches the CI eval gate's check). */
export const MIN_AWS_CLI = [2, 36] as const;
export const MIN_AWS_CLI_TEXT = `v${MIN_AWS_CLI.join('.')}`;

export const NO_CREDENTIALS_MESSAGE = 'Failed to get account ID. Check your AWS credentials.';

const CREDENTIAL_ERRORS = /Unable to locate credentials|could not be found|ExpiredToken|InvalidClientTokenId|SignatureDoesNotMatch|Token has expired|The SSO session|NoCredentialProviders|Error loading SSO Token|security token included in the request is (invalid|expired)/i;
const ACCESS_DENIED = /AccessDenied|UnauthorizedOperation|not authorized to perform|UnauthorizedException/i;
const UNKNOWN_COMMAND = /invalid choice/i;

/** Removes anything shaped like an AWS credential from text before it is printed. */
export function redact(text: string): string {
  return text
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted access key]')
    .replace(/(aws_secret_access_key|aws_session_token|SecretAccessKey|SessionToken)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2[redacted]')
    .replace(/(X-Amz-Security-Token|X-Amz-Signature|X-Amz-Credential)=[^&\s"']+/gi, '$1=[redacted]');
}

/** `list-agent-spaces` -> `ListAgentSpaces`. */
function pascal(cmd: string): string {
  return cmd.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

const SERVICE_PREFIX: Record<string, string> = { s3api: 's3', s3: 's3' };
const S3_ACTIONS: Record<string, string> = { 'head-object': 's3:GetObject', 'put-object': 's3:PutObject', cp: 's3:PutObject' };

/** The IAM action an `aws <service> <command>` call needs, derived from the argv. */
export function permissionFor(args: string[]): string {
  const [service = '', command = ''] = args;
  if (service === 's3api' || service === 's3') return S3_ACTIONS[command] ?? `s3:${pascal(command)}`;
  return `${SERVICE_PREFIX[service] ?? service}:${pascal(command)}`;
}

export type AwsErrorKind = 'no-credentials' | 'access-denied' | 'old-cli' | 'other';

export interface ExplainedError {
  kind: AwsErrorKind;
  /** One or more lines, already redacted. */
  message: string;
}

/**
 * Explains a failed `aws` call. `args` is the argv that failed (without
 * --region/--profile), `stderr` what the CLI printed, `cliVersion` the
 * `aws --version` output when known.
 */
export function explainAwsError(args: string[], stderr: string, cliVersion?: string | null): ExplainedError {
  const raw = redact((stderr || '').trim());
  const lastLine = raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';
  if (UNKNOWN_COMMAND.test(raw)) {
    return {
      kind: 'old-cli',
      message: `This AWS CLI does not have "aws ${args.slice(0, 2).join(' ')}". prism-cli enable security needs AWS CLI ${MIN_AWS_CLI_TEXT} or later`
        + `${cliVersion ? ` (found ${cliVersion.split(/\s+/)[0]})` : ''}. Install it from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html`,
    };
  }
  if (CREDENTIAL_ERRORS.test(raw)) {
    return {
      kind: 'no-credentials',
      message: `${NO_CREDENTIALS_MESSAGE}\n  ${lastLine}\n  Configure them with "aws configure" or "aws sso login", or pass --profile <name>.`,
    };
  }
  if (ACCESS_DENIED.test(raw)) {
    const op = /when calling the (\w+) operation/.exec(raw)?.[1] ?? pascal(args[1] || '');
    const action = /not authorized to perform:?\s+([\w-]+:[\w*]+)/.exec(raw)?.[1] ?? permissionFor(args);
    return {
      kind: 'access-denied',
      message: `AccessDenied: ${op} (aws ${args.slice(0, 2).join(' ')}) was refused. The caller needs the IAM permission ${action}.\n  ${lastLine}`,
    };
  }
  return { kind: 'other', message: `aws ${args.slice(0, 2).join(' ')} failed: ${lastLine}` };
}

/** Parses `aws --version` ("aws-cli/2.36.19 Python/...") and checks it against MIN_AWS_CLI. */
export function cliVersionOk(versionText: string | null): { ok: boolean; version: string | null } {
  const m = /aws-cli\/(\d+)\.(\d+)\.(\d+)/.exec(versionText || '');
  if (!m) return { ok: true, version: null }; // unknown: let the first securityagent call decide
  const [maj, min] = [Number(m[1]), Number(m[2])];
  const ok = maj > MIN_AWS_CLI[0] || (maj === MIN_AWS_CLI[0] && min >= MIN_AWS_CLI[1]);
  return { ok, version: `${m[1]}.${m[2]}.${m[3]}` };
}
