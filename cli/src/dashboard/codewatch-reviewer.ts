/**
 * GET /api/codewatch/reviewer?repo=<id>: the repo page's reviewer and model
 * card. Which reviewer and model a push would use in that repo, where each
 * comes from, which tools are installed, and, for a proposed change
 * (&scope=&reviewer=&model= or &reset=1), whether the team pin makes it moot
 * and, for the team scope, the .prism/config.json diff it would write.
 *
 * Read-only: one `git config --list` in the repo and one file read. The repo
 * id is matched against the dashboard's own scan list; nothing from the
 * request becomes a path or an argument. Writes go through the allowlisted
 * codewatch-reviewer-* actions (actions.ts), which run `prism-cli codewatch reviewer`.
 */
import { ADAPTERS, detectReviewers, isReviewerId, REVIEWER_IDS, type ReviewerId } from '../codewatch/reviewers/index.js';
import { CLAUDE_MODEL_SUGGESTIONS, PRECEDENCE, isScope, lineDiff, ORIGIN_LABEL, pinWarning, reviewerView, settingError, teamFiles } from '../codewatch/reviewer-settings.js';
import { CONFIG_PATH, MODEL_ID_RE, reviewModelGitKey } from '../codewatch/config.js';
import { repoId } from './actions.js';
import { tildeHome } from './payload.js';
import { GIT_CONFIG_LIST, gitRunner, parseConfigList, type GitRunner } from './setup.js';

export interface ReviewerDeps {
  repoPaths(): Promise<string[]>;
  pathEnv?: string;
  git?: GitRunner;
}

export async function codewatchReviewer(d: ReviewerDeps, q: URLSearchParams): Promise<{ status: number; json: unknown }> {
  const id = q.get('repo');
  if (!id || !/^[a-f0-9]{16}$/.test(id)) return { status: 400, json: { error: 'repo must be an id from the scan list' } };
  const path = (await d.repoPaths()).find((p) => repoId(p) === id);
  if (!path) return { status: 404, json: { error: 'repo is not in the scan list' } };
  const out = await (d.git ?? gitRunner)(path, GIT_CONFIG_LIST);
  const view = reviewerView(path, out === null ? [] : parseConfigList(out), detectReviewers(d.pathEnv ?? process.env.PATH));
  const labels = Object.fromEntries(Object.entries(ORIGIN_LABEL));
  const tools = REVIEWER_IDS.map((t) => ({ id: t, name: ADAPTERS[t].displayName, binary: ADAPTERS[t].binary, installed: view.installed[t], modelKey: reviewModelGitKey(t),
    suggestions: t === 'claude' ? CLAUDE_MODEL_SUGGESTIONS : [] }));
  const body: Record<string, unknown> = { repo: id, view, labels, tools, teamFile: CONFIG_PATH, modelPattern: MODEL_ID_RE.source, precedence: PRECEDENCE };
  const scope = q.get('scope');
  if (scope !== null) {
    const reset = q.get('reset') === '1';
    const reviewer = q.get('reviewer') ?? undefined;
    const model = q.get('model') ?? undefined;
    const err = settingError({ scope, reviewer, model, reset });
    if (err) return { status: 400, json: { error: err } };
    const r = isReviewerId(reviewer) ? (reviewer as ReviewerId) : undefined;
    body.proposal = {
      warning: isScope(scope) ? pinWarning(view, scope, model, r) : null,
      ...(scope === 'team' ? (() => { const f = teamFiles(path, { reviewer: r, model, reset }); return { diff: lineDiff(f.before ?? '', f.after), created: f.before === null }; })() : {}),
    };
  }
  return { status: 200, json: body };
}

/** `git config --get-regexp` output ("key value" lines) as the reviewer keys it names. */
function reviewerKeys(out: string | null): { reviewer: string | null; models: Record<ReviewerId, string | null> } {
  const kv = new Map<string, string>();
  for (const line of (out || '').split('\n')) { const m = /^(\S+)\s?(.*)$/.exec(line.trim()); if (m) kv.set(m[1].toLowerCase(), m[2].trim()); }
  return { reviewer: kv.get('prism.reviewer') || null, models: Object.fromEntries(REVIEWER_IDS.map((id) => [id, kv.get(reviewModelGitKey(id).toLowerCase()) || null])) as Record<ReviewerId, string | null> };
}
const KEYS_RE = ['--get-regexp', '^prism\\.(reviewer|kiromodel|claudemodel)$'];

/**
 * GET /api/codewatch/defaults: Settings › Repos' "Codewatch default". Your
 * default reviewer and model (git config --global) and the repos that override
 * it (git config --local in each repo of the scan list). Read-only git; repo
 * paths leave as ~ and with their scan-list id.
 */
export async function codewatchDefaults(d: ReviewerDeps & { home: string; label?: (p: string) => string }): Promise<unknown> {
  const git = d.git ?? gitRunner;
  const paths = await d.repoPaths();
  const global = reviewerKeys(await git(d.home, ['config', '--global', ...KEYS_RE]));
  const local = await Promise.all(paths.map((p) => git(p, ['config', '--local', ...KEYS_RE])));
  const tilde = (p: string) => tildeHome(p, d.home);
  const overrides = paths.map((p, i) => ({ p, k: reviewerKeys(local[i]) }))
    .filter(({ k }) => k.reviewer || Object.values(k.models).some(Boolean))
    .map(({ p, k }) => ({ id: repoId(p), name: d.label ? d.label(p) : p.split('/').pop(), path: tilde(p), ...k }));
  const available = detectReviewers(d.pathEnv ?? process.env.PATH);
  return {
    global, overrides, repoCount: paths.length, precedence: PRECEDENCE, modelPattern: MODEL_ID_RE.source,
    tools: REVIEWER_IDS.map((t) => ({ id: t, name: ADAPTERS[t].displayName, binary: ADAPTERS[t].binary, installed: available.includes(t), modelKey: reviewModelGitKey(t), suggestions: t === 'claude' ? CLAUDE_MODEL_SUGGESTIONS : [] })),
  };
}
