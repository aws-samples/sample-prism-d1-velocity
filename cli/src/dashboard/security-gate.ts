/**
 * The Security Agent page's setup gate (#security). Three steps, checked in
 * order; the page shows only the first one that is not met (security-page.ts).
 *
 *   1. AWS connected: a named profile, from AWS_PROFILE in the dashboard's
 *      environment or a saved aws connect (.prism/aws.local.json, then
 *      ~/.prism/aws.json). The order is prism-cli's own (aws/connection.ts
 *      applyConnection, read through aws-identity.ts): the environment first,
 *      so AWS_PROFILE wins over a saved connection, and AWS_ACCESS_KEY_ID, a web
 *      identity token or container credentials win over both. The profile must
 *      be a section of ~/.aws/config or ~/.aws/credentials. Local files only.
 *   2. Security Agent set up: a setup record applies in the repo (the repo
 *      override, else ~/.prism/security.json; security/config.ts loadSetup), for
 *      the account in use: the saved connection's verified account, or the
 *      lookup's sts get-caller-identity once it ran. Local files only.
 *   3. Agent space verified: the read-only lookup (security-agent.ts) found the
 *      agent space and scan bucket SSM names. The sign-in is verified by its
 *      sts get-caller-identity.
 *
 * Pure: the caller loads the identity, setup, lookup and command lines. Every
 * account id leaves as its last 4 digits; files are named, not their contents.
 */
import { last4 } from '../aws/connection.js';
import { setupLabel, type ResolvedSetup } from '../security/config.js';
import type { AwsIdentityView } from './aws-identity.js';
import type { Lookup } from './security-agent.js';

export type GateState = 'connect' | 'profile' | 'setup' | 'mismatch' | 'checking' | 'sso' | 'denied' | 'nospace' | 'error' | 'ready';
export const GATE_STEPS = ['AWS connected', 'Security Agent set up', 'Agent space verified'] as const;
const STEP_OF: Record<GateState, 1 | 2 | 3 | null> = {
  connect: 1, profile: 1, setup: 2, mismatch: 2, checking: 3, sso: 3, denied: 3, nospace: 3, error: 3, ready: null,
};

/** The read permissions the lookup needs, as the denied card lists them. */
export const LOOKUP_GRANTS = ['sts:GetCallerIdentity', 'securityagent:ListAgentSpaces', 'securityagent:BatchGetAgentSpaces', 'ssm:GetParameter on /prism/continuum/*'];

export interface GateUsing {
  via: 'aws connect' | 'AWS_PROFILE';
  profile: string;
  /** "aws connect: <profile>" or "AWS_PROFILE: <profile>". */
  label: string;
}

export interface Gate {
  state: GateState;
  /** The first step not met (1 to 3); null when all three pass. */
  step: 1 | 2 | 3 | null;
  /** The profile in use and where it came from; null when step 1 cannot name one. */
  using: GateUsing | null;
  /** Set when AWS_PROFILE and a saved aws connect profile differ: which wins, and why. */
  precedence: string | null;
  title: string;
  detail: string[];
  /** Commands the card shows with Copy (never run from the page). */
  copy: { setup?: string; repo?: string; replace?: string; login?: string };
  /** Access denied: the IAM action the refused call needed. */
  action: string | null;
  /** The account in use (last 4 digits), when known, and the region the commands use. */
  account4: string | null;
  region: string | null;
  /** The setup record that applies, masked. */
  setup: { source: 'repo' | 'machine'; file: string; account4: string; region: string } | null;
  /** Lines that inform without gating (a repo override). */
  info: string[];
}

export interface GateInput {
  identity: AwsIdentityView;
  /** The full account aws connect verified, when the saved connection is the one in use. */
  savedAccount: string | null;
  setup: ResolvedSetup | null;
  lookup: Lookup | null;
  /** The full account behind the current good lookup (server side only). */
  lookupAccount: string | null;
  repoName: string;
  /** The region the security commands and the lookup use in this repo. */
  region: string | null;
  /**
   * enable security lines: `setup` (no cd) and `repoSetup` (cd, --repo) with the
   * region the commands use here; `repo` (cd, --repo) and `replace` with the
   * connected profile's own region, for an account the setup is not for.
   */
  commands: { setup: string; repo: string; replace: string; repoSetup: string };
}

/** The named profile step 1 accepts, in prism-cli's order; null for env keys, a container, a web identity or the default chain. */
export function gateUsing(identity: AwsIdentityView): GateUsing | null {
  if (!identity.profile) return null;
  if (identity.source === 'AWS_PROFILE') return { via: 'AWS_PROFILE', profile: identity.profile, label: `AWS_PROFILE: ${identity.profile}` };
  if (identity.source.startsWith('aws connect')) return { via: 'aws connect', profile: identity.profile, label: `aws connect: ${identity.profile}` };
  return null;
}

/** Which wins when AWS_PROFILE and the saved aws connect profile differ, and why; null otherwise. */
export function gatePrecedence(identity: AwsIdentityView): string | null {
  const saved = identity.saved;
  if (identity.source !== 'AWS_PROFILE' || !saved || saved.profile === identity.profile) return null;
  const file = saved.scope === 'repo' ? '.prism/aws.local.json' : '~/.prism/aws.json';
  return `AWS_PROFILE (${identity.profile}) wins over the saved aws connect profile ${saved.profile}: prism-cli reads the environment before ${file}, as every prism-cli AWS command does. Unset AWS_PROFILE and restart the dashboard to use ${saved.profile}.`;
}

