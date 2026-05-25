# PRISM D1 Velocity -- SA Interview Guide

**Total questions**: 20
**Total points**: 100 (20 questions x 5 points each)
**Duration**: 60-90 minutes

---

## Opening (2 minutes)

> "Thanks for making time for this. We're going to walk through how your team builds software today, with a focus on how AI tools fit into your workflow. There are no wrong answers -- we're trying to understand where you are so we can figure out the most useful next steps. I'll ask questions across six areas: your AI tooling, development workflow, CI/CD, metrics, governance, and org structure. Feel free to jump in with context at any point."

---

## Section 1: Current AI Tooling Landscape

**Weight**: 15 points (3 questions)
**Time**: ~10 minutes

### Q1.1 -- AI Tool Usage Overview

**Ask**: "Walk me through how your engineers use AI tools today -- from IDE to deployment. What tools are in play, and how consistently are they used?"

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
|-------|----------|
| 0 | No AI tools in use, or only 1-2 engineers experimenting on their own |
| 1 | A few engineers use AI tools (Copilot, ChatGPT) but it is entirely ad hoc and self-directed |
| 2 | Multiple AI tools adopted across the team, but no standardization or shared configuration |
| 3 | Standardized primary tool (e.g., company-wide Copilot license), some shared config, but gaps in coverage across the lifecycle |
| 4 | Standardized toolset covering multiple lifecycle phases, shared configuration, approved tool list |
| 5 | Fully standardized and managed AI toolchain across the lifecycle, with shared config, version-controlled settings, and usage tracking |

---

### Q1.2 -- Tool Adoption Process

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
|-------|----------|
| 0 | No process; engineers install whatever they want with no oversight |
| 1 | Informal process; someone on the team evaluates tools but there is no formal framework |
| 2 | Some evaluation criteria exist (security, cost) but the process is inconsistent |
| 3 | Defined evaluation process with security review and cost analysis, but slow or bureaucratic |
| 4 | Streamlined evaluation process with clear criteria, fast turnaround, and budget owner identified |
| 5 | Formal but fast governance: evaluation framework, security review, pilot period, rollout plan, and ongoing effectiveness measurement |

---

### Q1.3 -- Usage Measurement

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
|-------|----------|
| 0 | "I don't know" or clearly guessing with no basis |
| 1 | Rough guess based on anecdotal observation ("most people I think") |
| 2 | Knows the license count but not actual usage ("we have 50 Copilot seats") |
| 3 | Has some usage data (e.g., Copilot admin dashboard) but does not actively monitor or act on it |
| 4 | Actively tracks usage with breakdowns by team or role, reviews periodically |
| 5 | Real-time or weekly dashboards showing usage depth (not just logins), with trends and team-level breakdowns, used to drive adoption decisions |

---

## Section 2: Development Workflow & Specs

**Weight**: 20 points (4 questions)
**Time**: ~15 minutes

### Q2.1 -- Feature Development Flow

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
|-------|----------|
| 0 | No consistent process; engineers go from ticket to code with no intermediate steps |
| 1 | Loose process exists (maybe a ticket template) but no spec phase, AI used only during coding |
| 2 | Some features get specs, but it is inconsistent; AI used primarily for code generation |
| 3 | Defined workflow with spec phase for major features; AI used in coding and some testing |
| 4 | Consistent spec-first workflow; AI participates in spec drafting, coding, and test generation |
| 5 | Fully spec-driven workflow where AI is involved at every phase: spec generation, design review, implementation planning, coding, testing, and PR description |

---

### Q2.2 -- Spec Quality and Structure

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
|-------|----------|
| 0 | No specs or design docs; engineers code from tickets directly |
| 1 | Occasional design docs for large features, but no standard format |
| 2 | Specs exist for most features but quality varies widely; no template |
| 3 | Spec template exists and is used for most features; includes basic structure (goal, approach, risks) |
| 4 | Structured specs with template enforcement, reviewed before coding, includes acceptance criteria and edge cases |
| 5 | Rigorous spec process: structured templates with acceptance criteria, constraints, and test scenarios; reviewed and approved before coding; version-controlled in the repo; AI-consumable format |

