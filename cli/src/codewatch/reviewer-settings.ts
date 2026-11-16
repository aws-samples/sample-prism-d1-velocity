/**
 * Which reviewer and model codewatch's pre-push review uses in one repo, where
 * each comes from, and the writes that change them, per scope:
 *
 *   clone   git config --local prism.reviewer / prism.<tool>Model   (an override for this repo, just me)
 *   team    .prism/config.json eval.reviewer / eval.model            (a committed file; the CI eval gate reads it too)
 *   global  git config --global prism.reviewer / prism.<tool>Model   (my default for every repo)
 *
 * The order is the hook's own (PRECEDENCE below): `git config --get` returns
 * the local value over the global one, so for the reviewer both beat the team
 * file; for the model the team pin wins when it was set for the tool that runs.
 *
 * The answer is never worked out here: resolveReviewer and resolveReviewModel
 * (the functions the pre-push hook runs) decide it, and this module only says
 * which scope supplied the value they used. Used by `prism-cli codewatch
 * reviewer` and the dashboard's repo page.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONFIG_PATH, isDefaultModel, MODEL_ID_RE, modelLabel, readEvalConfig, readPrismConfig, resolveReviewModel, reviewModelGitKey,
  REVIEWER_GIT_CONFIG_KEY, writeEvalConfig,
} from './config.js';
import { ADAPTERS, isReviewerId, resolveReviewer, REVIEWER_IDS, type ReviewerId } from './reviewers/index.js';
import type { RunResult } from '../utils/exec.js';

export const SCOPES = ['clone', 'team', 'global'] as const;
export type Scope = typeof SCOPES[number];
export const isScope = (s: unknown): s is Scope => typeof s === 'string' && (SCOPES as readonly string[]).includes(s);

/** The order resolveReviewer and resolveReviewModel apply, in words, for the page and the docs. */
export const PRECEDENCE = {
  reviewer: 'this repo\'s override (git config --local prism.reviewer), then your default (git config --global prism.reviewer), then the team file (.prism/config.json eval.reviewer), then whichever tool is installed. A chosen tool that is not installed falls back to the installed one.',
  model: 'the team file\'s eval.model when it was set for the reviewer that runs, then this repo\'s override (git config --local prism.<tool>Model), then your default (git config --global prism.<tool>Model), then the tool\'s own default.',
};

/** Claude Code's documented model aliases (`claude --help`). Neither tool has a model list that is sure to need no network. */
export const CLAUDE_MODEL_SUGGESTIONS = ['sonnet', 'opus', 'haiku'];

/** One `git config --list --show-scope` entry: the scope git reports (local, worktree, global, system, command). */
export interface ScopedEntry { scope: string; key: string; value: string | null }

export type Origin = 'team' | 'clone' | 'global' | 'tool default' | 'detected' | 'other git config';

export interface ReviewerView {
  /** What each scope sets (null: not set there). Values are shown as written; resolution ignores invalid ones. */
  team: { reviewer: string | null; model: string | null };
  clone: { reviewer: string | null; models: Record<ReviewerId, string | null> };
  global: { reviewer: string | null; models: Record<ReviewerId, string | null> };
  installed: Record<ReviewerId, boolean>;
  /** The reviewer the settings ask for (before the installed check), and where that came from. */
  wanted: { id: ReviewerId | null; from: Origin };
  /** The reviewer a push would actually run, or null when none is installed. */
  reviewer: ReviewerId | null;
  reviewerFrom: Origin;
  /** Set when the wanted tool is not installed: what runs instead (or that nothing does). */
  fallback: string | null;
  /** The model label a push would use (an id, `auto` or `default`), and its scope. */
  model: string;
  modelFrom: Origin;
  modelNote: string | null;
  /** The team's eval.model when it is a real pin for the reviewer that runs: it wins over every personal model. */
  teamPin: string | null;
}

