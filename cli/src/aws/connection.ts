/**
 * The saved AWS connection from `prism-cli aws connect`, and the one resolver
 * every AWS command uses to pick its default profile and region.
 *
 * What is saved is a profile NAME, a region and what that pair was verified
 * as (account, alias, when). Never a credential: the AWS CLI still resolves
 * the profile's credentials itself, every time.
 *
 * Files:
 *   ~/.prism/aws.json         per user
 *   .prism/aws.local.json     per repo override (git-ignored via .git/info/exclude)
 *
 * Precedence, per field:
 *   profile: --profile > env credentials (AWS_PROFILE, AWS_ACCESS_KEY_ID, ...) > repo file > user file > default chain
 *   region:  --region  > AWS_REGION > AWS_DEFAULT_REGION > saved region > the profile's configured region
 * The saved region is used only together with its saved profile (the two were
 * verified as a pair): `--profile other` falls through to other's own region.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { run, type RunResult } from '../utils/exec.js';

export const USER_CONNECTION_PATH = '~/.prism/aws.json';
export const REPO_CONNECTION_PATH = '.prism/aws.local.json';

export interface AwsConnection {
  profile: string;
  region: string;
  account: string;
  alias: string | null;
  verifiedAt: string;
}

export type ConnectionScope = 'repo' | 'user';
export interface SavedConnection extends AwsConnection { scope: ConnectionScope; path: string }

/** What a command's options gain from the resolver. */
export interface ConnectionDefaults {
  profile?: string;
  /** Where `profile` came from, e.g. "--profile" or "aws connect, user". Unset when no profile is used. */
  profileSource?: string;
  /** The saved connection whose region (and account, for the change warning) applies. */
  connection?: SavedConnection;
}

/** Credential env vars that the AWS CLI prefers over any profile; when set, the saved profile is not applied. */
export const ENV_CREDENTIAL_VARS = ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'];

export const PROFILE_RE = /^[A-Za-z0-9_.+=,@:-]{1,128}$/;
export const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
const ACCOUNT_RE = /^\d{12}$/;

export const userConnectionPath = (home: string): string => join(home, '.prism', 'aws.json');
export const repoConnectionPath = (root: string): string => resolve(root, REPO_CONNECTION_PATH);

function parse(x: any): AwsConnection | null {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.profile !== 'string' || !PROFILE_RE.test(x.profile)) return null;
  if (typeof x.region !== 'string' || !REGION_RE.test(x.region)) return null;
  if (typeof x.account !== 'string' || !ACCOUNT_RE.test(x.account)) return null;
  return {
    profile: x.profile, region: x.region, account: x.account,
    alias: typeof x.alias === 'string' && x.alias ? x.alias : null,
    verifiedAt: typeof x.verifiedAt === 'string' ? x.verifiedAt : '',
  };
}

/** The connection in `path`; null when the file is absent or not a valid connection. */
export function readConnectionFile(path: string): AwsConnection | null {
  try { return parse(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; }
}

/** Atomic write, owner-only (no secrets inside, but it is per-user state). */
export function writeConnectionFile(path: string, c: AwsConnection): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body: AwsConnection = { profile: c.profile, region: c.region, account: c.account, alias: c.alias, verifiedAt: c.verifiedAt };
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Removes the file; true when there was one. */
export function clearConnectionFile(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** The repo file first, then the user file. `home` '' means no user file. */
export function loadConnection(home: string, repoRoot: string | null): SavedConnection | null {
  if (repoRoot) {
    const p = repoConnectionPath(repoRoot);
    const c = readConnectionFile(p);
    if (c) return { ...c, scope: 'repo', path: p };
  }
  if (home) {
    const p = userConnectionPath(home);
    const c = readConnectionFile(p);
    if (c) return { ...c, scope: 'user', path: p };
  }
  return null;
}

export const connectionLabel = (c: Pick<SavedConnection, 'scope'>): string => `aws connect, ${c.scope}`;

/**
 * Fills the profile from the saved connection when neither a flag nor the
 * environment chose the credentials, and attaches the connection whose region
 * applies. Pure: the caller loads the connection.
 */
export function applyConnection<T extends { profile?: string; region?: string }>(opts: T, saved: SavedConnection | null, env: NodeJS.ProcessEnv): T & ConnectionDefaults {
  if (opts.profile) return { ...opts, profileSource: '--profile', connection: saved && saved.profile === opts.profile ? saved : undefined };
  if (ENV_CREDENTIAL_VARS.some((k) => env[k])) {
    return { ...opts, connection: saved && env.AWS_PROFILE === saved.profile ? saved : undefined };
  }
  if (saved) return { ...opts, profile: saved.profile, profileSource: connectionLabel(saved), connection: saved };
  return { ...opts };
}

/** `git -C dir rev-parse --show-toplevel`, or null outside a repository. */
export function repoRootOf(dir: string, git: (args: string[]) => RunResult = (a) => run('git', a)): string | null {
  const r = git(['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.ok && r.stdout ? r.stdout.trim() : null;
}

/**
 * The real-runtime entry point: loads the saved connection for the working
 * directory (or `opts.path`) and applies it. With an explicit `env` (tests),
 * the user file is looked up under env.HOME only, so a developer's own saved
 * connection never leaks into a test run.
 */
export function connectionDefaults<T extends { profile?: string; region?: string; path?: string }>(opts: T, env?: NodeJS.ProcessEnv): T & ConnectionDefaults {
  const e = env ?? process.env;
  const home = env ? (env.HOME ?? '') : homedir();
  const root = repoRootOf(opts.path ? resolve(opts.path) : process.cwd());
  return applyConnection(opts, loadConnection(home, root), e);
}

/** The account-change warning, or null when the account is the one that was verified. */
export function accountChangeWarning(c: SavedConnection | undefined, account: string): string | null {
  if (!c || !account || c.account === account) return null;
  return `Warning: aws connect verified profile ${c.profile} as account ${c.account}${c.verifiedAt ? ` on ${c.verifiedAt}` : ''}, but it now resolves to account ${account}. `
    + `Check the profile, then re-run prism-cli aws connect${c.scope === 'repo' ? ' --repo' : ''}.`;
}

/** `aws configure get region [--profile p]`: local config only, no AWS call. */
export function configuredRegion(profile?: string): string | null {
  const r = run('aws', ['configure', 'get', 'region', ...(profile ? ['--profile', profile] : [])]);
  return r.ok && r.stdout ? r.stdout.trim() : null;
}

/** `aws configure list-profiles`: local config only, no AWS call. */
export function listProfiles(): string[] {
  const r = run('aws', ['configure', 'list-profiles']);
  return r.ok ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}
