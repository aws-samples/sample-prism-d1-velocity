# PRISM D1 Velocity — Community Roadmap

> **Last updated:** 2026-04-22
> **Status:** Open for contributions
> **Context:** See [competitive-landscape.md](./competitive-landscape.md) for the full gap analysis driving these priorities.

---

## How This Roadmap Works

Items are organized into **phases** based on impact and dependency order. Each item includes:
- **Priority:** P0 (critical gap), P1 (high value), P2 (nice to have)
- **Complexity:** S (small, 1-2 days), M (medium, 3-5 days), L (large, 1-2 weeks), XL (epic, 2+ weeks)
- **Labels:** `dashboard`, `pipeline`, `infra`, `docs`, `new-metric`, `integration`, `community`
- **Closes gap vs:** Which 3P tools this catches up to or surpasses

Contributors: pick any item, open an issue referencing the roadmap ID (e.g., `R-101`), and submit a PR. See [Contributing](#contributing) at the bottom.

---

## Phase 1 — Close Critical Dashboard Gaps

*Goal: Make both dashboard tiers complete so executives and developers see the full picture.*

| ID | Item | Priority | Complexity | Labels | Closes Gap vs |
|----|------|----------|------------|--------|---------------|
| **R-101** | ✅ **Done** — **Bubble quality metrics to Executive dashboard** — Added AI vs Human defect rate and cost intelligence to executive readout | P0 | S | `dashboard` | Internal gap |
| **R-102** | **Add PRISM Level widget to Team Velocity dashboard** — Show current maturity level + dimension breakdown so developers see their own progress | P0 | S | `dashboard` | Internal gap |
| **R-103** | **Add cross-team comparison to Team Velocity dashboard** — Let developers see how their team compares on key metrics | P0 | S | `dashboard` | Swarmia, Jellyfish |
| **R-104** | **Add incident/alert panel to both dashboards** — Surface active CloudWatch alarms, recent incidents, and MTTR trends directly in dashboards | P0 | M | `dashboard`, `pipeline` | All 3P tools |
| **R-105** | ✅ **Done** — **Expand alerting** — Added 4 new alarms: GuardrailBlockRate, BedrockDailyCost, TokenEfficiency, ExfiltrationAlert (now 8 total) | P1 | M | `infra`, `dashboard` | All 3P tools |

---

## Phase 2 — Cost Intelligence & ROI

*Goal: Enable true ROI calculation by ingesting AI tool costs alongside productivity metrics.*

| ID | Item | Priority | Complexity | Labels | Closes Gap vs |
|----|------|----------|------------|--------|---------------|
| **R-201** | **AI tool cost ingestion pipeline** — New EventBridge event type `prism.d1.cost.license` to ingest per-tool, per-seat cost data (Copilot, Claude, Cursor, etc.) | P0 | M | `pipeline`, `new-metric` | Jellyfish, DX, Faros |
| **R-202** | **True ROI dashboard widget** — Calculate `(productivity_gain × avg_eng_salary) / tool_cost` and display in Executive Readout | P0 | M | `dashboard` | Jellyfish, DX |
| **R-203** | **License utilization tracking** — Track active-vs-provisioned seats per AI tool, flag underutilization | P1 | M | `pipeline`, `dashboard` | Swarmia, Faros |
| **R-204** | **Cost-per-deploy and cost-per-feature metrics** — Derived metrics combining deployment events with cost data | P1 | S | `dashboard`, `new-metric` | Jellyfish |

---

## Phase 2B — Token Usage & Cost Intelligence (Bedrock)

*Goal: Capture Bedrock token consumption from Claude Code, Kiro, and Q Developer. Correlate to developers, commits, PRs, and features. Overlay cost. See [Data Architecture](./data-architecture.md) for the full gap analysis.*

| ID | Item | Priority | Complexity | Labels | Details |
|----|------|----------|------------|--------|---------|
| **R-210** | ❌ **Removed** — **CloudTrail → EventBridge token pipeline** — Replaced by client-side codeburn git trailers. CloudTrail does not expose Bedrock token counts. | P0 | L | `pipeline`, `infra` | — |
| **R-211** | ✅ **Done** — **Model pricing table** — `prism-model-pricing` DynamoDB table, seeded on deploy via Custom Resource with Claude + Titan pricing. | P0 | S | `infra`, `new-metric` | Prerequisite for cost calculation. |
| **R-212** | ✅ **Done** — **IAM principal → Developer identity mapping** — `prism-identity-mapping` DynamoDB table with GSI on team_id. Requires manual seeding. | P0 | M | `pipeline`, `infra` | Critical for per-developer attribution. |
| **R-213** | ❌ **Removed** — **Token-to-commit correlation** — Replaced by codeburn per-commit trailers (AI-Input-Tokens, AI-Output-Tokens, AI-Cost). | P1 | L | `pipeline`, `new-metric` | — |
| **R-214** | **Token-to-PR aggregation** — Sum all correlated token usage across commits in a PR. Calculate cost-per-PR. | P1 | M | `pipeline`, `new-metric` | Depends on R-213. Enables feature-level cost visibility. |
| **R-215** | **Token-to-feature/epic mapping** — Aggregate PR-level costs to feature/epic using Jira/Linear issue keys from PR titles, branch names, or commit messages. | P1 | M | `pipeline`, `integration` | Depends on R-214. Answers "how much AI spend went into Feature X?" |
| **R-216** | **Developer session analytics** — Group Bedrock API calls into sessions (gap > 15 min = new session). Track: duration, turns, tokens in/out, models used, cost. New `prism.d1.session` event type. | P1 | L | `pipeline`, `new-metric` | Enables "avg session cost", "tokens per session", "sessions per developer per day". |
| **R-217** | ❌ **Removed** — **CloudWatch token & cost metrics** — Replaced by `AIInputTokens`, `AIOutputTokens`, `AICostUSD` published from PR merge workflow (codeburn git trailers). | P0 | M | `pipeline`, `new-metric` | — |
| **R-218** | ✅ **Done** — **Token & cost dashboards** — Added Cost Intelligence section to both dashboards: daily token trends, cost by model, cost-per-commit, Bedrock cost, token efficiency. | P0 | L | `dashboard` | Exec: weekly cost + cost/deploy. Dev: daily trends + efficiency. |
| **R-219** | ✅ **Done** — **Cost anomaly alarms** — `BedrockDailyCostHigh` (>$100/day) and `TokenEfficiencyLow` (>500 tokens/line). SNS not yet wired. | P1 | S | `infra`, `dashboard` | Prevents runaway costs. |
| **R-220** | **Multi-tool cost normalization** — Unified view across Bedrock (pay-per-token), Copilot (subscription), Cursor (subscription + usage). Normalize to cost-per-developer-day. | P2 | M | `pipeline`, `dashboard` | Different pricing models make comparison hard. |
| **R-221** | **ROI calculator with token cost input** — Enhanced ROI Multiplier: `(time_saved × hourly_eng_cost) / (token_cost + license_cost)`. Show break-even and marginal ROI. | P1 | M | `dashboard`, `new-metric` | The "is AI worth it?" answer for CFOs. |

---

## Phase 3 — Developer Experience & Sentiment

*Goal: Add qualitative measurement to complement systems data — the biggest gap vs. DX and Faros.*

| ID | Item | Priority | Complexity | Labels | Closes Gap vs |
|----|------|----------|------------|--------|---------------|
| **R-301** | **Developer sentiment survey framework** — Lightweight, opt-in pulse surveys (5-7 questions) delivered via CLI or Slack, stored in DynamoDB | P0 | L | `pipeline`, `new-metric`, `integration` | DX (core differentiator) |
| **R-302** | **Survey results dashboard** — Sentiment trends over time, correlation with DORA metrics, satisfaction by AI tool | P1 | M | `dashboard` | DX, Faros |
| **R-303** | **Developer Experience Index (DXI) equivalent** — Composite score combining systems metrics + survey responses into a single developer happiness signal | P1 | M | `new-metric`, `dashboard` | DX |
| **R-304** | **AI tool satisfaction breakdown** — Per-tool sentiment (Claude Code vs Copilot vs Kiro) from survey data | P2 | S | `dashboard` | DX |

---

## Phase 4 — Benchmarking & Comparisons

*Goal: Let teams compare themselves against industry peers — currently a zero-coverage gap.*

| ID | Item | Priority | Complexity | Labels | Closes Gap vs |
|----|------|----------|------------|--------|---------------|
| **R-401** | **Anonymous benchmark data submission** — Opt-in pipeline where PRISM users contribute anonymized metrics to a shared benchmark dataset (S3 + Athena) | P1 | L | `pipeline`, `infra`, `community` | LinearB, Jellyfish, DX |
| **R-402** | **Benchmark comparison widgets** — Show team metrics against community percentiles (P25/P50/P75/P90) in both dashboards | P1 | M | `dashboard` | LinearB, Jellyfish |
| **R-403** | **PRISM Level distribution** — Show where teams fall on the L1-L5 scale relative to the community | P2 | S | `dashboard`, `community` | DX |
| **R-404** | **Publish annual PRISM benchmark report** — Community-driven equivalent of LinearB's benchmarks report | P2 | L | `docs`, `community` | LinearB (8.1M PRs) |

---

## Phase 5 — Scale & Multi-Org Support

*Goal: Support org-wide rollups, hierarchies, and multi-repo aggregation at scale.*

| ID | Item | Priority | Complexity | Labels | Closes Gap vs |
|----|------|----------|------------|--------|---------------|
| **R-501** | **Org hierarchy model** — DynamoDB schema for org > division > team > repo hierarchy with rollup aggregation in Lambda | P1 | L | `pipeline`, `infra` | Jellyfish, Faros |
| **R-502** | **Executive drill-down dashboards** — Org-level summary that drills into division, team, and repo views | P1 | L | `dashboard` | Jellyfish, Faros |
| **R-503** | **Multi-repo aggregation** — Team-level metrics that aggregate across all repos owned by a team | P1 | M | `pipeline` | All 3P tools |
| **R-504** | **QuickSight row-level security** — Role-based access so executives see org-wide, managers see their teams, devs see their repos | P2 | M | `infra`, `dashboard` | Jellyfish, Faros |

---

## Phase 6 — Advanced Analytics & Intelligence

*Goal: Go beyond dashboards into proactive insights — matching or exceeding Jellyfish/Faros AI copilots.*

| ID | Item | Priority | Complexity | Labels | Closes Gap vs |
|----|------|----------|------------|--------|---------------|
| **R-601** | **Cohort A/B analysis** — Compare AI-using vs non-AI-using developer cohorts on all DORA + AI-DORA metrics | P1 | L | `pipeline`, `dashboard` | DX, Faros |
| **R-602** | **Anomaly detection** — ML-based alerts using CloudWatch Anomaly Detection for all key metrics (replace static thresholds) | P1 | M | `infra` | All 3P tools |
| **R-603** | **Natural-language metrics query (Bedrock)** — Claude-powered conversational interface over metrics data via Bedrock Agent | P1 | XL | `infra`, `integration` | Jellyfish, DX, Faros |
| **R-604** | **Automated weekly insights digest** — Bedrock-generated summary of key trends, anomalies, and recommendations, delivered via SNS/email | P2 | L | `infra`, `integration` | Jellyfish, Faros |
| **R-605** | **Predictive PRISM leveling** — ML model that predicts when a team will reach the next PRISM level based on current trajectory | P2 | L | `new-metric`, `infra` | None (novel) |

---

## Phase 7 — Integrations & Ecosystem

*Goal: Connect PRISM to the tools teams already use.*

| ID | Item | Priority | Complexity | Labels | Closes Gap vs |
|----|------|----------|------------|--------|---------------|
| **R-701** | **Multi-AI tool breakdown dashboard** — Break down metrics by AI tool (Claude Code, Copilot, Kiro, Q Developer, Cursor) in both dashboard tiers | P1 | M | `dashboard` | Jellyfish (10+ tools) |
| **R-702** | **Slack/Teams notifications** — Alert summaries and weekly digests to team channels via SNS + Lambda | P1 | M | `integration` | Swarmia, LinearB |
| **R-703** | **Jira/Linear integration** — Map issues to deployments for investment allocation and feature-level tracking | P2 | L | `integration`, `pipeline` | Jellyfish, LinearB |
| **R-704** | **R&D capitalization report** — Time allocation breakdown (new feature vs maintenance vs overhead) for finance teams | P2 | L | `dashboard`, `new-metric` | Jellyfish, Swarmia, Pluralsight Flow |
| **R-705** | **GitHub Actions marketplace action** — One-click PRISM metric emission from any CI/CD pipeline | P1 | M | `integration`, `community` | Swarmia, LinearB |
| **R-706** | **GitLab CI integration** — Equivalent collector for GitLab-based teams | P2 | M | `integration`, `community` | Swarmia, Faros |
| **R-707** | **ADOT collector mode for OTEL ingestion** — Replace the Lambda OTLP receiver with an ADOT collector on Fargate (`-c otelCollectorMode=adot`): OIDC-authenticated receiver, exporter fan-out to X-Ray/CloudWatch traces, S3, and any OTLP backend (Grafana Tempo, Datadog, Honeycomb) via YAML config. Lambda mode remains the low-cost default | P2 | L | `integration`, `infra` | — |

---

## Phase 8 — Beyond Feature Parity (Novel)

*Goal: Capabilities no 3P tool offers — PRISM-exclusive innovations.*

| ID | Item | Priority | Complexity | Labels | Closes Gap vs |
|----|------|----------|------------|--------|---------------|
| **R-801** | **Eval gate marketplace** — Community-contributed Bedrock Evaluation templates for common use cases (security review, API contract validation, test quality) | P1 | L | `community`, `infra` | None (novel) |
| **R-802** | **Spec quality scoring** — Rate spec completeness/clarity using Bedrock, correlate with downstream code quality and cycle time | P1 | L | `new-metric`, `pipeline` | None (novel) |
| **R-803** | **AI pair-programming session analytics** — Track Claude Code session duration, tool calls, iteration count, and correlation with output quality | P2 | L | `new-metric`, `pipeline` | None (novel) |
| **R-804** | **Cross-team knowledge flow** — Track how AI-generated patterns propagate across teams (shared prompts, reused specs, common agent configs) | P2 | XL | `new-metric`, `pipeline` | None (novel) |
| **R-805** | **Guardrail effectiveness metrics** — Track Bedrock Guardrail trigger rates, false positives, and correlation with code quality | P2 | M | `new-metric`, `pipeline` | None (novel) |
| **R-806** | **PRISM certification program** — Automated assessment that teams can run to certify their PRISM level, with badge generation | P2 | L | `community`, `docs` | None (novel) |
| **R-807** | **AI technical debt tracker** — Monitor AI-generated code that accumulates review comments, bug fixes, or churn — early warning for AI code that needs human refactoring | P1 | L | `new-metric`, `pipeline` | None (novel) |

---

## Priority Summary

| Phase | P0 Items | P1 Items | P2 Items | Done | Focus |
|-------|----------|----------|----------|------|-------|
| 1 — Dashboard Gaps | 4 | 1 | 0 | **2/5** | Complete the picture |
| 2 — Cost & ROI | 2 | 2 | 0 | 0/4 | Prove the business case |
| 2B — Token & Cost Intelligence | 5 | 6 | 1 | **7/12** | Bedrock token tracking & cost overlay |
| 3 — DevEx & Sentiment | 1 | 2 | 1 | 0/4 | Qualitative measurement |
| 4 — Benchmarking | 0 | 2 | 2 | 0/4 | Community comparisons |
| 5 — Scale | 0 | 3 | 1 | 0/4 | Enterprise readiness |
| 6 — Advanced Analytics | 0 | 3 | 2 | 0/5 | Intelligence layer |
| 7 — Integrations | 0 | 3 | 3 | 0/6 | Ecosystem connectivity |
| 8 — Novel | 0 | 3 | 4 | 0/7 | PRISM-exclusive innovation |

**Recommended execution order:** Phase 1 → 2 → 2B → 3 → 7 (R-701, R-705) → 4 → 5 → 6 → 8

> **Note (2026-04-27):** R-101, R-105, R-210-R-213, R-217-R-219 completed along with guardrail deployment, MCP authorization, VPC/KMS infrastructure, defect correlation, and spec-to-code calculation.

---

## Contributing

We welcome contributions from the community! Here's how to get involved:

### Picking Up a Roadmap Item

1. **Find an item** — Browse the phases above and pick something that matches your skills and interest.
2. **Open an issue** — Create a GitHub issue titled `[R-XXX] <Item title>` with:
   - The roadmap ID (e.g., `R-301`)
   - Your proposed approach (1-2 paragraphs)
   - Estimated timeline
3. **Get feedback** — Maintainers will comment within 48 hours with guidance, context, or approval.
4. **Submit a PR** — Reference the issue in your PR description. Follow the [development workflow](../CLAUDE.md#development-workflow).

### Contribution Guidelines

- **Start with a spec** — For M/L/XL items, write a spec in `specs/` before coding (see CLAUDE.md).
- **Tag AI origin** — Use `ai-origin: claude-code` or `ai-origin: kiro` in commit trailers.
- **Emit metrics** — Any new component must emit structured events per the [metrics schema](../CLAUDE.md#metrics-schema).
- **AWS-native only** — No third-party observability dependencies. CloudWatch, QuickSight, DynamoDB, EventBridge, Bedrock.
- **Test with sample data** — Use `scripts/` generators to validate dashboard changes.
- **Update this roadmap** — Mark items as `In Progress` or `Done` when you pick them up or complete them.

### Good First Issues

These items are well-scoped and great for first-time contributors:

| ID | Item | Why It's Good for New Contributors |
|----|------|-------------------------------------|
| R-101 | Bubble quality metrics to Exec dashboard | Copy existing widget patterns, just add new metrics |
| R-102 | Add PRISM Level to Team Velocity | Port widget from executive dashboard JSON |
| R-103 | Cross-team comparison for devs | Extend existing team comparison pattern |
| R-204 | Cost-per-deploy metric | Simple derived calculation in dashboard JSON |
| R-304 | AI tool satisfaction breakdown | Small dashboard widget, depends on R-301 |
| R-403 | PRISM Level distribution | Simple aggregation visualization |

### Proposing New Items

Have an idea not on the roadmap? Open an issue with the `roadmap-proposal` label including:
- **What:** One-sentence description
- **Why:** Which gap it closes or what novel value it adds
- **Complexity estimate:** S/M/L/XL
- **Competitive context:** Does any 3P tool do this? How?

---

## Status Tracking

| Status | Meaning |
|--------|---------|
| `Open` | Available for contribution |
| `In Progress` | Someone is actively working on it (linked issue) |
| `In Review` | PR submitted, awaiting review |
| `Done` | Merged to main |
| `Deferred` | Deprioritized — revisit next quarter |

*Items marked ✅ Done were completed on 2026-04-27. All other items are `Open` unless noted.*
