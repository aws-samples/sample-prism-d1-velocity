/**
 * The Security Agent page's server side (#security, #security/<repo-id>).
 *
 * GET /api/security-agent makes no AWS call: per discovered repo it returns the
 * account and region prism-cli would use there (aws-identity.ts, from env and
 * local files), the enable security marker, the exact command line of every
 * page action, and the last agent-space lookup for that account and region.
 *
 * POST /api/security-agent/spaces is the one AWS read the page starts itself,
 * on a click: sts get-caller-identity, securityagent list-agent-spaces and
 * batch-get-agent-spaces, and ssm get-parameter for the agent space and scan
 * bucket prism-cli uses. The same calls `enable security --status` makes. Each
 * call has a 20 s timeout and no shell; a good answer is cached for 5 minutes
 * per profile and region, a failure is never cached, and it runs under the
 * action runner's lock, so it never overlaps a Run.
 *
 * The cached lookup also gates the two AWS-writing actions (code-review and
 * threat-model): the confirm dialog names the account, region and scan bucket
 * from it, and the server refuses those actions without a current lookup.
 *
 * Account ids leave this module as their last 4 digits only.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { AwsResult } from '../utils/aws.js';
import { PROFILE_RE, REGION_RE } from '../aws/connection.js';
import { readSecurityMarker } from '../security/marker.js';
import { listsBucket, PARAM_AGENT_SPACE, PARAM_SCAN_BUCKET } from '../security/setup.js';
import { ACTIONS, displayCommand, redact, type ActionId, type ApiResult, type ScanRepo } from './actions.js';
import { resolveAwsIdentity, type AwsIdentityView, type IdentityDeps } from './aws-identity.js';
import { tildeHome } from './payload.js';

export const LOOKUP_TIMEOUT_MS = 20_000;
export const LOOKUP_TTL_MS = 5 * 60_000;
/** Pages of list-agent-spaces read at most (a page holds many spaces; this only bounds a runaway nextToken). */
export const MAX_SPACE_PAGES = 10;
/** Ids per batch-get-agent-spaces call. shortcut: a conservative chunk; raise it once the API's limit is documented. */
export const BATCH_IDS = 20;
/** The name `security pentest` gives the space it creates for one run (pentest.ts resolveAgentSpace). */
const PENTEST_SPACE_RE = /^pentest-/;

/** The page's actions, in the order the page shows them. Every one runs in the picked repo. */
export const SECURITY_ACTIONS = [
  'security-status', 'security-dry-run', 'security-findings', 'security-threats', 'security-pentest-findings',
  'security-code-review', 'security-code-review-full', 'security-threat-model',
] as const satisfies readonly ActionId[];

/** Where an AWS call goes: the profile only when one was chosen (else the AWS CLI's own chain), always a region. */
export interface AwsTargetArgs { profile: string | null; region: string | null }

/**
 * The --profile and --region the commands get in `repo`, from the same resolution
 * every prism-cli AWS command uses in that repo (env, the repo's
 * .prism/aws.local.json, ~/.prism/aws.json, the default chain). --profile only
 * when a named profile was chosen (AWS_PROFILE or a saved aws connect profile):
 * env keys, a container and the default chain stay with the AWS CLI's own chain.
 */
export function awsTargetFor(identity: AwsIdentityView): AwsTargetArgs {
  const named = !!identity.profile && identity.source !== 'default chain';
  const profile = named && PROFILE_RE.test(identity.profile!) ? identity.profile : null;
  const region = identity.region && REGION_RE.test(identity.region.value) ? identity.region.value : null;
  return { profile, region };
}

export const targetArgs = (t: AwsTargetArgs): string[] => [...(t.profile ? ['--profile', t.profile] : []), ...(t.region ? ['--region', t.region] : [])];
const targetKey = (t: AwsTargetArgs) => `${t.profile ?? ''}|${t.region ?? ''}`;
export const last4 = (account: string) => (account.length > 4 ? '••••' + account.slice(-4) : account);

export interface SpaceRow {
  id: string;
  name: string;
  createdAt: string | null;
  /** The space SSM /prism/continuum/agent-space-id names: the one prism-cli and the CI gate use. */
  inUse: boolean;
  /** A temporary space `security pentest` created for one run. */
  pentest: boolean;
  /** Whether the space lists the scan bucket; null when unknown (no bucket, or not returned). */
  bucketListed: boolean | null;
}

