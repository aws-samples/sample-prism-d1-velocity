# PRISM D1 Velocity -- Executive Readout

**Prepared for:** [CTO / VP Engineering Name]
**Prepared by:** [SA Name], AWS Solutions Architect
**Period:** [Week/Sprint of YYYY-MM-DD to YYYY-MM-DD]
**Customer:** [Company Name]

---

## 1. PRISM Level Summary

| | Current | Target | Trend |
|---|---------|--------|-------|
| **PRISM Level** | L[X] [Name] | L[X+1] [Name] | [Up/Flat/Down] |
| **Assessed Date** | YYYY-MM-DD | Target: YYYY-MM-DD | |

**Level Definition Reminder:**
- L1 Ad Hoc -- No systematic AI integration
- L2 Emerging -- Individual AI tool adoption, basic metrics
- L3 Scaling -- Team-wide AI workflows, eval gates in place
- L4 Optimized -- AI-native development, continuous evaluation
- L5 Transformative -- Autonomous AI pipelines, self-improving systems

**Key blockers to next level:**
1. [e.g., Eval gate coverage below 80% threshold for L3]
2. [e.g., AI acceptance rate inconsistent across teams]
3. [e.g., Spec-to-code pipeline not yet instrumented]

---

## 2. Enhanced DORA Scorecard

### Traditional DORA Metrics

| Metric | Current Value | L[X] Target | L[X+1] Target | Status | WoW Change |
|--------|---------------|-------------|----------------|--------|------------|
| Deployment Frequency | [X] deploys/day | [target] | [target] | [Green/Amber/Red] | [+/-X%] |
| Lead Time for Changes | [X] hours | [target] | [target] | [Green/Amber/Red] | [+/-X%] |
| Change Failure Rate | [X]% | [target]% | [target]% | [Green/Amber/Red] | [+/-X pp] |
| MTTR | [X] hours | [target] | [target] | [Green/Amber/Red] | [+/-X%] |

### AI-DORA Extension Metrics

| Metric | Current Value | L[X] Target | L[X+1] Target | Status | WoW Change |
|--------|---------------|-------------|----------------|--------|------------|
| AI Acceptance Rate | [X]% | [target]% | [target]% | [Green/Amber/Red] | [+/-X pp] |
| AI-to-Merge Ratio | [X.XX] | [target] | [target] | [Green/Amber/Red] | [+/-X] |
| Eval Gate Pass Rate | [X]% | [target]% | [target]% | [Green/Amber/Red] | [+/-X pp] |
| Spec-to-Code Turnaround | [X] hours | [target]h | [target]h | [Green/Amber/Red] | [+/-X%] |
| Post-Merge Defect Rate (AI) | [X.XX] | [target] | [target] | [Green/Amber/Red] | [+/-X] |
| AI Test Coverage Delta | [+/-X] pp | [target] pp | [target] pp | [Green/Amber/Red] | [+/-X pp] |

**Status legend:** Green = at or exceeding target for current level. Amber = within 20% of target. Red = more than 20% below target.

---

## 3. AI Adoption Highlights

### What is working

- [e.g., Claude Code adoption reached 45% acceptance rate on the Platform team, up from 32% two weeks ago]
- [e.g., AI-generated tests are achieving 12% higher branch coverage than human-written tests]
- [e.g., Spec-to-code turnaround dropped from 36h to 18h after Kiro integration]

### What needs attention

- [e.g., Payments team AI acceptance rate declined to 22% -- investigating prompt quality issues]
- [e.g., Eval gate pass rate dropped to 71% after model upgrade -- retuning eval suite]
- [e.g., Q Developer generating high false-positive rate on security suggestions]

### Tool-specific observations

| Tool | Teams Using | Acceptance Rate | Notable |
|------|-------------|-----------------|---------|
| Claude Code | [X] teams | [X]% | [observation] |
| Amazon Q Developer | [X] teams | [X]% | [observation] |
| Kiro | [X] teams | [X]% | [observation] |

---

## 4. Investment vs. Return

### Spend This Period

| Category | Amount | Change |
|----------|--------|--------|
| Amazon Bedrock (Claude) | $[X,XXX] | [+/-X%] |
| Amazon Q Developer licenses | $[X,XXX] | [flat] |
| Kiro (if applicable) | $[X,XXX] | [+/-X%] |
| Timestream + observability | $[XXX] | [flat] |
| **Total AI Platform Spend** | **$[X,XXX]** | **[+/-X%]** |

### Value Delivered This Period

| Dimension | Estimated Value | Calculation |
|-----------|-----------------|-------------|
| Velocity: Engineering time saved | $[XX,XXX] | [X] hours saved x $[XXX]/hr fully-burdened |
| Quality: Defects prevented | $[X,XXX] | [X] fewer defects x $[X,XXX] avg incident cost |
| Eval: Incidents prevented | $[X,XXX] | [X] eval-blocked merges x $[X,XXX] est. blast radius |
| **Total Estimated Value** | **$[XX,XXX]** | |
| **ROI Multiplier** | **[X.X]x** | Value / Spend |

*See [ROI Model](roi-model.md) for methodology and sensitivity analysis.*

---

## 5. Recommendations

### Immediate (This Sprint)

1. **[Action]** -- [Rationale]. Owner: [Name]. Expected impact: [metric improvement].
2. **[Action]** -- [Rationale]. Owner: [Name]. Expected impact: [metric improvement].

### Near-term (Next 2-4 Weeks)

1. **[Action]** -- Required for L[X+1] advancement. Dependency: [what].
2. **[Action]** -- Will unlock [capability]. Requires: [resource/decision].

### Strategic (Next Quarter)

1. **[Action]** -- Positions team for L[X+2]. Investment required: [estimate].

---

## 6. Risk Register

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| [e.g., Eval gate coverage falls below L3 threshold] | [High/Med/Low] | [High/Med/Low] | [action] | [name] |
| [e.g., Model version change degrades acceptance rate] | [Med] | [Med] | [Pin model versions, A/B test upgrades] | [name] |
| [e.g., Team resistance to AI-generated code review] | [Med] | [High] | [Champion program, show defect data] | [name] |
| [e.g., Bedrock cost scaling faster than value] | [Low] | [High] | [Usage tiers, prompt optimization] | [name] |
| [e.g., Data pipeline latency masks real-time issues] | [Low] | [Med] | [CloudWatch alarms, Timestream TTL] | [name] |

---

## Appendix: Dashboard Links

- **Team Velocity (CloudWatch):** `https://REGION.console.aws.amazon.com/cloudwatch/home?region=REGION#dashboards:name=PRISM-D1-TeamVelocity`
- **Executive Readout (CloudWatch):** `https://REGION.console.aws.amazon.com/cloudwatch/home?region=REGION#dashboards:name=PRISM-D1-ExecutiveReadout`
- **AI-DORA Analysis (QuickSight):** `https://REGION.quicksight.aws.amazon.com/sn/analyses/prism-d1-ai-dora-analysis`
- **Level Tracker (QuickSight):** `https://REGION.quicksight.aws.amazon.com/sn/analyses/prism-d1-level-tracker`

---

*This readout was generated using the PRISM D1 Velocity metrics platform. Data sourced from CloudWatch (`PRISM/D1` namespace) and Timestream (`prism_d1_velocity` database).*

*Formatting guidance: Use Green/Amber/Red text or cell background in the final version (Google Slides, PowerPoint, or Notion). Replace all bracketed placeholders with actual values from the dashboards.*
