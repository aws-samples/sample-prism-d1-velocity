/**
 * Routes behind the Setup page:
 *   GET  /api/setup      action catalog, repo ids, copy-only commands, AWS identity (no AWS call)
 *   GET  /api/action/status  the current or last action and its redacted output
 *   GET  /api/recheck    rebuilds the dashboard data now (status checks)
 *   POST /api/action     start an allowlisted action
 *   POST /api/check-now  one read-only sts get-caller-identity
 * Account ids and ARNs appear only here and in the page, never in `dashboard --json`.
 */
import { gitleaksInstallHint, shellPath } from './setup.js';
import { ACTIONS, displayCommand, redact, repoId, type ActionId, type ActionRunner, type ApiResult } from './actions.js';
import { checkNow, checkNowAws, resolveAwsIdentity, type CheckNowDeps, type IdentityDeps } from './aws-identity.js';
import { loadConnection } from '../aws/connection.js';
import { tildeHome } from './payload.js';

/** Commands the page shows as Copy only: each writes to AWS, needs a terminal, or both. */
export const COPY_ONLY = {
  enableSecurity: 'prism-cli enable security',
  addDeveloper: 'prism-cli team add-developer <email>',
  codeReview: 'prism-cli security code-review',
  threatModel: 'prism-cli security threat-model',
  pentest: 'prism-cli security pentest',
  awsConnect: 'prism-cli aws connect',
};

export interface SetupApiDeps {
  runner: ActionRunner;
  repoPaths(): Promise<string[]>;
  identity: IdentityDeps;
  /** Where repo-less actions run, for the confirm dialog. */
  cwd: string;
  refresh(): Promise<unknown>;
  checkAws?: CheckNowDeps['aws'];
  now?: () => Date;
}

export function setupApi(d: SetupApiDeps) {
  const catalog = () => (Object.keys(ACTIONS) as ActionId[]).map((id) => {
    const a = ACTIONS[id];
    return {
      id, label: a.label, command: displayCommand(a.args), repo: !!a.repo, url: !!a.url, confirm: !!a.confirm,
      readOnlyAws: !!a.readOnlyAws, timeoutSec: a.timeoutMs / 1000, available: d.runner.available(id),
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
          aws: resolveAwsIdentity(d.identity),
        };
      },
      '/api/action/status': async () => d.runner.status(),
      '/api/recheck': async () => d.refresh(),
    },
    postApi: {
      '/api/action': (body: unknown): Promise<ApiResult> => d.runner.start(body),
      '/api/check-now': (body: unknown): Promise<ApiResult> => {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
          return Promise.resolve({ status: 400, json: { error: 'check-now takes an empty JSON object' } });
        }
        return d.runner.exclusive(() => checkNow({
          identity: resolveAwsIdentity(d.identity),
          saved: loadConnection(d.identity.home, d.identity.repoRoot),
          aws: d.checkAws ?? checkNowAws,
          now: d.now ?? (() => new Date()),
          redact,
        }));
      },
    },
  };
}