export type Lookup =
  | { ok: true; at: string; profile: string | null; region: string; account4: string; spaces: SpaceRow[]; inUse: string | null; scanBucket: string | null; consoleUrl: string }
  | { ok: false; at: string; profile: string | null; region: string | null; error: string; credentials: boolean };

/** One read-only AWS CLI call, async, no shell, with a timeout. */
export type AwsCall = (args: string[], t: AwsTargetArgs & { timeoutMs: number }) => Promise<AwsResult>;

const READ_VERB = /^(get|list|batch-get|describe)-/;

/** The real call: `aws <args> [--profile p] --region r --output json`, killed after timeoutMs. */
export const execAwsCall: AwsCall = (args, t) => new Promise((resolve) => {
  if (!READ_VERB.test(args[1] || '')) { resolve({ ok: false, json: null, errorCode: 'NotReadOnly', raw: `refused: ${args.slice(0, 2).join(' ')} is not a read call` }); return; }
  const argv = [...args, ...targetArgs(t), '--output', 'json'];
  execFile('aws', argv, { timeout: t.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, AWS_PAGER: '' } }, (err, stdout, stderr) => {
    if (err) {
      const raw = String(stderr || '') || ((err as NodeJS.ErrnoException & { killed?: boolean }).killed ? `timed out after ${Math.round(t.timeoutMs / 1000)} s` : err.message);
      const m = /An error occurred \(([A-Za-z0-9.]+)\)/.exec(raw);
      resolve({ ok: false, json: null, errorCode: m ? m[1] : '', raw });
      return;
    }
    const body = String(stdout || '').trim();
    if (!body) { resolve({ ok: true, json: {}, errorCode: '', raw: '' }); return; }
    try { resolve({ ok: true, json: JSON.parse(body), errorCode: '', raw: body }); } catch { resolve({ ok: false, json: null, errorCode: 'UnparseableResponse', raw: body.slice(0, 200) }); }
  });
});

const CRED_RE = /ExpiredToken|InvalidClientTokenId|UnrecognizedClient|Unable to locate credentials|NoCredentialProviders|SignatureDoesNotMatch|AuthFailure|could not be found|Token has expired|sso|credential_process/i;

/** The first useful line of an AWS CLI error, redacted. */
function errLine(r: AwsResult): string {
  const line = r.raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() || r.errorCode || 'unknown error';
  return redact(line).slice(0, 300);
}

/**
 * Runs the lookup's read-only calls. Returns a failed Lookup (never throws) when
 * the region is unknown, the credentials fail, or a list call is refused.
 */
