/**
 * Which Security Agent setup a command uses.
 *
 * Files (ids, account and region only; never a credential):
 *   ~/.prism/security.json        the machine setup: `prism-cli enable security`, run once from any directory
 *   .prism/security.local.json    a repo override: `enable security --repo` (and every version before 1.17)
 *
 * Order, for every security command:
 *   explicit flags (--region) > the repo override, only when present and not
 *   tracked by git > the machine setup > not set up (one-line hint).
 *
 * The SSM parameters in the account stay the source of truth for the ids; a
 * setup record picks the region and is a fallback when SSM has no value.
 * Like ~/.prism/aws.json, the account is kept in the file and shown masked.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunResult } from '../utils/exec.js';
import { last4, REGION_RE } from '../aws/connection.js';
import { MARKER_PATH, readLocalMarker } from './marker.js';

export const USER_SECURITY_PATH = '~/.prism/security.json';
export const userSecurityPath = (home: string): string => join(home, '.prism', 'security.json');

export const SETUP_HINT = 'Security Agent is not set up on this machine: run prism-cli enable security (once, from any directory).';

export interface MachineSetup {
  agentSpaceId: string;
  applicationId: string;
  region: string;
  account: string;
  setupAt: string;
}

export type SetupSource = 'repo' | 'machine';

export interface ResolvedSetup extends MachineSetup {
  source: SetupSource;
  /** The file, as shown to the user (`~/.prism/security.json` or `.prism/security.local.json`). */
  file: string;
  /** Only a repo override names a code review. */
  codeReviewId: string | null;
}

/** The home directory from the environment; '' when unknown, so a test env never reads the real one. */
export const homeOf = (env: NodeJS.ProcessEnv): string => env.HOME || env.USERPROFILE || '';

function parse(x: any): MachineSetup | null {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.agentSpaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(x.agentSpaceId)) return null;
  if (typeof x.region !== 'string' || !REGION_RE.test(x.region)) return null;
  if (typeof x.account !== 'string' || !/^\d{12}$/.test(x.account)) return null;
  return {
    agentSpaceId: x.agentSpaceId, region: x.region, account: x.account,
    applicationId: typeof x.applicationId === 'string' ? x.applicationId : '',
    setupAt: typeof x.setupAt === 'string' ? x.setupAt : '',
  };
}

/** The machine setup, or null when the file is absent or not valid. `home` '' means none. */
export function readMachineSetup(home: string): MachineSetup | null {
  if (!home) return null;
  try { return parse(JSON.parse(readFileSync(userSecurityPath(home), 'utf8'))); } catch { return null; }
}

/**
 * Writes ~/.prism/security.json atomically, owner-only. setupAt is kept when
 * nothing else changed, so a re-run that changes nothing leaves the file as it was.
 */
export function writeMachineSetup(home: string, m: Omit<MachineSetup, 'setupAt'>, now: Date): { path: string; wrote: boolean } {
  const path = userSecurityPath(home);
  const prev = readMachineSetup(home);
  const same = !!prev && prev.agentSpaceId === m.agentSpaceId && prev.applicationId === m.applicationId && prev.region === m.region && prev.account === m.account && !!prev.setupAt;
  if (same) return { path, wrote: false };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body: MachineSetup = { agentSpaceId: m.agentSpaceId, applicationId: m.applicationId, region: m.region, account: m.account, setupAt: now.toISOString() };
  try {
    writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { path, wrote: true };
}

/** True when git tracks the repo override: a committed file never chooses the setup. */
export function overrideTracked(repoRoot: string, git: (args: string[]) => RunResult): boolean {
  return git(['-C', repoRoot, 'ls-files', '--error-unmatch', MARKER_PATH]).ok;
}

/**
 * The setup a command uses: the repo override (when `repoRoot` is given, the
 * file is there and git does not track it), else the machine setup, else null.
 */
export function loadSetup(home: string, repoRoot: string | null, git?: (args: string[]) => RunResult): ResolvedSetup | null {
  if (repoRoot) {
    const m = readLocalMarker(repoRoot);
    if (m && !(git && overrideTracked(repoRoot, git))) {
      return { agentSpaceId: m.agentSpaceId, applicationId: m.applicationId, region: m.region, account: m.account, setupAt: m.setupAt, codeReviewId: m.codeReviewId, source: 'repo', file: MARKER_PATH };
    }
  }
  const u = readMachineSetup(home);
  return u ? { ...u, codeReviewId: null, source: 'machine', file: USER_SECURITY_PATH } : null;
}

export const setupLabel = (s: Pick<ResolvedSetup, 'source' | 'file'>): string => (s.source === 'repo' ? `repo override ${s.file}` : `machine setup ${s.file}`);

/** One line: where, which account (masked) and region, and when. */
export function describeSetup(s: ResolvedSetup): string {
  return `${setupLabel(s)} (account ${last4(s.account)}, region ${s.region}${s.setupAt ? `, set up ${s.setupAt.slice(0, 10)}` : ''})`;
}

/** The warning when the credentials resolve to another account than the setup's, or null. */
export function setupAccountWarning(s: ResolvedSetup | null | undefined, account: string): string | null {
  if (!s || !account || s.account === account) return null;
  return `Warning: the ${setupLabel(s)} is for account ${last4(s.account)}, but the credentials resolve to account ${last4(account)}. `
    + `Run prism-cli enable security${s.source === 'repo' ? ' --repo' : ''} with these credentials to set this account up.`;
}