const last = (entries: ScopedEntry[], key: string) => {
  const k = key.toLowerCase();
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].key === k) return entries[i];
  return undefined;
};
const valueIn = (entries: ScopedEntry[], key: string, scopes: string[]) => {
  const k = key.toLowerCase();
  const e = [...entries].reverse().find((x) => x.key === k && scopes.includes(x.scope));
  return e ? (e.value ?? '').trim() || null : null;
};
const gitOrigin = (scope: string | undefined): Origin => (scope === 'local' || scope === 'worktree' ? 'clone' : scope === 'global' ? 'global' : 'other git config');

/** The view for a repo whose git config is `entries`, with `available` tools on PATH. Reads only `.prism/config.json`. */
export function reviewerView(repoRoot: string, entries: ScopedEntry[], available: ReviewerId[]): ReviewerView {
  const ev = readEvalConfig(repoRoot);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const models = (scopes: string[]) => Object.fromEntries(REVIEWER_IDS.map((id) => [id, valueIn(entries, reviewModelGitKey(id), scopes)])) as Record<ReviewerId, string | null>;
  const gitReviewer = last(entries, REVIEWER_GIT_CONFIG_KEY);
  const choice = resolveReviewer({ gitConfigValue: gitReviewer ? (gitReviewer.value ?? '').trim() || null : null, prismConfigValue: str(ev.reviewer), available });
  const wantedFrom: Origin = gitReviewer && isReviewerId((gitReviewer.value ?? '').trim()) ? gitOrigin(gitReviewer.scope) : isReviewerId(str(ev.reviewer)) ? 'team' : 'detected';
  const wantedId = wantedFrom === 'detected' ? null : wantedFrom === 'team' ? (str(ev.reviewer) as ReviewerId) : ((gitReviewer!.value ?? '').trim() as ReviewerId);
  const reviewer = choice.id;
  const modelKey = reviewer ? last(entries, reviewModelGitKey(reviewer)) : undefined;
  const m = resolveReviewModel({ reviewer, prismConfigValue: ev.model, prismConfigReviewer: ev.reviewer, gitConfigValue: modelKey ? (modelKey.value ?? '').trim() || null : null });
  const modelFrom: Origin = m.source === 'prism-config' ? 'team' : m.source === 'git-config' ? gitOrigin(modelKey?.scope) : 'tool default';
  // The team pin: eval.model for the reviewer that runs (a model set for another tool is skipped, not a pin).
  const pinned = m.source === 'prism-config' ? modelLabel(reviewer, m.model) : null;
  return {
    team: { reviewer: str(ev.reviewer), model: str(ev.model) },
    clone: { reviewer: valueIn(entries, REVIEWER_GIT_CONFIG_KEY, ['local', 'worktree']), models: models(['local', 'worktree']) },
    global: { reviewer: valueIn(entries, REVIEWER_GIT_CONFIG_KEY, ['global']), models: models(['global']) },
    installed: Object.fromEntries(REVIEWER_IDS.map((id) => [id, available.includes(id)])) as Record<ReviewerId, boolean>,
    wanted: { id: wantedId, from: wantedFrom },
    reviewer,
    reviewerFrom: choice.source === 'fallback' || choice.source === 'detected' ? 'detected' : wantedFrom,
    fallback: choice.source === 'fallback' || choice.source === 'none' ? choice.note : null,
    model: reviewer ? modelLabel(reviewer, m.model) : '-',
    modelFrom,
    modelNote: m.note,
    teamPin: pinned,
  };
}

