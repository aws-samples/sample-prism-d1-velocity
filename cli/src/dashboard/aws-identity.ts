/**
 * The Settings page's AWS tab: which credentials prism-cli would use and why,
 * and the profile and region choices for Connect (prism-cli aws connect), all
 * with no AWS call.
 *
 * Resolution follows the order every AWS command uses (aws/connection.ts):
 * flags (none here), env credentials, .prism/aws.local.json, ~/.prism/aws.json,
 * then the default chain. The credential TYPE comes from the KEY NAMES in
 * ~/.aws/config and ~/.aws/credentials. The parser drops every value as it
 * reads a line, except `region`, so no secret is kept, returned or shown.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyConnection, connectionLabel, loadConnection, PROFILE_RE, REGION_RE } from '../aws/connection.js';
import { resolveRegion } from '../security/setup.js';
import { tildeHome } from './payload.js';

/** Section name -> its key names (lower case), plus the region value: the only value kept. */
export type IniKeys = Map<string, { keys: Set<string>; region?: string }>;

/**
 * Key names per section. Values are discarded line by line; `region` is kept
 * only when it looks like a region name. Indented lines are nested settings
 * (e.g. s3 = ...) and are skipped.
 */
export function iniKeys(text: string, kind: 'config' | 'credentials'): IniKeys {
  const out: IniKeys = new Map();
  let cur: { keys: Set<string>; region?: string } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (sec) {
      // config: [default] and [profile name]; [sso-session x] and others are not profiles.
      const name = kind === 'credentials' ? sec[1] : sec[1] === 'default' ? 'default' : /^profile\s+(.+)$/.exec(sec[1])?.[1]?.trim();
      cur = name ? (out.get(name) ?? { keys: new Set() }) : null;
      if (name && cur) out.set(name, cur);
      continue;
    }
    const eq = line.indexOf('=');
    if (!cur || eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    cur.keys.add(key);
    if (key === 'region') {
      const v = line.slice(eq + 1).trim();
      if (REGION_RE.test(v)) cur.region = v;
    }
  }
  return out;
}

export type CredentialType = 'credential_process' | 'sso' | 'static-credentials-file' | 'static-config-file'
  | 'assume-role' | 'web-identity' | 'env' | 'container' | 'none';

export const CREDENTIAL_TYPE_LABEL: Record<CredentialType, string> = {
  credential_process: 'credential_process',
  sso: 'IAM Identity Center (SSO)',
  'static-credentials-file': 'static keys in ~/.aws/credentials',
  'static-config-file': 'static keys in ~/.aws/config',
  'assume-role': 'assume role (role_arn)',
  'web-identity': 'web identity token',
  env: 'environment variables',
  container: 'container credentials',
  none: 'none found',
};

/**
 * The type the AWS CLI would use for `profile`, in its provider order within a
 * profile: role_arn, web identity, SSO, keys in the credentials file,
 * credential_process, keys in the config file. `shadowed` lists the types that
 * are configured but lose.
 */
export function classifyProfile(profile: string, config: IniKeys, creds: IniKeys): { type: CredentialType; shadowed: CredentialType[] } {
  const c = config.get(profile)?.keys ?? new Set<string>();
  const k = creds.get(profile)?.keys ?? new Set<string>();
  const present: CredentialType[] = [];
  if (c.has('role_arn') && (c.has('web_identity_token_file'))) present.push('web-identity');
  else if (c.has('role_arn') || k.has('role_arn')) present.push('assume-role');
  if (c.has('sso_session') || c.has('sso_start_url') || c.has('sso_account_id')) present.push('sso');
  if (k.has('aws_access_key_id')) present.push('static-credentials-file');
  if (c.has('credential_process') || k.has('credential_process')) present.push('credential_process');
  if (c.has('aws_access_key_id')) present.push('static-config-file');
  if (!present.length) return { type: 'none', shadowed: [] };
  return { type: present[0], shadowed: present.slice(1) };
}

export interface ResolutionStep {
  id: 'flags' | 'env' | 'repo' | 'user' | 'default';
  label: string;
  /** used: this step chose the credentials. skipped: set, but an earlier step won. */
  state: 'used' | 'skipped' | 'not-set' | 'n/a';
  detail: string;
}

