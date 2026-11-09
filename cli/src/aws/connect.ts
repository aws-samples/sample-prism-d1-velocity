/**
 * `prism-cli aws connect`: choose the AWS profile and region the other AWS
 * commands default to, verify them, and save the choice. Read-only in AWS;
 * stores no credentials (see connection.ts for the files and precedence).
 */
import { existsSync } from 'node:fs';
import type { AwsResult } from '../utils/aws.js';
import type { RunResult } from '../utils/exec.js';
import { ensureMarkerIgnored } from '../security/marker.js';
import {
  accountChangeWarning, applyConnection, clearConnectionFile, connectionLabel, ENV_CREDENTIAL_VARS, loadConnection,
  PROFILE_RE, readConnectionFile, REGION_RE, REPO_CONNECTION_PATH, repoConnectionPath, repoRootOf, userConnectionPath,
  writeConnectionFile, type AwsConnection, type SavedConnection,
} from './connection.js';

export interface ConnectOptions {
  profile?: string;
  region?: string;
  /** Write (or clear) the per-repo file instead of the per-user one. */
  repo?: boolean;
  status?: boolean;
  clear?: boolean;
}

export interface ConnectDeps {
  /** A read-only `aws <args>` call as `profile` in `region` (JSON output). */
  aws(args: string[], profile: string, region: string): AwsResult;
  listProfiles(): string[];
  configRegion(profile?: string): string | null;
  git(args: string[]): RunResult;
  env: NodeJS.ProcessEnv;
  home: string;
  cwd(): string;
  isTTY: boolean;
  ask(question: string): Promise<string>;
  log(line?: string): void;
  now(): Date;
}

export const CONNECT_NOTICE = 'Read-only (aws connect): it checks the profile with STS and reads the account alias, Organizations and IAM; nothing in AWS is changed. No credentials are stored, only the profile name and region.';

export interface Identity { account: string; arn: string }
export type OrgRole = { kind: 'management'; orgId: string } | { kind: 'member'; orgId: string } | { kind: 'none' } | { kind: 'unknown'; reason: string };
export interface AccessLevel { level: 'admin' | 'read-only' | 'unknown'; basis: string }

const reason = (r: AwsResult) => r.errorCode || r.raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'unknown error';

export function callerIdentity(d: ConnectDeps, profile: string, region: string): Identity | { error: string } {
  const r = d.aws(['sts', 'get-caller-identity'], profile, region);
  if (!r.ok) return { error: reason(r) };
  const account = String(r.json?.Account || '');
  return account ? { account, arn: String(r.json?.Arn || '') } : { error: 'get-caller-identity returned no account' };
}

export function accountAlias(d: ConnectDeps, profile: string, region: string): string | null {
  const r = d.aws(['iam', 'list-account-aliases'], profile, region);
  const a = r.ok && Array.isArray(r.json?.AccountAliases) ? r.json.AccountAliases[0] : null;
  return a ? String(a) : null;
}

/** Whether the account is its organization's management account. AccessDenied is "unknown", never "no". */
export function orgRole(d: ConnectDeps, profile: string, region: string, account: string): OrgRole {
  const r = d.aws(['organizations', 'describe-organization'], profile, region);
  if (r.ok) {
    const org = r.json?.Organization ?? {};
    // The API names the management account's id field MasterAccountId.
    const managementId = String(org.MasterAccountId || '');
    return managementId === account ? { kind: 'management', orgId: String(org.Id || '') } : { kind: 'member', orgId: String(org.Id || '') };
  }
  if (r.errorCode === 'AWSOrganizationsNotInUseException') return { kind: 'none' };
  return { kind: 'unknown', reason: reason(r) };
}

const ADMIN_POLICY = /^(AdministratorAccess|PowerUserAccess)$|FullAccess$/;
const READ_POLICY = /^(ReadOnlyAccess|ViewOnlyAccess|SecurityAudit)$|ReadOnly/;
const ADMIN_NAME = /admin|poweruser|fullaccess/i;
const READ_NAME = /read-?only|view-?only|audit/i;