/** Why a requested change is refused, or null. Model `auto`/`default` means the tool's default. */
export function settingError(o: { scope: unknown; reviewer?: unknown; model?: unknown; reset?: boolean }): string | null {
  if (!isScope(o.scope)) return `scope must be one of: ${SCOPES.join(', ')}`;
  if (o.reviewer !== undefined && !isReviewerId(o.reviewer)) return `reviewer must be one of: ${REVIEWER_IDS.join(', ')}`;
  if (o.model !== undefined && (typeof o.model !== 'string' || !MODEL_ID_RE.test(o.model.trim()))) return `model must match ${MODEL_ID_RE.source} (the rule the CI eval gate uses), or be auto/default`;
  if (o.reset) return o.reviewer !== undefined ? 'reset takes no reviewer (it removes every setting at that scope)' : o.model !== undefined ? 'reset takes no model' : null;
  if (o.reviewer === undefined && o.model === undefined) return 'nothing to change: pass a reviewer, a model, or reset';
  if (o.scope === 'global' && o.reviewer === undefined) return 'your default for all repos names a reviewer: pass the reviewer (the model is stored for that tool)';
  return null;
}

export type GitFn = (args: string[]) => RunResult;

/** The team file after a change: eval.reviewer and eval.model as asked, every other key kept. null: remove. */
export function teamPatch(cur: { reviewer?: unknown; model?: unknown }, o: { reviewer?: ReviewerId; model?: string; reset?: boolean }): { reviewer?: string; model?: string } {
  if (o.reset) return { reviewer: undefined, model: undefined };
  const p: { reviewer?: string; model?: string } = {};
  if (o.reviewer) p.reviewer = o.reviewer;
  // eval.model belongs to eval.reviewer: switching the team's tool without a new model drops the old tool's model.
  if (o.model !== undefined) p.model = isDefaultModel(o.model) ? undefined : o.model.trim();
  else if (o.reviewer && isReviewerId(cur.reviewer) && cur.reviewer !== o.reviewer) p.model = undefined;
  return p;
}

/** `.prism/config.json` as it is and as the team change would write it (JSON, two-space indent, as writeEvalConfig does). */
export function teamFiles(repoRoot: string, o: { reviewer?: ReviewerId; model?: string; reset?: boolean }): { before: string | null; after: string } {
  let before: string | null = null;
  try { before = readFileSync(resolve(repoRoot, CONFIG_PATH), 'utf8'); } catch { before = null; }
  const cfg = readPrismConfig(repoRoot);
  const ev = cfg.eval && typeof cfg.eval === 'object' ? cfg.eval : {};
  const next = { ...cfg, eval: { ...ev, ...teamPatch(ev, o) } };
  return { before, after: JSON.stringify(next, null, 2) + '\n' };
}

/** A line diff (LCS) of two small texts: ' ', '-' or '+' before each line. Meant for config files, not large inputs. */
export function lineDiff(a: string, b: string): string[] {
  const x = a.split('\n'), y = b.split('\n');
  if (x[x.length - 1] === '') x.pop();
  if (y[y.length - 1] === '') y.pop();
  // shortcut: O(n*m) table; .prism/config.json is a few dozen lines. Use a real diff library if it ever grows large.
  const t = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push(' ' + x[i]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) out.push('-' + x[i++]); else out.push('+' + y[j++]);
  }
  while (i < x.length) out.push('-' + x[i++]);
  while (j < y.length) out.push('+' + y[j++]);
  return out;
}

/**
 * Applies one change. clone and global write git config (--local / --global,
 * `git config --unset` for a reset or for auto/default); team writes the
 * `.prism/config.json` eval block. Returns the lines to print, or throws with
 * the reason. A reset at clone or global removes prism.reviewer and every
 * prism.<tool>Model at that scope.
 */