---

### Q2.3 -- AI in the Design Phase

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
|-------|----------|
| 0 | AI is used only for inline code completion; no involvement before coding |
| 1 | AI used for code completion and occasional ChatGPT queries during design thinking |
| 2 | Some engineers use AI to draft specs or brainstorm designs, but it is not systematic |
| 3 | AI is regularly used to help draft specs and plan implementation, with human review |
| 4 | AI is integrated into the design phase: spec drafting, design review, implementation planning, with structured prompts and context |
| 5 | AI participates across the full design lifecycle: generates spec drafts from requirements, reviews specs for gaps, produces implementation plans, and the output feeds directly into coding agents with full context |

---

### Q2.4 -- AI Attribution and Traceability

**Ask**: "Show me your last 3 merged PRs. Can you tell me which parts were AI-assisted?"

**This is a "show me" question -- ask them to share their screen.**

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
|-------|----------|
| 0 | Cannot tell which code is AI-assisted; no metadata, no awareness |
| 1 | Can guess based on memory ("I think I used Copilot for this function") but no systematic tracking |
| 2 | Some PRs mention AI in the description, but it is inconsistent and manual |
| 3 | Convention exists for noting AI assistance (e.g., PR template checkbox, commit message convention) but not enforced |
| 4 | Consistent AI attribution via commit trailers or PR metadata, enforced by convention or CI check |
| 5 | Automated AI attribution: tooling tags AI contributions with trailers, PR descriptions auto-populated, searchable and auditable, feeds into quality metrics |

---

## Section 3: CI/CD & Quality

**Weight**: 20 points (4 questions)
**Time**: ~15 minutes

### Q3.1 -- AI Validation in CI/CD

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
|-------|----------|
| 0 | Standard CI only; no AI-specific steps; AI code is treated identically to human code |
| 1 | Awareness that AI code should be validated differently, but no action taken |
| 2 | Extra review attention for known AI-generated PRs, but no automated gates |
| 3 | Some automated checks that apply more scrutiny to AI code (e.g., stricter linting, mandatory test coverage thresholds) |
| 4 | Dedicated AI validation steps in CI: eval gates, AI-specific security scanning, automated quality benchmarks |
| 5 | Comprehensive AI validation pipeline: eval gates with Bedrock Evaluations or equivalent, AI-specific security scanning, quality benchmarks, automated rollback triggers, and feedback loops to improve AI prompts |

---

### Q3.2 -- AI Bug Tracking

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
|-------|----------|
| 0 | "Probably, but we don't track AI origin for bugs" or "AI doesn't cause bugs" (denial) |
| 1 | Aware of at least one AI-related bug, but no systematic tracking or follow-up |
| 2 | Can describe specific AI-related incidents, but response was ad hoc |
| 3 | AI-related bugs are discussed in retros; some process changes made but tracking is informal |
| 4 | AI-origin bugs are tagged in the issue tracker; post-mortems explicitly address AI failure mode; process improvements documented |
| 5 | Systematic AI bug tracking with defect attribution, post-mortems that feed back into prompt engineering and eval gates, and quantified AI defect rate trends |

---

### Q3.3 -- AI Code Quality Measurement

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
|-------|----------|
| 0 | Do not measure code quality in any systematic way, let alone by AI origin |
| 1 | General code quality metrics exist (test coverage, linting) but no AI dimension |
| 2 | Anecdotal awareness of AI code quality differences ("AI code tends to be more verbose") but no measurement |
| 3 | Some quality metrics tracked with AI awareness (e.g., know their Copilot acceptance rate) |
| 4 | Quality metrics explicitly compare AI vs. human code: defect rates, review feedback, complexity scores |
| 5 | Comprehensive quality measurement: AI vs. human defect rates, review cycle times, acceptance rates, complexity scores, with dashboards and trend analysis that feeds back into tooling decisions |

---