/** The principal behind a caller ARN: an assumed role, an IAM user, or root. */
export function principalOf(arn: string): { kind: 'role' | 'user' | 'root' | 'other'; name: string } {
  const m = /^arn:[^:]+:(sts|iam)::\d{12}:(assumed-role|user|root|role)(?:\/(.*))?$/.exec(arn);
  if (!m) return { kind: 'other', name: '' };
  if (m[2] === 'root') return { kind: 'root', name: 'root' };
  const parts = (m[3] || '').split('/');
  if (m[2] === 'assumed-role' || m[2] === 'role') return { kind: 'role', name: m[2] === 'assumed-role' ? parts[0] : parts[parts.length - 1] };
  return { kind: 'user', name: parts[parts.length - 1] };
}

/**
 * Admin or read-only, as far as can be told without simulating policies:
 * the attached managed policies when they can be read, else the role or user
 * name. "unknown" whenever neither is conclusive.
 */
export function accessLevel(d: ConnectDeps, profile: string, region: string, arn: string): AccessLevel {
  const p = principalOf(arn);
  if (p.kind === 'root') return { level: 'admin', basis: 'the root user' };
  if (p.kind === 'other' || !p.name) return { level: 'unknown', basis: 'the caller ARN has an unexpected form' };
  const call = p.kind === 'role' ? ['iam', 'list-attached-role-policies', '--role-name', p.name] : ['iam', 'list-attached-user-policies', '--user-name', p.name];
  const r = d.aws(call, profile, region);
  const names: string[] = r.ok ? (r.json?.AttachedPolicies || []).map((x: any) => String(x?.PolicyName || '')).filter(Boolean) : [];
  if (names.some((n) => ADMIN_POLICY.test(n))) return { level: 'admin', basis: `attached policy ${names.find((n) => ADMIN_POLICY.test(n))}` };
  if (names.length && names.every((n) => READ_POLICY.test(n))) return { level: 'read-only', basis: `attached policies ${names.join(', ')}` };
  const why = r.ok ? (names.length ? `custom policies (${names.join(', ')})` : 'no managed policies attached') : `policies not readable (${reason(r)})`;
  if (ADMIN_NAME.test(p.name)) return { level: 'admin', basis: `the ${p.kind} name ${p.name}; ${why}` };
  if (READ_NAME.test(p.name)) return { level: 'read-only', basis: `the ${p.kind} name ${p.name}; ${why}` };
  return { level: 'unknown', basis: why };
}

const createHint = (profile: string) => `Check the name, or create it with aws configure sso --profile ${profile} (or aws configure --profile ${profile}).`;

/** Signing in cannot fix a profile the AWS CLI cannot find, so that case gets the create hint instead. */
function fixHint(profile: string, error: string, signIn: string): string {
  return /config profile .* could not be found/i.test(error) ? createHint(profile) : signIn.replace('<p>', profile);
}

const orgText = (o: OrgRole) => o.kind === 'management' ? `yes, the management account of ${o.orgId}`
  : o.kind === 'member' ? `no, a member account of ${o.orgId}` : o.kind === 'none' ? 'no, not in an organization' : `unknown (${o.reason})`;

async function chooseProfile(o: ConnectOptions, d: ConnectDeps, saved: SavedConnection | null): Promise<string | { error: string }> {
  if (o.profile) return o.profile;
  const profiles = d.listProfiles();
  if (!d.isTTY) {
    if (d.env.AWS_PROFILE) return d.env.AWS_PROFILE;
    return { error: 'no --profile given and there is no terminal to choose on. Pass --profile <name> (see aws configure list-profiles).' };
  }
  if (!profiles.length) return { error: 'no AWS profiles are configured. Create one with aws configure sso (or aws configure --profile <name>), then re-run.' };
  const preferred = d.env.AWS_PROFILE || saved?.profile || (profiles.includes('default') ? 'default' : profiles[0]);
  const def = Math.max(0, profiles.indexOf(preferred));
  d.log('AWS profiles (from aws configure list-profiles):');
  profiles.forEach((p, i) => d.log(`  ${i + 1}) ${p}${i === def ? '  (default)' : ''}`));
  const a = (await d.ask(`Profile [${def + 1}]: `)).trim();
  if (!a) return profiles[def];
  const n = Number.parseInt(a, 10);
  if (String(n) === a && n >= 1 && n <= profiles.length) return profiles[n - 1];
  return profiles.includes(a) ? a : { error: `"${a}" is not one of the listed profiles.` };
}

