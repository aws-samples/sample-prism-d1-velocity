import { aws, AwsTarget } from './aws.js';
import { Finding } from './audit.js';

/**
 * Audit Bedrock blast-radius controls -- what bounds runaway model spend, how
 * fast you find out, and whether you can attribute it afterwards.
 *
 * These checks are composed by `bedrock-protection scan-account` alongside the
 * IAM hygiene checks in audit-iam.ts. Repository credential exposure is the
 * third side, covered by `bedrock-protection scan-repo`.
 *
 * Audit-only: every AWS call here is a read.
 */

/**
 * The IAM action for every budget READ is the single coarse `budgets:ViewBudget`
 * -- NOT the API operation name. AWS Budgets authorizes DescribeBudgets,
 * DescribeBudgetNotificationsForAccount and DescribeSubscribersForNotification
 * all against it, and a policy granting the operation names denies every one:
 *
 *   not authorized to perform: budgets:ViewBudget
 *   on resource: arn:aws:budgets::<account>:budget/*
 *   because no identity-based policy allows the budgets:ViewBudget action
 *
 * Measured live, and worth stating in the remediation because the obvious
 * correction -- granting the operation name printed in the error code -- does
 * not work. One constant so the three failure paths cannot drift apart, as the
 * anomaly-monitor title did.
 */
const BUDGET_READ_REMEDIATION =
  'Grant budgets:ViewBudget (the single IAM action covering all budget reads -- '
  + 'granting budgets:DescribeBudgets instead does NOT work) and re-run.';

/**
 * Bedrock spend lands on TWO billing surfaces, and a filter scoped to only the
 * first silently misses the second:
 *
 *   1. `Amazon Bedrock*` services -- first-party models, AgentCore, Knowledge
 *      Bases, Guardrails.
 *   2. `AWS Marketplace` -- every third-party model, billed as a subscription
 *      line item named e.g. "Claude Opus 5 (Amazon Bedrock Edition)".
 *
 * So a budget filtered on Amazon Bedrock alone reports nothing while an attacker
 * burns Opus -- both the priciest option and the likeliest target. The two
 * surfaces are therefore separate checks below, and a budget covering only one
 * does not clear the other.
 */
const BEDROCK_HINTS = ['bedrock'];
const MARKETPLACE_HINTS = ['marketplace'];

function budgetCovers(budget: any, hints: string[]): 'yes' | 'no' | 'unknown' {
  // Older budgets carry CostFilters (dimension -> values). Newer ones carry
  // FilterExpression, a nested tree. Rather than pretend to fully interpret an
  // expression tree, match its serialised form -- and return 'unknown' when
  // neither field is present, because an unrecognised budget must never be
  // counted as coverage.
  const filters = budget?.CostFilters;
  if (filters && Object.keys(filters).length > 0) {
    const blob = JSON.stringify(filters).toLowerCase();
    return hints.some((h) => blob.includes(h)) ? 'yes' : 'no';
  }
  if (budget?.FilterExpression) {
    const blob = JSON.stringify(budget.FilterExpression).toLowerCase();
    return hints.some((h) => blob.includes(h)) ? 'yes' : 'no';
  }
  // No filter at all means the budget covers total account spend. That bounds
  // Bedrock, but only bluntly -- it will not fire until everything else has
  // grown too.
  return 'unknown';
}

/**
 * Only a COST budget bounds spend.
 *
 * BudgetType is one of USAGE, COST, RI_UTILIZATION, RI_COVERAGE,
 * SAVINGS_PLANS_UTILIZATION or SAVINGS_PLANS_COVERAGE. A USAGE budget filtered on
 * Bedrock tracks request counts, and an RI/SP budget tracks commitment
 * efficiency -- neither caps a dollar figure. Treating any of them as coverage
 * would report a spend ceiling that does not exist, which is worse than
 * reporting none because it stops the reader looking.
 */
function isCostBudget(budget: any): boolean {
  return budget?.BudgetType === 'COST';
}