### Q3.4 -- Deployment Metrics and AI Impact

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
|-------|----------|
| 0 | Do not track deployment metrics; cannot state deployment frequency |
| 1 | Rough awareness ("we deploy a few times a week") but no formal tracking |
| 2 | Track deployment frequency and maybe lead time, but have not analyzed AI's impact |
| 3 | Track DORA metrics; have anecdotal sense that AI has helped but no rigorous attribution |
| 4 | Track DORA metrics with trend analysis; can show before/after AI adoption data; some attribution methodology |
| 5 | Full DORA tracking with AI-attributed impact analysis: can show how AI adoption changed each metric, with controlled comparison and confidence in the attribution |

---

## Section 4: Metrics & Visibility

**Weight**: 15 points (3 questions)
**Time**: ~10 minutes

### Q4.1 -- Executive Visibility

**Ask**: "If your CTO asked you right now, 'What is AI doing for our engineering velocity?' -- what would you show them?"

**This is a "show me" question -- if they say they have a dashboard, ask to see it.**

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
|-------|----------|
| 0 | Nothing; would rely on anecdotes ("engineers say they feel faster") |
| 1 | Could point to license costs and adoption numbers, but no velocity or quality data |
| 2 | Could assemble a slide deck with some data, but it would take effort and be mostly manual |
| 3 | Has a periodic report or dashboard with AI-related metrics, updated monthly or quarterly |
| 4 | Real-time or weekly dashboard showing AI contribution metrics: acceptance rates, AI-attributed commits, velocity trends |
| 5 | Executive-ready dashboard with real-time AI contribution metrics, ROI calculations, quality comparisons, trend analysis, and automated reporting cadence |

---

### Q4.2 -- Engineering Metrics with AI Dimensions

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
|-------|----------|
| 0 | Minimal or no engineering metrics tracked |
| 1 | Basic metrics (tickets closed, deploy count) with no AI dimension |
| 2 | Standard engineering metrics (cycle time, throughput) but no AI dimension |
| 3 | Good engineering metrics plus 1-2 AI-specific metrics (e.g., Copilot acceptance rate) |
| 4 | Comprehensive engineering metrics with AI dimensions: DORA + AI attribution, cycle time with AI breakdown, quality with AI comparison |
| 5 | Enhanced DORA with full AI dimensions, AI-specific metrics (acceptance rate, AI commit ratio, AI defect rate, prompt effectiveness), used actively to drive engineering decisions |

---

### Q4.3 -- AI ROI Reporting

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
|-------|----------|
| 0 | No AI ROI reporting to leadership |
| 1 | Occasional informal updates ("AI is helping, we should keep paying for it") |
| 2 | Periodic updates with some data (cost of tools, anecdotal time savings) but no rigorous ROI |
| 3 | Quarterly reporting with quantified metrics: time savings estimates, tool costs, adoption rates |
| 4 | Regular reporting with quantified ROI: measured time savings, quality improvements, cost vs. benefit, delivered to specific exec audience |
| 5 | Structured executive readouts with full ROI model: quantified velocity gains, quality impact, cost analysis, hiring/retention impact, with trend lines and forecasts, at regular cadence (monthly or quarterly) |

---

## Section 5: Governance & Security

**Weight**: 15 points (3 questions)
**Time**: ~10 minutes

### Q5.1 -- AI Guardrails

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
|-------|----------|
| 0 | No guardrails; AI tools operate with whatever access the developer has |
| 1 | Informal guidance ("review AI code carefully") but no enforced guardrails |
| 2 | Some guardrails: AI PRs require human review, but no formal policy or autonomy tiers |
| 3 | Documented guardrails: AI review requirements, restricted areas, basic autonomy rules |
| 4 | Formal guardrail framework: autonomy tiers (what AI can do alone vs. with review), enforced by tooling, documented and communicated |
| 5 | Comprehensive guardrail system: autonomy tiers enforced by CI/CD and tooling, agent sandboxing, restricted codebase zones, regular guardrail review and updates, with audit trail |

---