export async function lookupSpaces(call: AwsCall, t: AwsTargetArgs, now: Date): Promise<Lookup> {
  const at = now.toISOString();
  if (!t.region || !REGION_RE.test(t.region)) return { ok: false, at, profile: t.profile, region: null, error: 'No AWS region is set for this repo. Set one with prism-cli aws connect, or AWS_REGION.', credentials: false };
  const c = { ...t, timeoutMs: LOOKUP_TIMEOUT_MS };
  const fail = (r: AwsResult, what: string, credentials = false): Lookup => ({ ok: false, at, profile: t.profile, region: t.region, error: `${what}: ${errLine(r)}`, credentials });
  const who = await call(['sts', 'get-caller-identity'], c);
  if (!who.ok) return fail(who, 'the credentials did not work', true);
  const account = String(who.json?.Account || '');
  const spaces: any[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_SPACE_PAGES; page++) {
    const r = await call(['securityagent', 'list-agent-spaces', ...(token ? ['--next-token', token] : [])], c);
    if (!r.ok) return fail(r, 'list-agent-spaces failed', CRED_RE.test(r.raw));
    spaces.push(...(r.json?.agentSpaceSummaries || []));
    token = typeof r.json?.nextToken === 'string' && r.json.nextToken ? r.json.nextToken : null;
    if (!token) break;
  }
  const param = async (name: string): Promise<string | null> => {
    const r = await call(['ssm', 'get-parameter', '--name', name], c);
    return r.ok ? (typeof r.json?.Parameter?.Value === 'string' ? r.json.Parameter.Value : null) : null;
  };
  const inUse = await param(PARAM_AGENT_SPACE);
  const scanBucket = await param(PARAM_SCAN_BUCKET);
  const ids = spaces.map((s) => String(s?.agentSpaceId || '')).filter(Boolean);
  const details = new Map<string, any>();
  for (let i = 0; i < ids.length; i += BATCH_IDS) {
    const r = await call(['securityagent', 'batch-get-agent-spaces', '--agent-space-ids', ...ids.slice(i, i + BATCH_IDS)], c);
    // Details are a nicety (created time, bucket listed): a refused batch-get leaves them unknown.
    if (r.ok) for (const s of r.json?.agentSpaces || []) if (s?.agentSpaceId) details.set(String(s.agentSpaceId), s);
  }
  const rows: SpaceRow[] = spaces.filter((s) => s?.agentSpaceId).map((s) => {
    const id = String(s.agentSpaceId), d = details.get(id), name = String(s.name || d?.name || id);
    const buckets = d && Array.isArray(d.awsResources?.s3Buckets) ? d.awsResources.s3Buckets.map((b: unknown) => String(b)) : null;
    const created = d?.createdAt ?? s.createdAt ?? null;
    return {
      id, name, createdAt: created === null || created === undefined ? null : String(created),
      inUse: id === inUse, pentest: PENTEST_SPACE_RE.test(name),
      bucketListed: scanBucket && buckets ? listsBucket(buckets, scanBucket) : null,
    };
  });
  rows.sort((a, b) => Number(b.inUse) - Number(a.inUse) || Number(a.pentest) - Number(b.pentest) || a.name.localeCompare(b.name));
  return {
    ok: true, at, profile: t.profile, region: t.region, account4: last4(account), spaces: rows, inUse: rows.some((r) => r.inUse) ? inUse : null, scanBucket,
    // The region passed REGION_RE (awsTargetFor), so this is fixed text plus a checked value: what enable security prints.
    consoleUrl: `https://${t.region}.console.aws.amazon.com/securityagent/home?region=${t.region}`,
  };
}

/** Good lookups per profile and region for LOOKUP_TTL_MS; the last failure is kept to show, never reused as an answer. */
export class LookupCache {
  private good = new Map<string, Lookup & { ok: true }>();
  private bad = new Map<string, Lookup & { ok: false }>();
  constructor(private call: AwsCall = execAwsCall, private now: () => Date = () => new Date(), private ttlMs = LOOKUP_TTL_MS) {}

  /** The current good lookup for `t`, or null when there is none or it expired. */
  fresh(t: AwsTargetArgs): (Lookup & { ok: true }) | null {
    const g = this.good.get(targetKey(t));
    return g && this.now().getTime() - Date.parse(g.at) < this.ttlMs ? g : null;
  }

  /** What the page shows for `t`: the fresh good lookup, else the last failure, else null. No AWS call. */
  peek(t: AwsTargetArgs): Lookup | null {
    return this.fresh(t) ?? this.bad.get(targetKey(t)) ?? null;
  }

  /** The cached answer when fresh (unless `refresh`), else a new lookup. */
  async get(t: AwsTargetArgs, refresh = false): Promise<{ lookup: Lookup; cached: boolean }> {
    const f = this.fresh(t);
    if (f && !refresh) return { lookup: f, cached: true };
    const l = await lookupSpaces(this.call, t, this.now());
    if (l.ok) { this.good.set(targetKey(t), l); this.bad.delete(targetKey(t)); }
    else { this.bad.set(targetKey(t), l); this.good.delete(targetKey(t)); }
    return { lookup: l, cached: false };
  }
}

export type WriteKind = 'code review' | 'threat model';
export const WRITE_KIND: Partial<Record<ActionId, WriteKind>> = {
  'security-code-review': 'code review', 'security-code-review-full': 'code review', 'security-threat-model': 'threat model',
};

/**
 * The confirm dialog's sentence for an AWS-writing action, from the lookup the
 * server holds. null (with the reason) when it cannot be named yet.
 */
export function writeNotice(kind: WriteKind, repoName: string, l: Lookup | null): { text: string | null; reason: string | null } {
  if (!l || !l.ok) return { text: null, reason: 'Look up agent spaces first, so the dialog can name the account, region and scan bucket.' };
  if (!l.inUse) return { text: null, reason: 'No agent space is set up for prism-cli in this account and region: run enable security first.' };
  if (!l.scanBucket) return { text: null, reason: `SSM ${PARAM_SCAN_BUCKET} is not set in this account and region: run enable security first.` };
  const docs = kind === 'threat model' ? ' Its scope docs at HEAD (default .kiro/specs/*/design.md and requirements.md) are uploaded too.' : '';
  return { text: `Uploads ${repoName} source at HEAD to the scan bucket ${l.scanBucket} in account ${l.account4} / ${l.region} and starts a ${kind} job.${docs}`, reason: null };
}

