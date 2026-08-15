# PRISM D1 Velocity — Assessment Guide

This guide is the single reference for AWS Solutions Architects conducting PRISM D1 Velocity customer assessments. It covers the end-to-end methodology: automated scanner categories and scoring, the 20-question structured interview with full rubrics, organizational readiness evaluation, the qualification matrix, blended scoring formula, verdict logic, track routing, and report generation.

---

## Running an Assessment (Web Tool)

### Web Assessment Tool (Recommended)

The prism-cli includes a local web interface for running the full assessment flow — scan, interview, and report generation — in a browser.

```bash
prism-cli assessment web
# Opens http://localhost:3120
```

The web tool supports two workflows:

**Self-service (customer runs it themselves):**
1. Customer installs `npm install -g @prism-d1/cli` and runs `prism-cli assessment web`
2. Scans their own repository from the web UI
3. Exports the scan results as JSON and sends the file to you
4. Optionally completes the interview themselves and sends the final HTML report

**SA-led (you run it):**
1. Import the customer's scan JSON into the web UI (skip re-scanning)
2. Conduct the interview using the built-in guide with scoring rubrics
3. Generate the HTML report directly in the browser

**AI Agent interview:**
1. After scanning (or importing a scan), choose "AI Agent Interview" from the next steps
2. An AI agent conducts the 20-question interview conversationally, asks follow-up probes, and scores responses against the rubrics automatically
3. The agent uses context from prior answers to ask smarter questions and avoid repetition
4. When complete, generates the same assessment report as the manual flow

