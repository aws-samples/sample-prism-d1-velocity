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
import { ADVICE, type Effort } from './advice.js';
import { awsCheck, resultsRoot, type CheckOptions, type CheckRunDeps } from './run-check.js';

export const RECOMMEND_NOTICE = 'No AWS calls (aws recommend): it reads the latest aws check result in .prism/results/. Nothing in AWS is changed.';
const EFFORT_RANK: Record<Effort, number> = { quick: 0, medium: 1, large: 2 };

export interface RecommendOptions extends Pick<CheckOptions, 'profile' | 'region' | 'profileSource' | 'connection'> {
  account?: string;
  refresh?: boolean;
  json?: boolean;
  markdown?: boolean;
}

export interface Recommendation {
  /** fix: a FAIL. access: an INDETERMINATE check (grant read access). */
  kind: 'fix' | 'access';
  id: string;
  section: string;
  severity: Severity;
  effort: Effort;
  title: string;
  why: string;
  steps: string[];
  command: string | null;
  doc: string | null;
  /** What the check found. */
  detail: string;
}

function toRecommendation(f: Finding): Recommendation {
  const a = ADVICE[f.id];
  const base = { id: f.id, section: f.category, severity: f.severity, detail: f.detail };
  if (f.status === 'INDETERMINATE') {
    const needs = a?.needs?.length ? `Grant ${a.needs.join(', ')} (read-only), then re-run prism-cli aws check.` : 'Grant read access for this check, then re-run prism-cli aws check.';
    return {
      ...base, kind: 'access', effort: 'quick', title: a?.indeterminate ? a.title : `Grant read access to check: ${f.title}`,
      why: 'The check could not run, so it is not a pass.', steps: [a?.indeterminate ?? needs], command: null, doc: a?.doc ?? null,
    };
  }
  // A check id with no mapping (an older result): fall back to the check's own remediation.
  if (!a) return { ...base, kind: 'fix', effort: 'medium', title: f.title, why: f.detail, steps: f.remediation ? [f.remediation] : [], command: null, doc: null };
  return { ...base, kind: 'fix', effort: a.effort, title: a.title, why: a.why, steps: a.steps, command: a.command ?? null, doc: a.doc };
}

/** Severity first, then effort (quick wins first), then id. */
export function rank(a: Recommendation, b: Recommendation): number {
  return severityRank(b.severity) - severityRank(a.severity) || EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort] || a.id.localeCompare(b.id);
}

export interface SectionAdvice { section: string; heading: string; fixes: Recommendation[]; access: Recommendation[] }

/** FAILs and INDETERMINATEs as recommendations, grouped by section in aws check's order, each group ranked. */
export function buildRecommendations(checks: Finding[]): SectionAdvice[] {
  const recs = checks.filter((f) => f.status !== 'PASS').map(toRecommendation);
  const known = SECTIONS.map((s) => [s.name, s.heading] as const);
  const extra = [...new Set(recs.map((r) => r.section))].filter((s) => !known.some(([n]) => n === s)).map((s) => [s, s] as const);
  return [...known, ...extra].map(([section, heading]) => ({
    section, heading,
    fixes: recs.filter((r) => r.section === section && r.kind === 'fix').sort(rank),
    access: recs.filter((r) => r.section === section && r.kind === 'access').sort(rank),
  })).filter((g) => g.fixes.length || g.access.length);
}

/** The newest aws-check result, optionally for one account and region. */
export function latestCheck(entries: ResultEntry[], account?: string, region?: string): ResultEntry | null {
  return entries
    .filter((e) => e.result.kind === 'aws-check' && e.result.aws_check && (!account || e.result.aws_check.account === account) && (!region || e.result.aws_check.region === region))
    .sort((a, b) => b.result.started_at.localeCompare(a.result.started_at))[0] ?? null;
}

const header = (r: PrismResult) => {
  const c = r.aws_check!;
  return `account ${c.account}${c.alias ? ` (${c.alias})` : ''}, region ${c.region}`;
};

export function renderText(r: PrismResult, groups: SectionAdvice[], source: string): string[] {
  const out = [`AWS recommendations for ${header(r)}`, `   From aws check at ${r.started_at} (${source}).`, ''];
  if (!groups.length) return [...out, 'Nothing to fix: every check passed.'];
  let n = 0;
  for (const g of groups) {
    out.push(`── ${g.heading} ──`, '');
    for (const x of g.fixes) {
      out.push(`  ${++n}. [${x.severity} · ${x.effort}] ${x.title}`, `     Why: ${x.why}`, `     Found: ${x.detail}`);
      for (const s of x.steps) out.push(`     - ${s}`);
      if (x.command) out.push(`     Run: ${x.command}`);
      if (x.doc) out.push(`     Docs: ${x.doc}`);
      out.push('');
    }
    if (g.access.length) {
      out.push('  Could not check (not a pass):');
      for (const x of g.access) out.push(`  - [${x.severity}] ${x.title}: ${x.steps[0]}`);
      out.push('');
    }
  }
  return out;
}

export function renderMarkdown(r: PrismResult, groups: SectionAdvice[], source: string): string {
  const out = [`# AWS recommendations`, '', `For ${header(r)}, from \`prism-cli aws check\` at ${r.started_at} (${source}). Generated by \`prism-cli aws recommend\`; no AWS or model calls.`, ''];
  if (!groups.length) out.push('Nothing to fix: every check passed.', '');
  let n = 0;
  for (const g of groups) {
    out.push(`## ${g.heading}`, '');
    for (const x of g.fixes) {
      out.push(`### ${++n}. ${x.title}`, '', `**${x.severity}**, effort ${x.effort}. ${x.why}`, '', `Found: ${x.detail}`, '');
      for (const s of x.steps) out.push(`- ${s}`);
      if (x.command) out.push(`- Run \`${x.command}\``);
      if (x.doc) out.push(`- Docs: ${x.doc}`);
      out.push('');
    }
    if (g.access.length) {
      out.push('Could not check (not a pass):', '');
      for (const x of g.access) out.push(`- **${x.severity}** ${x.title}: ${x.steps[0]}`);
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
  const groups = buildRecommendations(entry.result.aws_check!.checks);
  if (!account) say(`Using the latest result (${entry.result.aws_check!.account}); pass --account to choose another account.`);
  if (input.json) d.log(JSON.stringify({ schema: 'prism.aws-recommend.v1', account: entry.result.aws_check!.account, region: entry.result.aws_check!.region, checked_at: entry.result.started_at, source, groups }, null, 2));
  else for (const l of renderText(entry.result, groups, source)) d.log(l);
  if (input.markdown) {
    const md = join(entry.root, RESULTS_DIR, `${entry.id}.recommend.md`);
    writeFileSync(md, renderMarkdown(entry.result, groups, source), { mode: 0o600 });
    say(`Wrote ${md}`);
  }
  return 0;
}