export interface SecurityAgentDeps {
  /** The dashboard's own discovered repos; the only paths the page can target. */
  repos(): Promise<(ScanRepo & { current: boolean })[]>;
  identity: Omit<IdentityDeps, 'repoRoot'>;
  cache: LookupCache;
  /** The action runner's lock, shared with every Run and Check now. */
  exclusive<T>(fn: () => Promise<T>): Promise<ApiResult>;
}

/** The identity prism-cli resolves inside `repo` (its own .prism/aws.local.json counts). */
export const identityIn = (d: Pick<SecurityAgentDeps, 'identity'>, repoPath: string): AwsIdentityView => resolveAwsIdentity({ ...d.identity, repoRoot: repoPath });

/** AWS-writing commands the page shows as Copy only, with the same profile and region the Run actions get. */
export const COPY_ARGS = {
  enableSecurity: ['enable', 'security'],
  pentestDryRun: ['security', 'pentest', '--dry-run'],
  pentest: ['security', 'pentest'],
  pentestStatus: ['security', 'pentest', '--status'],
} as const;

/** `cd <repo> && prism-cli <args> [--profile p] [--region r]`: what actually runs (or what to paste). */
export function commandLine(args: readonly string[], repoPath: string, home: string, t: AwsTargetArgs): string {
  return `cd ${shellWord(tildeHome(repoPath, home))} && ${displayCommand([...args, ...targetArgs(t)])}`;
}
const shellWord = (p: string) => (/^[~A-Za-z0-9_./@%+,:=-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

/** GET /api/security-agent: no AWS call. */
export async function securityAgentView(d: SecurityAgentDeps) {
  const repos = await d.repos();
  return {
    repos: repos.map((r) => {
      const idn = identityIn(d, r.path);
      const t = awsTargetFor(idn);
      const m = readSecurityMarker(r.path);
      const lookup = d.cache.peek(t);
      const notices = Object.fromEntries(Object.entries(WRITE_KIND).map(([id, kind]) => [id, writeNotice(kind!, r.name, lookup)]));
      return {
        id: r.id, name: r.name, path: tildeHome(r.path, d.identity.home), current: r.current,
        target: { profile: t.profile, region: t.region, source: idn.source, credentialLabel: idn.credentialLabel },
        marker: m ? { agentSpaceId: m.agentSpaceId, codeReviewId: m.codeReviewId, account4: last4(m.account), region: m.region, setupAt: m.setupAt } : null,
        commands: Object.fromEntries(SECURITY_ACTIONS.map((id) => [id, commandLine(ACTIONS[id].args, r.path, d.identity.home, t)])),
        copy: Object.fromEntries(Object.entries(COPY_ARGS).map(([k, args]) => [k, commandLine(args, r.path, d.identity.home, t)])),
        notices,
        lookup,
      };
    }),
    ttlSec: LOOKUP_TTL_MS / 1000,
  };
}

/** POST /api/security-agent/spaces {repo, refresh?}: the lookup for the account and region of that repo. */
export async function securityAgentLookup(d: SecurityAgentDeps, body: unknown): Promise<ApiResult> {
  const bad = (error: string): ApiResult => ({ status: 400, json: { error } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('expected a JSON object');
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== 'repo' && k !== 'refresh');
  if (extra.length) return bad(`unexpected field ${extra[0]}`);
  if (typeof b.repo !== 'string' || !/^[a-f0-9]{16}$/.test(b.repo)) return bad('repo must be an id from the scan list');
  if (b.refresh !== undefined && typeof b.refresh !== 'boolean') return bad('refresh must be true or false');
  const repo = (await d.repos()).find((r) => r.id === b.repo);
  if (!repo) return bad('repo is not in the scan list');
  const t = awsTargetFor(identityIn(d, repo.path));
  return d.exclusive(async () => {
    const r = await d.cache.get(t, b.refresh === true);
    return { ...r, repo: basename(repo.path) };
  });
}