export function auditBudgets(target: AwsTarget | undefined, accountId: string): { findings: Finding[]; coveringBudgets: string[]; listError?: string } {
  // describe-budgets requires an explicit account id, and returns an EMPTY body
  // -- not {"Budgets": []} -- when no budgets exist.
  const bud = aws(['budgets', 'describe-budgets', '--account-id', accountId], target);

  if (!bud.ok) {
    // Propagate the reason. Without it the alerting check below cannot tell
    // "no budget covers Bedrock" from "the budget list could not be read", and
    // would report the former -- a confident statement about state we never saw.
    return { coveringBudgets: [], listError: bud.errorCode || 'the DescribeBudgets call failed', findings: [
      ['bedrock-budget', 'Budget covering Bedrock services'],
      ['marketplace-budget', 'Budget covering Marketplace (Bedrock Edition) models'],
    ].map(([id, title]) => ({
      id, category: 'budget', title,
      status: 'INDETERMINATE' as const, severity: 'HIGH' as const,
      detail: `Could not list budgets (${bud.errorCode || 'unknown error'}).`,
      remediation: BUDGET_READ_REMEDIATION,
    })) };
  }

  const budgets: any[] = bud.json?.Budgets ?? [];

  // Coverage requires BOTH a matching filter and BudgetType === COST.
  const covering = (hints: string[]) =>
    budgets.filter((b) => budgetCovers(b, hints) === 'yes' && isCostBudget(b)).map((b) => b.BudgetName);
  // Matching filter but the wrong budget type: named explicitly, because from
  // the console it looks like a Bedrock budget while capping no dollar figure.
  const wrongType = (hints: string[]) =>
    budgets.filter((b) => budgetCovers(b, hints) === 'yes' && !isCostBudget(b))
      .map((b) => `${b.BudgetName} (BudgetType=${b.BudgetType})`);
  const untargeted = budgets
    .filter((b) => budgetCovers(b, BEDROCK_HINTS) === 'unknown' && isCostBudget(b))
    .map((b) => b.BudgetName);

  const bedrock = covering(BEDROCK_HINTS);
  const marketplace = covering(MARKETPLACE_HINTS);
  const bedrockWrongType = wrongType(BEDROCK_HINTS);
  const marketplaceWrongType = wrongType(MARKETPLACE_HINTS);

  return { coveringBudgets: [...new Set([...bedrock, ...marketplace])], findings: [
    {
      id: 'bedrock-budget', category: 'budget', title: 'Budget covering Bedrock services',
      status: bedrock.length ? 'PASS' : 'FAIL', severity: 'HIGH',
      detail: bedrock.length
        ? `Covered by: ${bedrock.join(', ')}.`
        : budgets.length === 0
          ? 'No budgets exist in this account, so runaway Bedrock spend has no ceiling and raises no alert.'
          : bedrockWrongType.length
            ? `${bedrockWrongType.join(', ')} filters on Bedrock but is not a COST budget, so it caps no dollar figure — it looks like a Bedrock budget in the console while bounding nothing.`
            : `${budgets.length} budget(s) exist but none is a COST budget filtering on a Bedrock service${untargeted.length ? ` (${untargeted.length} cover total account spend, which bounds Bedrock only indirectly)` : ''}.`,
      remediation: bedrock.length ? undefined : 'Create a monthly budget filtered on Service contains "Bedrock", alerting at 50/80/100% to SNS.',
    },
    {
      id: 'marketplace-budget', category: 'budget', title: 'Budget covering Marketplace (Bedrock Edition) models',
      status: marketplace.length ? 'PASS' : 'FAIL', severity: 'HIGH',
      detail: marketplace.length
        ? `Covered by: ${marketplace.join(', ')}.`
        : (marketplaceWrongType.length ? `${marketplaceWrongType.join(', ')} filters on Marketplace but is not a COST budget, so it caps no dollar figure. ` : '')
          + 'No COST budget filters on AWS Marketplace. Third-party models invoked through Bedrock — Anthropic, Meta, Mistral, Cohere — bill as Marketplace subscription line items named "(Amazon Bedrock Edition)", NOT under Amazon Bedrock. A Bedrock-only budget misses them entirely, which is the most expensive blind spot here because Opus-class models are both the priciest and the likeliest target.',
      remediation: marketplace.length ? undefined : 'Add a second COST budget filtered on Service = AWS Marketplace, or define a Cost Category grouping both surfaces and budget on that.',
    },
  ] };
}

