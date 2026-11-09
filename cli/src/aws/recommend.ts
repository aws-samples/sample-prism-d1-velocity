/**
 * `prism-cli aws recommend`: turns the latest aws check result for the
 * account and region into a ranked fix list. Makes no AWS calls (except
 * through --refresh, which runs aws check first) and no model calls.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { severityRank, type Finding, type Severity } from '../utils/audit.js';
import { readResultEntries, RESULTS_DIR, type PrismResult, type ResultEntry } from '../codewatch/results.js';
import { resolveRegion } from '../security/setup.js';
import { SECTIONS } from './check.js';
import { ADVICE, GROUPS, type Effort } from './advice.js';
import { awsCheck, resultsRoot, type CheckOptions, type CheckRunDeps } from './run-check.js';

export const RECOMMEND_NOTICE = 'No AWS calls (aws recommend): it reads the latest aws check result in .prism/results/. Nothing in AWS is changed.';
const EFFORT_RANK: Record<Effort, number> = { quick: 0, medium: 1, large: 2 };

export interface RecommendOptions extends Pick<CheckOptions, 'profile' | 'region' | 'profileSource' | 'connection'> {
  account?: string;
  refresh?: boolean;
  json?: boolean;
  markdown?: boolean;
}

/** Why an INDETERMINATE check could not run, as far as its detail tells. */
export type IndeterminateCause = 'access-denied' | 'no-credential-report' | 'prerequisite' | 'not-integrated' | 'other';

export interface Recommendation {
  /** fix: one or more FAILs. access: one or more INDETERMINATE checks (could not check). */
  kind: 'fix' | 'access';
  /** The recommendation key; checks that share one fix share it (e.g. "budgets"). */
  id: string;
  /** Every check this item covers, worst first. */
  covers: { id: string; title: string; detail: string }[];
  section: string;
  severity: Severity;
  effort: Effort;
  title: string;
  why: string;
  steps: string[];
  command: string | null;
  doc: string | null;
  /** fix only: its position in the ranked list, 1-based across sections. */
  number?: number;
  /** access only. */
  cause?: IndeterminateCause;
}

/** Account and region from the result, filled into the advice's `<account>` and `<region>`. */
export interface AdviceContext { account?: string; region?: string }

const fill = (text: string, c: AdviceContext): string =>
  text.replace(/<region>/g, c.region || '<region>').replace(/<account>/g, c.account || '<account>');

const DENIED = /AccessDenied|UnauthorizedOperation|AuthorizationError|not authorized|Unauthorized/i;
export const NO_REPORT_STEP = 'No credential report exists yet. Run `prism-cli bedrock-protection scan-account` once (it generates one, which is a write) or `aws iam generate-credential-report`, then re-run aws check.';

/** Only an access-denied detail means "grant"; a missing report or a missing prerequisite says what to do first. */
export function indeterminateCause(f: Finding): IndeterminateCause {
  const a = ADVICE[f.id];
  if (a?.indeterminate) return 'not-integrated';
  if (/ReportNotPresent/.test(f.detail)) return 'no-credential-report';
  if (DENIED.test(f.detail)) return 'access-denied';
  if (a?.prerequisite) return 'prerequisite';
  return 'other';
}

type Rankable = Pick<Recommendation, 'severity' | 'effort' | 'id'>;

/** Severity first, then effort (quick wins first), then id. */
export function rank(a: Rankable, b: Rankable): number {
  return severityRank(b.severity) - severityRank(a.severity) || EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort] || a.id.localeCompare(b.id);
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Check ids older results still carry, and the check that replaced them, so a cached result de-duplicates too. */
export const RETIRED_IDS: Record<string, string> = { 'baseline.root-mfa': 'bedrock.root-mfa' };
const adviceId = (id: string) => RETIRED_IDS[id] ?? id;

