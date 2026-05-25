# PRISM D1 Velocity -- Onboarding Tracks

## Track Assignment Logic

The onboarding track is determined by the blended PRISM D1 Level and the assessment verdict:

| Blended Level | Verdict | Track |
|---------------|---------|-------|
| L1.0--L1.5 | NEEDS_FOUNDATIONS | A -- Foundations |
| L2.0--L2.5 | READY_FOR_PILOT | B -- Full Workshop |
| L3.0--L3.5 | READY_FOR_PILOT | C -- Accelerated |
| L4.0--L5.0 | READY_FOR_PILOT | D -- Advanced Optimization |
| Any | NOT_QUALIFIED | No track (exit with recommendations) |

---

## Track A: Foundations

**Target**: L1.0--L1.5, NEEDS_FOUNDATIONS verdict

**Duration**: 2 weeks pre-work + 4-hour workshop (Modules 00--02 only)

**Focus**: Get AI tooling standardized and introduce spec-driven development. These teams are early in their AI-assisted development journey. They may have ad-hoc tool usage but lack standards, commit conventions, or any measurement of AI's contribution.

### Workshop Modules

| Module | Included | Reason |
|--------|----------|--------|
| 00 -- Environment Setup | Yes | Foundation for everything else |
| 01 -- CLAUDE.md & Standards | Yes | Standardize AI tool configuration |
| 02 -- Spec-Driven Development | Yes | Introduce structured AI workflows |
| 03 -- CI/CD & Eval Gates | No | Too early -- no baseline to gate against |
| 04 -- Metrics & Dashboards | No | Too early -- need data flowing first |
| 05 -- Governance & Scaling | No | Too early -- need adoption first |

### Deliverables

- CLAUDE.md deployed to all active repositories
- Spec templates adopted by the team (feature spec, bug fix spec, refactor spec)
- First AI-tagged commits flowing (using `AI-Origin` and `AI-Confidence` trailers)
- Team has completed at least one spec-driven feature build

### Success Metrics

| Metric | Target | Measure By |
|--------|--------|------------|
| AI-origin commit trailers | 30%+ of commits | 2 weeks post-workshop |
| CLAUDE.md deployment | 100% of active repos | 1 week post-workshop |
| Spec adoption | 2+ specs written per developer | 2 weeks post-workshop |

### SA Touchpoints

| When | Type | Duration | Agenda |
|------|------|----------|--------|
| Pre-work kick-off | Video call | 30 min | Walk through pre-work, answer questions |
| Workshop day | In-person or video | 4 hr | Deliver Modules 00--02 |
| Week 1 post-workshop | Async check-in | -- | Review commit trailer adoption |
| Week 2 post-workshop | Video call | 30 min | Review metrics, troubleshoot |
| Week 4 | Re-assessment | 1 hr | Re-run scanner, determine if ready for Track B |

### Next Step

Re-assess after 4 weeks. If the team reaches L2.0+, upgrade to Track B for the full workshop and pilot. If still below L2.0, extend the foundations engagement with targeted coaching.

---

## Track B: Full Workshop

**Target**: L2.0--L2.5, READY_FOR_PILOT verdict

**Duration**: 1 week pre-work + full 4-hour workshop (all 6 modules) + 8-week pilot

**Focus**: Complete AI-DLC implementation with metrics and dashboards. These teams have some AI tooling in place and basic standards, but need the full framework to measure, govern, and scale their AI-assisted development.

### Workshop Modules

| Module | Included | Reason |
|--------|----------|--------|
| 00 -- Environment Setup | Yes | Verify and upgrade existing setup |
| 01 -- CLAUDE.md & Standards | Yes | Align existing config to PRISM standards |
| 02 -- Spec-Driven Development | Yes | Formalize and standardize spec workflows |
| 03 -- CI/CD & Eval Gates | Yes | Instrument pipeline with eval gates |
| 04 -- Metrics & Dashboards | Yes | Deploy Timestream + QuickSight dashboards |
| 05 -- Governance & Scaling | Yes | Establish governance model for scaling |

### Deliverables

- Full bootstrapper deployed (CLAUDE.md, hooks, metrics pipeline)
- Metrics pipeline live (EventBridge -> Timestream -> QuickSight)
- Dashboards active with real-time data
- Eval gate integrated into at least one CI/CD pipeline
- Executive readout template configured

### Success Metrics

| Metric | Target | Measure By |
|--------|--------|------------|
| AI acceptance rate | 30%+ | Week 4 checkpoint |
| Eval gate in CI | At least 1 pipeline | Week 2 of pilot |
| Weekly executive readout | Active | Week 3 of pilot |
| PRISM D1 level improvement | +0.5 levels | Week 8 of pilot |

### SA Touchpoints

| When | Type | Duration | Agenda |
|------|------|----------|--------|
| Pre-work kick-off | Video call | 30 min | Review pre-work, confirm access |
| Workshop day | In-person or video | 4 hr | Deliver all 6 modules |
| Week 1 | Video call | 45 min | Verify bootstrapper deployment, first metrics |
| Week 2 | Async check-in | -- | Review dashboard data, flag issues |
| Week 4 | Video call (checkpoint) | 1 hr | Midpoint review, adjust targets |
| Week 6 | Async check-in | -- | Review progress toward 8-week goals |
| Week 8 | Video call (readout) | 1 hr | Final pilot readout, next steps |