/**
 * A budget that alerts nobody is a record, not a control.
 *
 * `describe-budgets` says nothing about whether anyone is told when a threshold
 * is crossed -- notifications and their subscribers are separate resources. A
 * budget created without them still shows a spend bar in the console and still
 * reports as "a Bedrock budget exists", while nothing reaches a human. For
 * LLMjacking specifically, being told is the entire value: the spend has already
 * happened by the time anyone opens the Billing console.
 *
 * `DescribeBudgetNotificationsForAccount` returns notifications for every budget
 * in ONE call. Subscribers need a call per notification, which is why this is
 * scoped to the budgets that actually cover Bedrock rather than all of them.
 */
export function auditBudgetAlerting(
  target: AwsTarget | undefined,
  accountId: string,
  coveringBudgets: string[],
  listError?: string,
): Finding {
  const id = 'budget-alerting';
  const title = 'Bedrock budgets actually notify someone';

  // The budget list never loaded, so "no covering budget" is not something we
  // established -- say so rather than describing an absence we cannot see.
  if (listError) {
    return {
      id, category: 'budget', title,
      status: 'INDETERMINATE', severity: 'HIGH',
      detail: `Could not list budgets (${listError}), so it is unknown whether any Bedrock budget notifies anyone.`,
      remediation: BUDGET_READ_REMEDIATION,
    };
  }

  if (coveringBudgets.length === 0) {
    // Nothing to evaluate. Not a PASS -- no alerting was established -- and not
    // a duplicate FAIL, since bedrock-budget/marketplace-budget already report
    // the absence.
    return {
      id, category: 'budget', title,
      status: 'INDETERMINATE', severity: 'HIGH',
      detail: 'No COST budget covers Bedrock or Marketplace, so there is no budget whose alerting could be checked (see bedrock-budget and marketplace-budget above).',
    };
  }

  const all = aws(['budgets', 'describe-budget-notifications-for-account', '--account-id', accountId], target);
  if (!all.ok) {
    return {
      id, category: 'budget', title,
      status: 'INDETERMINATE', severity: 'HIGH',
      detail: `Could not read budget notifications (${all.errorCode || 'unknown error'}), so it is unknown whether ${coveringBudgets.join(', ')} alerts anyone.`,
      remediation: BUDGET_READ_REMEDIATION,
    };
  }

  const perBudget: any[] = all.json?.BudgetNotificationsForAccount ?? [];
  const silent: string[] = [];
  const unsubscribed: string[] = [];
  let alerting = 0;

  for (const name of coveringBudgets) {
    const entry = perBudget.find((e) => e.BudgetName === name);
    const notifications: any[] = entry?.Notifications ?? [];
    if (notifications.length === 0) { silent.push(name); continue; }

    let subscribers = 0;
    for (const n of notifications) {
      const subs = aws([
        'budgets', 'describe-subscribers-for-notification',
        '--account-id', accountId, '--budget-name', name,
        '--notification', JSON.stringify(n),
      ], target);
      if (subs.ok) subscribers += (subs.json?.Subscribers ?? []).length;
    }
    if (subscribers === 0) unsubscribed.push(name); else alerting++;
  }

  const broken = [...silent, ...unsubscribed];
  return {
    id, category: 'budget', title,
    status: broken.length ? 'FAIL' : 'PASS', severity: 'HIGH',
    detail: broken.length
      ? [
          silent.length ? `${silent.join(', ')} has no notification thresholds at all` : '',
          unsubscribed.length ? `${unsubscribed.join(', ')} has thresholds but no subscribers` : '',
        ].filter(Boolean).join('; ')
        + '. A budget with nothing to notify records the overspend without telling anyone, which reads as protection while providing none.'
      : `All ${alerting} covering budget(s) have at least one threshold with a subscriber.`,
    remediation: broken.length
      ? 'Add notification thresholds (50/80/100%) with an SNS topic or email subscriber. Prefer SNS — it can fan out to a rota rather than one mailbox.'
      : undefined,
  };
}

/**
 * One title constant per check, because this check is pushed from three
 * branches (CE disabled, CE unreadable, CE readable). Inlining the string in
 * each made them drift the moment the check gained its subscription
 * requirement: the same `anomaly-monitor` id reported two different titles
 * depending on account state, which is unstable in --json output.
 */
const ANOMALY_TITLE = 'Cost anomaly monitor covering Bedrock, with an alert subscription';