async function chooseRegion(o: ConnectOptions, d: ConnectDeps, profile: string): Promise<string | { error: string }> {
  if (o.region) return o.region;
  const def = d.env.AWS_REGION || d.env.AWS_DEFAULT_REGION || d.configRegion(profile) || '';
  if (!d.isTTY) return def || { error: `no --region given and profile ${profile} has no configured region. Pass --region <region>.` };
  const a = (await d.ask(`Region${def ? ` [${def}]` : ''}: `)).trim();
  return a || def || { error: 'a region is required.' };
}

function repoRoot(d: ConnectDeps): string | null {
  return repoRootOf(d.cwd(), d.git);
}

/** `--clear`: removes the user file, or the repo file with --repo. */
function clear(o: ConnectOptions, d: ConnectDeps): number {
  let path: string;
  if (o.repo) {
    const root = repoRoot(d);
    if (!root) { d.log('Error: --repo needs to run inside a git repository.'); return 1; }
    path = repoConnectionPath(root);
  } else path = userConnectionPath(d.home);
  d.log(clearConnectionFile(path) ? `Removed ${path}. Nothing in AWS was changed.` : `Nothing to clear: ${path} does not exist.`);
  return 0;
}

function describeFile(label: string, path: string, d: ConnectDeps): void {
  const c = readConnectionFile(path);
  if (c) d.log(`  ${label}: ${path}\n      profile ${c.profile}, region ${c.region}, account ${c.account}${c.alias ? ` (${c.alias})` : ''}, verified ${c.verifiedAt || 'unknown'}`);
  else d.log(`  ${label}: ${path} (${existsSync(path) ? 'not a valid connection; ignored. Re-run prism-cli aws connect' : 'not set'})`);
}

/** `--status`: what is saved, which file applies, and whether it still validates. */
function status(d: ConnectDeps): number {
  const root = repoRoot(d);
  d.log('Saved AWS connection:');
  describeFile('user', userConnectionPath(d.home), d);
  if (root) describeFile('repo', repoConnectionPath(root), d);
  else d.log('  repo: (not in a git repository)');
  const saved = loadConnection(d.home, root);
  if (!saved) { d.log(''); d.log('No saved connection: AWS commands use the default credential chain. Save one with: prism-cli aws connect'); return 0; }
  const applied = applyConnection({}, saved, d.env);
  d.log('');
  if (applied.profileSource) d.log(`In use: profile ${saved.profile}, region ${saved.region} (${connectionLabel(saved)}, ${saved.path})`);
  else {
    const v = ENV_CREDENTIAL_VARS.find((k) => d.env[k]);
    d.log(`Not in use for credentials: ${v} is set, and the environment wins over the saved connection${applied.connection ? ` (the saved region ${saved.region} still applies)` : ''}.`);
  }
  if (d.env.AWS_REGION || d.env.AWS_DEFAULT_REGION) d.log(`Region note: ${d.env.AWS_REGION ? 'AWS_REGION' : 'AWS_DEFAULT_REGION'} is set and wins over the saved region.`);
  const id = callerIdentity(d, saved.profile, saved.region);
  if ('error' in id) { d.log(`Validation: FAILED for profile ${saved.profile}: ${id.error}. ${fixHint(saved.profile, id.error, 'Sign in again (e.g. aws sso login --profile <p>) or re-run prism-cli aws connect.')}`); return 1; }
  const w = accountChangeWarning(saved, id.account);
  d.log(w ?? `Validation: ok, profile ${saved.profile} is account ${id.account} as saved (caller ${id.arn}).`);
  return w ? 1 : 0;
}