export interface AwsIdentityView {
  /** Profile name the AWS CLI is given, or null (env keys, container, or nothing). */
  profile: string | null;
  /** Why: "AWS_PROFILE", "aws connect, repo", "default chain", ... */
  source: string;
  credentialType: CredentialType;
  credentialLabel: string;
  region: { value: string; source: string } | null;
  steps: ResolutionStep[];
  /** The saved aws connect connection (the repo file, else the user file), whether or not it is in use. */
  saved: null | {
    scope: 'repo' | 'user'; path: string; profile: string; region: string; account: string; alias: string | null;
    verifiedAt: string; inUse: boolean;
  };
  warnings: string[];
  files: { config: string; credentials: string; configFound: boolean; credentialsFound: boolean };
}

export interface IdentityDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** The repo the dashboard runs in (for .prism/aws.local.json), or null. */
  repoRoot: string | null;
  /** File reader; null when the file is missing or unreadable. */
  readText?: (path: string) => string | null;
}

const readTextFile = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

export const STATIC_DEFAULT_WARNING = 'The default profile has static keys in ~/.aws/credentials. Static keys win over a credential_process or SSO setting for the same profile, and they often expire. If you sign in with credential_process or SSO, remove the keys from [default] in ~/.aws/credentials.';
export const NO_CREDENTIALS_WARNING = 'No AWS credentials found: no AWS env var, no saved aws connect profile, and no default profile in ~/.aws/config or ~/.aws/credentials. Set one up with aws configure sso (or aws configure), then run prism-cli aws connect.';

/** What prism-cli would use, from local files and env only. No AWS call, no aws CLI call. */
export function resolveAwsIdentity(d: IdentityDeps): AwsIdentityView {
  const read = d.readText ?? readTextFile;
  const env = d.env;
  const configPath = env.AWS_CONFIG_FILE || join(d.home, '.aws', 'config');
  const credsPath = env.AWS_SHARED_CREDENTIALS_FILE || join(d.home, '.aws', 'credentials');
  const configText = read(configPath), credsText = read(credsPath);
  const config = iniKeys(configText ?? '', 'config');
  const creds = iniKeys(credsText ?? '', 'credentials');
  const saved = loadConnection(d.home, d.repoRoot);
  const applied = applyConnection({}, saved, env);
  const warnings: string[] = [];

  let profile: string | null = null, source: string, type: CredentialType, shadowed: CredentialType[] = [];
  let envDetail = 'no AWS credential env var set';
  let decided: ResolutionStep['id'];
  if (env.AWS_ACCESS_KEY_ID) {
    type = 'env'; source = 'AWS_ACCESS_KEY_ID'; decided = 'env';
    envDetail = `AWS_ACCESS_KEY_ID is set${env.AWS_PROFILE ? ' (it wins over AWS_PROFILE)' : ''}`;
  } else if (env.AWS_PROFILE) {
    profile = env.AWS_PROFILE; source = 'AWS_PROFILE'; decided = 'env';
    ({ type, shadowed } = classifyProfile(profile, config, creds));
    envDetail = `AWS_PROFILE=${profile}`;
  } else if (env.AWS_WEB_IDENTITY_TOKEN_FILE) {
    type = 'web-identity'; source = 'AWS_WEB_IDENTITY_TOKEN_FILE'; decided = 'env'; envDetail = 'AWS_WEB_IDENTITY_TOKEN_FILE is set';
  } else if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
    type = 'container'; source = 'container credentials env var'; decided = 'env'; envDetail = 'a container credentials env var is set';
  } else if (saved && applied.profileSource) {
    profile = saved.profile; source = connectionLabel(saved); decided = saved.scope;
    ({ type, shadowed } = classifyProfile(profile, config, creds));
  } else {
    profile = 'default'; source = 'default chain'; decided = 'default';
    ({ type, shadowed } = classifyProfile(profile, config, creds));
  }

  const repoFile = d.repoRoot ? join(d.repoRoot, '.prism', 'aws.local.json') : null;
  const savedStep = (scope: 'repo' | 'user'): ResolutionStep['state'] =>
    decided === scope ? 'used' : saved?.scope === scope ? 'skipped' : 'not-set';
  const steps: ResolutionStep[] = [
    { id: 'flags', label: '--profile / --region', state: 'n/a', detail: 'not used by the dashboard' },
    { id: 'env', label: 'Environment', state: decided === 'env' ? 'used' : 'not-set', detail: envDetail },
    { id: 'repo', label: 'Repo: .prism/aws.local.json', state: savedStep('repo'),
      detail: !repoFile ? 'the dashboard is not running in a git repo' : saved?.scope === 'repo' ? `profile ${saved.profile}` : 'not set' },
    { id: 'user', label: 'User: ~/.prism/aws.json', state: savedStep('user'),
      detail: saved?.scope === 'user' ? `profile ${saved.profile}` : saved?.scope === 'repo' ? 'the repo file wins' : 'not set' },
    { id: 'default', label: 'Default chain', state: decided === 'default' ? 'used' : 'not-set', detail: 'the [default] profile' },
  ];

  const configRegion = (p?: string) => config.get(p ?? env.AWS_PROFILE ?? 'default')?.region ?? null;
  const region = resolveRegion({ profile: profile && profile !== 'default' ? profile : undefined, connection: applied.connection }, { env, configRegion });

  if (creds.get('default')?.keys.has('aws_access_key_id')) warnings.push(STATIC_DEFAULT_WARNING);
  if (profile && profile !== 'default' && type === 'static-credentials-file' && shadowed.length) {
    warnings.push(`Profile ${profile} has static keys in ~/.aws/credentials, and they win over its ${shadowed.map((t) => CREDENTIAL_TYPE_LABEL[t]).join(' and ')}. Remove the keys if they are stale.`);
  }
  if (type === 'none') {
    warnings.push(profile && profile !== 'default'
      ? `Profile ${profile} (${source}) is not configured in ~/.aws/config or ~/.aws/credentials. Create it with aws configure sso --profile ${profile}, or re-run prism-cli aws connect.`
      : NO_CREDENTIALS_WARNING);
  }
  if (saved && !applied.profileSource) warnings.push(`The saved aws connect profile ${saved.profile} is not used: ${source} is set in the dashboard's environment and wins.`);

  return {
    profile, source, credentialType: type, credentialLabel: CREDENTIAL_TYPE_LABEL[type],
    region: region ? { value: region.region, source: region.source } : null,
    steps,
    saved: saved ? {
      scope: saved.scope, path: tildeHome(saved.path, d.home), profile: saved.profile, region: saved.region, account: saved.account,
      alias: saved.alias, verifiedAt: saved.verifiedAt, inUse: !!applied.profileSource,
    } : null,
    warnings,
    files: { config: tildeHome(configPath, d.home), credentials: tildeHome(credsPath, d.home), configFound: configText !== null, credentialsFound: credsText !== null },
  };
}

