# Leader Guide -- PRISM D1 Velocity

Materials for AWS Solutions Architects preparing executive readouts and ROI conversations with engineering leaders (CTOs, VPEs, Directors).

## Contents

| Document | Purpose | When to Use |
|----------|---------|-------------|
| [Executive Readout Template](executive-readout-template.md) | Structured template for weekly/biweekly CTO briefings | Every readout cycle. Fill in from CloudWatch + QuickSight dashboards. |
| [ROI Model](roi-model.md) | Quantitative framework for AI engineering investment returns | QBRs, budget conversations, board prep, CFO presentations. |

## How SAs Should Use These Materials

### Executive Readout Flow

1. **Before the meeting:** Pull current metrics from the CloudWatch Executive Readout dashboard and QuickSight AI-DORA Analysis. Fill in all bracketed placeholders in the template.
2. **During the meeting:** Walk through sections 1-4 (Level Summary, Scorecard, Highlights, Investment). Spend the most time on section 3 (what is working / what needs attention). Sections 5-6 (Recommendations, Risks) drive the action items.
3. **After the meeting:** Log action items, update risk register, share the completed readout with stakeholders.

### Cadence Recommendations

| Customer Stage | Readout Frequency | Depth |
|----------------|-------------------|-------|
| Early adoption (L1-L2) | Weekly | Focus on adoption metrics, quick wins |
| Scaling (L2-L3) | Biweekly | Full scorecard, ROI starting to materialize |
| Optimizing (L3-L4) | Biweekly to monthly | ROI deep dives, benchmark comparisons |
| Mature (L4-L5) | Monthly | Strategic focus, cross-org patterns |

### ROI Model Usage

- **First engagement:** Run the model with the customer's actual numbers. Even conservative estimates typically show compelling ROI -- let the math do the selling.
- **Quarterly reviews:** Update inputs from actual metrics. Show the trajectory from projected to realized ROI.
- **Budget conversations:** Use the sensitivity analysis to show the "floor" case. CFOs respect honest ranges more than inflated single-point estimates.
- **Competitive displacement:** If a customer is evaluating non-AWS AI tooling, run the ROI model side-by-side with competitor cost structures. The AWS-native integration story (Bedrock + Timestream + CloudWatch) eliminates integration overhead costs that inflate competitor TCO.

### Customization Notes

- Both documents use placeholder values in brackets `[like this]`. Replace all of them before sharing with customers.
- Adjust PRISM level thresholds if the customer has negotiated custom level definitions.
- The ROI model's `utilization_factor` (0.35) and `incident_probability` (0.15) are calibrated from early adopter data. Adjust if you have customer-specific data.
- For very large organizations (500+ engineers), apply a diminishing returns factor of 0.85 to Velocity ROI to account for coordination overhead.

## Related Resources

- **CloudWatch Dashboards:** `dashboards/cloudwatch/` -- Deploy these first so the customer has real-time visibility.
- **QuickSight Analyses:** `dashboards/quicksight/` -- For deep-dive analytics and historical trend analysis.
- **PRISM Level Definitions:** Reference the main PRISM framework documentation for detailed level criteria.