export function applySetting(repoRoot: string, git: GitFn, o: { scope: Scope; reviewer?: ReviewerId; model?: string; reset?: boolean }, toolForModel: ReviewerId | null): string[] {
  const out: string[] = [];
  if (o.scope === 'team') {
    const cur = readEvalConfig(repoRoot);
    writeEvalConfig(repoRoot, teamPatch(cur, o));
    out.push(o.reset ? `Removed eval.reviewer and eval.model from ${CONFIG_PATH}` : `Wrote ${CONFIG_PATH} eval: ${JSON.stringify(readEvalConfig(repoRoot))}`);
    out.push(`${CONFIG_PATH} is a repo file: commit it to share the change. The CI eval gate reads it from the base branch.`);
    return out;
  }
  const where = o.scope === 'clone' ? '--local' : '--global';
  const at = ['-C', repoRoot, 'config', where];
  const unset = (key: string) => {
    // --unset fails when the key is not set too: only a key still present is a failure.
    if (!git([...at, '--unset-all', key]).ok && git([...at, '--get', key]).ok) throw new Error(`could not unset git config ${where} ${key}`);
    out.push(`Unset git config ${where} ${key}`);
  };
  const set = (key: string, value: string) => {
    const r = git([...at, key, value]);
    if (!r.ok) throw new Error(`could not write git config ${where} ${key}: ${r.stderr.trim() || 'git failed'}`);
    out.push(`git config ${where} ${key} ${value}`);
  };
  if (o.reset) {
    const keys = [REVIEWER_GIT_CONFIG_KEY, ...REVIEWER_IDS.map(reviewModelGitKey)];
    for (const k of keys) unset(k);
    return out;
  }
  if (o.reviewer) set(REVIEWER_GIT_CONFIG_KEY, o.reviewer);
  if (o.model !== undefined) {
    const tool = o.reviewer ?? toolForModel;
    if (!tool) throw new Error('no reviewer is chosen or installed here, so there is no tool to store the model for: pass the reviewer too');
    if (isDefaultModel(o.model)) unset(reviewModelGitKey(tool));
    else set(reviewModelGitKey(tool), o.model.trim());
  }
  return out;
}

/** What a personal model loses to: the team pin, said plainly, or null. */
export function pinWarning(v: ReviewerView, scope: Scope, model: string | undefined, reviewer: ReviewerId | undefined): string | null {
  if (scope === 'team' || model === undefined || !v.teamPin) return null;
  const runs = reviewer ?? v.reviewer;
  if (runs !== v.reviewer) return null;
  return `The team pins model ${v.teamPin} for ${runs} in ${CONFIG_PATH}, and that wins over a personal model: this change will not affect pushes here. Change the team default instead, or ask the team to remove the pin.`;
}

export const ORIGIN_LABEL: Record<Origin, string> = {
  team: `team file (${CONFIG_PATH})`, clone: 'overridden for this repo (git config --local)', global: 'your default (git config --global)',
  'tool default': "tool default", detected: 'the installed tool', 'other git config': 'git config (system or included file)',
};

/** The local reviewer keys a clone sets: its override of your default. Empty when it follows the default. */
export function localOverrides(entries: ScopedEntry[]): { reviewer: string | null; models: Record<ReviewerId, string | null> } | null {
  const local = ['local', 'worktree'];
  const reviewer = valueIn(entries, REVIEWER_GIT_CONFIG_KEY, local);
  const models = Object.fromEntries(REVIEWER_IDS.map((id) => [id, valueIn(entries, reviewModelGitKey(id), local)])) as Record<ReviewerId, string | null>;
  return reviewer || Object.values(models).some(Boolean) ? { reviewer, models } : null;
}

/**
 * "Apply to all repos": removes the local reviewer keys (prism.reviewer, prism.<tool>Model) from each
 * repo, so every one follows your default. Only git config --local in those repos; .prism/config.json
 * (a committed team file) is never touched. Returns the repos it changed.
 */
export function clearOverrides(roots: string[], git: GitFn): string[] {
  const changed: string[] = [];
  for (const root of roots) {
    let did = false;
    for (const k of [REVIEWER_GIT_CONFIG_KEY, ...REVIEWER_IDS.map(reviewModelGitKey)]) {
      if (!git(['-C', root, 'config', '--local', '--get', k]).ok) continue;
      if (!git(['-C', root, 'config', '--local', '--unset-all', k]).ok) throw new Error(`could not unset git config --local ${k} in ${root}`);
      did = true;
    }
    if (did) changed.push(root);
  }
  return changed;
}

export const displayName = (id: ReviewerId) => ADAPTERS[id].displayName;