The AI agent requires **Amazon Bedrock access** — specifically the `us.anthropic.claude-sonnet-4-6` model (Claude Sonnet 4.6 via cross-region inference). To set this up:
- Enable model access in the [Bedrock console](https://console.aws.amazon.com/bedrock/home#/modelaccess) (Anthropic → Claude Sonnet 4.6)
- Configure AWS credentials locally (`aws configure`, SSO, or environment variables)
- The agent validates Bedrock access on startup and shows setup instructions if anything is missing

The interview form includes the full question bank, scoring rubrics, and scanner-informed focus areas. Reports can be printed or saved as PDF from the browser.

### Manual Assessment

For a CLI-only or fully manual workflow, run the PRISM Assessment (this guide) to determine maturity level and onboarding track. See the full methodology guide (this guide) for scanner logic, interview rubrics, and scoring formulas.

## Table of Contents

- [Assessment Flow Overview](#assessment-flow-overview)
- [How to Run an Assessment](#how-to-run-an-assessment)
- [Part 1: Automated Scanner (40%)](#part-1-automated-scanner-40)
- [Part 2: SA Interview (40%)](#part-2-sa-interview-40)
  - [Pre-Interview Checklist](#pre-interview-checklist)
  - [Who to Interview](#who-to-interview)
  - [Interview Duration and Scoring Approach](#interview-duration-and-scoring-approach)
  - [Section 1: Current AI Tooling Landscape (15 pts)](#section-1-current-ai-tooling-landscape-15-pts)
  - [Section 2: Development Workflow & Specs (20 pts)](#section-2-development-workflow--specs-20-pts)
  - [Section 3: CI/CD & Quality (20 pts)](#section-3-cicd--quality-20-pts)
  - [Section 4: Metrics & Visibility (15 pts)](#section-4-metrics--visibility-15-pts)
  - [Section 5: Governance & Security (15 pts)](#section-5-governance--security-15-pts)
  - [Section 6: Organization & Culture (15 pts)](#section-6-organization--culture-15-pts)
  - [Interview Closing](#interview-closing)
  - [Interview Scoring Sheet](#interview-scoring-sheet)
- [Part 3: Org Readiness (20%)](#part-3-org-readiness-20)
- [Part 4: Blended Scoring & Level Mapping](#part-4-blended-scoring--level-mapping)
- [Part 5: Qualification Matrix & Verdict Logic](#part-5-qualification-matrix--verdict-logic)
- [Part 6: Report Generation](#part-6-report-generation)
- [End-to-End Example](#end-to-end-example)
- [Sample Reports](#sample-reports)

---

## Assessment Flow Overview

```
QUALIFICATION
─────────────
  Path 1: CLI + SA
    Customer Repo → prism-cli assessment run → scan.json
    SA imports scan.json → assessment web → AI Interview (20 questions)

  Path 2: Self-Service
    prism-cli assessment web → Scan + Interview + Org all in one UI

SCORING
───────
    Scanner (0-100)       ×40%  ─┐
    Interview (0-100)     ×40%  ─┼─→ Blended Score → PRISM Level (L1.0–L5.0)
    Org Readiness (0-20)  ×20%  ─┘
                                        │
                                        ▼
    READY_FOR_PILOT ─── ≥L2.0 and org≥12
    NEEDS_FOUNDATIONS ── ≥L1.5 and org≥8
    NOT_QUALIFIED ────── below thresholds

ONBOARDING
──────────
    Track A: Foundations   → Modules 00-02, 2wk pre-work
    Track B: Full Workshop → All modules, 8-week pilot
    Track C: Accelerated   → Modules 03-05, targeted gaps
    Track D: Advanced      → Custom engagement, L4+ optimization
                                        │
                                        ▼
                          Customer Report (HTML/JSON/Markdown)
```

**Key principle:** The scanner looks at real artifacts in code — not self-reported surveys. If a team says "we do spec-driven development" but the scanner finds zero spec files, the score reflects reality.

---

## How to Run an Assessment

There are two paths depending on who conducts the interview:

### Path 1: CLI Scan → Hand off to SA

Run the repo scanner yourself, then send the results to an SA who conducts the interview.

```bash
prism-cli assessment run \
  --repo ~/customer-repos/acme-app \
  --output json \
  --output-file acme-scan.json \
  --verbose
```

The SA imports `acme-scan.json` into the web UI, conducts the interview, and generates the final report.

### Path 2: Self-Service via Web UI

Run the entire assessment yourself — scan, interview, scoring, and report — through the interactive web app:

```bash
prism-cli assessment web
```

Open `http://localhost:3120`, paste the customer's repo path (or import a JSON scan), then walk through the AI-guided interview. The app scores everything in real-time and generates a downloadable report at the end.

### CLI Commands

```bash
prism-cli <category> <command> [options]
```

#### `assessment run`

Run the repo scanner against a customer's codebase.

```bash
prism-cli assessment run --repo /path/to/repo --output json --output-file report.json
```

| Option | Description | Default |
|--------|-------------|---------|
| `-r, --repo <path>` | Path to git repository to scan | `.` |
| `-o, --output <format>` | Output format: `console`, `json`, `markdown` | `console` |
| `-f, --output-file <path>` | Write report to file | — |
| `-v, --verbose` | Show timing and detailed evidence | `false` |

#### `assessment web`

Launch the interactive assessment web UI.

```bash
prism-cli assessment web --port 3120
```

| Option | Description | Default |
|--------|-------------|---------|
| `--port <number>` | Port to serve on | `3120` |

Features:
- **Repo scanner** — paste a repo path or import JSON scan results
- **AI interview** — conversational agent asks 20 questions across 6 sections, scores in real-time
- **Org readiness** — 5 binary qualification factors
- **Blended scoring** — 40% scanner + 40% interview + 20% org → PRISM level + verdict
- **Onboarding routing** — auto-assigns Track A–D based on score and gaps
- **Report generation** — downloadable HTML/JSON/Markdown customer-facing report

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

> **⚠️ KNOWN ISSUE — stale scoring:** The 'Commit Hygiene' category (15 points) scores `AI-Origin` git trailers and awards 3 bonus points for `AI-Model` trailers. However: (1) Git hooks that produce these trailers are being **deprecated** in this project in favour of OTEL-based attribution via `codeburn sync --attribution`, and (2) the report remediation text (see Report Generation section) recommends deploying hooks for an `AI-Confidence` trailer that was **never implemented** — no hook, CLI flag, or spec for this trailer exists. Point values are preserved as-is pending a scoring model revision.

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

**What it does:** Structured 60-90 minute conversation using this guide. 20 questions across 6 sections, each scored 0-5.

### Pre-Interview Checklist

Complete these steps before the SA interview. Allow 30-60 minutes of preparation time.

#### 1. Run the Automated Scanner

- [ ] Obtain read access to at least one primary application repository
- [ ] Run the PRISM D1 scanner and review the output report
- [ ] Note the scanner score and any flagged gaps — these inform follow-up probes
- [ ] If scanner could not be run (access issues, monorepo complexity), note this and plan to spend extra time on CI/CD and workflow questions

#### 2. Review GitHub / Source Control Activity

- [ ] Review the last 30 days of merged PRs in their primary repo
- [ ] Note PR size distribution (small/focused vs. large/monolithic)
- [ ] Look for AI-related commit trailers or metadata (e.g., `Co-authored-by: github-copilot`, `ai-assisted: true`)
- [ ] Check PR review turnaround times
- [ ] Look for spec documents, design docs, or RFC links in PR descriptions

#### 3. Check AWS Account Activity (if accessible)

- [ ] Check for Amazon Bedrock usage (API calls, model invocations)
- [ ] Check for Amazon Q Developer license count and activity
- [ ] Note any CodeWhisperer, CodeGuru, or CodePipeline usage
- [ ] Review their AWS spend trajectory (relevant for org readiness scoring)

#### 4. Company Context

- [ ] Confirm funding stage (Series A, B, C, D)
- [ ] Confirm engineering team size (target: 20-200 engineers)
- [ ] Identify the company's primary tech stack and languages
- [ ] Review their product briefly (what they build, who their customers are)
- [ ] Check for any public blog posts or talks about their AI/engineering practices

#### 5. Logistics

- [ ] Confirm interview participants and their roles
- [ ] Send calendar invite with clear agenda (do not share scoring criteria)
- [ ] Print or prepare digital copies of the scoring sheet (below)
- [ ] Ensure screen-sharing capability (you will ask them to show PRs and dashboards)
- [ ] Prepare a quiet room or reliable video connection

#### 6. Prepare Follow-Up Probes from Scanner Results

If the scanner has been run, prepare specific follow-up questions based on its findings:

| Scanner Finding | Interview Probe |
|----------------|-----------------|
| Low AI commit attribution | "I noticed your commits don't have AI attribution trailers. How do you track which code is AI-assisted?" |
| No eval gates in CI | "Your CI pipeline doesn't appear to have AI-specific validation steps. Is that intentional?" |
| High PR size variance | "Some of your PRs are quite large. How do you handle review for big AI-generated PRs?" |
| No spec files detected | "I didn't see structured spec documents in the repo. Where do design decisions live?" |
| Low test-to-code ratio | "Your test coverage seems light relative to code volume. How does AI factor into your testing strategy?" |

These probes turn scanner data into conversation starters. They signal to the customer that you have done your homework and ground the discussion in their actual codebase.

---

### Who to Interview

| Role | Required | Why |
|------|----------|-----|
| Engineering Lead / VP Eng / CTO | Required | Strategic decisions, metrics visibility, governance |
| 2 Individual Contributors (senior) | Required | Ground truth on daily workflows, tool usage, friction |
| Platform / DevEx Lead | If exists | CI/CD details, tooling infrastructure, measurement |

If the company has fewer than 30 engineers, the eng lead + 1 IC may suffice. For 100+ engineer orgs, consider adding a second eng lead from a different team to check for consistency.

### Interview Duration and Scoring Approach

- **Total**: 60-90 minutes
- **Section timing** (suggested, not rigid):
  - Section 1 — AI Tooling Landscape: 10 min
  - Section 2 — Development Workflow & Specs: 15 min
  - Section 3 — CI/CD & Quality: 15 min
  - Section 4 — Metrics & Visibility: 10 min
  - Section 5 — Governance & Security: 10 min
  - Section 6 — Organization & Culture: 10 min
  - Buffer / follow-ups: 10 min

**Scoring rules:**
- Score each question 0-5 in real time using the scoring sheet
- Use the "listening for" guidance to calibrate — these are the signals that differentiate scores
- When in doubt between two scores, pick the lower one; the assessment should be conservative
- It is normal for startups to score unevenly across sections — this is valuable signal
- The 20 questions yield a raw total out of 100 (20 questions × 5 points max)

**Best practices:**
- Ask open-ended, then probe for evidence: *"Walk me through..."* not *"Do you have...?"*
- Look for **discrepancies** between scanner and interview (scanner shows 5% AI commits but team says "we use AI for everything")
- Note the **limiting dimension** — the single weakest area that would block advancement
- Capture org readiness inputs during the conversation
- Do not share scoring criteria or level definitions with the customer during the interview

---

### Opening (2 minutes)

> "Thanks for making time for this. We're going to walk through how your team builds software today, with a focus on how AI tools fit into your workflow. There are no wrong answers — we're trying to understand where you are so we can figure out the most useful next steps. I'll ask questions across six areas: your AI tooling, development workflow, CI/CD, metrics, governance, and org structure. Feel free to jump in with context at any point."

---

### Section 1: Current AI Tooling Landscape (15 pts)

#### Q1.1 — AI Tool Usage Overview

**Ask**: "Walk me through how your engineers use AI tools today — from IDE to deployment. What tools are in play, and how consistently are they used?"

**Listening for**:
- Specific tool names vs. vague "we use Copilot"
- Standardization vs. individual choice
- Whether tools span the full lifecycle (IDE, PR review, testing, deployment) or cluster in one phase
- Shared configuration (e.g., team-wide Copilot settings, shared prompt libraries, .cursorrules files)
- Approved tool list or procurement process

**Follow-up probes**:
- "Is there a standard IDE or AI tool configuration that new engineers get?"
- "Do different teams use different tools, or is it standardized?"
- "Are engineers paying for their own tools, or is it company-provisioned?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | No AI tools in use, or only 1-2 engineers experimenting on their own |
| 1 | A few engineers use AI tools (Copilot, ChatGPT) but it is entirely ad hoc and self-directed |
| 2 | Multiple AI tools adopted across the team, but no standardization or shared configuration |
| 3 | Standardized primary tool (e.g., company-wide Copilot license), some shared config, but gaps in coverage across the lifecycle |
| 4 | Standardized toolset covering multiple lifecycle phases, shared configuration, approved tool list |
| 5 | Fully standardized and managed AI toolchain across the lifecycle, with shared config, version-controlled settings, and usage tracking |

---

#### Q1.2 — Tool Adoption Process

**Ask**: "How do you decide which AI tools to adopt? Is there a process, or does it happen organically?"

**Listening for**:
- Governance vs. grassroots adoption
- Evaluation criteria (security review, cost, effectiveness)
- Budget ownership (who pays, who approves)
- Whether they have evaluated and rejected tools (shows intentionality)
- Speed of adoption (weeks vs. months)

**Follow-up probes**:
- "Who approves the budget for AI tooling?"
- "Have you evaluated and decided against any AI tools? What was the reason?"
- "How long does it take from discovering a new tool to rolling it out?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | No process; engineers install whatever they want with no oversight |
| 1 | Informal process; someone on the team evaluates tools but there is no formal framework |
| 2 | Some evaluation criteria exist (security, cost) but the process is inconsistent |
| 3 | Defined evaluation process with security review and cost analysis, but slow or bureaucratic |
| 4 | Streamlined evaluation process with clear criteria, fast turnaround, and budget owner identified |
| 5 | Formal but fast governance: evaluation framework, security review, pilot period, rollout plan, and ongoing effectiveness measurement |

---

#### Q1.3 — Usage Measurement

**Ask**: "What percentage of your engineers use AI tools weekly? How do you know that number?"

**Listening for**:
- Actual data vs. guessing
- Telemetry or license dashboards
- Whether they track usage depth (just autocomplete vs. agentic workflows)
- Awareness of adoption gaps (e.g., "backend team uses it heavily, mobile team barely touches it")

**Follow-up probes**:
- "Can you show me the dashboard or data source for that number?"
- "Do you know which teams or individuals are getting the most value?"
- "How has adoption changed over the last quarter?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | "I don't know" or clearly guessing with no basis |
| 1 | Rough guess based on anecdotal observation ("most people I think") |
| 2 | Knows the license count but not actual usage ("we have 50 Copilot seats") |
| 3 | Has some usage data (e.g., Copilot admin dashboard) but does not actively monitor or act on it |
| 4 | Actively tracks usage with breakdowns by team or role, reviews periodically |
| 5 | Real-time or weekly dashboards showing usage depth (not just logins), with trends and team-level breakdowns, used to drive adoption decisions |

---

### Section 2: Development Workflow & Specs (20 pts)

#### Q2.1 — Feature Development Flow

**Ask**: "When a new feature comes in, what does the journey from idea to first PR look like? Walk me through a recent example."

**Listening for**:
- Whether there is a defined process or it varies by person
- Where AI enters the workflow (spec writing, design, coding, testing, review)
- Handoff points and bottlenecks
- Whether the process is documented or tribal knowledge

**Follow-up probes**:
- "At which step does AI first get involved?"
- "How does the process differ for a small bug fix vs. a large feature?"
- "Is the process documented anywhere, or is it understood implicitly?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | No consistent process; engineers go from ticket to code with no intermediate steps |
| 1 | Loose process exists (maybe a ticket template) but no spec phase, AI used only during coding |
| 2 | Some features get specs, but it is inconsistent; AI used primarily for code generation |
| 3 | Defined workflow with spec phase for major features; AI used in coding and some testing |
| 4 | Consistent spec-first workflow; AI participates in spec drafting, coding, and test generation |
| 5 | Fully spec-driven workflow where AI is involved at every phase: spec generation, design review, implementation planning, coding, testing, and PR description |

---

#### Q2.2 — Spec Quality and Structure

**Ask**: "Do engineers write specs or design docs before coding? How structured are they?"

**Listening for**:
- Spec existence and consistency
- Template usage and enforcement
- Quality of specs (vague paragraphs vs. structured with acceptance criteria, edge cases, constraints)
- Whether specs are reviewed before coding begins
- Whether specs live in the repo (version-controlled) or in external tools

**Follow-up probes**:
- "Can you show me a recent spec for a feature that has shipped?"
- "Is there a spec template? Who enforces it?"
- "Do specs get reviewed before implementation starts?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | No specs or design docs; engineers code from tickets directly |
| 1 | Occasional design docs for large features, but no standard format |
| 2 | Specs exist for most features but quality varies widely; no template |
| 3 | Spec template exists and is used for most features; includes basic structure (goal, approach, risks) |
| 4 | Structured specs with template enforcement, reviewed before coding, includes acceptance criteria and edge cases |
| 5 | Rigorous spec process: structured templates with acceptance criteria, constraints, and test scenarios; reviewed and approved before coding; version-controlled in the repo; AI-consumable format |

---

#### Q2.3 — AI in the Design Phase

**Ask**: "How does AI participate in the design phase vs. just the coding phase? Is AI involved before the first line of code is written?"

**Listening for**:
- AI usage beyond code completion (spec writing, architecture suggestions, risk analysis)
- Prompt engineering for design tasks
- Whether they feed specs to AI for implementation planning
- Maturity of AI usage across the lifecycle (left-shift)

**Follow-up probes**:
- "Have you tried using AI to draft or review specs?"
- "Do you feed specs to AI tools as context for implementation?"
- "How do you give AI the context it needs to generate good code for your codebase?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | AI is used only for inline code completion; no involvement before coding |
| 1 | AI used for code completion and occasional ChatGPT queries during design thinking |
| 2 | Some engineers use AI to draft specs or brainstorm designs, but it is not systematic |
| 3 | AI is regularly used to help draft specs and plan implementation, with human review |
| 4 | AI is integrated into the design phase: spec drafting, design review, implementation planning, with structured prompts and context |
| 5 | AI participates across the full design lifecycle: generates spec drafts from requirements, reviews specs for gaps, produces implementation plans, and the output feeds directly into coding agents with full context |

---

#### Q2.4 — AI Attribution and Traceability

**Ask**: "Show me your last 3 merged PRs. Can you tell me which parts were AI-assisted?"

**This is a "show me" question — ask them to share their screen.**

**Listening for**:
- Whether they can identify AI-assisted code at all
- Commit trailers or metadata indicating AI origin (e.g., `Co-authored-by`, `ai-tool:`, custom trailers)
- PR descriptions that mention AI involvement
- Tooling that automatically tags AI contributions
- Commit hygiene (small, focused AI commits vs. large undifferentiated blobs)

**Follow-up probes**:
- "Is there a way to search your repo for AI-generated code?"
- "Do your commit messages or PR descriptions indicate when AI was used?"
- "If a bug is found, can you trace whether it came from AI-generated code?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | Cannot tell which code is AI-assisted; no metadata, no awareness |
| 1 | Can guess based on memory ("I think I used Copilot for this function") but no systematic tracking |
| 2 | Some PRs mention AI in the description, but it is inconsistent and manual |
| 3 | Convention exists for noting AI assistance (e.g., PR template checkbox, commit message convention) but not enforced |
| 4 | Consistent AI attribution via commit trailers or PR metadata, enforced by convention or CI check |
| 5 | Automated AI attribution: tooling tags AI contributions with trailers, PR descriptions auto-populated, searchable and auditable, feeds into quality metrics |

---

### Section 3: CI/CD & Quality (20 pts)

#### Q3.1 — AI Validation in CI/CD

**Ask**: "Walk me through your CI/CD pipeline. Where does AI-generated code get validated differently from human-written code, if at all?"

**Listening for**:
- Whether CI/CD has any AI-specific validation steps
- Eval gates (automated quality checks specifically for AI output)
- Whether AI-generated PRs go through the same or different review process
- Use of Amazon Bedrock Evaluations or similar eval frameworks
- Security scanning for AI-specific risks (hallucinated APIs, insecure patterns)

**Follow-up probes**:
- "Does your CI pipeline know whether code is AI-generated?"
- "Have you considered adding AI-specific quality gates?"
- "Do you use any evaluation frameworks for AI output quality?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | Standard CI only; no AI-specific steps; AI code is treated identically to human code |
| 1 | Awareness that AI code should be validated differently, but no action taken |
| 2 | Extra review attention for known AI-generated PRs, but no automated gates |
| 3 | Some automated checks that apply more scrutiny to AI code (e.g., stricter linting, mandatory test coverage thresholds) |
| 4 | Dedicated AI validation steps in CI: eval gates, AI-specific security scanning, automated quality benchmarks |
| 5 | Comprehensive AI validation pipeline: eval gates with Bedrock Evaluations or equivalent, AI-specific security scanning, quality benchmarks, automated rollback triggers, and feedback loops to improve AI prompts |

---

#### Q3.2 — AI Bug Tracking

**Ask**: "Have you ever had an AI-generated bug reach production? What happened, and what did you learn?"

**Listening for**:
- Honesty and self-awareness (every team using AI has had bugs)
- Whether they track AI-origin bugs separately
- Post-mortem process for AI-related incidents
- Whether incidents led to process improvements
- Specific examples with detail (shows real engagement with the problem)

**Follow-up probes**:
- "How did you identify that it was AI-generated code that caused the issue?"
- "Did you change your process as a result?"
- "Do you track defect rates for AI-generated code separately?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | "Probably, but we don't track AI origin for bugs" or "AI doesn't cause bugs" (denial) |
| 1 | Aware of at least one AI-related bug, but no systematic tracking or follow-up |
| 2 | Can describe specific AI-related incidents, but response was ad hoc |
| 3 | AI-related bugs are discussed in retros; some process changes made but tracking is informal |
| 4 | AI-origin bugs are tagged in the issue tracker; post-mortems explicitly address AI failure mode; process improvements documented |
| 5 | Systematic AI bug tracking with defect attribution, post-mortems that feed back into prompt engineering and eval gates, and quantified AI defect rate trends |

---

#### Q3.3 — AI Code Quality Measurement

**Ask**: "How do you measure the quality of AI-generated code vs. human-written code? Is there a difference?"

**Listening for**:
- Whether they measure quality at all (many do not)
- Defect rate comparison between AI and human code
- Review feedback patterns (do AI PRs get more review comments?)
- Acceptance rate for AI suggestions
- Code quality metrics with AI dimension (complexity, test coverage, bug rate)

**Follow-up probes**:
- "Do AI-generated PRs get more review comments or change requests?"
- "What's your AI suggestion acceptance rate?"
- "Have you noticed patterns in the types of issues AI code introduces?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | Do not measure code quality in any systematic way, let alone by AI origin |
| 1 | General code quality metrics exist (test coverage, linting) but no AI dimension |
| 2 | Anecdotal awareness of AI code quality differences ("AI code tends to be more verbose") but no measurement |
| 3 | Some quality metrics tracked with AI awareness (e.g., know their Copilot acceptance rate) |
| 4 | Quality metrics explicitly compare AI vs. human code: defect rates, review feedback, complexity scores |
| 5 | Comprehensive quality measurement: AI vs. human defect rates, review cycle times, acceptance rates, complexity scores, with dashboards and trend analysis that feeds back into tooling decisions |

---

#### Q3.4 — Deployment Metrics and AI Impact

**Ask**: "What's your deployment frequency and lead time? How has AI affected these numbers?"

**Listening for**:
- DORA metrics awareness (deployment frequency, lead time, change failure rate, MTTR)
- Whether they actually measure these metrics
- Whether they can attribute changes to AI adoption
- Before/after data or trend analysis
- Sophistication of measurement (gut feel vs. dashboards)

**Follow-up probes**:
- "Do you track DORA metrics formally?"
- "Can you show me the trend in deployment frequency over the last 6 months?"
- "How do you separate AI's impact from other process improvements?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | Do not track deployment metrics; cannot state deployment frequency |
| 1 | Rough awareness ("we deploy a few times a week") but no formal tracking |
| 2 | Track deployment frequency and maybe lead time, but have not analyzed AI's impact |
| 3 | Track DORA metrics; have anecdotal sense that AI has helped but no rigorous attribution |
| 4 | Track DORA metrics with trend analysis; can show before/after AI adoption data; some attribution methodology |
| 5 | Full DORA tracking with AI-attributed impact analysis: can show how AI adoption changed each metric, with controlled comparison and confidence in the attribution |

---

### Section 4: Metrics & Visibility (15 pts)

#### Q4.1 — Executive Visibility

**Ask**: "If your CTO asked you right now, 'What is AI doing for our engineering velocity?' — what would you show them?"

**This is a "show me" question — if they say they have a dashboard, ask to see it.**

**Listening for**:
- Whether the answer is data or anecdotes
- Dashboard existence and quality
- Real-time vs. quarterly snapshots
- Whether leadership actually asks this question (indicates exec engagement)
- Specific metrics they would cite

**Follow-up probes**:
- "Has leadership actually asked this question? What was the conversation?"
- "Can you pull up what you would show them right now?"
- "How often does this data get updated?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | Nothing; would rely on anecdotes ("engineers say they feel faster") |
| 1 | Could point to license costs and adoption numbers, but no velocity or quality data |
| 2 | Could assemble a slide deck with some data, but it would take effort and be mostly manual |
| 3 | Has a periodic report or dashboard with AI-related metrics, updated monthly or quarterly |
| 4 | Real-time or weekly dashboard showing AI contribution metrics: acceptance rates, AI-attributed commits, velocity trends |
| 5 | Executive-ready dashboard with real-time AI contribution metrics, ROI calculations, quality comparisons, trend analysis, and automated reporting cadence |

---

#### Q4.2 — Engineering Metrics with AI Dimensions

**Ask**: "What engineering metrics do you currently track? Which ones include an AI dimension?"

**Listening for**:
- Baseline engineering metrics maturity (many startups track very little)
- Whether existing metrics have been enhanced with AI dimensions
- DORA metrics, cycle time, throughput, quality metrics
- AI-specific metrics: acceptance rate, AI commit ratio, AI defect rate
- Whether metrics drive decisions or are just collected

**Follow-up probes**:
- "Do you track cycle time? Does it distinguish AI-assisted work?"
- "What's your AI suggestion acceptance rate across the team?"
- "Which metric has been most useful for understanding AI's impact?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | Minimal or no engineering metrics tracked |
| 1 | Basic metrics (tickets closed, deploy count) with no AI dimension |
| 2 | Standard engineering metrics (cycle time, throughput) but no AI dimension |
| 3 | Good engineering metrics plus 1-2 AI-specific metrics (e.g., Copilot acceptance rate) |
| 4 | Comprehensive engineering metrics with AI dimensions: DORA + AI attribution, cycle time with AI breakdown, quality with AI comparison |
| 5 | Enhanced DORA with full AI dimensions, AI-specific metrics (acceptance rate, AI commit ratio, AI defect rate, prompt effectiveness), used actively to drive engineering decisions |

---

#### Q4.3 — AI ROI Reporting

**Ask**: "How do you report AI ROI to leadership? What's the cadence and what does it include?"

**Listening for**:
- Whether ROI is reported at all
- Quantitative vs. qualitative ROI
- Cadence and audience
- Whether ROI includes cost (tooling spend) and benefit (velocity, quality, hiring)
- Sophistication of the ROI model

**Follow-up probes**:
- "What's included in the ROI calculation?"
- "Has the ROI data influenced any decisions (budget, headcount, tool choices)?"
- "Who is the audience for this reporting?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | No AI ROI reporting to leadership |
| 1 | Occasional informal updates ("AI is helping, we should keep paying for it") |
| 2 | Periodic updates with some data (cost of tools, anecdotal time savings) but no rigorous ROI |
| 3 | Quarterly reporting with quantified metrics: time savings estimates, tool costs, adoption rates |
| 4 | Regular reporting with quantified ROI: measured time savings, quality improvements, cost vs. benefit, delivered to specific exec audience |
| 5 | Structured executive readouts with full ROI model: quantified velocity gains, quality impact, cost analysis, hiring/retention impact, with trend lines and forecasts, at regular cadence (monthly or quarterly) |

---

### Section 5: Governance & Security (15 pts)

#### Q5.1 — AI Guardrails

**Ask**: "What guardrails do you have around AI-generated code and AI agents? How do you limit what AI can do autonomously?"

**Listening for**:
- Whether guardrails exist at all
- Specificity of guardrails (vague "be careful" vs. concrete rules)
- Autonomy tiers (what AI can do without review vs. with review)
- Whether guardrails are documented and enforced
- Agent-specific controls (if they use agentic coding tools)

**Follow-up probes**:
- "Can an AI agent merge a PR without human review?"
- "Are there parts of the codebase where AI is restricted?"
- "How do you handle it when AI generates code that touches security-sensitive areas?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | No guardrails; AI tools operate with whatever access the developer has |
| 1 | Informal guidance ("review AI code carefully") but no enforced guardrails |
| 2 | Some guardrails: AI PRs require human review, but no formal policy or autonomy tiers |
| 3 | Documented guardrails: AI review requirements, restricted areas, basic autonomy rules |
| 4 | Formal guardrail framework: autonomy tiers (what AI can do alone vs. with review), enforced by tooling, documented and communicated |
| 5 | Comprehensive guardrail system: autonomy tiers enforced by CI/CD and tooling, agent sandboxing, restricted codebase zones, regular guardrail review and updates, with audit trail |

---

#### Q5.2 — AI Access and Permissions

**Ask**: "How do you handle AI access to sensitive data, credentials, or production systems? Does AI get the same access as the developer using it?"

**Listening for**:
- Whether AI tools have scoped permissions or inherit developer access
- IAM considerations for AI agents
- Credential management (can AI access secrets?)
- Audit trails for AI actions
- Production access controls for AI

**Follow-up probes**:
- "Can AI tools access your production database?"
- "Do you have audit logs for what AI agents do in your systems?"
- "How do you prevent AI from leaking credentials in generated code?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | AI tools have the same access as the developer; no distinction, no audit trail |
| 1 | Awareness that AI access is a concern, but no action taken |
| 2 | Some basic controls (AI tools cannot access production directly) but not comprehensive |
| 3 | AI-specific access controls: scoped permissions for AI tools, credential isolation, basic audit logging |
| 4 | Comprehensive AI access management: scoped IAM for AI agents, credential exclusion, audit trails, explicit trust boundaries documented |
| 5 | Full AI access governance: least-privilege IAM for all AI tools, audit trails with AI action attribution, trust boundaries enforced by infrastructure, regular access reviews, secrets scanning for AI output |

---

#### Q5.3 — AI Incident Response

**Ask**: "Do you have an AI-specific incident response process? If an AI agent causes a production issue, what happens?"

**Listening for**:
- Whether they have thought about AI-specific failure modes
- Runbooks or escalation paths for AI incidents
- Post-mortem process that addresses AI root causes
- Automated detection of AI-related issues
- Whether AI incidents have actually occurred and how they were handled

**Follow-up probes**:
- "Has an AI agent ever done something unexpected in your systems?"
- "How would you detect if an AI tool introduced a subtle security vulnerability?"
- "Do your runbooks distinguish between AI-caused and human-caused incidents?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | No AI-specific incident response; all incidents handled the same way |
| 1 | Awareness that AI could cause unique incidents, but no specific process |
| 2 | Some ad hoc handling of AI incidents, but no documented process |
| 3 | AI incident response considerations added to existing runbooks; post-mortems consider AI factors |
| 4 | Dedicated AI incident response process: AI-specific runbooks, escalation paths, post-mortem template that addresses AI failure modes |
| 5 | Comprehensive AI incident response: dedicated runbooks with eval checkpoints, automated detection of AI-related anomalies, AI-specific escalation, post-mortems that feed back into guardrails and eval gates, regular AI incident drills |

---

### Section 6: Organization & Culture (15 pts)

#### Q6.1 — AI Ownership and Sponsorship

**Ask**: "Who owns AI engineering transformation in your org? Is there a dedicated person, team, or budget?"

**Listening for**:
- Named individual or team responsible
- Executive sponsorship (CTO/VP level buy-in)
- Dedicated budget vs. coming out of general eng budget
- Whether this is someone's primary job or a side project
- Strategic intent vs. organic adoption

**Follow-up probes**:
- "Is this someone's full-time job, or part of broader responsibilities?"
- "Does the CEO/CTO actively champion AI adoption?"
- "What's the annual budget for AI tooling and transformation?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | Nobody owns it; purely grassroots, no budget, no executive awareness |
| 1 | Grassroots with informal champion (an enthusiastic engineer) but no authority or budget |
| 2 | Engineering leadership is supportive and involved, but no dedicated owner or budget line |
| 3 | Named owner (e.g., platform lead, DevEx lead) with partial responsibility and some budget |
| 4 | Dedicated owner with clear mandate, budget, and executive backing; AI transformation is a stated priority |
| 5 | Named owner with dedicated team, explicit budget, executive sponsorship at C-level, AI transformation on the company roadmap with OKRs |

---

#### Q6.2 — AI Onboarding

**Ask**: "How do new engineers get onboarded to your AI toolchain? What does their first week look like with respect to AI tools?"

**Listening for**:
- Whether onboarding includes AI tooling at all
- Documentation and guides for AI tools
- Time-to-productivity with AI tools
- Whether onboarding is structured or "ask a colleague"
- Ongoing training and skill development

**Follow-up probes**:
- "How long until a new engineer is productive with your AI toolchain?"
- "Is there documentation for how to use AI tools effectively in your codebase?"
- "Do you provide ongoing training as new AI capabilities emerge?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | AI tools are not part of onboarding; new engineers discover them on their own |
| 1 | Mentioned informally during onboarding ("by the way, we use Copilot") but no structured setup |
| 2 | AI tools are set up during onboarding, but no guidance on effective use |
| 3 | Structured AI onboarding: tools installed, basic usage guide, team conventions documented |
| 4 | Comprehensive AI onboarding: tools configured, usage guides with codebase-specific tips, mentoring from experienced AI users, first-week AI tasks |
| 5 | Full AI onboarding program: structured setup, codebase-specific prompt libraries, mentoring, effectiveness benchmarks, ongoing training program, feedback loop from new hires to improve the process |

---

#### Q6.3 — Blockers and Self-Awareness

**Ask**: "What's blocking you from getting more value from AI in engineering? If you could fix one thing tomorrow, what would it be?"

**Listening for**:
- Self-awareness and honesty about gaps
- Specificity of blockers (vague "culture" vs. concrete "we don't have specs so AI doesn't have context")
- Whether blockers are organizational, technical, or cultural
- Willingness to change and invest
- Whether the answer aligns with what you have observed in the rest of the interview

**Follow-up probes**:
- "What have you tried to address that blocker?"
- "Is that a resource issue, a knowledge issue, or a prioritization issue?"
- "If you had an extra engineer dedicated to this, what would you have them do first?"

**Scoring**:
| Score | Evidence |
|:---:|---|
| 0 | "Nothing, we're fine" (lack of self-awareness) or "AI isn't useful for us" |
| 1 | Vague blockers ("culture", "time") with no specifics |
| 2 | Can name specific blockers but has not taken action to address them |
| 3 | Specific, actionable blockers identified; some efforts underway to address them |
| 4 | Clear understanding of gaps with prioritized action plan; some progress already made |
| 5 | Deep self-awareness with specific blockers, root cause analysis, prioritized roadmap, and evidence of iterating on solutions; answer is consistent with the rest of the interview |

---

### Interview Closing

> "That covers everything I wanted to ask. A few wrap-up items:
>
> 1. Is there anything about your AI engineering practices that I didn't ask about but you think is important?
> 2. What's the most impactful change you've made in the last quarter related to AI in engineering?
> 3. We'll compile this into a report and share recommendations within a week.
>
> Thanks for your time — this was very helpful."

Note any additional context from the closing in the free-form notes section of the scoring sheet. These answers do not affect scoring but can provide useful color for the final report.

---

### Interview Scoring Sheet

#### Assessment Information

| Field | Value |
|-------|-------|
| **Customer Name** | __________________ |
| **Date** | __________________ |
| **SA / Interviewer** | __________________ |
| **Interviewees** | __________________ |
| **Funding Stage** | __________________ |
| **Team Size (engineers)** | __________________ |
| **Scanner Score (if run)** | ______ / 100 |

#### Section Scores

| # | Question | Score (0-5) | Notes |
|---|----------|:-----------:|-------|
| Q1.1 | AI tool usage overview | [ ] | |
| Q1.2 | Tool adoption process | [ ] | |
| Q1.3 | Usage measurement | [ ] | |
| **Section 1 Subtotal** | | **__/15** | |
| Q2.1 | Feature development flow | [ ] | |
| Q2.2 | Spec quality and structure | [ ] | |
| Q2.3 | AI in the design phase | [ ] | |
| Q2.4 | AI attribution and traceability | [ ] | |
| **Section 2 Subtotal** | | **__/20** | |
| Q3.1 | AI validation in CI/CD | [ ] | |
| Q3.2 | AI bug tracking | [ ] | |
| Q3.3 | AI code quality measurement | [ ] | |
| Q3.4 | Deployment metrics and AI impact | [ ] | |
| **Section 3 Subtotal** | | **__/20** | |
| Q4.1 | Executive visibility | [ ] | |
| Q4.2 | Engineering metrics with AI dimensions | [ ] | |
| Q4.3 | AI ROI reporting | [ ] | |
| **Section 4 Subtotal** | | **__/15** | |
| Q5.1 | AI guardrails | [ ] | |
| Q5.2 | AI access and permissions | [ ] | |
| Q5.3 | AI incident response | [ ] | |
| **Section 5 Subtotal** | | **__/15** | |
| Q6.1 | AI ownership and sponsorship | [ ] | |
| Q6.2 | AI onboarding | [ ] | |
| Q6.3 | Blockers and self-awareness | [ ] | |
| **Section 6 Subtotal** | | **__/15** | |
| **INTERVIEW TOTAL** | | **__/100** | |

#### Limiting Dimension

**Lowest section**: ______________________

**Why it matters**: ______________________

#### Key Observations (free-form)

- **Strongest area**:
- **Weakest area**:
- **Discrepancies between scanner and interview**:
- **Things that surprised you**:
- **Recommended focus areas for this customer**:

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

## Part 5: Qualification Matrix & Verdict Logic

### Verdict Rules

| Verdict | Conditions | Action |
|---------|-----------|--------|
| **READY_FOR_PILOT** | blendedScore ≥ 21 AND orgReadiness ≥ 12 | Assign track B, C, or D |
| **NEEDS_FOUNDATIONS** | blendedScore ≥ 11 AND orgReadiness ≥ 8 | Assign track A |
| **NOT_QUALIFIED** | Below both thresholds | Exit with recommendations |

> **NOTE — conflicting source:** The verdict thresholds above (from the scoring model) state READY_FOR_PILOT requires blendedScore ≥ 21, but the Assessment Flow Overview diagram states "≥L2.0 and org≥12" which maps to blendedScore ≥ 21. These are consistent. However, the qualification matrix detail rows below show READY_FOR_PILOT at blendedScore 15-25 with org ≥ 12 — which would map to L1.5-L2.0, seemingly contradicting the ≥L2.0 rule. The matrix rows should be treated as the authoritative lookup since they handle edge cases.

### Full Decision Matrix

| Blended Score | Org Readiness | Level | Verdict | Next Step |
|:---:|:---:|:---:|:---:|---|
| 0-14 | Any | L1.0 | NOT_QUALIFIED | Revisit in 6 months; provide self-service materials |
| 15-25 | < 8 | L1.5-L2.0 | NOT_QUALIFIED | Org not ready; need executive sponsorship first |
| 15-25 | 8-11 | L1.5-L2.0 | NEEDS_FOUNDATIONS | Start with Module 00-02 only (foundations track) |
| 15-25 | >= 12 | L1.5-L2.0 | READY_FOR_PILOT | Foundations workshop + limited pilot (Module 00-02) |
| 26-40 | < 8 | L2.0-L2.5 | NOT_QUALIFIED | Technical readiness exists but org is blocking; run executive alignment |
| 26-40 | 8-11 | L2.0-L2.5 | NEEDS_FOUNDATIONS | Org readiness gap; executive alignment workshop first, then Module 01-04 |
| 26-40 | >= 12 | L2.0-L2.5 | READY_FOR_PILOT | Full workshop + 8-week pilot |
| 41-55 | < 12 | L3.0-L3.5 | NEEDS_FOUNDATIONS | Strong technical base, org needs to catch up; executive alignment + Module 04-06 |
| 41-55 | >= 12 | L3.0-L3.5 | READY_FOR_PILOT | Accelerated workshop, focus on identified gaps |
| 56-70 | < 12 | L3.5-L4.0 | NEEDS_FOUNDATIONS | Advanced practices with org lag; executive + governance workshops |
| 56-70 | >= 12 | L3.5-L4.0 | READY_FOR_PILOT | Advanced track, focus on L3-to-L4 transition |
| 71+ | >= 12 | L4.5-L5.0 | READY_FOR_PILOT | Peer-level engagement; co-innovation focus |

### Detailed Guidance by Scenario

#### Blended < 15, Any Org Readiness — NOT_QUALIFIED

**Profile**: Minimal or no AI adoption in engineering. Not a fit for PRISM D1 at this time.

**Action**:
- Share self-service PRISM D1 getting-started materials
- Recommend basic AI tool adoption (Amazon Q Developer, Copilot)
- Set a follow-up in 6 months to reassess
- Do not invest SA time in a workshop

**SA talking points**:
> "Your team is early in the AI engineering journey, which is completely normal. We have self-service materials that can help you get started with AI tools, and I'd love to reconnect in about six months to see how things have progressed."

#### Blended 15-25, Org Readiness < 8 — NOT_QUALIFIED

**Profile**: Some engineers experimenting with AI tools, but no executive sponsorship, budget, or dedicated ownership.

**Action**:
- Share assessment findings focusing on the org readiness gap
- Recommend they secure executive sponsorship and budget before proceeding
- Offer to present the "AI Engineering Value Proposition" deck to their leadership
- Set a follow-up in 3 months

**SA talking points**:
> "Your engineers are starting to experiment with AI, which is great. The gap we see is on the organizational side — without executive sponsorship and dedicated budget, the practices we'd introduce in a workshop won't be sustainable. Let me share some materials you can use to build the business case internally."

#### Blended 15-25, Org Readiness 8-11 — NEEDS_FOUNDATIONS

**Profile**: Early-stage AI adoption with partial org readiness.

**Action**: Foundations track (Module 00-02). Keep engagement short (2-3 sessions). Focus on quick wins. Reassess after foundations to determine if ready for full pilot.

#### Blended 15-25, Org Readiness >= 12 — READY_FOR_PILOT

**Profile**: Early technical adoption but strong organizational backing. Good investment.

**Action**: Foundations workshop (Module 00-02) with confidence. Include a limited pilot (4 weeks) focused on one team. Measure baseline DORA metrics before the pilot starts.

#### Blended 26-40, Org Readiness < 8 — NOT_QUALIFIED

**Profile**: Technical team has progressed but org has not caught up. Single champion risk.

**Action**: Acknowledge technical progress. Frame org gap as sustainability risk. Offer executive alignment workshop. Do not start technical modules until org readiness reaches >= 8.

**SA talking points**:
> "Your engineering team has done impressive work adopting AI tools. The risk I see is that these practices depend on a few champions rather than organizational structure. I recommend we start with an executive alignment session to build the structural support these practices need to be durable."

#### Blended 26-40, Org Readiness 8-11 — NEEDS_FOUNDATIONS

**Profile**: Solid technical foundation with partial org readiness. Close to pilot-ready.

**Action**: Executive alignment workshop (1 session) + Module 01-04 in parallel. Focus on metrics/visibility (Module 04) to build ROI narrative. Target reassessment in 6-8 weeks.

#### Blended 26-40, Org Readiness >= 12 — READY_FOR_PILOT

**Profile**: Ideal pilot candidate.

**Action**: Full PRISM D1 workshop (2-day format). 8-week pilot with defined success criteria. Assign dedicated SA for pilot duration.

**SA talking points**:
> "You're in a great position to move fast. You have the tools, the team support, and the organizational backing. I recommend a full workshop followed by an 8-week pilot where we focus on [top 2-3 gaps from the assessment]."

#### Blended 41-55, Org Readiness < 12 — NEEDS_FOUNDATIONS (org gap)

**Profile**: Strong technical practices but organizational structure has not kept pace.

**Action**: Executive alignment is priority. Use strong technical metrics as basis for ROI narrative. Module 04 + Module 06 to bridge engineering practices and organizational structure.

#### Blended 41-55, Org Readiness >= 12 — READY_FOR_PILOT

**Profile**: Strong candidate. Ready for accelerated engagement.

**Action**: Accelerated workshop (1 day, skip foundations). Focus on limiting dimension. Module 05-07 track. 6-week pilot. Consider for case study/reference.

#### Blended 56-70, Org Readiness >= 12 — READY_FOR_PILOT (advanced)

**Profile**: Mature practices. Focus on L3-to-L4 transition.

**Action**: Advanced workshop (Module 07-08). AI-native architecture, agentic workflows, scaling. 4-week targeted engagement. Peer-connect with other advanced customers. Strong case study candidate.

#### Blended 71+, Org Readiness >= 12 — READY_FOR_PILOT (co-innovation)

**Profile**: Industry-leading. Standard workshops not appropriate.

**Action**: Co-innovation engagement. Connect with AWS product teams for feedback and early access. Case study and reference customer. Module 09 (AI-Native Leadership) and custom content.

### Quick Reference: Org Readiness Scoring

| Criterion | Points | How to Assess |
|-----------|:------:|---------------|
| Executive sponsor identified | 4 | Named C-level or VP actively championing AI in engineering |
| Budget allocated for AI tooling | 4 | Dedicated line item, not "coming from general eng budget" |
| Dedicated AI/platform team or owner | 4 | Named person or team with AI engineering as primary responsibility |
| Existing AWS commitment/relationship | 4 | Active AWS customer with committed spend or partnership |
| Team size appropriate (20-200 engineers) | 4 | Confirmed engineering headcount in range |
| **Total** | **20** | |

Thresholds:
- **>= 12**: Strong org readiness (at least 3 of 5 criteria met)
- **8-11**: Partial org readiness (2 of 5 criteria met)
- **< 8**: Insufficient org readiness (1 or fewer criteria met)

---

## Part 6: Report Generation

The `reports/report-generator.ts` produces the customer-facing assessment report in three formats.

### Report Sections

1. **Executive Summary** — PRISM Level, verdict, one-paragraph narrative, component scores
2. **Radar Chart** — Visual of all 12 scanner categories (SVG in HTML, ASCII in markdown)
3. **Scanner Breakdown** — Category-by-category with GREEN/AMBER/RED status indicators
4. **Interview Summary** — Section-by-section findings with key quotes
5. **Gap Analysis** — Top 5 gaps ranked by lowest percentage, each with remediation action
6. **Strengths** — Top 3 highest-scoring areas
7. **Onboarding Recommendation** — Track, modules, pre-work, 90-day roadmap, SA schedule
8. **Appendix** — Full scanner evidence (every signal, every file found)

### Gap Analysis Remediation Text

> **⚠️ KNOWN ISSUE — stale scoring:** The report generator's gap remediation for the 'Commit Hygiene' category recommends: *"Deploy git hooks for AI-Origin and AI-Confidence trailers."* This text has two problems: (1) Git hooks are being **deprecated** in this project in favour of OTEL-based attribution via `codeburn sync --attribution`, and (2) `AI-Confidence` was **never an implemented trailer** — no hook, spec, or code for it exists anywhere in the project. The remediation text should be updated to reference OTEL attribution once the scoring model revision is complete.

### Output Formats

| Format | Use Case | Features |
|--------|----------|----------|
| **Markdown** | Print-ready customer handout | ASCII radar chart, tables |
| **JSON** | Programmatic use, re-rendering | Structured data, all scores |
| **HTML/PDF** | Styled web display, board presentation | SVG radar chart, color coding |

### Report Template

The markdown report template is at `reports/templates/assessment-report.md`. The HTML template is at [`reports/templates/assessment-report.html`](reports/templates/assessment-report.html).

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

Generated PDF includes radar chart showing strengths (Commit Hygiene, Tooling) and gaps (Observability, Agents, Governance), plus a 90-day roadmap.

---

## Sample Reports

| Company | Level | Verdict | Track | Report |
|---------|:-----:|---------|:-----:|--------|
| NovaPay (Series A, 6 eng) | L1.5 | NEEDS_FOUNDATIONS | A | [PDF](reports/sample-reports/pdf/novapay-l1.5-assessment.pdf) · [HTML](reports/sample-reports/pdf/novapay-l1.5-assessment.html) |
| Arcline Health (Series B, 14 eng) | L2.5 | READY_FOR_PILOT | B | [PDF](reports/sample-reports/pdf/arcline-health-l2.5-assessment.pdf) · [HTML](reports/sample-reports/pdf/arcline-health-l2.5-assessment.html) |
| Vectrix AI (Series C, 28 eng) | L3.5 | READY_FOR_PILOT | C | [PDF](reports/sample-reports/pdf/vectrix-ai-l3.5-assessment.pdf) · [HTML](reports/sample-reports/pdf/vectrix-ai-l3.5-assessment.html) |

---

## Running the Full Pipeline

```bash
# 1. Scan
cd assessment/scanner && npx ts-node src/index.ts --repo /path/to/repo --output json --output-file ../reports/scan.json

# 2. Interview (manual — use the guide and scoring sheet above)

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
