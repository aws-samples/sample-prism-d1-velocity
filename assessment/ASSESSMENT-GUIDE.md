# PRISM D1 Assessment — Complete Methodology Guide

> How the assessment works end-to-end: scanner logic, interview process, scoring model, and report generation.

## Table of Contents

- [Overview](#overview)
- [Part 1: Automated Scanner (40%)](#part-1-automated-scanner-40)
- [Part 2: SA Interview (40%)](#part-2-sa-interview-40)
- [Part 3: Org Readiness (20%)](#part-3-org-readiness-20)
- [Part 4: Blended Scoring & Level Mapping](#part-4-blended-scoring--level-mapping)
- [Part 5: Verdict & Track Routing](#part-5-verdict--track-routing)
- [Part 6: Report Generation](#part-6-report-generation)
- [End-to-End Example](#end-to-end-example)

---

## Overview

The PRISM D1 assessment is a **three-part system** that combines automated repo analysis, a structured SA interview, and organizational readiness signals to produce a maturity score, a readiness verdict, and a personalized onboarding plan.

```
Customer Repo ──→ Scanner (12 categories) ──→ 0-100 score (40% weight)
SA Interview  ──→ 20 questions, 6 sections ──→ 0-100 score (40% weight)
Org Readiness ──→ 5 binary factors          ──→ 0-20 score  (20% weight)
                                                     │
                                              Blended Score (0-100)
                                                     │
                                              PRISM Level (L1.0-L5.0)
                                                     │
                                              Verdict → Track → Report
```

**Key principle:** The scanner looks at real artifacts in code — not self-reported surveys. If a team says "we do spec-driven development" but the scanner finds zero spec files, the score reflects reality.

---

## Part 1: Automated Scanner (40%)

**What it does:** Runs `prism-scan` CLI against the customer's repository, checking 12 categories of AI-DLC maturity via file glob patterns and content regex.

**How to run:**
```bash
cd assessment/scanner
npm install
npx ts-node src/index.ts --repo /path/to/customer/repo --verbose
```

### 12 Scanner Categories

| # | Category | Max Pts | What It Detects | How |
|---|----------|---------|-----------------|-----|
| 1 | **AI Tool Config** | 10 | CLAUDE.md, Kiro config, Bedrock references, IDE config | File existence + content regex (`/bedrock/i`, `/claude-\d/i`) |
| 2 | **Spec-Driven Dev** | 10 | specs/ directory, structured spec format (Requirements, ACs) | Glob for `specs/**/*.md`, regex for `/## requirements/i`, `/acceptance[_\s-]?criteria/i` |
| 3 | **Commit Hygiene** | 15 | AI-Origin trailers in git history, AI-Model trailers | `git log` last 200 commits, regex for `/AI-Origin:/i`, `/Co-Authored-By:.*\b(claude\|copilot)\b/i` |
| 4 | **CI/CD Integration** | 15 | Eval gates in workflows, metrics emission, AI test steps | Glob for `.github/workflows/*.yml`, regex for eval/Bedrock/EventBridge references |
| 5 | **Eval & Quality** | 10 | Bedrock Evaluation configs, LLM-as-Judge patterns, rubrics | Glob for eval dirs, regex for `/bedrock.*eval/i`, `/llm.*judge/i`, `/quality[_-]?gate/i` |
| 6 | **Testing Maturity** | 10 | Test-to-source ratio, AI-specific tests (hallucination, groundedness) | Count test vs source files, regex for `/hallucination/i`, `/groundedness/i` |
| 7 | **AI Observability** | 10 | CloudWatch/DORA metrics, dashboard definitions, custom AI namespace | Regex for `/cloudwatch/i`, `/dora/i`, `/deployment[_-]?frequency/i` |
| 8 | **Governance** | 5 | Bedrock Guardrails, autonomy tiers, AI-specific IAM | Regex for `/bedrock.*guardrail/i`, `/autonomy[_-]?tier/i` |
| 9 | **Agent Workflows** | 8 | Strands/AgentCore/MCP patterns, agent tests, agent metrics | Glob for `**/agent/**`, regex for `/\bstrands\b/i`, `/agentcore/i`, `/McpServer/i` |
| 10 | **Platform & Reuse** | 5 | Prompt library, model gateway, RAG/Knowledge Base configs | Glob for `prompts/`, regex for `/prompt[_-]?library/i`, `/rag/i` |
| 11 | **Documentation** | 3 | AI development guidelines, ADRs mentioning AI, onboarding docs | File name patterns, content regex |
| 12 | **Dependencies** | 2 | AI SDKs in package.json/requirements.txt (Anthropic, Bedrock, LangChain, etc.) | Parse dependency files for AI package names |

### Scoring Example: Commit Hygiene (15 pts)

The scanner runs `git log --format='%B' -200` and counts AI-Origin trailers:

| AI-Origin % in last 200 commits | Points |
|:---:|:---:|
| >50% | 12 |
| >30% | 9 |
| >10% | 6 |
| >0% | 3 |
| 0% | 0 |

Plus 3 points if `AI-Model:` trailers are also present.

### Scanner Output

Each category produces evidence:

```json
{
  "category": "AI Tool Config",
  "maxPoints": 10,
  "earnedPoints": 8,
  "evidence": [
    { "signal": "CLAUDE.md exists", "found": true, "points": 3, "detail": "Found at /CLAUDE.md" },
    { "signal": "Spec-first enforcement rules", "found": true, "points": 2, "detail": "Contains 'spec' + 'before'" },
    { "signal": "Kiro IDE config", "found": false, "points": 0, "detail": "No .kiro/ directory" },
    { "signal": "Bedrock model references", "found": true, "points": 3, "detail": "Found in 2 config files" }
  ]
}
```

### Status Colors

| Percentage | Status | Meaning |
|:---:|:---:|---|
| ≥70% | GREEN | Strong — maintain and optimize |
| 40-69% | AMBER | Developing — specific actions needed |
| <40% | RED | Gap — priority remediation |

---

## Part 2: SA Interview (40%)

**What it does:** Structured 60-90 minute conversation using a detailed interview guide. 20 questions across 6 sections, each scored 0-5.

**Materials:**
- [`interview/interview-guide.md`](interview/interview-guide.md) — Full script with questions, probes, and "listen for" cues
- [`interview/scoring-sheet.md`](interview/scoring-sheet.md) — Printable scoring form

### Six Sections

| Section | Questions | Max Pts | Focus |
|---------|:---------:|:-------:|-------|
| 1. AI Tooling Landscape | 3 | 15 | Which tools, adoption process, usage measurement |
| 2. Workflow & Specs | 4 | 20 | Feature flow, spec quality, AI in design, attribution/traceability |
| 3. CI/CD & Quality | 4 | 20 | AI validation in pipeline, bug tracking, quality measurement, DORA |
| 4. Metrics & Visibility | 3 | 15 | Executive dashboards, AI-dimensioned metrics, ROI reporting |
| 5. Governance & Security | 3 | 15 | Guardrails, access control, incident response |
| 6. Org & Culture | 3 | 15 | Ownership/sponsorship, AI onboarding, self-awareness |

### Scoring Rubric (0-5 per question)

Each question has a detailed rubric. Example — **"What % of engineers use AI tools weekly?"**:

| Score | Evidence |
|:---:|---|
| 0 | "Don't know" |
| 1 | Rough guess, no data |
| 2 | License count only |
| 3 | Some usage data, not actively monitored |
| 4 | Active tracking with team breakdowns |
| 5 | Real-time dashboards with adoption trends |

### Interview Best Practices

- Ask open-ended, then probe for evidence: *"Walk me through..."* not *"Do you have...?"*
- Look for **discrepancies** between scanner and interview (scanner shows 5% AI commits but team says "we use AI for everything")
- Note the **limiting dimension** — the single weakest area that would block advancement
- Capture org readiness inputs during the conversation

---

## Part 3: Org Readiness (20%)

Five binary yes/no questions, 4 points each = 20 points max:

| # | Factor | Points | Why It Matters |
|---|--------|:------:|----------------|
| 1 | **Executive Sponsor** — C-level champion identified | 4 | Without exec backing, AI transformation stalls at team level |
| 2 | **Budget Allocated** — Explicit AI tooling budget approved | 4 | No budget = no sustained tool adoption |
| 3 | **Dedicated Owner** — Named person/team owns AI transformation | 4 | Nobody's job = nobody does it |
| 4 | **AWS Relationship** — Existing AWS commitment or account | 4 | Reduces friction for Bedrock/CDK deployment |
| 5 | **Team Size 20-200** — Sweet spot for PRISM D1 | 4 | Too small = no process needed; too large = different engagement |

These are typically collected during the interview (Section 6) or from the SA's existing account knowledge.

---

## Part 4: Blended Scoring & Level Mapping

### Formula

```
blendedScore = (scannerScore × 0.4) + (interviewScore × 0.4) + ((orgReadiness / 20 × 100) × 0.2)
```

### Score → PRISM Level

| Blended Score | Level | Name | What It Looks Like |
|:---:|:---:|---|---|
| 0-10 | L1.0 | Experimental | Ad hoc AI use, no metrics, no governance |
| 11-20 | L1.5 | Early Experimentation | Some tools adopted, grassroots, no standardization |
| 21-30 | L2.0 | Emerging Standardization | Company licenses, basic governance |
| 31-40 | L2.5 | Structured Adoption | Broad adoption, standards in place, informal metrics |
| 41-50 | L3.0 | Integrated Workflows | AI across full SDLC, eval gates, attribution, dedicated owner |
| 51-60 | L3.5 | Measured & Optimized | Bedrock evals, defect tracking, ROI reporting |
| 61-70 | L4.0 | AI-Native Practices | Agents handle workflows, autonomy tiers, sophisticated evals |
| 71-80 | L4.5 | Advanced AI-Native | Deep embedding, competitive advantage |
| 81-100 | L5.0 | Industry-Leading | Default mode for all work, >5x ROI |

---

## Part 5: Verdict & Track Routing

### Verdict Rules

| Verdict | Conditions | Action |
|---------|-----------|--------|
| **READY_FOR_PILOT** | blendedScore ≥ 21 AND orgReadiness ≥ 12 | Assign track B, C, or D |
| **NEEDS_FOUNDATIONS** | blendedScore ≥ 11 AND orgReadiness ≥ 8 | Assign track A |
| **NOT_QUALIFIED** | Below both thresholds | Exit with recommendations |

### Track Assignment

| Level | Track | Duration | Modules | What They Get |
|-------|-------|----------|---------|---------------|
| L1.0-L1.5 | **A: Foundations** | 2-week pre-work + 4-hour workshop | 00, 01, 02 | Basic AI toolchain setup, first agent, spec-driven dev |
| L2.0-L2.5 | **B: Full Workshop** | 1-week pre-work + 4-hour + 8-week pilot | All (00-06) | Complete AI-DLC with metrics, evals, dashboards, agents |
| L3.0-L3.5 | **C: Accelerated** | 2-hour targeted + 8-week pilot | 04, 05, 06 | Fill specific gaps (metrics, evals, dashboards) |
| L4.0+ | **D: Advanced** | Custom architecture review + 8-12 weeks | Custom | Multi-agent governance, AI FinOps, platform scaling |

### What the Onboarding Router Produces

The `onboarding-router.ts` generates a complete `OnboardingPlan`:

- **Workshop modules** — which to include, which to skip, with reasons
- **Pre-work tasks** — what the customer does before the workshop
- **Bootstrapper components** — which templates/hooks/workflows to deploy first
- **Gap remediations** — top 3 gaps from scanner + interview, each with a specific action
- **Success metrics** — measurable targets (e.g., "AI acceptance rate ≥30% by Week 4")
- **90-day milestones** — week-by-week progression plan
- **SA touchpoints** — scheduled check-in calls over the pilot period

---

## Part 6: Report Generation

The `reports/report-generator.ts` produces the customer-facing assessment report in three formats:

### Report Sections

1. **Executive Summary** — PRISM Level, verdict, one-paragraph narrative, component scores
2. **Radar Chart** — Visual of all 12 scanner categories (SVG in HTML, ASCII in markdown)
3. **Scanner Breakdown** — Category-by-category with GREEN/AMBER/RED status indicators
4. **Interview Summary** — Section-by-section findings with key quotes
5. **Gap Analysis** — Top 5 gaps ranked by lowest percentage, each with remediation action
6. **Strengths** — Top 3 highest-scoring areas
7. **Onboarding Recommendation** — Track, modules, pre-work, 90-day roadmap, SA schedule
8. **Appendix** — Full scanner evidence (every signal, every file found)

### Output Formats

| Format | Use Case | Features |
|--------|----------|----------|
| **Markdown** | Print-ready customer handout | ASCII radar chart, tables |
| **JSON** | Programmatic use, re-rendering | Structured data, all scores |
| **HTML/PDF** | Styled web display, board presentation | SVG radar chart, color coding |

### Sample Reports

Three realistic examples are included:

| Company | Level | Verdict | Track |
|---------|:-----:|---------|:-----:|
| [NovaPay](reports/sample-reports/pdf/novapay-l1.5-assessment.pdf) (Series A, 6 eng) | L1.5 | NEEDS_FOUNDATIONS | A |
| [Arcline Health](reports/sample-reports/pdf/arcline-health-l2.5-assessment.pdf) (Series B, 14 eng) | L2.5 | READY_FOR_PILOT | B |
| [Vectrix AI](reports/sample-reports/pdf/vectrix-ai-l3.5-assessment.pdf) (Series C, 28 eng) | L3.5 | READY_FOR_PILOT | C |

---

## End-to-End Example

**Customer: Arcline Health** (Series B, 14 engineers, healthcare data platform)

### Step 1: Scan

```bash
npx ts-node src/index.ts --repo /path/to/arcline-repo --verbose
```

Results:
- AI Tool Config: 7/10 (CLAUDE.md exists, Bedrock refs, no Kiro)
- Commit Hygiene: 8/15 (35% AI-Origin trailers)
- CI/CD: 7/15 (GitHub Actions exist, no eval gates yet)
- Eval & Quality: 4/10 (basic rubric, no Bedrock Evaluations)
- AI Observability: 2/10 (no dashboards, no DORA tracking)
- **Scanner Total: 52/100**

### Step 2: Interview

SA runs the 60-minute interview:
- Strong on tooling (10/15) — standardized on Claude Code
- Good specs (14/20) — templates exist, some enforcement
- Weak on metrics (8/15) — "we know it helps but can't prove it"
- **Interview Total: 62/100**

### Step 3: Org Readiness

- Executive sponsor: YES (CTO)
- Budget: YES ($50K/yr approved)
- Dedicated owner: YES (Staff Eng)
- AWS relationship: NO (just started)
- Team size: YES (14 engineers)
- **Org Total: 12/20**

### Step 4: Compute

```
Blended = (52 × 0.4) + (62 × 0.4) + ((12/20 × 100) × 0.2)
        = 20.8 + 24.8 + 12.0
        = 57.6
```

**Level: L3.5** (Measured & Optimized)
**Verdict: READY_FOR_PILOT** (57.6 ≥ 21, org 12 ≥ 12)

### Step 5: Route

Level L3.0-L3.5 + READY_FOR_PILOT → **Track C: Accelerated**

Top 3 gaps:
1. Agent Workflows (1/8 = 12%) → "Deploy first Strands agent with MCP"
2. AI Observability (2/10 = 20%) → "Deploy metrics pipeline + dashboards"
3. Governance (2/5 = 40%) → "Formalize autonomy tiers with Bedrock Guardrails"

### Step 6: Report

Generated PDF includes radar chart showing strengths (Commit Hygiene, Tooling) and gaps (Observability, Agents, Governance), plus a 90-day roadmap with Week 1: deploy bootstrapper → Week 4: metrics flowing → Week 8: dashboards live + L3.5 target.

---

## Running the Full Pipeline

```bash
# 1. Scan
cd assessment/scanner && npx ts-node src/index.ts --repo /path/to/repo --output json --output-file ../reports/scan.json

# 2. Interview (manual — use the guide and scoring sheet)
# Fill in assessment/interview/scoring-sheet.md

# 3. Compute + Route
cd assessment && npx ts-node -e "
  const { computeAssessment } = require('./scoring/scoring-model');
  const { routeOnboarding } = require('./onboarding/onboarding-router');
  const result = computeAssessment({ scannerScore: 52, interviewScore: 62, orgReadiness: { executiveSponsor: true, budgetAllocated: true, dedicatedOwner: true, awsRelationship: false, teamSizeAppropriate: true } });
  console.log(result);
  const plan = routeOnboarding(result, { name: 'Arcline Health', teamSize: 14, fundingStage: 'Series B' });
  console.log(plan);
"

# 4. Generate report
cd assessment/reports && npx ts-node -e "
  const { generateReport } = require('./report-generator');
  // ... pass full assessment data
"

# 5. Generate PDF
bash generate-pdfs.sh
```