### Next Step

8-week pilot with a Week 4 checkpoint. At pilot completion, re-assess and determine if the team is ready for Track C (L3.0+) or needs continued Track B coaching.

---

## Track C: Accelerated

**Target**: L3.0--L3.5, READY_FOR_PILOT verdict

**Duration**: 2-hour targeted workshop (Modules 03--05 only) + 8-week pilot

**Focus**: Fill specific gaps. These teams already have solid AI tooling, commit hygiene, and spec-driven workflows. Their gaps are typically in metrics/observability, governance, or platform reuse. The workshop focuses exclusively on closing those gaps.

### Workshop Modules

| Module | Included | Reason |
|--------|----------|--------|
| 00 -- Environment Setup | No | Already have a working setup |
| 01 -- CLAUDE.md & Standards | No | Already adopted standards |
| 02 -- Spec-Driven Development | No | Already practicing spec-driven dev |
| 03 -- CI/CD & Eval Gates | Yes | Close eval and quality gaps |
| 04 -- Metrics & Dashboards | Yes | Deploy advanced observability |
| 05 -- Governance & Scaling | Yes | Formalize governance for scale |

### Deliverables

- Gap-specific improvements deployed (based on assessment gap analysis)
- Advanced dashboard deployment (custom metrics, trend analysis)
- Governance model formalized (approval workflows, cost controls)
- Platform reuse patterns documented

### Success Metrics

| Metric | Target | Measure By |
|--------|--------|------------|
| Top-3 gap categories closed | Score improvement 50%+ | Week 4 |
| PRISM D1 level | Reach L3.5+ | Week 8 |
| Governance model | Documented and adopted | Week 2 |
| Advanced dashboards | Live with trend data | Week 4 |

### SA Touchpoints

| When | Type | Duration | Agenda |
|------|------|----------|--------|
| Pre-workshop | Async | -- | Share gap analysis, confirm focus areas |
| Workshop day | Video call | 2 hr | Targeted Modules 03--05 |
| Week 2 | Video call | 30 min | Verify gap remediation progress |
| Week 4 | Video call (checkpoint) | 45 min | Midpoint review |
| Week 8 | Video call (readout) | 1 hr | Final readout, L4 transition plan |

### Next Step

Pilot focused on L3 to L4 transition. At completion, the team should be ready for Track D (Advanced Optimization) or transition to D2/D3/D4 pillars.

---

## Track D: Advanced Optimization

**Target**: L4.0+, READY_FOR_PILOT verdict

**Duration**: Custom engagement, architecture review focused

**Focus**: Multi-agent governance, AI FinOps, platform leverage. These teams have mature AI-assisted development practices and are ready to optimize at the organizational level. This track transitions the customer toward D2 (Reliability), D3 (Governance), and D4 (Leverage) pillars.

### Workshop Modules

All modules are optional. The engagement is driven by an architecture review and custom recommendations.

| Module | Included | Reason |
|--------|----------|--------|
| 00--05 | Optional | Used only to address specific regression areas |
| Custom: Multi-Agent Governance | Yes | Scale AI across teams and repos |
| Custom: AI FinOps | Yes | Optimize Bedrock costs and token usage |
| Custom: Platform Reuse | Yes | Maximize shared component leverage |

### Deliverables

- Custom architecture recommendations document
- Multi-agent governance framework
- AI FinOps dashboard and cost optimization plan
- D2/D3/D4 domain readiness assessment
- Cross-pillar transition roadmap

### Success Metrics

| Metric | Target | Measure By |
|--------|--------|------------|
| Cost per AI-assisted commit | Reduction 20%+ | 8 weeks |
| Cross-team pattern reuse | 3+ shared components | 8 weeks |
| Multi-agent workflow | 1+ production workflow | 4 weeks |
| D2/D3/D4 readiness | Assessment scheduled | 8 weeks |

### SA Touchpoints

| When | Type | Duration | Agenda |
|------|------|----------|--------|
| Architecture review | In-person or video | 3 hr | Deep-dive into current architecture |
| Week 2 | Video call | 1 hr | Review recommendations, prioritize |
| Week 4 | Video call | 1 hr | Progress review |
| Week 8 | Video call | 1 hr | Readout, D2/D3/D4 transition plan |
| Ongoing | Monthly check-in | 30 min | Strategic alignment |

### Next Step

Full PRISM assessment across all 4 domains (D1 Velocity, D2 Reliability, D3 Governance, D4 Leverage). This team is a candidate for the complete PRISM framework deployment.

---

## NOT_QUALIFIED Exit Path

Teams that receive a NOT_QUALIFIED verdict are not ready for any PRISM D1 track. This typically means:

- No AI tooling in use at all
- Fundamental engineering practices missing (no CI/CD, no version control discipline)
- Org readiness below 8/20 (fewer than 2 of 5 factors met)

**Action**: The SA provides a written recommendation document outlining:
1. Prerequisites the team must meet before re-assessment
2. Recommended resources for foundational engineering practices
3. Suggested timeline for re-assessment (typically 8--12 weeks)
4. Option for a lightweight consulting engagement to close prerequisite gaps