### Q5.2 -- AI Access and Permissions

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
|-------|----------|
| 0 | AI tools have the same access as the developer; no distinction, no audit trail |
| 1 | Awareness that AI access is a concern, but no action taken |
| 2 | Some basic controls (AI tools cannot access production directly) but not comprehensive |
| 3 | AI-specific access controls: scoped permissions for AI tools, credential isolation, basic audit logging |
| 4 | Comprehensive AI access management: scoped IAM for AI agents, credential exclusion, audit trails, explicit trust boundaries documented |
| 5 | Full AI access governance: least-privilege IAM for all AI tools, audit trails with AI action attribution, trust boundaries enforced by infrastructure, regular access reviews, secrets scanning for AI output |

---

### Q5.3 -- AI Incident Response

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
|-------|----------|
| 0 | No AI-specific incident response; all incidents handled the same way |
| 1 | Awareness that AI could cause unique incidents, but no specific process |
| 2 | Some ad hoc handling of AI incidents, but no documented process |
| 3 | AI incident response considerations added to existing runbooks; post-mortems consider AI factors |
| 4 | Dedicated AI incident response process: AI-specific runbooks, escalation paths, post-mortem template that addresses AI failure modes |
| 5 | Comprehensive AI incident response: dedicated runbooks with eval checkpoints, automated detection of AI-related anomalies, AI-specific escalation, post-mortems that feed back into guardrails and eval gates, regular AI incident drills |

---

## Section 6: Organization & Culture

**Weight**: 15 points (3 questions)
**Time**: ~10 minutes

### Q6.1 -- AI Ownership and Sponsorship

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
|-------|----------|
| 0 | Nobody owns it; purely grassroots, no budget, no executive awareness |
| 1 | Grassroots with informal champion (an enthusiastic engineer) but no authority or budget |
| 2 | Engineering leadership is supportive and involved, but no dedicated owner or budget line |
| 3 | Named owner (e.g., platform lead, DevEx lead) with partial responsibility and some budget |
| 4 | Dedicated owner with clear mandate, budget, and executive backing; AI transformation is a stated priority |
| 5 | Named owner with dedicated team, explicit budget, executive sponsorship at C-level, AI transformation on the company roadmap with OKRs |

---

### Q6.2 -- AI Onboarding

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
|-------|----------|
| 0 | AI tools are not part of onboarding; new engineers discover them on their own |
| 1 | Mentioned informally during onboarding ("by the way, we use Copilot") but no structured setup |
| 2 | AI tools are set up during onboarding, but no guidance on effective use |
| 3 | Structured AI onboarding: tools installed, basic usage guide, team conventions documented |
| 4 | Comprehensive AI onboarding: tools configured, usage guides with codebase-specific tips, mentoring from experienced AI users, first-week AI tasks |
| 5 | Full AI onboarding program: structured setup, codebase-specific prompt libraries, mentoring, effectiveness benchmarks, ongoing training program, feedback loop from new hires to improve the process |

---

### Q6.3 -- Blockers and Self-Awareness

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
|-------|----------|
| 0 | "Nothing, we're fine" (lack of self-awareness) or "AI isn't useful for us" |
| 1 | Vague blockers ("culture", "time") with no specifics |
| 2 | Can name specific blockers but has not taken action to address them |
| 3 | Specific, actionable blockers identified; some efforts underway to address them |
| 4 | Clear understanding of gaps with prioritized action plan; some progress already made |
| 5 | Deep self-awareness with specific blockers, root cause analysis, prioritized roadmap, and evidence of iterating on solutions; answer is consistent with the rest of the interview |

---

## Closing (3 minutes)

> "That covers everything I wanted to ask. A few wrap-up items:
>
> 1. Is there anything about your AI engineering practices that I didn't ask about but you think is important?
> 2. What's the most impactful change you've made in the last quarter related to AI in engineering?
> 3. We'll compile this into a report and share recommendations within a week.
>
> Thanks for your time -- this was very helpful."

Note any additional context from the closing in the free-form notes section of the scoring sheet. These answers do not affect scoring but can provide useful color for the final report.
