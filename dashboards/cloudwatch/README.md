# CloudWatch Dashboards for PRISM D1 Velocity

Two pre-built CloudWatch dashboards for engineering velocity and AI adoption tracking.

| Dashboard | File | Audience |
|-----------|------|----------|
| Team Velocity | `team-velocity.json` | Engineering teams, tech leads |
| Executive Readout | `executive-readout.json` | CTOs, VPEs, engineering directors |

## Prerequisites

- AWS CLI configured with appropriate permissions
- CloudWatch `PutDashboard` permission (`cloudwatch:PutDashboard`)
- Metrics flowing into the `PRISM/D1` namespace (via the PRISM collector pipeline)

## Deploying Dashboards

### Quick deploy

```bash
# Deploy team dashboard
aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-TeamVelocity" \
  --dashboard-body file://team-velocity.json

# Deploy executive dashboard
aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-ExecutiveReadout" \
  --dashboard-body file://executive-readout.json
```

### Deploy with sed replacement for dimensions

Before deploying, replace placeholder dimension values with your actual team and repo identifiers:

```bash
# Replace placeholders
sed -e 's/REPLACE_TEAM_ID/your-team-id/g' \
    -e 's/REPLACE_REPO/your-repo-name/g' \
    team-velocity.json > /tmp/team-velocity-configured.json

aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-TeamVelocity-YourTeam" \
  --dashboard-body file:///tmp/team-velocity-configured.json
```

### Deploy via CloudFormation

```yaml
Resources:
  TeamVelocityDashboard:
    Type: AWS::CloudWatch::Dashboard
    Properties:
      DashboardName: !Sub "PRISM-D1-TeamVelocity-${TeamId}"
      DashboardBody: !Sub |
        # Inline the JSON with ${TeamId} substitutions
```

## Customizing Dimensions

All metrics use the following dimensions:

| Dimension | Description | Example |
|-----------|-------------|---------|
| `TeamId` | Unique team identifier | `platform-team`, `payments-squad` |
| `Repo` | Repository name | `backend-api`, `web-frontend` |
| `Environment` | Deployment target | `production`, `staging` |

To add an Environment dimension to any widget, add it to the metric array:

```json
["PRISM/D1", "DeploymentCount", "TeamId", "my-team", "Repo", "my-repo", "Environment", "production", {...}]
```

## Adding Custom Widgets

Append to the `widgets` array in either dashboard JSON. CloudWatch uses a 24-column grid:

```json
{
  "type": "metric",
  "x": 0,
  "y": 25,
  "width": 12,
  "height": 6,
  "properties": {
    "title": "My Custom Metric",
    "view": "timeSeries",
    "metrics": [
      ["PRISM/D1", "YourMetricName", "TeamId", "your-team", {"stat": "Average", "period": 86400}]
    ],
    "region": "${AWS::Region}"
  }
}
```

### Widget types

| Type | `view` value | Use case |
|------|-------------|----------|
| Line graph | `timeSeries` | Trend data over time |
| Bar chart | `bar` | Counts, frequencies |
| Stacked area | `timeSeries` + `"stacked": true` | Comparative breakdowns |
| Single number | `singleValue` | Current/latest metric value |
| Text | (type: `text`) | Section headers, notes |

## Threshold Recommendations by PRISM Level

Use these as annotation values to visualize targets on your dashboards:

### DORA Metrics

| Metric | L1 (Ad Hoc) | L2 (Emerging) | L3 (Scaling) | L4 (Optimized) | L5 (Transformative) |
|--------|-------------|---------------|--------------|-----------------|---------------------|
| Deployment Frequency | < 1/week | 1-2/week | Daily | Multiple/day | On-demand |
| Lead Time | > 30 days | 7-30 days | 1-7 days | < 1 day | < 1 hour |
| Change Failure Rate | > 45% | 30-45% | 15-30% | 5-15% | < 5% |
| MTTR | > 7 days | 1-7 days | < 1 day | < 1 hour | < 15 min |

### AI-DORA Metrics

| Metric | L1 | L2 | L3 | L4 | L5 |
|--------|----|----|----|----|-----|
| AI Acceptance Rate | 0% | 10-30% | 30-50% | 50-70% | > 70% |
| AI-to-Merge Ratio | 0 | 0.1-0.3 | 0.3-0.5 | 0.5-0.7 | > 0.7 |
| Eval Gate Pass Rate | N/A | > 60% | > 80% | > 90% | > 95% |
| Spec-to-Code Hours | N/A | > 48h | 24-48h | 8-24h | < 8h |

## Updating Dashboards

CloudWatch `put-dashboard` is idempotent. Re-run the deploy command to update:

```bash
# Edit the JSON, then re-deploy
aws cloudwatch put-dashboard \
  --dashboard-name "PRISM-D1-TeamVelocity" \
  --dashboard-body file://team-velocity.json
```

## Metric Namespace Reference

All metrics live under `PRISM/D1`. The full list:

- `PRISM/D1/AIAcceptanceRate` -- Percentage of AI suggestions accepted
- `PRISM/D1/DeploymentCount` -- Number of deployments
- `PRISM/D1/LeadTimeSeconds` -- Time from commit to production (seconds)
- `PRISM/D1/ChangeFailureRate` -- Percentage of deployments causing failure
- `PRISM/D1/MTTRSeconds` -- Mean time to recovery (seconds)
- `PRISM/D1/AIToMergeRatio` -- Ratio of AI-generated code to total merged code
- `PRISM/D1/EvalGatePassRate` -- Percentage of AI outputs passing eval gates
- `PRISM/D1/SpecToCodeHours` -- Hours from spec approval to code completion
- `PRISM/D1/DefectRateAI` -- Post-merge defect rate for AI-generated code
- `PRISM/D1/DefectRateHuman` -- Post-merge defect rate for human-written code
- `PRISM/D1/AITestCoverageDelta` -- Change in test coverage from AI-generated tests
- `PRISM/D1/PRISMLevel` -- Current assessed PRISM maturity level (1-5)
- `PRISM/D1/AIROIMultiplier` -- Return on AI investment multiplier
