/**
 * `prism-cli team`: platform-team helpers for the PRISM metrics stack.
 *
 *   team info            READ-ONLY. describe-stacks on the metrics stack; prints
 *                        OtelCollectorUrl and OtelUserPoolId.
 *   team add-developer   AWS WRITE. One Cognito AdminCreateUser (username = the
 *                        developer's email, as in README step 2), after the plan
 *                        is shown and confirmed. Cognito emails the invite; the
 *                        temporary password is never requested, printed, logged
 *                        or stored here.
 *
 * Same AWS resolution as the other AWS commands (aws connect precedence,
 * --profile / --region), through the AWS CLI with an argv array (no shell).
 */
import { aws, type AwsResult, type AwsTarget } from '../utils/aws.js';
import { NO_REGION_MESSAGE, credentialSource, resolveRegion, PIPELINE_STACK, type SecurityOptions } from '../security/setup.js';
import { accountChangeWarning } from './connection.js';
import { SETUP_DOCS } from '../utils/sync-mode.js';

export const TEAM_INFO_NOTICE = 'Read-only (team info): one describe-stacks call and an identity check; nothing in AWS is changed.';
export const ADD_DEVELOPER_NOTICE = 'AWS write (team add-developer): creates one Cognito user after you confirm; nothing else in AWS is changed.';
export const INFO_PERMISSIONS = 'cloudformation:DescribeStacks';
export const ADD_PERMISSIONS = 'cloudformation:DescribeStacks (unless --user-pool-id) and cognito-idp:AdminCreateUser';

/**
 * shortcut: a practical shape check, not RFC 5322; Cognito does its own validation on create.
 * ',' and '=' are rejected too: they are separators in AWS CLI shorthand (attributes are also passed as JSON).
 * A leading '-' is rejected so the value can never be read as an AWS CLI option.
 */
