# PRISM D1 Velocity — Competitive Landscape & Gap Analysis

> **Last updated:** 2026-04-22
> **Purpose:** Compare PRISM D1's AI-DORA metrics against leading 3P engineering intelligence platforms to identify differentiators, gaps, and roadmap priorities.

---

## Executive Summary

PRISM D1 Velocity introduces **AI-native DORA extensions** that no commercial platform currently offers — eval gate pass rates, spec-to-code velocity, AI provenance tracking, and AI-vs-human defect comparison. However, established platforms lead in developer experience measurement, industry benchmarking, cost/license analytics, and cross-org rollups.

This document maps the landscape, identifies where PRISM leads and trails, and feeds the [community roadmap](./ROADMAP.md).

---

## Platforms Compared

| Platform | Focus | Pricing Tier | AI Metric Maturity |
|----------|-------|-------------|-------------------|
| **Swarmia** | Team productivity + DORA | Mid-market | Moderate — adoption & cycle time |
| **Jellyfish** | Executive engineering intelligence | Enterprise ($50K+/yr) | Strong — 10+ AI tools, ROI |
| **LinearB** | DORA + workflow automation | Mid-market (free DORA tier) | Moderate — Copilot/Cursor focus |
| **DX (getdx.com)** | Developer experience + surveys | Mid-market | Strong — file-level AI detection, surveys |
| **Faros AI** | Data aggregation (100+ sources) | Enterprise | Strongest 3P — accept rates, A/B testing |
| **Pluralsight Flow** | Git activity analytics | Mid-market (acquired by Appfire) | None — no AI metrics |

---

## Metric Coverage Matrix

### Standard DORA Metrics

