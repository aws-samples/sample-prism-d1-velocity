/**
 * Routes behind the Settings page:
 *   GET  /api/setup      action catalog, repo ids, copy-only commands, AWS identity (no AWS call)
 *   GET  /api/action/status  the current or last action and its redacted output
 *   GET  /api/recheck    rebuilds the dashboard data now (status checks)
 *   POST /api/action     start an allowlisted action
 *   POST /api/action/sign-in-return  {url}: hand the address the browser ended on to the running codeburn sign-in (127.0.0.1 only)
 *   GET  /api/accountguard           AccountGuard's data (cached aws check results; no AWS call; accountguard.ts)
 *   POST /api/accountguard/baseline  {run}: mark a run as the baseline (a local file only)
 *   POST /api/update-check  asks the npm registry for the latest prism-cli now (one GET)
 *   GET  /api/security-agent         the Security Agent page's data (no AWS call; security-agent.ts)
 *   GET  /api/security-agent/gate?repo=<id>  the gate card's re-check for one repo (local files only, no git)
 *   GET  /api/security-agent/scope?repo=<id> what a branch code review would review there (local git only)
 *   GET  /api/security-agent/pentest?repo=<id>  the pentest picker: tracked Dockerfiles, .prism/pentest.json (read-only)
 *   GET  /api/security-agent/pentest/check?repo=<id>&dockerfile=&app_dir=&port=&health_path=  one choice checked, its commands
 *   POST /api/security-agent/spaces  {repo, refresh?}: the read-only agent-space lookup
 *   POST /api/security-agent/repo    {repo}: remember the page's picked repo in ~/.prism/dashboard.json (local file, no AWS)
 *   GET  /api/codewatch/reviewer?repo=<id>[&scope=&reviewer=&model=&reset=1]  the repo page's reviewer and model (git config, .prism/config.json; read-only)
 *   GET  /api/codewatch/defaults     your default reviewer and model (git config --global) and the repos that override it
 *   GET  /api/security-run?repo=<id>&run=<id>  one security run's findings (local result files; security-runs.ts)
 * Account ids and ARNs appear only here and in the page, never in `dashboard --json`.
 */
import { gitleaksInstallHint, shellPath } from './setup.js';
import { configuredSyncUrl } from '../utils/otel-sync-schedule.js';
import { redactUrl } from '../utils/redact.js';
import { ACTIONS, displayCommand, redact, repoId, type ActionId, type ActionRunner, type ApiResult } from './actions.js';
import { profileChoices, resolveAwsIdentity, type IdentityDeps } from './aws-identity.js';
import { accountGuardView, setBaseline, type AccountGuardDeps } from './accountguard.js';
import { tildeHome } from './payload.js';
import type { VersionInfo } from './update-check.js';
import { commandLine, securityAgentGate, securityAgentLookup, securityAgentRemember, securityAgentScope, securityAgentView, securityTargetIn, type SecurityAgentDeps } from './security-agent.js';
import { securityAgentPentest, securityAgentPentestCheck } from './security-pentest.js';
import { securityRunDetail, securityRunLog, type CheckLookup } from './security-runs.js';
import { ApiAnswer } from './server.js';
import { codewatchDefaults, codewatchReviewer } from './codewatch-reviewer.js';

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
  /** The last auto-check of a pending job (security-autocheck.ts), for the run drill-down. */
  securityCheck?: CheckLookup;
}

const emptyObject = (b: unknown) => !!b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length === 0;

/** Where the Updates tab's Release notes link goes (https, a fixed constant). */
export const RELEASES_URL = 'https://github.com/aws-samples/sample-prism-d1-velocity/releases';

