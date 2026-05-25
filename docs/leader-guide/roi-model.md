# PRISM D1 Velocity -- ROI Calculation Model

A practical, defensible framework for quantifying return on AI-augmented engineering investment. Designed to be presented to CFOs and board-level stakeholders alongside PRISM maturity assessments.

---

## Input Variables

Collect these values before running calculations. Sources noted for each.

### Team & Cost Inputs

| Variable | Symbol | Source | Example |
|----------|--------|--------|---------|
| Fully-burdened engineering cost per hour | `C_hr` | Finance / HR | $125/hr |
| Average team size (engineers) | `N_eng` | Org chart | 8 |
| Number of teams | `N_teams` | Org chart | 5 |
| Working hours per month per engineer | `H_month` | Standard | 160 |
| Average new hire onboarding time (weeks) | `T_onboard` | Engineering management | 6 weeks |
| New engineers onboarding per quarter | `N_new` | Hiring plan | 3 |

### Current Metric Inputs (Pre-AI or Current State)

| Variable | Symbol | Source | Example |
|----------|--------|--------|---------|
| Current deployment frequency (deploys/day) | `DF_current` | PRISM/D1/DeploymentCount | 1.2 |
| Current lead time (hours) | `LT_current` | PRISM/D1/LeadTimeSeconds / 3600 | 72h |
| Current change failure rate | `CFR_current` | PRISM/D1/ChangeFailureRate | 25% |
| Current MTTR (hours) | `MTTR_current` | PRISM/D1/MTTRSeconds / 3600 | 12h |
| Current monthly defect count | `D_current` | Incident tracking | 15 |
| Average cost per production incident | `C_incident` | Post-incident reviews | $8,000 |
| Average incident blast radius cost | `C_blast` | SRE estimates | $25,000 |
| Monthly AI platform spend | `S_ai` | AWS Cost Explorer | $3,500 |

### Target Metric Inputs (Post-AI at Next PRISM Level)

| Variable | Symbol | Source | Example |
|----------|--------|--------|---------|
| Target deployment frequency | `DF_target` | PRISM level thresholds | 3.0 |
| Target lead time (hours) | `LT_target` | PRISM level thresholds | 24h |
| Target change failure rate | `CFR_target` | PRISM level thresholds | 12% |
| Target MTTR (hours) | `MTTR_target` | PRISM level thresholds | 4h |
| Target monthly defect count | `D_target` | Based on CFR improvement | 8 |
| Target onboarding time (weeks) | `T_onboard_target` | AI-assisted ramp | 3 weeks |

---

## ROI Dimension 1: Velocity ROI

**What it measures:** Engineering time saved through faster cycle times and higher deployment frequency.

### Formula

```
Hours saved per engineer per month:
  H_saved = (LT_current - LT_target) / LT_current * H_month * utilization_factor

Where utilization_factor = 0.35
  (proportion of eng time spent in commit-to-deploy cycle)

Velocity ROI (monthly, per team):
  ROI_velocity = H_saved * N_eng * C_hr

Velocity ROI (monthly, org-wide):
  ROI_velocity_org = ROI_velocity * N_teams
```

### Example: L2 to L3

```
H_saved = (72 - 24) / 72 * 160 * 0.35 = 37.3 hours/eng/month
ROI_velocity = 37.3 * 8 * $125 = $37,333/month per team
ROI_velocity_org = $37,333 * 5 = $186,667/month
```

### Example: L3 to L4

```
H_saved = (24 - 4) / 24 * 160 * 0.35 = 46.7 hours/eng/month
ROI_velocity = 46.7 * 8 * $125 = $46,667/month per team
ROI_velocity_org = $46,667 * 5 = $233,333/month
```

---

## ROI Dimension 2: Quality ROI

**What it measures:** Cost avoided through fewer production defects and failures.

### Formula