All platforms (except Pluralsight Flow's uncertain future) and PRISM D1 cover the core four:

| Metric | Swarmia | Jellyfish | LinearB | DX | Faros | **PRISM D1** |
|--------|---------|-----------|---------|-----|-------|-------------|
| Deployment Frequency | Yes | Yes | Yes | Yes | Yes | **Yes** |
| Lead Time for Changes | Yes | Yes | Yes | Yes | Yes | **Yes** |
| Change Failure Rate | Yes | Yes | Yes | Yes | Yes | **Yes** |
| MTTR | Yes | Yes | Yes | Yes | Yes | **Yes** |

### AI-Native Metrics

| Metric | Swarmia | Jellyfish | LinearB | DX | Faros | **PRISM D1** |
|--------|---------|-----------|---------|-----|-------|-------------|
| AI Tool Adoption Tracking | Yes | Yes (10+) | Yes | Yes | Yes | Partial (origin tag) |
| AI Code % / Merge Ratio | No | Yes | No | Yes | Yes | **Yes** |
| AI Suggestion Accept Rate | No | No | No | No | Yes | **Yes** |
| AI Impact on Cycle Time | Yes | Yes | Yes | Yes | Yes | **Yes** |
| AI ROI / Cost Analysis | No | Yes | Yes | Yes | Yes | Partial (no cost input) |
| AI Agent Tracking | Yes | Yes | Limited | Limited | Limited | **Yes** |

### PRISM-Exclusive Metrics (No 3P Equivalent)

| Metric | Description | Why It Matters |
|--------|-------------|----------------|
| **Eval Gate Pass Rate** | % of AI outputs passing Bedrock Evaluation gates before merge | Quality assurance for AI-generated code at the CI gate |
| **Spec-to-Code Hours** | Time from spec approval to code completion | Measures AI impact on the full spec-driven development lifecycle |
| **AI Test Coverage Delta** | Isolated AI contribution to test coverage changes | Separates AI testing value from human testing effort |
| **Post-Merge Defect Rate (AI vs Human)** | Side-by-side defect comparison by code origin | Answers "is AI code as reliable as human code?" |
| **PRISM Maturity Level (L1-L5)** | Composite score across 6 normalized dimensions | Structured maturity model with clear progression path |
| **AI Provenance Tracking** | Every event tagged: ai-generated / ai-assisted / human | Full traceability of AI contribution at the event level |

### Platform Capabilities

| Capability | Swarmia | Jellyfish | LinearB | DX | Faros | **PRISM D1** |
|------------|---------|-----------|---------|-----|-------|-------------|
| Developer Surveys/Sentiment | No | No | No | **Yes (core)** | Yes | **No** |
| Industry Benchmarking | Limited | Yes | Yes (8.1M PRs) | Yes | Yes | **No** |
| Executive Dashboards | Limited | **Strong** | Yes | Yes | Yes | Yes |
| Developer Dashboards | Yes | Limited | Yes | Yes | Limited | Yes |
| Multi-repo Aggregation | Yes | Yes | Yes | Yes | Yes | **Limited** |
| Workflow Automation | No | No | Yes (gitStream) | No | No | **No** |
| R&D Capitalization | Yes | Yes | No | Yes | No | **No** |
| Cohort A/B Testing | No | No | No | Yes | Yes | **No** |
| Cross-org Rollups | Yes | Yes | Yes | Yes | Yes | **Limited** |
| NL Query Interface | No | Yes (AI copilot) | No | Yes (AI copilot) | Yes (Lighthouse) | **No** |
| Maturity Model | No | No | No | No | No | **Yes** |
| Alerting/Anomaly Detection | Yes | Yes | Yes | Yes | Yes | **Yes** (8 alarms) |
| AI Cost Intelligence | No | Yes | Yes | Yes | Yes | **Yes** (token + cost pipeline) |
| MCP/Tool Governance | No | No | No | No | No | **Yes** (scope-based auth + audit) |
| Guardrail Enforcement | No | No | No | No | No | **Yes** (Bedrock Guardrails) |
| Data Encryption (CMK) | Varies | Yes | Varies | Varies | Yes | **Yes** (KMS with rotation) |
| Exfiltration Detection | No | No | No | No | No | **Yes** (CloudTrail anomaly) |

---

## Internal Dashboard Gap Analysis

PRISM D1 ships two dashboard tiers — an Executive Readout and a Team Velocity (developer) dashboard. The table below highlights where signals are missing at each tier:

| Signal | Executive Readout | Team Velocity | Gap |
|--------|:-----------------:|:-------------:|-----|
| DORA metrics | Single-value summaries | Time-series with thresholds | Exec lacks trend drill-down |
| AI Acceptance Rate | 90-day trend | Time-series with L2/L3 targets | Well-covered |
| Cost / Budget | ROI Multiplier (no cost input) | Not shown | Neither has real cost data |
| Team Comparison | Multi-team overlay | Single team | Devs can't compare across teams |
| Defect Quality (AI vs Human) | **Not shown** | Side-by-side | Exec has no quality visibility |
| Spec-to-Code Hours | **Not shown** | Time-series | Exec missing velocity signal |
| AI Test Coverage Delta | **Not shown** | Time-series | Exec missing quality signal |
| PRISM Level | Gauge + radar | **Not shown** | Devs can't see their maturity |
| Incidents / Alerts | **Not shown** | **Not shown** | Neither surfaces incident data |

**Key finding:** Quality signals (defects, test coverage) don't bubble up to executives. Maturity context (PRISM level, team comparison) doesn't flow down to developers. Neither tier surfaces incidents.

---

## Competitive Positioning

### Where PRISM D1 Wins

1. **AI Quality Gates** — Only platform with eval-gate-pass-rate as a first-class metric. This directly addresses the "AI code ships fast but breaks things" concern that Faros AI's research highlighted (242.7% increase in incidents per AI-generated PR in some orgs).

2. **Spec-Driven Lifecycle Tracking** — No 3P tool measures the spec-to-code pipeline. This is unique to the PRISM framework's spec-first development philosophy.

3. **AI Provenance at Event Level** — While Jellyfish and DX track AI code percentages, PRISM tags every individual event with its AI origin, enabling granular attribution.

4. **Maturity Model** — The PRISM L1-L5 framework provides a structured adoption path. Commercial tools show metrics but don't prescribe a maturity journey.

5. **AWS-Native / Zero 3P Cost** — Runs entirely on CloudWatch, QuickSight, EventBridge, and DynamoDB. No per-seat licensing fees.

6. **MCP Tool Governance** — Only platform with scope-based authorization, session management, and audit logging for MCP tool calls. No 3P tool governs agent-to-tool access.

7. **Bedrock Guardrail Integration** — Only platform with deployed Bedrock Guardrails (content filters, PII protection, denied topics) and per-trigger metric tracking. No 3P tool enforces AI safety at the platform level.

8. **AI vs Human Defect Comparison** — Only platform correlating deployment failures to AI vs human commit origins, providing side-by-side defect rates.

9. **Integrated Pen Testing via AWS Security Agent** — Only platform with automated pen testing (OWASP Top 10 + business logic), design review, and code review findings flowing into the metrics pipeline. Findings correlated with AI origin, tracked for remediation SLA, and fed back into eval gates (SECURITY-09). CISO Compliance dashboard provides cross-team security posture and shift-left effectiveness.

### Where PRISM D1 Trails

1. **Developer Experience** — No qualitative/survey capability. DX and Faros combine systems data with developer sentiment for a complete picture.

2. **Benchmarking** — No industry comparison data. LinearB has 8.1M+ PRs of benchmark data; Jellyfish and DX offer peer comparisons.

3. ~~**Cost Intelligence**~~ — **CLOSED.** Token-level cost tracking via CloudTrail → Bedrock pipeline now provides per-developer, per-model, per-commit cost attribution. Remaining gap: multi-tool cost normalization (Copilot/Cursor subscription models).

4. **Scale & Rollups** — Dashboards are per-team. No org-wide hierarchy, drill-down, or cross-team aggregation at the executive level.

5. **Self-Serve Analytics** — No natural-language query interface. Jellyfish, DX, and Faros all offer AI copilots for exploring metrics data.

---

## Key Industry Data Points

- **Faros AI (2025 DORA Report):** AI-generated PRs show 441% increase in review wait time and 242.7% increase in incidents per PR — making eval gates and defect tracking critical.
- **LinearB (2026 Benchmarks):** AI PRs have 32.7% merge acceptance rate vs. 84.4% for manual PRs — acceptance rate tracking is essential.
- **DX Research:** Developer satisfaction with AI tools correlates more strongly with productivity gains than raw usage metrics — surveys matter.
- **Jellyfish:** Organizations using 3+ AI coding tools see diminishing returns without centralized measurement — multi-tool tracking is table stakes.

---

## How to Use This Document

1. **Workshop facilitators** — Use the positioning section in Module 06 to explain why PRISM's metrics go beyond commercial tools.
2. **Engineering leaders** — Use the gap analysis to decide whether PRISM complements or replaces a 3P tool in your stack.
3. **Contributors** — See [ROADMAP.md](./ROADMAP.md) for prioritized backlog items that close the gaps identified here.

---

## References

- [Swarmia — AI Tools Docs](https://help.swarmia.com/features/measure-the-productivity-impact-of-ai-tools)
- [Jellyfish — AI Impact Platform](https://jellyfish.co/platform/jellyfish-ai-impact/)
- [LinearB — 2026 Engineering Benchmarks](https://linearb.io/resources/software-engineering-benchmarks-report)
- [DX — AI Measurement Framework](https://getdx.com/whitepaper/ai-measurement-framework/)
- [Faros AI — Copilot Evaluation Module](https://www.faros.ai/copilot-module)
- [Faros AI — 2025 DORA Report](https://www.faros.ai/blog/key-takeaways-from-the-dora-report-2025)