const ENV_WINS = new Set(['AWS_ACCESS_KEY_ID', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'container credentials env var']);

export function computeGate(i: GateInput): Gate {
  const using = gateUsing(i.identity);
  const s = i.setup;
  const known = i.lookupAccount ?? (using?.via === 'aws connect' ? i.savedAccount : null);
  const base = {
    using, precedence: gatePrecedence(i.identity), copy: {}, action: null, region: i.region,
    account4: known ? last4(known) : i.lookup?.ok ? i.lookup.account4 : null,
    setup: s ? { source: s.source, file: s.file, account4: last4(s.account), region: s.region } : null,
    info: s?.source === 'repo'
      ? [`${i.repoName} has its own setup: the repo override ${s.file} (account ${last4(s.account)}, ${s.region}). It takes precedence over the machine setup in this repo; delete the file to use the machine setup.`]
      : [],
  };
  const gate = (state: GateState, title: string, detail: string[], more: Partial<Gate> = {}): Gate => ({ ...base, state, step: STEP_OF[state], title, detail, ...more });
  const intro = 'Security Agent runs in your AWS account, so this page needs a named AWS profile: a saved aws connect (Settings › AWS), or AWS_PROFILE in the environment the dashboard was started from.';

  // Step 1: a named profile, configured on this machine.
  if (!using) {
    const src = i.identity.source;
    return gate('connect', 'Connect an AWS account first', [intro, ENV_WINS.has(src)
      ? `${src} is set in the dashboard's environment. prism-cli uses it before AWS_PROFILE and aws connect, so neither would apply. Restart the dashboard without it, then connect an account.`
      : 'Nothing is connected yet: there is no saved aws connect and no AWS_PROFILE.']);
  }
  if (i.identity.credentialType === 'none') {
    const f = i.identity.files;
    return gate('profile', 'The AWS profile is not configured', [
      `${using.label} names a profile that is not in ${f.config} or ${f.credentials}.`,
      using.via === 'AWS_PROFILE'
        ? 'Fix AWS_PROFILE and restart the dashboard, or unset it and connect an account in Settings › AWS.'
        : `Create it (aws configure sso --profile ${using.profile}), or connect another profile in Settings › AWS.`]);
  }

  // Step 2: a setup record, for the account in use.
  const where = `${using.label}${i.region ? `, region ${i.region}` : ''}`;
  if (!s) {
    return gate('setup', 'Set up Security Agent on this machine', [
      'Do this once per machine. Run it in a terminal, from any folder. It shows what it will create and asks before changing anything.',
      `It uses ${where}.`], { copy: { setup: i.commands.setup } });
  }
  if (known && known !== s.account) {
    return gate('mismatch', 'Security Agent is set up for a different account', [
      `The ${setupLabel(s)} is for account ${last4(s.account)}, region ${s.region}. ${using.label} resolves to account ${last4(known)}.`,
      'The commands would run in that account, where this setup does not apply. Set it up for this repo only, change the machine default, or switch back in Settings › AWS.'],
    { copy: { repo: i.commands.repo, replace: i.commands.replace } });
  }

  // Step 3: the lookup.
  const l = i.lookup;
  if (!l) {
    return gate('checking', 'Checking the agent space…', [
      'Read-only calls to AWS: who you are (sts get-caller-identity), the agent spaces (list-agent-spaces, batch-get-agent-spaces) and the two SSM parameters prism-cli uses (ssm get-parameter).',
      `It runs once when the page opens, with ${where}, and is kept until the dashboard stops. Check again refreshes it.`]);
  }
  if (!l.ok) {
    if (l.kind === 'credentials') {
      const sso = i.identity.credentialType === 'sso';
      return gate('sso', 'Your AWS sign-in has expired or does not work', [`The AWS CLI said: ${l.error}`,
        sso ? 'Sign in again in a terminal, then retry:' : `Refresh the credentials for profile ${using.profile} (${i.identity.credentialLabel}), then retry.`],
      { copy: sso ? { login: `aws sso login --profile ${using.profile}` } : {} });
    }
    if (l.kind === 'denied') {
      return gate('denied', 'This profile cannot read Security Agent', [`Access denied${l.action ? ` for ${l.action}` : ''}: ${l.error}`,
        `${using.label} needs these read permissions: ${LOOKUP_GRANTS.join(', ')}. Ask your AWS admin to add them, or connect a profile that has them.`], { action: l.action });
    }
    return gate('error', 'The agent-space check failed', [l.error, 'Retry. If it keeps failing, run the status check in a terminal: prism-cli enable security --status.']);
  }
  if (!l.inUse || !l.scanBucket) {
    const what = !l.inUse
      ? `Account ${l.account4} in ${l.region} has no agent space set up for prism-cli: SSM /prism/continuum/agent-space-id is not set, or names a space that no longer exists.`
      : `SSM /prism/continuum/scan-bucket is not set in account ${l.account4}, ${l.region}.`;
    return gate('nospace', 'The agent space is missing', [what, 'Run enable security again. It shows what it will recreate and asks first:'],
      { copy: s.source === 'repo' ? { repo: i.commands.repoSetup } : { setup: i.commands.setup } });
  }
  return gate('ready', 'Security Agent ready', []);
}
