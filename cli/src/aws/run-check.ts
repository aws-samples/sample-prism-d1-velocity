/**
 * Runs `prism-cli aws check`: resolve the target, print the identity header,
 * run the selected sections, save the result (kind aws-check) and print the
 * report. Synchronous on purpose: every AWS call is a blocking CLI read, and
 * the tests drive it through the fake `aws` binary.
 */
import { aws, type AwsTarget } from '../utils/aws.js';
import { parseFailOn, renderReport, type Finding } from '../utils/audit.js';
import type { RunResult } from '../utils/exec.js';
import { makeResult, writeResult, type AwsCheckInfo, type PrismResult } from '../codewatch/results.js';
import { NO_REGION_MESSAGE, printIdentity, resolveRegion, type Resolved, type SecurityOptions } from '../security/setup.js';
import { repoRootOf } from './connection.js';
import { breaching, countFindings, failBySeverity, securityContext, selectSections, type CheckContext } from './check.js';

export const CHECK_NOTICE = 'Read-only (aws check): every AWS call is a describe, get or list; nothing in AWS is changed. The result is saved to .prism/results/.';

export interface CheckOptions extends Pick<SecurityOptions, 'profile' | 'region' | 'profileSource' | 'connection'> {
  section?: string[];
  failOn?: string;
  json?: boolean;
  /** false: save the result but print no report (aws recommend --refresh --json). */
  report?: boolean;
}

export interface CheckRunDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  cwd(): string;
  configRegion(profile?: string): string | null;
  awsVersion(): string | null;
  git(args: string[]): RunResult;
  log(line?: string): void;
  err(line?: string): void;
  now(): Date;
}

export interface CheckOutcome { code: number; result?: PrismResult; path?: string }

/** Where results go: the repo of the working directory, else ~ (so ~/.prism/results/). */
export function resultsRoot(d: Pick<CheckRunDeps, 'cwd' | 'git' | 'home'>): string {
  return repoRootOf(d.cwd(), d.git) ?? d.home;
}

export function awsCheck(input: CheckOptions, d: CheckRunDeps): CheckOutcome {
  const say = input.json ? d.err : d.log;
  // Bad flags print only the Error line, before the notice.
  let failOn;
  try { failOn = parseFailOn(input.failOn); } catch (e) { say(`Error: ${(e as Error).message}`); return { code: 1 }; }
  const sections = selectSections(input.section);
  if ('error' in sections) { say(`Error: ${sections.error}`); return { code: 1 }; }
  say(CHECK_NOTICE);
  say('');
  const r = resolveRegion(input, d);
  if (!r) { say(`Error: ${NO_REGION_MESSAGE} Or save one with prism-cli aws connect.`); return { code: 1 }; }
  const region = r.region;
  // The region is pinned in the child env too, so global-endpoint calls (IAM, budgets) never depend on profile config.
  const target: AwsTarget = { profile: input.profile, env: { AWS_PAGER: '', AWS_REGION: region, AWS_DEFAULT_REGION: region } };

  const who = aws(['sts', 'get-caller-identity'], target);
  const account = who.ok ? String(who.json?.Account || '') : '';
  if (!account) {
    const why = who.errorCode || who.raw.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'no account in the response';
    say(`Error: cannot resolve the AWS identity: ${why}. Sign in (e.g. aws sso login), pass --profile, or run prism-cli aws connect.`);
    return { code: 1 };
  }
  const a = aws(['iam', 'list-account-aliases'], target);
  const alias = a.ok && a.json?.AccountAliases?.[0] ? String(a.json.AccountAliases[0]) : null;
  const opts: Resolved = { ...input, region, regionSource: r.source };
  const security = securityContext(opts, (args, rg) => aws([...args, '--region', rg], target), d.env, d.awsVersion, say);
  printIdentity(security, { account, arn: String(who.json?.Arn || ''), alias });
  say('');

  const started = d.now().toISOString();
  const ctx: CheckContext = { target, account, region, home: d.home, security };
  const findings: Finding[] = sections.flatMap((s) => s.run(ctx));
  const info: AwsCheckInfo = {
    account, alias, region, profile: input.profile ?? null, profile_source: input.profileSource ?? null,
    sections: sections.map((s) => s.name),
    section_counts: Object.fromEntries(sections.map((s) => [s.name, countFindings(findings.filter((f) => f.category === s.name))])),
    counts: countFindings(findings),
    fail_by_severity: failBySeverity(findings),
    checks: findings,
  };
  const result = makeResult({
    kind: 'aws-check', hook: 'manual', tool: 'prism-cli', started_at: started, finished_at: d.now().toISOString(),
    status: info.counts.fail || info.counts.indeterminate ? 'findings' : 'ok',
    summary: `${info.counts.pass} pass, ${info.counts.fail} fail, ${info.counts.indeterminate} indeterminate`,
    aws_check: info,
  });
  const path = writeResult(resultsRoot(d), result);

  if (input.report !== false) renderReport(findings, {
    title: '☁️  AWS account check',
    subtitle: `Account: ${account}${alias ? ` (${alias})` : ''}    Region: ${region}`,
    groups: sections.map((s) => [s.name, s.heading]),
    json: !!input.json,
    jsonContext: { account, alias, region, sections: info.sections, section_counts: info.section_counts, result_path: path },
  });
  say(`Saved ${path}`);
  say('Next: prism-cli aws recommend (turns these results into a ranked fix list; no AWS calls).');

  const breach = breaching(findings, failOn);
  if (breach.length) {
    d.err(`❌ ${breach.length} finding(s) at or above ${failOn}: ${breach.map((f) => f.id).join(', ')}`);
    return { code: 1, result, path };
  }
  return { code: 0, result, path };
}