export function setupApi(d: SetupApiDeps) {
  const catalog = () => (Object.keys(ACTIONS) as ActionId[]).map((id) => {
    const a = ACTIONS[id];
    return {
      id, label: a.label, command: displayCommand(a.args, a.program), repo: !!a.repo, url: !!a.url, confirm: !!a.confirm,
      readOnlyAws: !!a.readOnlyAws, installs: !!a.installs, writesAws: !!a.writesAws, note: a.note ?? null, choose: !!a.choose, connected: !!a.connected, inHome: !!a.inHome, confirmLabel: a.confirmLabel ?? null, pick: a.pick ?? null, pentest: a.pentest ?? null, detached: !!a.detached, timeoutSec: a.timeoutMs / 1000, available: d.runner.available(id),
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
          // The URL codeburn syncs to now, redacted (no user name or password, secret-looking query values masked;
          // null: none set up, or its config is unreadable), so Sync to team can name it in its confirm dialog. The
          // re-run action reads the real one server side. Live page only: the snapshot drops it.
          codeburnSyncUrl: redactUrl(configuredSyncUrl(d.identity.home) || ''),
          // The Connect picker's choices: section names and configured regions only, read fresh (aws-identity.ts profileChoices).
          aws: { ...resolveAwsIdentity(d.identity), choices: profileChoices(d.identity) },
        };
      },
      '/api/action/status': async () => d.runner.status(),
      '/api/recheck': async () => d.refresh(),
      '/api/security-agent': async () => (d.securityAgent ? securityAgentView(d.securityAgent) : { repos: [], ttlSec: 0 }),
      // The gate card's 10 s re-check: one known repo, local files only (no git, no repo scan). 404: load the full answer.
      '/api/security-agent/gate': async (url: URL) => {
        const g = d.securityAgent ? securityAgentGate(d.securityAgent, url.searchParams.get('repo')) : null;
        return g ?? new ApiAnswer(404, { error: 'not a repo from the last Security Agent answer' });
      },
      // The branch review's scope in the picked repo: local git only (security/review.ts branchScope).
      '/api/security-agent/scope': async (url: URL) => {
        const s = d.securityAgent ? securityAgentScope(d.securityAgent, url.searchParams.get('repo')) : null;
        return s ?? new ApiAnswer(404, { error: 'not a repo from the last Security Agent answer' });
      },
      // The pentest picker: git-tracked Dockerfiles and .prism/pentest.json, read-only (security-pentest.ts). Writes nothing.
      '/api/security-agent/pentest': async (url: URL) => {
        const s = d.securityAgent ? securityAgentPentest(d.securityAgent, url.searchParams.get('repo')) : null;
        return s ?? new ApiAnswer(404, { error: 'not a repo from the last Security Agent answer' });
      },
      '/api/security-agent/pentest/check': async (url: URL) => {
        const s = d.securityAgent ? securityAgentPentestCheck(d.securityAgent, url.searchParams) : null;
        return s ?? new ApiAnswer(404, { error: 'not a repo from the last Security Agent answer' });
      },
      '/api/codewatch/reviewer': async (url: URL) => {
        const r = await codewatchReviewer({ repoPaths: d.repoPaths }, url.searchParams);
        return r.status === 200 ? r.json : new ApiAnswer(r.status, r.json);
      },
      '/api/codewatch/defaults': async () => codewatchDefaults({ repoPaths: d.repoPaths, home: d.identity.home }),
      '/api/accountguard': async () => (d.accountGuard ? accountGuardView(d.accountGuard) : null),
      // Ids only: the repo id is matched against the scan list and the run id against that repo's result files.
      // No such run answers 404 (the page shows Run not found and stops asking); any other failure is retried.
      '/api/security-run': async (url: URL) => {
        const sa = d.securityAgent;
        // Clean up's exact line: the action's args, the run's --job, and the profile and region the commands use in that repo.
        const line = sa ? (path: string, args: string[]) => commandLine([...ACTIONS['security-pentest-cleanup'].args, ...args], path, sa.identity.home, securityTargetIn(sa, path)) : undefined;
        const run = securityRunDetail(sa ? await sa.repos() : [], url.searchParams.get('repo'), url.searchParams.get('run'), d.identity.home, new Date(), undefined, d.securityCheck, line);
        return run.found ? run : new ApiAnswer(404, run);
      },
      // A pentest deploy's log (1.21.7): the end of the run's own .log, redacted, home as ~. Ids only, as above.
      '/api/security-run/log': async (url: URL) => {
        const sa = d.securityAgent;
        const log = securityRunLog(sa ? await sa.repos() : [], url.searchParams.get('repo'), url.searchParams.get('run'), d.identity.home);
        return log.found ? log : new ApiAnswer(404, log);
      },
    },
    postApi: {
      '/api/action': (body: unknown): Promise<ApiResult> => d.runner.start(body),
      '/api/action/sign-in-return': (body: unknown): Promise<ApiResult> => d.runner.signInReturn(body),
      '/api/security-agent/spaces': async (body: unknown): Promise<ApiResult> =>
        d.securityAgent ? securityAgentLookup(d.securityAgent, body) : { status: 400, json: { error: 'the Security Agent page is not available here' } },
      '/api/security-agent/repo': async (body: unknown): Promise<ApiResult> =>
        d.securityAgent ? securityAgentRemember(d.securityAgent, body) : { status: 400, json: { error: 'the Security Agent page is not available here' } },
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
