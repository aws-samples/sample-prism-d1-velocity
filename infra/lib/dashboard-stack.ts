import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

const METRIC_NAMESPACE = 'PRISM/D1/Velocity';
const DEFAULT_PERIOD = cdk.Duration.hours(1);

export interface DashboardStackProps extends cdk.StackProps {
  /** ARN of the productivity custom-widget Lambda (from the OTEL collector construct). */
  readonly productivityWidgetArn?: string;
  /** ARN of the Team Velocity custom-widget Lambda (DDB-backed panels). */
  readonly velocityWidgetArn?: string;
}

export class DashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: DashboardStackProps) {
    super(scope, id, props);

    // cdk-nag: CloudWatch alarms in this stack are for observability dashboards.
    // SNS alarm actions are configured by operators post-deployment.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-SNS2',
        reason: 'Alarm notification topics are configured post-deployment by operators.',
      },
      {
        id: 'AwsSolutions-SNS3',
        reason: 'Alarm notification topics are configured post-deployment by operators.',
      },
    ]);

    // =======================================================
    // Dashboard 1: Team Velocity
    // =======================================================
    const teamDashboard = new cloudwatch.Dashboard(this, 'TeamVelocityDashboard', {
      dashboardName: 'PRISM-D1-Team-Velocity',
      defaultInterval: cdk.Duration.days(7),
    });

    // --- Hybrid layout ---
    // KPI and detail panels are DDB-backed custom widgets (velocity-widget
    // Lambda) reading the events table via the by-detail-type GSI: full
    // 365-day history, real event timestamps, no CloudWatch metric-dimension
    // matching, and honest empty states naming the missing emitter. Native
    // graphs are retained only for attribution/OTEL-fed series, which are
    // dimensionless and verified live. Access to panel data is gated by
    // lambda:InvokeFunction on the widget Lambda (viewer's IAM creds).
    const velocityPanel = (title: string, view: string, height: number): cloudwatch.CustomWidget =>
      new cloudwatch.CustomWidget({
        functionArn: props?.velocityWidgetArn ?? '',
        title,
        width: 24,
        height,
        params: { view },
        updateOnRefresh: true,
        updateOnResize: false,
        updateOnTimeRangeChange: true,
      });

    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          '# PRISM D1 - Team Velocity Dashboard\n' +
          'Delivery health: DORA proxies, AI-DORA quality, eval gates, governance, security. ' +
          'Spend and per-developer output live on **PRISM-D1-Developer-Productivity**.',
        width: 24,
        height: 2,
      }),
    );

    if (props?.velocityWidgetArn) {
      // Row 1: DORA proxy KPIs (merge frequency, PR cycle time, revert rate/turnaround)
      teamDashboard.addWidgets(velocityPanel('Delivery KPIs (DORA proxies)', 'dora', 4));
      // Row 2: AI-DORA KPIs (attribution store + eval events, L2/L4 coloring)
      teamDashboard.addWidgets(velocityPanel('AI-DORA KPIs', 'aidora', 4));
    }

    // Row 3: native graphs — attribution/OTEL-fed series only. These are the
    // dimensionless series published by the attribution/OTEL publishers, so
    // plain (dimensionless) metric queries match. FILL/IF guards throughout:
    // commit data is sparse and an unguarded ratio renders NaN on empty
    // buckets; FILL(..., REPEAT) carries the last value through gap days so
    // the series draws a line instead of invisible isolated dots.
    const dailySum = (metricName: string, label?: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.days(1),
        ...(label ? { label } : {}),
      });

    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Commits / Day (AI vs Human)',
        left: [
          dailySum('AICommits', 'AI commits'),
          dailySum('HumanCommits', 'Human commits'),
        ],
        view: cloudwatch.GraphWidgetView.BAR,
        stacked: true,
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Commits' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Merge Ratio: AI vs Human',
        left: [
          // Both lines from attribution spans. Divergence is the signal:
          // AI code merging at a materially lower rate than human code means
          // review friction or quality problems, not just "AI is used a lot".
          new cloudwatch.MathExpression({
            expression: 'FILL(IF(FILL(aiCommits, 0) > 0, 100 * FILL(mergedAi, 0) / FILL(aiCommits, 0)), REPEAT)',
            usingMetrics: {
              mergedAi: dailySum('MergedAICommits'),
              aiCommits: dailySum('AICommits'),
            },
            label: 'AI merge rate (%)',
            period: cdk.Duration.days(1),
          }),
          new cloudwatch.MathExpression({
            expression: 'FILL(IF(FILL(humanCommits, 0) > 0, 100 * FILL(mergedHuman, 0) / FILL(humanCommits, 0)), REPEAT)',
            usingMetrics: {
              mergedHuman: dailySum('MergedHumanCommits'),
              humanCommits: dailySum('HumanCommits'),
            },
            label: 'Human merge rate (%)',
            period: cdk.Duration.days(1),
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Defect Trend (reverted / merged)',
        left: [
          // RevertedAICommits may not exist at all until the first revert is
          // published — a metric with zero datums is MISSING, not zero, so the
          // inner FILL is required or the whole expression renders NaN.
          new cloudwatch.MathExpression({
            expression: 'FILL(IF(FILL(mergedAi2, 0) > 0, 100 * FILL(revertedAi, 0) / FILL(mergedAi2, 0)), REPEAT)',
            usingMetrics: {
              revertedAi: dailySum('RevertedAICommits'),
              mergedAi2: dailySum('MergedAICommits'),
            },
            label: 'AI defect rate (%)',
            period: cdk.Duration.days(1),
          }),
        ],
        right: [dailySum('RevertedAICommits', 'Reverted AI commits')],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Percent' },
        rightYAxis: { min: 0, label: 'Count' },
      }),
    );

    if (props?.velocityWidgetArn) {
      // Row 4: per-repo drill-down — bridges org-level trends above to the
      // per-concern detail panels below. Attribution store, full history.
      teamDashboard.addWidgets(velocityPanel('Repository Breakdown (attribution, full history)', 'repos', 7));
      // Rows 5-8: DDB-backed detail panels
      teamDashboard.addWidgets(velocityPanel('Eval Gates (auto-discovers rubrics, incl. kiro-headless)', 'eval', 9));
      teamDashboard.addWidgets(velocityPanel('Governance — Guardrails & MCP (populates during sample-app runs)', 'governance', 7));
      teamDashboard.addWidgets(velocityPanel('Agent Operations (populates during sample-app runs)', 'agents', 7));
      teamDashboard.addWidgets(velocityPanel('Security — Continuum Findings & Remediation SLA', 'security', 10));
    }

    teamDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          `Spend, tokens, and per-developer breakdowns: [PRISM-D1-Developer-Productivity](https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Developer-Productivity)`,
        width: 24,
        height: 1,
      }),
    );

    // =======================================================
    // Dashboard 2: Executive Readout
    // =======================================================
    // Same hybrid approach as Team Velocity, with a stricter bar: this is the
    // highest-stakes audience, so every widget must be backed by a real
    // emitter, units are humanized (hours, not seconds), and proxies say so.
    // Deleted in the rebuild: PRISM Level Progress, AI Cost & Cycle Time,
    // Feature Cycle Time Trend, Weekly Bedrock Cost, and AI vs Human Defect
    // Rate — all fed only by `prism-cli workshop generate-demo-data`. Security
    // collapsed from 7 widgets to 1 panel; CISO Compliance owns the depth.
    const execDashboard = new cloudwatch.Dashboard(this, 'ExecutiveReadoutDashboard', {
      dashboardName: 'PRISM-D1-Executive-Readout',
      defaultInterval: cdk.Duration.days(30),
    });

    const execPanel = (title: string, view: string, height: number): cloudwatch.CustomWidget =>
      new cloudwatch.CustomWidget({
        functionArn: props?.velocityWidgetArn ?? '',
        title,
        width: 24,
        height,
        params: { view },
        updateOnRefresh: true,
        updateOnResize: false,
        updateOnTimeRangeChange: true,
      });

    execDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          '# PRISM D1 - Executive Readout\n' +
          'AI adoption, unit economics, delivery health, and security posture. ' +
          'Delivery figures are merge-based proxies, labeled as such.',
        width: 24,
        height: 2,
      }),
    );

    if (props?.velocityWidgetArn) {
      // Rows 1-2: observed PRISM level + business KPIs + delivery proxies
      execDashboard.addWidgets(execPanel('Business Outcomes & Observed Maturity', 'exec', 9));
    }

    // Row 3: adoption and cost trends (native, attribution/OTEL-fed).
    // Weekly periods — an exec view wants the trend, not daily noise.
    const weeklySum = (metricName: string, label?: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.days(7),
        ...(label ? { label } : {}),
      });

    execDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'AI vs Human Commits (Weekly)',
        left: [
          weeklySum('AICommits', 'AI commits'),
          weeklySum('HumanCommits', 'Human commits'),
        ],
        view: cloudwatch.GraphWidgetView.BAR,
        stacked: true,
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Commits' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Spend Trend (Weekly)',
        left: [weeklySum('AICostUSD', 'Spend ($)')],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Cost per Shipped Commit (Weekly)',
        left: [
          // The ROI narrative: spend can rise while this falls, which means AI
          // is getting more efficient per unit of shipped work.
          new cloudwatch.MathExpression({
            expression: 'FILL(IF(FILL(execMerged, 0) > 0, FILL(execCost, 0) / FILL(execMerged, 0)), REPEAT)',
            usingMetrics: {
              execCost: weeklySum('AICostUSD'),
              execMerged: weeklySum('MergedAICommits'),
            },
            label: '$ / shipped AI commit',
            period: cdk.Duration.days(7),
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
      }),
    );

    // Row 4: quality — "is AI code as reliable as human code?"
    execDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Merge Rate: AI vs Human (Weekly)',
        left: [
          new cloudwatch.MathExpression({
            expression: 'FILL(IF(FILL(xAi, 0) > 0, 100 * FILL(xMergedAi, 0) / FILL(xAi, 0)), REPEAT)',
            usingMetrics: { xMergedAi: weeklySum('MergedAICommits'), xAi: weeklySum('AICommits') },
            label: 'AI merge rate (%)',
            period: cdk.Duration.days(7),
          }),
          new cloudwatch.MathExpression({
            expression: 'FILL(IF(FILL(xHuman, 0) > 0, 100 * FILL(xMergedHuman, 0) / FILL(xHuman, 0)), REPEAT)',
            usingMetrics: { xMergedHuman: weeklySum('MergedHumanCommits'), xHuman: weeklySum('HumanCommits') },
            label: 'Human merge rate (%)',
            period: cdk.Duration.days(7),
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Defect Trend (Weekly)',
        left: [
          // RevertedAICommits may not exist at all until the first revert is
          // published — a metric with zero datums is missing, not zero, so the
          // inner FILL is required to avoid a NaN series.
          new cloudwatch.MathExpression({
            expression: 'FILL(IF(FILL(xMergedAi2, 0) > 0, 100 * FILL(xReverted, 0) / FILL(xMergedAi2, 0)), REPEAT)',
            usingMetrics: { xReverted: weeklySum('RevertedAICommits'), xMergedAi2: weeklySum('MergedAICommits') },
            label: 'AI defect rate (%)',
            period: cdk.Duration.days(7),
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Percent' },
      }),
    );

    if (props?.velocityWidgetArn) {
      // Row 5: condensed security posture (CISO dashboard has the breakdowns)
      execDashboard.addWidgets(execPanel('Security & Governance Posture', 'exec-security', 5));
    }

    execDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          `Drill down: [Team Velocity](https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Team-Velocity) (delivery detail) · ` +
          `[Developer Productivity](https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Developer-Productivity) (per-developer spend) · ` +
          `[CISO Compliance](https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-CISO-Compliance) (full security posture)`,
        width: 24,
        height: 1,
      }),
    );

    // =======================================================
    // CloudWatch Alarms
    // =======================================================

    // Alarm: AI acceptance rate dropping below 20%
    new cloudwatch.Alarm(this, 'AiAcceptanceRateLowAlarm', {
      alarmName: 'PRISM-D1-AIAcceptanceRate-Low',
      alarmDescription: 'AI acceptance rate has dropped below 20%, indicating potential issues with AI-generated code quality or review friction.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'AIAcceptanceRate',
        statistic: 'Average',
        period: cdk.Duration.hours(6),
      }),
      threshold: 20,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Eval gate pass rate dropping below 70%
    new cloudwatch.Alarm(this, 'EvalGatePassRateLowAlarm', {
      alarmName: 'PRISM-D1-EvalGatePassRate-Low',
      alarmDescription: 'Eval gate pass rate has dropped below 70%, indicating degraded quality in AI-generated outputs.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'EvalGatePassRate',
        statistic: 'Average',
        period: cdk.Duration.hours(6),
      }),
      threshold: 70,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Change failure rate exceeding 20%
    new cloudwatch.Alarm(this, 'ChangeFailureRateHighAlarm', {
      alarmName: 'PRISM-D1-ChangeFailureRate-High',
      alarmDescription: 'Change failure rate exceeds 20%, indicating deployment quality regression.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'ChangeFailureRate',
        statistic: 'Average',
        period: cdk.Duration.hours(6),
      }),
      threshold: 20,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // =======================================================
    // Dashboard 3: CISO Compliance
    //
    // This dashboard is DEPTH. The Executive Readout owns the headline
    // posture strip; everything past Row 2 here is detail the exec view
    // deliberately omits.
    //
    // Rows 1-5 are DDB-backed custom widgets rather than metric graphs. The
    // previous build used metric graphs and three of them could never render:
    // the metrics publisher emits either the FULL dimension set
    // ([TeamId, Repository, Phase, Severity, AIOrigin]) or a dimensionless
    // aggregate copy — never a subset. Widgets querying a partial set
    // ({AIOrigin} or {Phase} alone) silently matched nothing. Reading events
    // directly sidesteps dimension matching, and is the only way to surface
    // compliance_mappings, which is a string array and therefore cannot be a
    // CloudWatch dimension at all.
    // =======================================================
    const cisoDashboard = new cloudwatch.Dashboard(this, 'CISOComplianceDashboard', {
      dashboardName: 'PRISM-D1-CISO-Compliance',
      defaultInterval: cdk.Duration.days(30),
    });

    const cisoPanel = (title: string, view: string, height: number): cloudwatch.CustomWidget =>
      new cloudwatch.CustomWidget({
        functionArn: props?.velocityWidgetArn ?? '',
        title,
        width: 24,
        height,
        params: { view },
        updateOnRefresh: true,
        updateOnResize: false,
        updateOnTimeRangeChange: true,
      });

    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          '# PRISM D1 - CISO Compliance Dashboard\n' +
          'Security depth: exposure, remediation SLA compliance, AI code risk normalized by ' +
          'commit volume, shift-left effectiveness, and vulnerability classes. ' +
          'Headline posture is on **PRISM-D1-Executive-Readout**.',
        width: 24,
        height: 2,
      }),
    );

    // Row 1 — current exposure
    cisoDashboard.addWidgets(cisoPanel('Current Exposure', 'ciso-exposure', 5));

    // Row 2 — remediation SLA compliance (SECURITY-09 budgets)
    cisoDashboard.addWidgets(cisoPanel('Remediation SLA Compliance', 'ciso-sla', 8));

    // Row 3 — AI code risk, normalized. Raw finding counts are not comparable
    // across origins; this joins findings to attribution commit volume.
    cisoDashboard.addWidgets(cisoPanel('AI Code Risk Profile (per 100 commits)', 'ciso-risk', 10));

    // Row 4 — shift-left effectiveness, incl. computed finding survival rate
    cisoDashboard.addWidgets(cisoPanel('Shift-Left Effectiveness', 'ciso-shiftleft', 10));

    // Row 5 — vulnerability classes + compliance framework coverage
    cisoDashboard.addWidgets(cisoPanel('Vulnerability Classes & Compliance Coverage', 'ciso-classes', 12));

    // Row 6 — runtime governance. These stay native graphs: the guardrail /
    // MCP / exfiltration metrics are published with a dimensionless copy and
    // these widgets query dimensionlessly, so they match correctly.
    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Runtime Governance',
        width: 24,
        height: 1,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Guardrail Triggers vs Blocks',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailTriggerCount',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Triggers',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailBlockCount',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Blocks',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Count' },
      }),
      new cloudwatch.GraphWidget({
        title: 'MCP Authorization Denials',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MCPAuthDeniedCount',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Out-of-scope tool calls',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Count' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Exfiltration Alerts',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'ExfiltrationAlertCount',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Alerts',
          }),
        ],
        width: 8,
        height: 6,
        leftYAxis: { min: 0, label: 'Count' },
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown:
          `**Related:** [Executive Readout](https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Executive-Readout) (headline posture) · ` +
          `[Team Velocity](https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Team-Velocity) (per-repo delivery and security)`,
        width: 24,
        height: 2,
      }),
    );

    new cdk.CfnOutput(this, 'CISODashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-CISO-Compliance`,
      description: 'CISO Compliance Dashboard URL',
    });

    // =======================================================
    // Security Agent Alarms
    // =======================================================

    new cloudwatch.Alarm(this, 'SecurityCriticalFindingAlarm', {
      alarmName: 'PRISM-D1-SecurityCriticalFinding',
      alarmDescription: 'Critical or High security finding detected by AWS Security Agent.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'SecurityCriticalFindingCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'SecurityRemediationSLAAlarm', {
      alarmName: 'PRISM-D1-SecurityRemediationSLA',
      alarmDescription: 'Average security finding remediation time exceeds 72 hours.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'SecurityRemediationTimeHours',
        statistic: 'Average',
        period: cdk.Duration.days(1),
      }),
      threshold: 72,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'SecurityFindingRateHighAlarm', {
      alarmName: 'PRISM-D1-SecurityFindingRate-High',
      alarmDescription: 'Security finding count exceeds 50 in 6 hours — systemic quality issue.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'SecurityFindingCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(6),
      }),
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // =======================================================
    // Existing Alarms
    // =======================================================

    // Alarm: Guardrail block rate exceeding threshold
    new cloudwatch.Alarm(this, 'GuardrailBlockRateHighAlarm', {
      alarmName: 'PRISM-D1-GuardrailBlockRate-High',
      alarmDescription: 'Guardrail block count exceeds 50 per hour, indicating potential prompt attack or misconfiguration.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'GuardrailBlockCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 50,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Daily AI cost exceeding budget.
    // Watches AICostUSD (real — otel-metrics-publisher from codeburn usage
    // spans) rather than BedrockCostUSD, which has no emitter outside
    // `prism-cli workshop generate-demo-data` and left this alarm permanently
    // in INSUFFICIENT_DATA.
    new cloudwatch.Alarm(this, 'BedrockDailyCostHighAlarm', {
      alarmName: 'PRISM-D1-AIDailyCost-High',
      alarmDescription: 'Daily AI tooling cost exceeds the $100 threshold.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'AICostUSD',
        statistic: 'Sum',
        period: cdk.Duration.days(1),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // NOTE: a TokenEfficiency alarm was removed here. The metric (tokens per
    // line changed) has no emitter — the only source is `prism-cli workshop
    // generate-demo-data` — so the alarm sat in INSUFFICIENT_DATA permanently.
    // Reinstate it if/when a real emitter computes tokens-per-line.

    // Alarm: Exfiltration detection
    new cloudwatch.Alarm(this, 'ExfiltrationAlertAlarm', {
      alarmName: 'PRISM-D1-ExfiltrationAlert',
      alarmDescription: 'Data exfiltration pattern detected — anomalous read volume on PRISM tables.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'ExfiltrationAlertCount',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Agent success rate dropping below 80%
    // Uses the dimensionless aggregate series (dual-published by the
    // processor). The previous TeamId=ALL/Repository=ALL dimensions never
    // matched real events, so the alarm sat in INSUFFICIENT_DATA forever.
    new cloudwatch.Alarm(this, 'AgentSuccessRateAlarm', {
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'AgentSuccessRate',
        statistic: 'Average',
        period: cdk.Duration.hours(1),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      alarmDescription: 'Agent success rate below 80% for 3 consecutive hours',
      alarmName: 'prism-d1-agent-success-rate',
    });

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, 'TeamDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Team-Velocity`,
      description: 'Team Velocity Dashboard URL',
    });

    new cdk.CfnOutput(this, 'ExecDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Executive-Readout`,
      description: 'Executive Readout Dashboard URL',
    });

    // =======================================================
    // Dashboard 3: Developer Productivity (attribution store)
    // Only created when the OTEL collector (and its custom-widget
    // Lambda) is deployed.
    // =======================================================
    if (props?.productivityWidgetArn) {
      // Type-in filter for the detail row. PATTERN variables literal-replace
      // the token below anywhere in the dashboard JSON, so the token must be
      // unique. Default 'all' = organization scope.
      const USER_TOKEN = 'PRISM_USER_FILTER_TOKEN';
      const devDashboard = new cloudwatch.Dashboard(this, 'DeveloperProductivityDashboard', {
        dashboardName: 'PRISM-D1-Developer-Productivity',
        defaultInterval: cdk.Duration.days(30),
        variables: [
          new cloudwatch.DashboardVariable({
            id: 'devFilter',
            label: 'Developer',
            type: cloudwatch.VariableType.PATTERN,
            value: USER_TOKEN,
            inputType: cloudwatch.VariableInputType.INPUT,
            defaultValue: cloudwatch.DefaultValue.value('all'),
            visible: true,
          }),
        ],
      });

      devDashboard.addWidgets(
        new cloudwatch.TextWidget({
          markdown:
            '# PRISM D1 - Developer Productivity\n' +
            'Rows 1-2: org metrics (CloudWatch, 2-week ingestion window applies to backfills). ' +
            'Rows 3-4: attribution store — full history, real commit timestamps. ' +
            'Type a developer email into the **Developer** variable (default `all`) to scope the detail row.',
          width: 24,
          height: 2,
        }),
      );

      // --- Row 1: Org KPIs (NaN-guarded metric math, follow time range) ---
      const dailyMetric = (metricName: string, id: string): cloudwatch.Metric =>
        new cloudwatch.Metric({
          namespace: METRIC_NAMESPACE,
          metricName,
          statistic: 'Sum',
          period: cdk.Duration.days(1),
          label: id,
        });
      const ratioKpi = (title: string, expression: string, using: Record<string, cloudwatch.IMetric>): cloudwatch.SingleValueWidget =>
        new cloudwatch.SingleValueWidget({
          title,
          metrics: [new cloudwatch.MathExpression({ expression, usingMetrics: using, label: title, period: cdk.Duration.days(1) })],
          setPeriodToTimeRange: true,
          width: 6,
          height: 4,
        });

      devDashboard.addWidgets(
        ratioKpi('AI Share of Commits (%)', 'IF(FILL(kTotal, 0) > 0, 100 * FILL(kAi, 0) / FILL(kTotal, 0))', {
          kAi: dailyMetric('AICommits', 'kAi'), kTotal: dailyMetric('CommitsTotal', 'kTotal'),
        }),
        ratioKpi('AI Merge Rate (%)', 'IF(FILL(kAi2, 0) > 0, 100 * FILL(kMerged, 0) / FILL(kAi2, 0))', {
          kMerged: dailyMetric('MergedAICommits', 'kMerged'), kAi2: dailyMetric('AICommits', 'kAi2'),
        }),
        ratioKpi('Cost per Shipped Commit ($)', 'IF(FILL(kMerged2, 0) > 0, FILL(kCost, 0) / FILL(kMerged2, 0))', {
          kCost: dailyMetric('AICostUSD', 'kCost'), kMerged2: dailyMetric('MergedAICommits', 'kMerged2'),
        }),
        new cloudwatch.SingleValueWidget({
          title: 'AI Spend (range, $)',
          metrics: [dailyMetric('AICostUSD', 'AI Spend')],
          setPeriodToTimeRange: true,
          width: 6,
          height: 4,
        }),
      );

      // --- Row 2: Org trends (native interactive charts) ---
      devDashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Commits / Day (AI vs Human)',
          left: [
            dailyMetric('AICommits', 'AI commits'),
            dailyMetric('HumanCommits', 'Human commits'),
          ],
          view: cloudwatch.GraphWidgetView.BAR,
          stacked: true,
          width: 8,
          height: 6,
          leftYAxis: { min: 0, label: 'Commits' },
        }),
        new cloudwatch.GraphWidget({
          title: 'AI Spend / Day',
          left: [dailyMetric('AICostUSD', 'Spend ($)')],
          width: 8,
          height: 6,
          leftYAxis: { min: 0, label: 'USD' },
        }),
        new cloudwatch.GraphWidget({
          title: 'AI Merge Ratio Trend',
          left: [
            new cloudwatch.MathExpression({
              expression: 'FILL(IF(FILL(tAi, 0) > 0, 100 * FILL(tMerged, 0) / FILL(tAi, 0)), REPEAT)',
              usingMetrics: { tMerged: dailyMetric('MergedAICommits', 'tMerged'), tAi: dailyMetric('AICommits', 'tAi') },
              label: 'Merge ratio (%)',
              period: cdk.Duration.days(1),
            }),
          ],
          width: 8,
          height: 6,
          leftYAxis: { min: 0, max: 100, label: 'Percent' },
        }),
      );

      // --- Row 3: Team comparison table (custom widget, view=table) ---
      devDashboard.addWidgets(
        new cloudwatch.CustomWidget({
          functionArn: props.productivityWidgetArn,
          title: 'Team Comparison (full history)',
          width: 24,
          height: 8,
          params: { view: 'table' },
          updateOnRefresh: true,
          updateOnResize: false,
          updateOnTimeRangeChange: true,
        }),
      );

      // --- Row 4: Detail panel (custom widget, view=detail, follows filter) ---
      devDashboard.addWidgets(
        new cloudwatch.CustomWidget({
          functionArn: props.productivityWidgetArn,
          title: 'Detail: By Tool / By Model / Ratios',
          width: 24,
          height: 8,
          params: { view: 'detail', user: USER_TOKEN },
          updateOnRefresh: true,
          updateOnResize: false,
          updateOnTimeRangeChange: true,
        }),
      );

      new cdk.CfnOutput(this, 'DevProductivityDashboardUrl', {
        value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=PRISM-D1-Developer-Productivity`,
        description: 'Developer Productivity Dashboard URL',
      });
    }
  }
}