```
Defects prevented per month:
  D_prevented = D_current - D_target

  Alternative calculation from CFR:
  D_prevented = DF_current * 30 * (CFR_current - CFR_target)

Quality ROI (monthly):
  ROI_quality = D_prevented * C_incident

MTTR improvement value (monthly):
  ROI_mttr = D_target * (MTTR_current - MTTR_target) * C_hr * N_eng_on_incident

Where N_eng_on_incident = 2.5
  (average engineers pulled into incident response)
```

### Example: L2 to L3

```
D_prevented = 15 - 8 = 7 defects/month
ROI_quality = 7 * $8,000 = $56,000/month

ROI_mttr = 8 * (12 - 4) * $125 * 2.5 = $20,000/month

Total Quality ROI = $76,000/month
```

### Example: L3 to L4

```
D_prevented = 8 - 3 = 5 defects/month
ROI_quality = 5 * $8,000 = $40,000/month

ROI_mttr = 3 * (4 - 1) * $125 * 2.5 = $2,813/month

Total Quality ROI = $42,813/month
```

---

## ROI Dimension 3: Eval ROI

**What it measures:** Value of incidents prevented by eval gates catching defective AI-generated code before merge.

### Formula

```
Eval-blocked merges per month:
  M_blocked = total_ai_merges * (1 - EvalGatePassRate)

Incidents prevented (assuming X% of blocked merges would have caused incidents):
  I_prevented = M_blocked * incident_probability

Where incident_probability = 0.15
  (estimated probability a failed-eval merge causes a production incident)

Eval ROI (monthly):
  ROI_eval = I_prevented * C_blast
```

### Example: L2 to L3

```
Assume 200 AI-assisted merges/month, 82% pass rate:
M_blocked = 200 * (1 - 0.82) = 36 blocked merges
I_prevented = 36 * 0.15 = 5.4 incidents prevented
ROI_eval = 5.4 * $25,000 = $135,000/month
```

### Example: L3 to L4

```
Assume 350 AI-assisted merges/month, 94% pass rate:
M_blocked = 350 * (1 - 0.94) = 21 blocked merges
I_prevented = 21 * 0.15 = 3.15 incidents prevented
ROI_eval = 3.15 * $25,000 = $78,750/month
```

**Note:** Eval ROI is often the most impactful and most surprising number. It makes the case for investing in eval infrastructure.

---

## ROI Dimension 4: Platform ROI

**What it measures:** Reduced onboarding time for new engineers through AI-assisted codebase navigation, documentation, and code generation.

### Formula

```
Onboarding weeks saved per new hire:
  W_saved = T_onboard - T_onboard_target

Onboarding hours saved per new hire:
  H_onboard_saved = W_saved * 40

Platform ROI (quarterly):
  ROI_platform = N_new * H_onboard_saved * C_hr

Platform ROI (monthly):
  ROI_platform_monthly = ROI_platform / 3
```

### Example: L2 to L3

```
W_saved = 6 - 4 = 2 weeks
H_onboard_saved = 2 * 40 = 80 hours
ROI_platform = 3 * 80 * $125 = $30,000/quarter = $10,000/month
```

### Example: L3 to L4

```
W_saved = 4 - 2 = 2 weeks
H_onboard_saved = 2 * 40 = 80 hours
ROI_platform = 3 * 80 * $125 = $30,000/quarter = $10,000/month
```

---

## Total ROI Summary

### L2 to L3 Transition (Example: 5 teams, 8 eng each)

| Dimension | Monthly Value |
|-----------|---------------|
| Velocity ROI | $186,667 |
| Quality ROI | $76,000 |
| Eval ROI | $135,000 |
| Platform ROI | $10,000 |
| **Total Monthly Value** | **$407,667** |
| Monthly AI Platform Spend | ($3,500) |
| **Net Monthly ROI** | **$404,167** |
| **ROI Multiplier** | **115x** |

### L3 to L4 Transition (Example: 5 teams, 8 eng each)

