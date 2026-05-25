# QuickSight Analyses for PRISM D1 Velocity

Deep-dive analytics for AI-augmented engineering velocity, built on Amazon QuickSight.

| Analysis | File | Purpose |
|----------|------|---------|
| AI-DORA Analysis | `ai-dora-analysis.json` | Full DORA + AI-DORA metric exploration across teams, repos, and tools |
| PRISM Level Tracker | `prism-level-tracker.json` | Maturity level progression, sub-dimension radar, cohort benchmarks |

## Prerequisites

1. **QuickSight Enterprise Edition** -- Required for calculated fields, conditional formatting, and advanced visuals (radar, gauge).
2. **Amazon Timestream database** populated with PRISM D1 metrics.
3. **IAM permissions** for `quicksight:CreateAnalysis`, `quicksight:CreateDataSet`, `quicksight:CreateDataSource`.
4. **VPC connectivity** (if Timestream is in a VPC) or public endpoint access.

## Step 1: Create the Timestream Data Source

```bash
aws quicksight create-data-source \
  --aws-account-id YOUR_ACCOUNT_ID \
  --data-source-id prism-d1-timestream \
  --name "PRISM D1 Metrics (Timestream)" \
  --type TIMESTREAM \
  --data-source-parameters '{
    "TimestreamParameters": {
      "DatabaseName": "prism_d1_velocity",
      "MeasureName": "metrics"
    }
  }' \
  --permissions '[{
    "Principal": "arn:aws:quicksight:REGION:ACCOUNT_ID:user/default/YOUR_USER",
    "Actions": [
      "quicksight:DescribeDataSource",
      "quicksight:DescribeDataSourcePermissions",
      "quicksight:PassDataSource",
      "quicksight:UpdateDataSource",
      "quicksight:DeleteDataSource",
      "quicksight:UpdateDataSourcePermissions"
    ]
  }]'
```

## Step 2: Create the DataSet

The DataSet maps Timestream measures to QuickSight columns. Create it via the QuickSight console or CLI:

```bash
aws quicksight create-data-set \
  --aws-account-id YOUR_ACCOUNT_ID \
  --data-set-id prism-d1-metrics-dataset \
  --name "PRISM D1 Metrics" \
  --physical-table-map '{
    "prism_metrics": {
      "CustomSql": {
        "DataSourceArn": "arn:aws:quicksight:REGION:ACCOUNT_ID:datasource/prism-d1-timestream",
        "Name": "PRISM D1 Metrics Query",
        "SqlQuery": "SELECT time as measure_date, TeamId, Repo, Environment, AITool, measure_value::double as metric_value, measure_name FROM prism_d1_velocity.metrics WHERE time > ago(180d)",
        "Columns": [
          {"Name": "measure_date", "Type": "DATETIME"},
          {"Name": "TeamId", "Type": "STRING"},
          {"Name": "Repo", "Type": "STRING"},
          {"Name": "Environment", "Type": "STRING"},
          {"Name": "AITool", "Type": "STRING"},
          {"Name": "metric_value", "Type": "DECIMAL"},
          {"Name": "measure_name", "Type": "STRING"}
        ]
      }
    }
  }' \
  --import-mode SPICE
```

**Note:** If your Timestream schema uses wide-format tables (one column per metric), adjust the SQL query and column mappings accordingly. The analysis templates assume each metric is available as a separate column.

## Step 3: Deploy the Analyses

Replace placeholder values in each JSON file, then deploy:

```bash
# Replace placeholders
ACCOUNT_ID="123456789012"
REGION="us-west-2"
DATASET_ARN="arn:aws:quicksight:${REGION}:${ACCOUNT_ID}:dataset/prism-d1-metrics-dataset"

# Process and deploy AI-DORA Analysis
sed -e "s/REPLACE_AWS_ACCOUNT_ID/${ACCOUNT_ID}/g" \
    -e "s|REPLACE_DATA_SET_ARN|${DATASET_ARN}|g" \
    -e "s/REPLACE_REGION/${REGION}/g" \
    ai-dora-analysis.json > /tmp/ai-dora-analysis-configured.json

aws quicksight create-analysis \
  --cli-input-json file:///tmp/ai-dora-analysis-configured.json

# Process and deploy PRISM Level Tracker
sed -e "s/REPLACE_AWS_ACCOUNT_ID/${ACCOUNT_ID}/g" \
    -e "s|REPLACE_DATA_SET_ARN|${DATASET_ARN}|g" \
    -e "s|REPLACE_BENCHMARK_DATA_SET_ARN|${DATASET_ARN}|g" \
    prism-level-tracker.json > /tmp/prism-level-tracker-configured.json

aws quicksight create-analysis \
  --cli-input-json file:///tmp/prism-level-tracker-configured.json
```

