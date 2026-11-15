/**
 * Routes behind the Settings page:
 *   GET  /api/setup      action catalog, repo ids, copy-only commands, AWS identity (no AWS call)
 *   GET  /api/action/status  the current or last action and its redacted output
 *   GET  /api/recheck    rebuilds the dashboard data now (status checks)
 *   POST /api/action     start an allowlisted action
 *   GET  /api/accountguard           AccountGuard's data (cached aws check results; no AWS call; accountguard.ts)
 *   POST /api/accountguard/baseline  {run}: mark a run as the baseline (a local file only)
 *   POST /api/update-check  asks the npm registry for the latest prism-cli now (one GET)
 *   GET  /api/security-agent         the Security Agent page's data (no AWS call; security-agent.ts)
 *   POST /api/security-agent/spaces  {repo, refresh?}: the read-only agent-space lookup
 * Account ids and ARNs appear only here and in the page, never in `dashboard --json`.
 */
import { gitleaksInstallHint, shellPath } from './setup.js';
import { ACTIONS, displayCommand, redact, repoId, type ActionId, type ActionRunner, type ApiResult } from './actions.js';
import { profileChoices, resolveAwsIdentity, type IdentityDeps } from './aws-identity.js';
import { accountGuardView, setBaseline, type AccountGuardDeps } from './accountguard.js';
import { tildeHome } from './payload.js';
import type { VersionInfo } from './update-check.js';
import { securityAgentLookup, securityAgentView, type SecurityAgentDeps } from './security-agent.js';

/** Commands the page shows as Copy only: each writes to AWS, needs a terminal, or both. */
export const COPY_ONLY = {
  enableSecurity: 'prism-cli enable security',
  addDeveloper: 'prism-cli team add-developer <email>',
  codeReview: 'prism-cli security code-review',
  threatModel: 'prism-cli security threat-model',
  pentest: 'prism-cli security pentest',
};

export interface SetupApiDeps {
  runner: ActionRunner;
  repoPaths(): Promise<string[]>;
  identity: IdentityDeps;
  /** Where repo-less actions run, for the confirm dialog. */
  cwd: string;
  refresh(): Promise<unknown>;
  /** The Updates tab's Check now: asks the npm registry now, past the once-a-day limit. Absent: the route answers 404-like. */
  checkUpdate?: () => Promise<VersionInfo>;
  now?: () => Date;
  /** The Security Agent page's routes; absent: they answer 400. */
  securityAgent?: SecurityAgentDeps;
  /** AccountGuard's routes; absent: they answer 400. */
  accountGuard?: AccountGuardDeps;
}

const emptyObject = (b: unknown) => !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length === 0;

/** Where the Updates tab's Release notes link goes (https, a fixed constant). */
export const RELEASES_URL = 'https://github.com/aws-samples/sample-prism-d1-velocity/releases';

export function setupApi(d: SetupApiDeps) {
  const catalog = () => (Object.keys(ACTIONS) as ActionId[]).map((id) => {
    const a = ACTIONS[id];
    return {
      id, label: a.label, command: displayCommand(a.args, a.program), repo: !!a.repo, url: !!a.url, confirm: !!a.confirm,
      readOnlyAws: !!a.readOnlyAws, installs: !!a.installs, writesAws: !!a.writesAws, note: a.note ?? null, choose: !!a.choose, connected: !!a.connected, inHome: !!a.inHome, confirmLabel: a.confirmLabel ?? null, timeoutSec: a.timeoutMs / 1000, available: d.runner.available(id),
    };
  });
  return {
    getApi: {
      '/api/setup': async () => {
        const paths = await d.repoPaths();
        return {
          actions: catalog(),
          repoIds: Object.fromEntries(paths.map((p) => [p, repoId(p)])),
          /** `cd <repo>` prefixes for the copy-only per-repo commands. */
          repoCd: Object.fromEntries(paths.map((p) => [p, `cd ${shellPath(p)}`])),
          cwd: tildeHome(d.cwd, d.identity.home),
          copy: { ...COPY_ONLY, gitleaks: gitleaksInstallHint() },
          links: { releases: RELEASES_URL },
          // The Connect picker's choices: section names and configured regions only, read fresh (aws-identity.ts profileChoices).
          aws: { ...resolveAwsIdentity(d.identity), choices: profileChoices(d.identity) },
        };
      },
      '/api/action/status': async () => d.runner.status(),
      '/api/recheck': async () => d.refresh(),
      '/api/security-agent': async () => (d.securityAgent ? securityAgentView(d.securityAgent) : { repos: [], ttlSec: 0 }),
      '/api/accountguard': async () => (d.accountGuard ? accountGuardView(d.accountGuard) : null),
    },
    postApi: {
      '/api/action': (body: unknown): Promise<ApiResult> => d.runner.start(body),
      '/api/security-agent/spaces': async (body: unknown): Promise<ApiResult> =>
        d.securityAgent ? securityAgentLookup(d.securityAgent, body) : { status: 400, json: { error: 'the Security Agent page is not available here' } },
      '/api/accountguard/baseline': async (body: unknown): Promise<ApiResult> =>
        d.accountGuard ? setBaseline(d.accountGuard, body) : { status: 400, json: { error: 'AccountGuard is not available here' } },
      '/api/update-check': async (body: unknown): Promise<ApiResult> => {
        if (!emptyObject(body)) return { status: 400, json: { error: 'update-check takes an empty JSON object' } };
        if (!d.checkUpdate) return { status: 400, json: { error: 'the update check is not available here' } };
        return { status: 200, json: await d.checkUpdate() };
      },
    },
  };
}