| Dimension | Monthly Value |
|-----------|---------------|
| Velocity ROI | $233,333 |
| Quality ROI | $42,813 |
| Eval ROI | $78,750 |
| Platform ROI | $10,000 |
| **Total Monthly Value** | **$364,896** |
| Monthly AI Platform Spend | ($7,000) |
| **Net Monthly ROI** | **$357,896** |
| **ROI Multiplier** | **52x** |

---

## Sensitivity Analysis Guidance

ROI models are only as good as their inputs. Run these sensitivity tests before presenting:

### Key Variables to Stress-Test

| Variable | Low Estimate | Base | High Estimate | Impact on Total ROI |
|----------|-------------|------|---------------|---------------------|
| `C_hr` (eng cost) | $85/hr | $125/hr | $175/hr | Scales Velocity + Platform linearly |
| `C_incident` (incident cost) | $3,000 | $8,000 | $20,000 | Scales Quality linearly |
| `C_blast` (blast radius) | $10,000 | $25,000 | $75,000 | Scales Eval linearly |
| `incident_probability` | 5% | 15% | 30% | Scales Eval linearly |
| `utilization_factor` | 20% | 35% | 50% | Scales Velocity linearly |

### Running a Sensitivity Range

For CFO presentation, show a 3-column table:

```
                Conservative    Base Case    Optimistic
Velocity ROI    $112,000        $186,667     $266,667
Quality ROI     $28,500         $76,000      $190,000
Eval ROI        $27,000         $135,000     $405,000
Platform ROI    $6,800          $10,000      $14,000
---------------------------------------------------
Total           $174,300        $407,667     $875,667
ROI Multiplier  50x             115x         250x
```

Use the conservative estimate as your "floor" when presenting. If the floor is still compelling, the investment case is strong.

### What CFOs Want to Hear

1. **Payback period.** At $3,500/month spend, the investment pays for itself in the first day of each month even at conservative estimates.
2. **Marginal cost.** Bedrock pricing is usage-based. Show the cost curve: spend scales sub-linearly with adoption because prompt caching and model improvements reduce per-query cost over time.
3. **Opportunity cost.** What does NOT doing this cost? Frame it as: "Every month at L2 instead of L3 represents $400K+ in unrealized engineering value."
4. **Comparison to alternatives.** A single senior engineer hire costs ~$25K/month fully burdened. The AI platform delivers equivalent output value of 3-5 senior engineers.

---

## How to Present This to a CFO

### Slide Structure (Recommended)

**Slide 1: The Headline**
- "AI-augmented engineering delivers [X]x return on a [$X,XXX]/month investment"
- One sentence. One number. Let it land.

**Slide 2: The Scorecard**
- Current PRISM Level, target level, timeline
- 4 DORA metrics with trend arrows
- Total monthly value generated

**Slide 3: ROI Breakdown**
- Four-quadrant visual (Velocity, Quality, Eval, Platform)
- Each quadrant: formula in plain English + dollar value
- Bar chart showing conservative / base / optimistic

**Slide 4: Investment Profile**
- Monthly spend by category (Bedrock, Q Developer, Timestream)
- Cost trajectory over 12 months (show it flattening as efficiency improves)
- Net ROI multiplier trend

**Slide 5: What Happens If We Don't**
- Competitor velocity benchmarks (from PRISM cohort data)
- Time-to-market gap at current trajectory vs. AI-augmented
- Talent retention risk (engineers increasingly expect AI tooling)

### Language Tips for CFO Audiences

- Say "engineering throughput" not "developer experience"
- Say "defect prevention" not "code quality"
- Say "time-to-revenue" not "deployment frequency"
- Say "incident cost avoidance" not "MTTR improvement"
- Always anchor to dollars, not percentages
- Show the trend line, not just the snapshot

---

*This ROI model is part of the PRISM D1 Velocity metrics platform. All input metrics are sourced from the `PRISM/D1` CloudWatch namespace and Timestream database. Update input variables quarterly or when team structure changes significantly.*