## Customization Guide

### Adding Teams

All analyses use `TeamId` as a filter and dimension. As new teams onboard:
1. Ensure the collector pipeline tags metrics with the team's `TeamId`.
2. New teams appear automatically in filters and team-comparison visuals.
3. Update the `Team Comparison` widget in CloudWatch manually (it requires explicit team IDs).

### Adjusting PRISM Level Thresholds

Threshold values for conditional formatting (green/amber/red) are embedded in each analysis. Search for these patterns and adjust:

| Color | Meaning | Example threshold |
|-------|---------|-------------------|
| `#4CAF50` (green) | On target or exceeding | AI Acceptance >= 50%, CFR <= 5% |
| `#FF9800` (amber) | Approaching target | AI Acceptance 30-50%, CFR 5-15% |
| `#F44336` (red) | Below target | AI Acceptance < 30%, CFR > 15% |

### Adding Custom Visuals

To add a visual to an existing sheet, append to the `Visuals` array in the target sheet. Use the existing visuals as templates for `FieldWells`, `ChartConfiguration`, and `ConditionalFormatting` structure.

### Publishing as a Dashboard

Once an analysis is tuned, publish it as a read-only dashboard:

```bash
aws quicksight create-dashboard \
  --aws-account-id YOUR_ACCOUNT_ID \
  --dashboard-id prism-d1-ai-dora-dashboard \
  --name "PRISM D1 — AI-DORA Dashboard" \
  --source-entity '{
    "SourceTemplate": {
      "DataSetReferences": [{
        "DataSetPlaceholder": "prism_d1_metrics",
        "DataSetArn": "arn:aws:quicksight:REGION:ACCOUNT_ID:dataset/prism-d1-metrics-dataset"
      }],
      "Arn": "arn:aws:quicksight:REGION:ACCOUNT_ID:template/prism-d1-ai-dora-template"
    }
  }'
```

### Embedding in Applications

QuickSight Enterprise supports embedding dashboards in internal tools:

```bash
aws quicksight get-dashboard-embed-url \
  --aws-account-id YOUR_ACCOUNT_ID \
  --dashboard-id prism-d1-ai-dora-dashboard \
  --identity-type IAM
```

## Timestream Schema Reference

Expected table structure in `prism_d1_velocity.metrics`:

| Column | Type | Description |
|--------|------|-------------|
| `time` | TIMESTAMP | Measurement timestamp |
| `TeamId` | VARCHAR (dimension) | Team identifier |
| `Repo` | VARCHAR (dimension) | Repository name |
| `Environment` | VARCHAR (dimension) | Deployment environment |
| `AITool` | VARCHAR (dimension) | AI tool used (ClaudeCode, Kiro, QDeveloper) |
| `DeploymentCount` | DOUBLE (measure) | Number of deployments |
| `LeadTimeSeconds` | DOUBLE (measure) | Lead time in seconds |
| `ChangeFailureRate` | DOUBLE (measure) | Change failure rate (0-100) |
| `MTTRSeconds` | DOUBLE (measure) | Mean time to recovery in seconds |
| `AIAcceptanceRate` | DOUBLE (measure) | AI suggestion acceptance rate (0-100) |
| `AIToMergeRatio` | DOUBLE (measure) | Ratio of AI code to merged code (0-1) |
| `EvalGatePassRate` | DOUBLE (measure) | Eval gate pass rate (0-100) |
| `SpecToCodeHours` | DOUBLE (measure) | Spec-to-code turnaround in hours |
| `DefectRateAI` | DOUBLE (measure) | Post-merge defect rate for AI code |
| `DefectRateHuman` | DOUBLE (measure) | Post-merge defect rate for human code |
| `AITestCoverageDelta` | DOUBLE (measure) | Test coverage change from AI tests |
| `PRISMLevel` | DOUBLE (measure) | Current PRISM maturity level (1-5) |
| `AIROIMultiplier` | DOUBLE (measure) | AI return on investment multiplier |