/** Runs `aws connect`. Returns the exit code. */
export async function awsConnect(o: ConnectOptions, d: ConnectDeps): Promise<number> {
  if (o.status && o.clear) { d.log('Error: --status and --clear cannot be combined.'); return 1; }
  if (o.clear) return clear(o, d);
  d.log(CONNECT_NOTICE);
  d.log('');
  if (o.status) return status(d);

  const root = repoRoot(d);
  if (o.repo && !root) { d.log('Error: --repo needs to run inside a git repository.'); return 1; }
  const before = loadConnection(d.home, root);
  const profile = await chooseProfile(o, d, before);
  if (typeof profile !== 'string') { d.log(`Error: ${profile.error}`); return 1; }
  if (!PROFILE_RE.test(profile)) { d.log(`Error: "${profile}" is not a valid profile name.`); return 1; }
  const known = d.listProfiles();
  if (!known.includes(profile)) {
    d.log(`Error: profile ${profile} is not configured here (aws configure list-profiles lists ${known.length ? known.join(', ') : 'no profiles'}). ${createHint(profile)}`);
    return 1;
  }
  const region = await chooseRegion(o, d, profile);
  if (typeof region !== 'string') { d.log(`Error: ${region.error}`); return 1; }
  if (!REGION_RE.test(region)) { d.log(`Error: "${region}" is not a valid AWS region name (e.g. us-west-2).`); return 1; }

  const id = callerIdentity(d, profile, region);
  if ('error' in id) {
    d.log(`Error: profile ${profile} does not validate: ${id.error}. ${fixHint(profile, id.error, 'Sign in (e.g. aws sso login --profile <p>) and re-run.')} Nothing was saved.`);
    return 1;
  }
  const alias = accountAlias(d, profile, region);
  const org = orgRole(d, profile, region, id.account);
  const access = accessLevel(d, profile, region, id.arn);

  d.log(`Profile:     ${profile}`);
  d.log(`Region:      ${region}`);
  d.log(`Account:     ${id.account}${alias ? ` (${alias})` : ' (no account alias)'}`);
  d.log(`Caller:      ${id.arn || 'unknown'}`);
  d.log(`Org management account: ${orgText(org)}`);
  d.log(`Access:      ${access.level} (${access.basis})`);
  if (access.level === 'admin') d.log('             prism-cli aws check and aws recommend only need read access; a read-only profile is enough for them.');

  const path = o.repo && root ? repoConnectionPath(root) : userConnectionPath(d.home);
  const prev = readConnectionFile(path);
  if (prev && prev.profile === profile && prev.account !== id.account) {
    d.log(`Warning: profile ${profile} was saved as account ${prev.account}; it now resolves to account ${id.account}.`);
  }
  const conn: AwsConnection = { profile, region, account: id.account, alias, verifiedAt: d.now().toISOString() };
  if (o.repo && root) {
    const excluded = ensureMarkerIgnored(root, d.git, REPO_CONNECTION_PATH, 'prism-cli aws connect');
    if (excluded) d.log(`Added ${REPO_CONNECTION_PATH} to ${excluded} so git ignores it in this clone.`);
  }
  writeConnectionFile(path, conn);
  d.log('');
  d.log(`Saved ${path} (profile name, region, account and alias; no credentials).`);
  d.log(`AWS commands now default to profile ${profile} in ${region}${o.repo ? ' in this repo' : ''}. --profile/--region and AWS_PROFILE/AWS_REGION still win.`);
  const env = ENV_CREDENTIAL_VARS.find((k) => d.env[k]);
  if (env && d.env.AWS_PROFILE !== profile) d.log(`Note: ${env} is set in this shell, so it wins here until it is unset.`);
  if (!o.repo && root && readConnectionFile(repoConnectionPath(root))) d.log(`Note: this repo has its own ${REPO_CONNECTION_PATH}, which wins over the user file here.`);
  return 0;
}