/**
 * The regions Settings › AWS offers: a fixed list of commercial regions. Any
 * region a profile has configured is added (profileChoices). No AWS call.
 */
export const REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'sa-east-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1',
  'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2',
] as const;

export interface ProfileChoice {
  name: string;
  /** The profile's configured region, when it has one (the only value read from the files). */
  region: string | null;
  /** Which file has the section: the config file, the credentials file, or both. */
  from: 'config' | 'credentials' | 'both';
}

/**
 * The profiles the Connect picker offers and the server accepts: the section
 * names of ~/.aws/config (`[default]`, `[profile x]`) and ~/.aws/credentials
 * (`[x]`), the same files `aws configure list-profiles` reads (AWS_CONFIG_FILE
 * and AWS_SHARED_CREDENTIALS_FILE honoured). iniKeys() drops every value as it
 * reads, except a region that looks like one, so no key material is kept or
 * returned. Names that are not valid profile names are left out. Read fresh on
 * every call. No AWS call.
 */
export function profileChoices(d: Pick<IdentityDeps, 'env' | 'home' | 'readText'>): { profiles: ProfileChoice[]; regions: string[] } {
  const read = d.readText ?? readTextFile;
  const config = iniKeys(read(d.env.AWS_CONFIG_FILE || join(d.home, '.aws', 'config')) ?? '', 'config');
  const creds = iniKeys(read(d.env.AWS_SHARED_CREDENTIALS_FILE || join(d.home, '.aws', 'credentials')) ?? '', 'credentials');
  const names = [...new Set([...config.keys(), ...creds.keys()])].filter((n) => PROFILE_RE.test(n)).sort((a, b) => a.localeCompare(b));
  const profiles = names.map((name): ProfileChoice => ({
    name,
    region: config.get(name)?.region ?? creds.get(name)?.region ?? null,
    from: config.has(name) && creds.has(name) ? 'both' : config.has(name) ? 'config' : 'credentials',
  }));
  const regions = [...new Set<string>([...REGIONS, ...profiles.map((p) => p.region).filter((r): r is string => !!r && REGION_RE.test(r))])];
  return { profiles, regions };
}
