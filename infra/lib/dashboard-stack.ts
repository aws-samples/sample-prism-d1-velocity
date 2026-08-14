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

    // Row 3: native graphs — attribution/OTEL-fed series only
    teamDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Commits / Day (AI vs Human)',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE, metricName: 'AICommits',
            statistic: 'Sum', period: cdk.Duration.days(1), label: 'AI commits',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE, metricName: 'HumanCommits',
            statistic: 'Sum', period: cdk.Duration.days(1), label: 'Human commits',
          }),
        ],
        view: cloudwatch.GraphWidgetView.BAR,
        stacked: true,
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Commits' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI to Merge Ratio (attribution)',
        left: [
          // Inner FILL/IF: avoid NaN on empty buckets (gap, not 0). Outer
          // FILL(..., REPEAT): carry the last ratio through gap days —
          // commit data is sparse and isolated datapoints render invisibly.
          new cloudwatch.MathExpression({
            expression: 'FILL(IF(FILL(aiCommits, 0) > 0, 100 * FILL(mergedAi, 0) / FILL(aiCommits, 0)), REPEAT)',
            usingMetrics: {
              mergedAi: new cloudwatch.Metric({
                namespace: METRIC_NAMESPACE, metricName: 'MergedAICommits',
                statistic: 'Sum', period: cdk.Duration.days(1),
              }),
              aiCommits: new cloudwatch.Metric({
                namespace: METRIC_NAMESPACE, metricName: 'AICommits',
                statistic: 'Sum', period: cdk.Duration.days(1),
              }),
            },
            label: 'Merged AI / AI commits (%)',
            period: cdk.Duration.days(1),
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
      }),
    );

    if (props?.velocityWidgetArn) {
      // Rows 4-7: DDB-backed detail panels
      teamDashboard.addWidgets(velocityPanel('Eval Gates (auto-discovers rubrics, incl. kiro-headless)', 'eval', 7));
      teamDashboard.addWidgets(velocityPanel('Governance — Guardrails & MCP (populates during sample-app runs)', 'governance', 6));
      teamDashboard.addWidgets(velocityPanel('Agent Operations (populates during sample-app runs)', 'agents', 6));
      teamDashboard.addWidgets(velocityPanel('Security — Continuum Findings', 'security', 7));
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
    const execDashboard = new cloudwatch.Dashboard(this, 'ExecutiveReadoutDashboard', {
      dashboardName: 'PRISM-D1-Executive-Readout',
      defaultInterval: cdk.Duration.days(30),
    });

    execDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# PRISM D1 - Executive Readout\nLeadership view of AI-assisted engineering velocity and DORA performance.',
        width: 24,
        height: 1,
      }),
    );

    // --- PRISM Level Progress + Enhanced DORA Summary row ---
    execDashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'PRISM Level Progress',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PRISMLevel',
            statistic: 'Maximum',
            period: cdk.Duration.days(1),
            label: 'Current PRISM Level',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Enhanced DORA Summary',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'DeploymentFrequency',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Deploy Freq (7d)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'LeadTimeForChanges',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Avg Lead Time (s)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'ChangeFailureRate',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Change Fail Rate (%)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MTTR',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Avg MTTR (s)',
          }),
        ],
        width: 12,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'AI Cost & Cycle Time',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AICostUSD',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Total AI Cost (7d, USD)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SpecToCodeHours',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Avg Spec-to-Code (hrs)',
          }),
        ],
        width: 6,
        height: 4,
      }),
    );

    // --- AI Contribution Trend + Feature Cycle Time Trend ---
    execDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'AI Contribution Trend',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AIAcceptanceRate',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'AI Acceptance Rate (%)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AIToMergeRatio',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'AI-to-Merge Ratio (CI, %)',
          }),
          new cloudwatch.MathExpression({
            expression: 'IF(FILL(execAiCommits, 0) > 0, 100 * FILL(execMergedAi, 0) / FILL(execAiCommits, 0))',
            usingMetrics: {
              execMergedAi: new cloudwatch.Metric({
                namespace: METRIC_NAMESPACE,
                metricName: 'MergedAICommits',
                statistic: 'Sum',
                period: cdk.Duration.days(1),
              }),
              execAiCommits: new cloudwatch.Metric({
                namespace: METRIC_NAMESPACE,
                metricName: 'AICommits',
                statistic: 'Sum',
                period: cdk.Duration.days(1),
              }),
            },
            label: 'AI-to-Merge Ratio (Attribution, %)',
            period: cdk.Duration.days(1),
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AITestCoverageDelta',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'AI Test Coverage Delta (%)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, max: 100, label: 'Percent' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Feature Cycle Time Trend',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SpecToCodeHours',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Spec-to-Code (hrs)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'LeadTimeForChanges',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'Lead Time (seconds)',
          }),
        ],
        width: 12,
        height: 6,
      }),
    );

    // --- Eval gate, quality, and cost trend row ---
    execDashboard.addWidgets(
      new cloudwatch.GaugeWidget({
        title: 'Eval Gate Pass Rate',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'EvalGatePassRate',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Eval Pass Rate (%)',
          }),
        ],
        width: 6,
        height: 6,
        leftYAxis: { min: 0, max: 100 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Post-Merge Defect Rate',
        left: [
          // CI-fed (git trailers + revert scan in prism-ai-metrics.yml)
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PostMergeDefectRate',
            statistic: 'Average',
            period: cdk.Duration.days(1),
            label: 'CI (per-PR)',
          }),
          // Attribution-derived: reverted AI commits over merged AI commits.
          // FILL guards both series: RevertedAICommits may not exist AT ALL
          // until the first revert is published (a metric with zero datums is
          // missing, not zero — unguarded math renders NaN). The IF guard
          // gaps buckets with no merged commits instead of dividing by zero.
          new cloudwatch.MathExpression({
            expression: 'IF(FILL(mergedAi, 0) > 0, 100 * FILL(revertedAi, 0) / FILL(mergedAi, 0))',
            usingMetrics: {
              revertedAi: new cloudwatch.Metric({
                namespace: METRIC_NAMESPACE,
                metricName: 'RevertedAICommits',
                statistic: 'Sum',
                period: cdk.Duration.days(1),
              }),
              mergedAi: new cloudwatch.Metric({
                namespace: METRIC_NAMESPACE,
                metricName: 'MergedAICommits',
                statistic: 'Sum',
                period: cdk.Duration.days(1),
              }),
            },
            label: 'Attribution (codeburn spans)',
            period: cdk.Duration.days(1),
          }),
        ],
        width: 6,
        height: 6,
        leftYAxis: { min: 0, label: 'Percent' },
      }),
      new cloudwatch.GraphWidget({
        title: 'AI Cost Trend (Weekly)',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'AICostUSD',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Total Cost (USD)',
          }),
        ],
        width: 6,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Deployment Frequency (Weekly)',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'DeploymentFrequency',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Deploys / Week',
          }),
        ],
        width: 6,
        height: 6,
        view: cloudwatch.GraphWidgetView.BAR,
        leftYAxis: { min: 0, label: 'Deployments' },
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
    // Executive Dashboard: Security & Compliance section
    // =======================================================
    execDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Security & Compliance',
        width: 24,
        height: 1,
      }),
    );

    execDashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Guardrail Blocks (7d)',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailBlockCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Blocks',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.GraphWidget({
        title: 'Guardrail Trigger Trend',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailTriggerCount',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
            label: 'Daily Triggers',
          }),
        ],
        width: 9,
        height: 4,
        leftYAxis: { min: 0, label: 'Count' },
      }),
      new cloudwatch.SingleValueWidget({
        title: 'MCP Auth Denied (7d)',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MCPAuthDeniedCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Denied',
          }),
        ],
        width: 3,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Exfiltration Alerts (7d)',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'ExfiltrationAlertCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Alerts',
          }),
        ],
        width: 6,
        height: 4,
      }),
    );

    // =======================================================
    // Executive Dashboard: Cost Intelligence
    // =======================================================
    execDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Cost Intelligence',
        width: 24,
        height: 1,
      }),
    );

    execDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Weekly Bedrock Cost',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'BedrockCostUSD',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Weekly Cost ($)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'USD' },
        view: cloudwatch.GraphWidgetView.BAR,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'AI vs Human Defect Rate',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PostMergeDefectRateAI',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'AI Defect Rate (%)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'PostMergeDefectRateHuman',
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Human Defect Rate (%)',
          }),
        ],
        width: 6,
        height: 6,
      }),
    );

    // =======================================================
    // Dashboard 3: CISO Compliance
    // =======================================================
    const cisoDashboard = new cloudwatch.Dashboard(this, 'CISOComplianceDashboard', {
      dashboardName: 'PRISM-D1-CISO-Compliance',
      defaultInterval: cdk.Duration.days(30),
    });

    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# PRISM D1 - CISO Compliance Dashboard\nSecurity posture, remediation SLAs, and AI code risk profile across all teams.',
        width: 24,
        height: 1,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Open Critical Findings',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityCriticalFindingCount',
            statistic: 'Sum',
            period: cdk.Duration.days(30),
            label: 'Critical + High (30d)',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Avg Remediation Time',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            statistic: 'Average',
            period: cdk.Duration.days(30),
            label: 'Hours (30d avg)',
          }),
        ],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Security Scans Run',
        metrics: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityScanCount',
            statistic: 'Sum',
            period: cdk.Duration.days(30),
            label: 'Scans (30d)',
          }),
        ],
        width: 6,
        height: 4,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### AI Code Risk Profile',
        width: 24,
        height: 1,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Security Findings: AI vs Human Code',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingByOrigin',
            dimensionsMap: { AIOrigin: 'ai-assisted' },
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'AI Code Findings',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingByOrigin',
            dimensionsMap: { AIOrigin: 'human' },
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Human Code Findings',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Findings' },
      }),
      new cloudwatch.GraphWidget({
        title: 'Remediation Time by Code Origin',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            dimensionsMap: { AIOrigin: 'ai-assisted' },
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'AI Code (hrs)',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityRemediationTimeHours',
            dimensionsMap: { AIOrigin: 'human' },
            statistic: 'Average',
            period: cdk.Duration.days(7),
            label: 'Human Code (hrs)',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Hours' },
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '### Shift-Left Effectiveness',
        width: 24,
        height: 1,
      }),
    );

    cisoDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Findings by Phase (Monthly Trend)',
        left: ['design_review', 'code_review', 'pen_test'].map((phase) =>
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'SecurityFindingCount',
            dimensionsMap: { Phase: phase },
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: phase.replace('_', ' '),
          }),
        ),
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Findings' },
        view: cloudwatch.GraphWidgetView.BAR,
      }),
      new cloudwatch.GraphWidget({
        title: 'Guardrail + Exfiltration Trends',
        left: [
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'GuardrailBlockCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Guardrail Blocks',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'ExfiltrationAlertCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'Exfiltration Alerts',
          }),
          new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: 'MCPAuthDeniedCount',
            statistic: 'Sum',
            period: cdk.Duration.days(7),
            label: 'MCP Auth Denied',
          }),
        ],
        width: 12,
        height: 6,
        leftYAxis: { min: 0, label: 'Count' },
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

    // Alarm: Daily Bedrock cost exceeding budget
    new cloudwatch.Alarm(this, 'BedrockDailyCostHighAlarm', {
      alarmName: 'PRISM-D1-BedrockDailyCost-High',
      alarmDescription: 'Daily Bedrock cost exceeds $100 threshold.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'BedrockCostUSD',
        statistic: 'Sum',
        period: cdk.Duration.days(1),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Alarm: Token efficiency below threshold
    new cloudwatch.Alarm(this, 'TokenEfficiencyLowAlarm', {
      alarmName: 'PRISM-D1-TokenEfficiency-Low',
      alarmDescription: 'Token efficiency is low — high token consumption relative to code output.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: 'TokenEfficiency',
        statistic: 'Average',
        period: cdk.Duration.hours(6),
      }),
      threshold: 500,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

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