export const EMAIL_RE = /^(?!-)[^\s@<>"'`;|&$\\,=]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const POOL_RE = /^[\w-]+_[0-9a-zA-Z]+$/;
const ACCESS_DENIED = /AccessDenied|UnauthorizedOperation|NotAuthorized/;

export interface TeamOptions extends Pick<SecurityOptions, 'profile' | 'region' | 'profileSource' | 'connection'> {
  json?: boolean;
}
export interface AddDeveloperOptions extends TeamOptions {
  email?: string;
  userPoolId?: string;
  yes?: boolean;
  dryRun?: boolean;
}

export interface TeamDeps {
  env: NodeJS.ProcessEnv;
  configRegion(profile?: string): string | null;
  isTTY: boolean;
  ask(q: string): Promise<string>;
  log(line?: string): void;
  err(line?: string): void;
}

export interface StackInfo { account: string; region: string; stack: string; otelCollectorUrl: string | null; otelUserPoolId: string | null }

const lastLine = (r: AwsResult) => r.errorCode || r.raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';

interface Target { target: AwsTarget; account: string; region: string }

/** Region, identity and the header lines. Returns null after printing the error. */
function resolveTarget(o: TeamOptions, d: TeamDeps, say: (l?: string) => void): Target | null {
  const r = resolveRegion(o, d);
  if (!r) { say(`Error: ${NO_REGION_MESSAGE} Or save one with prism-cli aws connect.`); return null; }
  const target: AwsTarget = { profile: o.profile, env: { AWS_PAGER: '', AWS_REGION: r.region, AWS_DEFAULT_REGION: r.region } };
  const who = aws(['sts', 'get-caller-identity'], target);
  const account = who.ok ? String(who.json?.Account || '') : '';
  if (!account) {
    say(`Error: cannot resolve the AWS identity: ${lastLine(who)}. Sign in (e.g. aws sso login), pass --profile, or run prism-cli aws connect.`);
    return null;
  }
  say(`Account:     ${account}`);
  say(`Region:      ${r.region} (${r.source})`);
  say(`Credentials: ${credentialSource(o, d.env)}`);
  const w = accountChangeWarning(o.connection, account);
  if (w) say(w);
  say('');
  return { target, account, region: r.region };
}

/** The metrics stack's OTEL outputs, or an error line. */
function readStack(t: Target): StackInfo | { error: string } {
  const r = aws(['cloudformation', 'describe-stacks', '--stack-name', PIPELINE_STACK, '--region', t.region], t.target);
  if (!r.ok) {
    if (/does not exist/.test(r.raw)) return { error: `${PIPELINE_STACK} is not deployed in account ${t.account}, ${t.region}. Deploy it first (infra/: npx cdk deploy --all); see ${SETUP_DOCS.platformTeamGuide}` };
    if (ACCESS_DENIED.test(r.errorCode || r.raw)) return { error: `access denied reading ${PIPELINE_STACK} (${lastLine(r)}). team info needs ${INFO_PERMISSIONS}.` };
    return { error: `cannot read ${PIPELINE_STACK}: ${lastLine(r)}. team info needs ${INFO_PERMISSIONS}.` };
  }
  const outputs: { OutputKey?: string; OutputValue?: unknown }[] = r.json?.Stacks?.[0]?.Outputs || [];
  const out = (k: string) => { const v = outputs.find((o) => o?.OutputKey === k)?.OutputValue; return typeof v === 'string' && v ? v : null; };
  return { account: t.account, region: t.region, stack: PIPELINE_STACK, otelCollectorUrl: out('OtelCollectorUrl'), otelUserPoolId: out('OtelUserPoolId') };
}

export const developerCommand = (url: string): string => `prism-cli enable codeburn --url ${url}`;

export function teamInfo(o: TeamOptions, d: TeamDeps): number {
  const say = o.json ? d.err : d.log;
  say(TEAM_INFO_NOTICE);
  say('');
  const t = resolveTarget(o, d, say);
  if (!t) return 1;
  const s = readStack(t);
  if ('error' in s) { say(`Error: ${s.error}`); return 1; }
  if (!s.otelCollectorUrl && !s.otelUserPoolId) {
    say(`Error: ${PIPELINE_STACK} has no OtelCollectorUrl or OtelUserPoolId output, so the OTEL collector is not deployed. Redeploy without -c skipOtelCollector=true.`);
    return 1;
  }
  const cmd = s.otelCollectorUrl ? developerCommand(s.otelCollectorUrl) : null;
  if (o.json) {
    d.log(JSON.stringify({ ...s, developer_command: cmd }, null, 2));
    return 0;
  }
  d.log(`Stack:            ${s.stack}`);
  d.log(`OtelCollectorUrl: ${s.otelCollectorUrl ?? '(no output)'}`);
  d.log(`OtelUserPoolId:   ${s.otelUserPoolId ?? '(no output; developer accounts cannot be created in this stack)'}`);
  d.log('');
  if (cmd) {
    d.log('Send each developer this line:');
    d.log(`  ${cmd}`);
  }
  if (s.otelUserPoolId) d.log('Add a developer: prism-cli team add-developer <email>');
  return 0;
}

const yes = (a: string) => ['y', 'yes'].includes(a.trim().toLowerCase());

export async function addDeveloper(o: AddDeveloperOptions, d: TeamDeps): Promise<number> {
  const email = (o.email || '').trim();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    d.err(`Error: "${email}" is not a valid email address. The username is the developer's email (README step 2).`);
    return 1;
  }
  if (o.userPoolId !== undefined && !POOL_RE.test(o.userPoolId)) {
    d.err(`Error: "${o.userPoolId}" is not a Cognito user pool id (like us-west-2_AbC123).`);
    return 1;
  }
  d.log(ADD_DEVELOPER_NOTICE);
  d.log(`Needs: ${ADD_PERMISSIONS}.`);
  d.log('');
  const t = resolveTarget(o, d, d.log);
  if (!t) return 1;
  let pool = o.userPoolId;
  if (!pool) {
    const s = readStack(t);
    if ('error' in s) { d.err(`Error: ${s.error}`); return 1; }
    if (!s.otelUserPoolId) { d.err(`Error: ${PIPELINE_STACK} has no OtelUserPoolId output. Pass --user-pool-id, or redeploy with the OTEL collector.`); return 1; }
    pool = s.otelUserPoolId;
  }
  d.log('Plan: create one Cognito user');
  d.log(`  Account:   ${t.account}`);
  d.log(`  Region:    ${t.region}`);
  d.log(`  User pool: ${pool}`);
  d.log(`  Username:  ${email} (email attribute too; Cognito emails the invite)`);
  d.log('');
  if (o.dryRun) { d.log('Dry run: nothing was changed.'); return 0; }
  if (!o.yes) {
    if (!d.isTTY) { d.err('Error: no terminal to confirm. Re-run with --yes to create the user, or --dry-run to see the plan.'); return 1; }
    if (!yes(await d.ask('Create this user? [y/N] '))) { d.err('Not created. Nothing was changed.'); return 1; }
  }
  // No --temporary-password: Cognito generates one and emails it; it never passes through here.
  const r = aws(['cognito-idp', 'admin-create-user', '--user-pool-id', pool, '--username', email,
    '--user-attributes', JSON.stringify([{ Name: 'email', Value: email }]), '--desired-delivery-mediums', 'EMAIL', '--region', t.region], t.target);
  if (r.ok) {
    d.log(`✓ Created ${email} in ${pool}. Cognito emailed the invite with a temporary password.`);
    return 0;
  }
  // Only the error code is shown: AWS error text can echo request values.
  if (r.errorCode === 'UsernameExistsException') { d.log(`✓ ${email} already exists in ${pool}; nothing changed.`); return 0; }
  if (ACCESS_DENIED.test(r.errorCode || '')) { d.err(`Error: access denied (${r.errorCode}). team add-developer needs ${ADD_PERMISSIONS}.`); return 1; }
  d.err(`Error: AdminCreateUser failed (${r.errorCode || 'unknown error'}). Nothing was created.`);
  return 1;
}