export function auditDetection(target: AwsTarget | undefined, region: string): Finding[] {  const out: Finding[] = [];

  // Cost Explorer is an account-level opt-in that stays OFF until someone
  // enables it -- measured error: AccessDeniedException "User not enabled for
  // cost explorer access". Every CE-backed check must be gated on this, or the
  // audit reports "no anomaly monitor configured" when the truth is that it
  // could not look.
  const ce = aws(['ce', 'get-anomaly-monitors'], target);
  const ceDisabled = !ce.ok && /not enabled for cost explorer/i.test(ce.raw);

  out.push({
    id: 'cost-explorer-enabled', category: 'detection', title: 'Cost Explorer enabled',
    status: ceDisabled ? 'FAIL' : ce.ok ? 'PASS' : 'INDETERMINATE',
    severity: 'HIGH',
    detail: ceDisabled
      ? 'Cost Explorer is not enabled on this account, so cost anomaly detection is impossible and spend cannot be attributed to a service or model.'
      : ce.ok
        ? 'Cost Explorer is enabled.'
        : `Could not confirm Cost Explorer access (${ce.errorCode || 'unknown error'}).`,
    remediation: ceDisabled ? 'Enable Cost Explorer in Billing settings (management account for an org). It backfills up to 12 months and can take 24h to become queryable.' : undefined,
  });

  if (ceDisabled || !ce.ok) {
    out.push({
      id: 'anomaly-monitor', category: 'detection', title: ANOMALY_TITLE,
      status: 'INDETERMINATE', severity: 'MEDIUM',
      detail: ceDisabled
        ? 'Cannot be checked while Cost Explorer is disabled.'
        : `Could not list anomaly monitors (${ce.errorCode || 'unknown error'}).`,
    });
  } else {
    const monitors: any[] = ce.json?.AnomalyMonitors ?? [];
    const serviceWide = monitors.filter((m) => m.MonitorDimension === 'SERVICE');
    const bedrockScoped = monitors.filter((m) =>
      JSON.stringify(m.MonitorSpecification ?? {}).toLowerCase().includes('bedrock'));
    const covering = [...serviceWide, ...bedrockScoped];

    // A monitor with no subscription is the same failure mode as a budget with
    // no subscriber: it detects the anomaly and tells nobody. Monitors and
    // subscriptions are separate resources, and get-anomaly-monitors reports
    // nothing about whether one is attached, so this needs a second call.
    //
    // Worth knowing: creating a first budget auto-enables Cost Explorer, and AWS
    // then auto-creates a "Default-Services-Monitor" (SERVICE dimension) WITH a
    // subscription -- observed live. So this check often passes as a side effect
    // of setting up budgets rather than deliberately.
    const subs = aws(['ce', 'get-anomaly-subscriptions'], target);
    const coveringArns = new Set(covering.map((m) => m.MonitorArn));
    const subscribed = subs.ok
      ? (subs.json?.AnomalySubscriptions ?? []).some((s: any) =>
          (s.MonitorArnList ?? []).some((arn: string) => coveringArns.has(arn)))
      : null;

    const status = covering.length === 0 ? 'FAIL' : subscribed === null ? 'INDETERMINATE' : subscribed ? 'PASS' : 'FAIL';
    out.push({
      id: 'anomaly-monitor', category: 'detection', title: ANOMALY_TITLE,
      status, severity: 'MEDIUM',
      detail: covering.length === 0
        ? (monitors.length === 0
          ? 'No cost anomaly monitors. A budget only fires once a threshold is crossed; anomaly detection catches spend that is abnormal for this account, which is what a stolen key looks like on day one.'
          : `${monitors.length} monitor(s) exist but none covers Bedrock.`)
        : subscribed === null
          ? `${covering.length} covering monitor(s), but the subscription list could not be read (${subs.errorCode || 'unknown error'}), so it is unknown whether anomalies reach anyone.`
          : subscribed
            ? `${covering.length} covering monitor(s) (${serviceWide.length} SERVICE-dimension, ${bedrockScoped.length} Bedrock-scoped), with an alert subscription attached.`
            : `${covering.length} covering monitor(s) exist but NO subscription references them, so detected anomalies notify nobody — the monitor records them and stops there.`,
      remediation: status === 'PASS' ? undefined
        : covering.length === 0
          ? 'Create a SERVICE-dimension monitor — it covers every service including Marketplace — then attach a subscription with a threshold low enough to fire before the monthly budget would.'
          : 'Attach an anomaly subscription to the monitor. Without one the monitor is detection with no delivery.',
    });
  }

  // CloudWatch is the only fast signal. Cost data lags 12-24h, so a cost-only
  // posture lets a stolen key run for up to a day before anything fires.
  const alarms = aws(['cloudwatch', 'describe-alarms', '--region', region], target);
  if (!alarms.ok) {
    out.push({
      id: 'bedrock-invocation-alarm', category: 'detection', title: 'CloudWatch alarm on Bedrock invocation volume',
      status: 'INDETERMINATE', severity: 'MEDIUM',
      detail: `Could not list alarms in ${region} (${alarms.errorCode || 'unknown error'}).`,
    });
  } else {
    const bedrockAlarms = (alarms.json?.MetricAlarms ?? []).filter((a: any) => a.Namespace === 'AWS/Bedrock');
    out.push({
      id: 'bedrock-invocation-alarm', category: 'detection', title: 'CloudWatch alarm on Bedrock invocation volume',
      status: bedrockAlarms.length ? 'PASS' : 'FAIL', severity: 'MEDIUM',
      detail: bedrockAlarms.length
        ? `${bedrockAlarms.length} alarm(s) on AWS/Bedrock metrics: ${bedrockAlarms.map((a: any) => a.AlarmName).slice(0, 5).join(', ')}.`
        : `No alarms on AWS/Bedrock metrics in ${region}. Cost data lags 12–24h, so budgets and anomaly detection cannot catch a stolen key inside the first day. Token-count metrics are near real-time and are the only fast signal available.`,
      remediation: bedrockAlarms.length ? undefined : 'Alarm on AWS/Bedrock Invocations and InputTokenCount with a threshold above normal peak; it fires in minutes rather than hours.',
    });
  }

  return out;
}