/** FAILs that share a recommendation key become one fix naming every check it covers. */
function fixes(fails: Finding[], c: AdviceContext): Recommendation[] {
  const byKey = new Map<string, Finding[]>();
  for (const f of fails) {
    const key = ADVICE[adviceId(f.id)]?.key ?? adviceId(f.id);
    byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  return [...byKey.entries()].map(([key, fs]) => {
    // The worst member sets the severity, the section and the lead text; the current id leads a retired one.
    const retired = (id: string) => Number(id in RETIRED_IDS);
    const members = fs.map((f) => ({ f, a: ADVICE[adviceId(f.id)], r: { severity: f.severity, effort: ADVICE[adviceId(f.id)]?.effort ?? 'medium', id: f.id } as Rankable }))
      .sort((x, y) => retired(x.f.id) - retired(y.f.id) || rank(x.r, y.r));
    const lead = members[0];
    const group = GROUPS[key];
    // A check id with no mapping (an older result) falls back to the check's own remediation.
    const steps = unique(members.flatMap(({ f, a }) => (a ? a.steps : f.remediation ? [f.remediation] : []))).map((x) => fill(x, c));
    const cmd = members.map((m) => m.a?.command).find(Boolean);
    const effort = members.map((m) => m.r.effort).sort((x, y) => EFFORT_RANK[x] - EFFORT_RANK[y])[0];
    return {
      kind: 'fix' as const, id: key, section: lead.f.category, severity: lead.f.severity, effort,
      covers: members.map(({ f }) => ({ id: f.id, title: f.title, detail: f.detail })),
      title: fill(group?.title ?? lead.a?.title ?? lead.f.title, c), why: group?.why ?? lead.a?.why ?? lead.f.detail,
      steps, command: cmd ? fill(cmd, c) : null, doc: lead.a?.doc ?? null,
    };
  });
}

function accessItem(f: Finding, numbers: Map<string, number>, c: AdviceContext): Recommendation {
  const a = ADVICE[f.id];
  const cause = indeterminateCause(f);
  let title = `Could not check: ${f.title}`;
  let step = 'The check got no answer (see what it found); re-run prism-cli aws check.';
  if (cause === 'not-integrated') { title = a!.title; step = a!.indeterminate!; }
  else if (cause === 'no-credential-report') { title = 'Create an IAM credential report'; step = NO_REPORT_STEP; }
  else if (cause === 'access-denied') {
    title = `Grant read access to check: ${f.title}`;
    step = a?.needs?.length ? `Grant ${a.needs.join(', ')} (read-only), then re-run prism-cli aws check.` : 'Grant read access for this check, then re-run prism-cli aws check.';
  } else if (cause === 'prerequisite') {
    const n = numbers.get(a!.prerequisite!);
    title = `Checked after another fix: ${f.title}`;
    step = `${GROUPS[a!.prerequisite!]?.first ?? `Fix ${a!.prerequisite}`}${n ? ` in item ${n}` : ''} first, then re-run prism-cli aws check.`;
  }
  return {
    kind: 'access', id: f.id, cause, section: f.category, severity: f.severity, effort: 'quick',
    covers: [{ id: f.id, title: f.title, detail: f.detail }], title, why: 'The check could not run, so it is not a pass.',
    steps: [fill(step, c)], command: null, doc: a?.doc ?? null,
  };
}

/** INDETERMINATE items with the same step (three checks waiting on one credential report) become one. */
function mergeAccess(items: Recommendation[]): Recommendation[] {
  const out = new Map<string, Recommendation>();
  for (const x of [...items].sort(rank)) {
    const prev = out.get(x.steps[0]);
    if (prev) prev.covers.push(...x.covers);
    else out.set(x.steps[0], { ...x, covers: [...x.covers] });
  }
  for (const x of out.values()) {
    if (x.covers.length > 1 && (x.cause === 'access-denied' || x.cause === 'other')) x.title = `${x.title.split(': ')[0]}: ${x.covers.map((v) => v.title).join('; ')}`;
  }
  return [...out.values()];
}

export interface SectionAdvice { section: string; heading: string; fixes: Recommendation[]; access: Recommendation[] }

/**
 * FAILs and INDETERMINATEs as recommendations, grouped by section in aws
 * check's order, each group ranked. Fixes are numbered across sections, so a
 * check that waits on a fix can name it ("item 2").
 */
export function buildRecommendations(checks: Finding[], c: AdviceContext = {}): SectionAdvice[] {
  const fixList = fixes(checks.filter((f) => f.status === 'FAIL'), c);
  const known = SECTIONS.map((s) => [s.name, s.heading] as const);
  const extra = unique(checks.filter((f) => f.status !== 'PASS').map((f) => f.category))
    .filter((s) => !known.some(([n]) => n === s)).map((s) => [s, s] as const);
  const groups: SectionAdvice[] = [...known, ...extra].map(([section, heading]) => ({
    section, heading, fixes: fixList.filter((r) => r.section === section).sort(rank), access: [],
  }));
  const numbers = new Map<string, number>();
  let n = 0;
  for (const g of groups) for (const x of g.fixes) { x.number = ++n; numbers.set(x.id, n); }
  const access = mergeAccess(checks.filter((f) => f.status === 'INDETERMINATE').map((f) => accessItem(f, numbers, c)));
  for (const g of groups) g.access = access.filter((x) => x.section === g.section);
  return groups.filter((g) => g.fixes.length || g.access.length);
}

/** The sections a `--section` run left out; empty for a full run. */
export function skippedSections(r: PrismResult): string[] {
  const ran = r.aws_check?.sections;
  return ran ? SECTIONS.map((s) => s.name).filter((n) => !ran.includes(n)) : [];
}

/**
 * The newest full aws-check result, optionally for one account and region,
 * else the newest `--section` run. A section run is never read as "everything
 * passed" (see `partialNote`).
 */
export function latestCheck(entries: ResultEntry[], account?: string, region?: string): ResultEntry | null {
  const matching = entries
    .filter((e) => e.result.kind === 'aws-check' && e.result.aws_check && (!account || e.result.aws_check.account === account) && (!region || e.result.aws_check.region === region))
    .sort((a, b) => b.result.started_at.localeCompare(a.result.started_at));
  return matching.find((e) => !skippedSections(e.result).length) ?? matching[0] ?? null;
}

const header = (r: PrismResult) => {
  const c = r.aws_check!;
  return `account ${c.account}${c.alias ? ` (${c.alias})` : ''}, region ${c.region}`;
};

/** For a `--section` run: which sections it covers. null for a full run. */
function partialNote(r: PrismResult): string | null {
  if (!skippedSections(r).length) return null;
  return `This aws check covered only ${r.aws_check!.sections.join(', ')} (a --section run); run prism-cli aws check for every section.`;
}

function nothingToFix(r: PrismResult): string {
  return partialNote(r) ? `Nothing to fix in ${r.aws_check!.sections.join(', ')}; the other sections were not checked.` : 'Nothing to fix: every check passed.';
}

/** What the check found; one line per check when an item covers several. */
function found(x: Recommendation): string[] {
  if (x.covers.length === 1) return [`Found: ${x.covers[0].detail}`];
  return [`Covers ${x.covers.length} checks:`, ...x.covers.map((v) => `- ${v.title}: ${v.detail}`)];
}

const coversText = (x: Recommendation) => (x.covers.length > 1 && !x.title.includes(x.covers[1].title) ? ` (covers: ${x.covers.map((v) => v.title).join('; ')})` : '');

export function renderText(r: PrismResult, groups: SectionAdvice[], source: string): string[] {
  const note = partialNote(r);
  const out = [`AWS recommendations for ${header(r)}`, `   From aws check at ${r.started_at} (${source}).`, ...(note ? [`   ${note}`] : []), ''];
  if (!groups.length) return [...out, nothingToFix(r)];
  for (const g of groups) {
    out.push(`── ${g.heading} ──`, '');
    for (const x of g.fixes) {
      out.push(`  ${x.number}. [${x.severity} · ${x.effort}] ${x.title}`, `     Why: ${x.why}`, ...found(x).map((l) => `     ${l}`));
      for (const s of x.steps) out.push(`     - ${s}`);
      if (x.command) out.push(`     Run: ${x.command}`);
      if (x.doc) out.push(`     Docs: ${x.doc}`);
      out.push('');
    }
    if (g.access.length) {
      out.push('  Could not check (not a pass):');
      for (const x of g.access) out.push(`  - [${x.severity}] ${x.title}: ${x.steps[0]}${coversText(x)}`);
      out.push('');
    }
  }
  return out;
}

export function renderMarkdown(r: PrismResult, groups: SectionAdvice[], source: string): string {
  const out = [`# AWS recommendations`, '', `For ${header(r)}, from \`prism-cli aws check\` at ${r.started_at} (${source}). Generated by \`prism-cli aws recommend\`; no AWS or model calls.`, ''];
  const note = partialNote(r);
  if (note) out.push(note, '');
  if (!groups.length) out.push(nothingToFix(r), '');
  for (const g of groups) {
    out.push(`## ${g.heading}`, '');
    for (const x of g.fixes) {
      out.push(`### ${x.number}. ${x.title}`, '', `**${x.severity}**, effort ${x.effort}. ${x.why}`, '', ...found(x), '');
      for (const s of x.steps) out.push(`- ${s}`);
      if (x.command) out.push(`- Run \`${x.command}\``);
      if (x.doc) out.push(`- Docs: ${x.doc}`);
      out.push('');
    }
    if (g.access.length) {
      out.push('Could not check (not a pass):', '');
      for (const x of g.access) out.push(`- **${x.severity}** ${x.title}: ${x.steps[0]}${coversText(x)}`);
      out.push('');
    }
  }
  return out.join('\n');
}

/** Runs `aws recommend`. Returns the exit code. */
export function awsRecommend(input: RecommendOptions, d: CheckRunDeps): number {
  const say = input.json ? d.err : d.log;
  say(input.refresh ? 'aws recommend --refresh: runs prism-cli aws check first (read-only), then reads its result.' : RECOMMEND_NOTICE);
  say('');
  if (input.account && !/^\d{12}$/.test(input.account)) { say(`Error: --account must be a 12-digit account id, got "${input.account}".`); return 1; }
  let account = input.account ?? input.connection?.account;
  const region = resolveRegion(input, d)?.region;
  if (input.refresh) {
    const o = awsCheck({ ...input, json: false, report: !input.json }, { ...d, log: say });
    if (o.code !== 0 && !o.result) return o.code;
    account = o.result?.aws_check?.account ?? account;
    say('');
  }
  const roots = [...new Set([resultsRoot(d), d.home])];
  const entry = latestCheck(roots.flatMap((root) => readResultEntries(root).map((e) => ({ ...e, root }))), account, region) as (ResultEntry & { root: string }) | null;
  if (!entry) {
    const scope = [account ? `account ${account}` : '', region ? `region ${region}` : ''].filter(Boolean).join(', ');
    say(`No aws check result${scope ? ` for ${scope}` : ''}. Run prism-cli aws check first, or prism-cli aws recommend --refresh.`);
    return 1;
  }
  const source = join(entry.root, RESULTS_DIR, `${entry.id}.json`);
  const c = entry.result.aws_check!;
  const groups = buildRecommendations(c.checks, { account: c.account, region: c.region });
  if (!account) say(`Using the latest result (${entry.result.aws_check!.account}); pass --account to choose another account.`);
  if (input.json) d.log(JSON.stringify({ schema: 'prism.aws-recommend.v1', account: entry.result.aws_check!.account, region: entry.result.aws_check!.region, checked_at: entry.result.started_at, sections: c.sections, source, groups }, null, 2));
  else for (const l of renderText(entry.result, groups, source)) d.log(l);
  if (input.markdown) {
    const md = join(entry.root, RESULTS_DIR, `${entry.id}.recommend.md`);
    writeFileSync(md, renderMarkdown(entry.result, groups, source), { mode: 0o600 });
    say(`Wrote ${md}`);
  }
  return 0;
}