export function auditCommitments(target: AwsTarget | undefined, region: string): Finding {
  const pt = aws(['bedrock', 'list-provisioned-model-throughputs', '--region', region], target);
  if (!pt.ok) {
    return {
      id: 'provisioned-throughput', category: 'commitment', title: 'Provisioned Throughput commitments',
      status: 'INDETERMINATE', severity: 'INFO',
      detail: `Could not list provisioned throughput in ${region} (${pt.errorCode || 'unknown error'}).`,
    };
  }
  const pts: any[] = pt.json?.provisionedModelSummaries ?? [];
  return {
    id: 'provisioned-throughput', category: 'commitment', title: 'Provisioned Throughput commitments',
    status: pts.length ? 'FAIL' : 'PASS',
    severity: pts.length ? 'MEDIUM' : 'INFO',
    detail: pts.length
      ? `${pts.length} commitment(s) in ${region}: ${pts.map((p) => p.provisionedModelName || p.modelArn).slice(0, 5).join(', ')}. These bill monthly whether or not they are used.`
      : `No Provisioned Throughput commitments in ${region}. NOTE: region-scoped — a commitment in another region will not appear here.`,
    remediation: pts.length ? 'Confirm each commitment is intentional and still in use; an abandoned one bills indefinitely.' : undefined,
  };
}

export function auditForensics(target: AwsTarget | undefined, region: string): Finding {
  // Returns an EMPTY body when logging is off -- same trap as describe-budgets.
  const log = aws(['bedrock', 'get-model-invocation-logging-configuration', '--region', region], target);
  if (!log.ok) {
    return {
      id: 'model-invocation-logging', category: 'forensics', title: 'Bedrock model invocation logging',
      status: 'INDETERMINATE', severity: 'MEDIUM',
      detail: `Could not read the logging configuration in ${region} (${log.errorCode || 'unknown error'}).`,
    };
  }
  const cfg = log.json?.loggingConfig;
  const configured = Boolean(cfg && (cfg.cloudWatchConfig || cfg.s3Config));
  return {
    id: 'model-invocation-logging', category: 'forensics', title: 'Bedrock model invocation logging',
    status: configured ? 'PASS' : 'FAIL', severity: 'MEDIUM',
    detail: configured
      ? `Enabled in ${region} (${[cfg.cloudWatchConfig && 'CloudWatch', cfg.s3Config && 'S3'].filter(Boolean).join(' + ')}).`
      : `Off in ${region}. CloudTrail records that InvokeModel was called but not the model, prompt or token counts, so during an incident you can see spend rose without being able to attribute it to a caller or workload.`,
    remediation: configured ? undefined : 'Enable model invocation logging to CloudWatch Logs or S3. Prompts and completions are captured, so treat the destination as sensitive and scope its access accordingly.',
  };
}
