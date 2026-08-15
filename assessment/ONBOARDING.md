# PRISM D1 Velocity — Customer Onboarding

This guide is the single reference for AWS Solutions Architects managing post-assessment customer onboarding. It covers track definitions and routing logic, the full set of SA email templates for customer communications, and track-specific pre-work checklists that customers must complete before their workshop.

---

## Table of Contents

- [Track Assignment Logic](#track-assignment-logic)
- [Track A: Foundations](#track-a-foundations)
- [Track B: Full Workshop](#track-b-full-workshop)
- [Track C: Accelerated](#track-c-accelerated)
- [Track D: Advanced Optimization](#track-d-advanced-optimization)
- [NOT_QUALIFIED Exit Path](#not_qualified-exit-path)
- [SA Email Templates](#sa-email-templates)
  - [1. Post-Assessment Email](#1-post-assessment-email)
  - [2. Workshop Invitation](#2-workshop-invitation)
  - [3. Post-Workshop Follow-Up](#3-post-workshop-follow-up)
  - [4. Week 4 Checkpoint](#4-week-4-checkpoint)
  - [5. Pilot Completion](#5-pilot-completion)
- [Pre-Work Checklists](#pre-work-checklists)
  - [Track A Pre-Work](#track-a-pre-work)
  - [Track B Pre-Work](#track-b-pre-work)
  - [Track C Pre-Work](#track-c-pre-work)

---

## Track Assignment Logic

The onboarding track is determined by the blended PRISM D1 Level and the assessment verdict:

| Blended Level | Verdict | Track |
|---------------|---------|-------|
| L1.0–L1.5 | NEEDS_FOUNDATIONS | A — Foundations |
| L2.0–L2.5 | READY_FOR_PILOT | B — Full Workshop |
| L3.0–L3.5 | READY_FOR_PILOT | C — Accelerated |
| L4.0–L5.0 | READY_FOR_PILOT | D — Advanced Optimization |
| Any | NOT_QUALIFIED | No track (exit with recommendations) |

---

## Track A: Foundations

**Target**: L1.0–L1.5, NEEDS_FOUNDATIONS verdict

**Duration**: 2 weeks pre-work + 4-hour workshop (Modules 00–02 only)

**Focus**: Get AI tooling standardized and introduce spec-driven development. These teams are early in their AI-assisted development journey. They may have ad-hoc tool usage but lack standards, commit conventions, or any measurement of AI's contribution.

### Workshop Modules

| Module | Included | Reason |
|--------|----------|--------|
| 00 — Environment Setup | Yes | Foundation for everything else |
| 01 — CLAUDE.md & Standards | Yes | Standardize AI tool configuration |
| 02 — Spec-Driven Development | Yes | Introduce structured AI workflows |
| 03 — CI/CD & Eval Gates | No | Too early — no baseline to gate against |
| 04 — Metrics & Dashboards | No | Too early — need data flowing first |
| 05 — Governance & Scaling | No | Too early — need adoption first |

### Deliverables

- CLAUDE.md deployed to all active repositories
- Spec templates adopted by the team (feature spec, bug fix spec, refactor spec)
- First AI-tagged commits flowing (using `AI-Origin` and `AI-Confidence` trailers)
- Team has completed at least one spec-driven feature build

> **⚠️ KNOWN ISSUE — stale scoring:** The deliverable above references `AI-Confidence` trailers. This trailer was **never implemented** — no hook, CLI flag, or spec for it exists in the project. Additionally, git hooks that produce `AI-Origin` trailers are being **deprecated** in favour of OTEL-based attribution via `codeburn sync --attribution`. The deliverable should reference OTEL attribution once the scoring model revision is complete.

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
| Workshop day | In-person or video | 4 hr | Deliver Modules 00–02 |
| Week 1 post-workshop | Async check-in | — | Review commit trailer adoption |
| Week 2 post-workshop | Video call | 30 min | Review metrics, troubleshoot |
| Week 4 | Re-assessment | 1 hr | Re-run scanner, determine if ready for Track B |

### Next Step

Re-assess after 4 weeks. If the team reaches L2.0+, upgrade to Track B for the full workshop and pilot. If still below L2.0, extend the foundations engagement with targeted coaching.

---

## Track B: Full Workshop

**Target**: L2.0–L2.5, READY_FOR_PILOT verdict

**Duration**: 1 week pre-work + full 4-hour workshop (all 6 modules) + 8-week pilot

**Focus**: Complete AI-DLC implementation with metrics and dashboards. These teams have some AI tooling in place and basic standards, but need the full framework to measure, govern, and scale their AI-assisted development.

### Workshop Modules

| Module | Included | Reason |
|--------|----------|--------|
| 00 — Environment Setup | Yes | Verify and upgrade existing setup |
| 01 — CLAUDE.md & Standards | Yes | Align existing config to PRISM standards |
| 02 — Spec-Driven Development | Yes | Formalize and standardize spec workflows |
| 03 — CI/CD & Eval Gates | Yes | Instrument pipeline with eval gates |
| 04 — Metrics & Dashboards | Yes | Deploy the metrics pipeline + CloudWatch dashboards |
| 05 — Governance & Scaling | Yes | Establish governance model for scaling |

### Deliverables

- Full bootstrapper deployed (CLAUDE.md, hooks, metrics pipeline)
- Metrics pipeline live (EventBridge → Lambda → DynamoDB + CloudWatch)
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
| Week 2 | Async check-in | — | Review dashboard data, flag issues |
| Week 4 | Video call (checkpoint) | 1 hr | Midpoint review, adjust targets |
| Week 6 | Async check-in | — | Review progress toward 8-week goals |
| Week 8 | Video call (readout) | 1 hr | Final pilot readout, next steps |

### Next Step

8-week pilot with a Week 4 checkpoint. At pilot completion, re-assess and determine if the team is ready for Track C (L3.0+) or needs continued Track B coaching.

---

## Track C: Accelerated

**Target**: L3.0–L3.5, READY_FOR_PILOT verdict

**Duration**: 2-hour targeted workshop (Modules 03–05 only) + 8-week pilot

**Focus**: Fill specific gaps. These teams already have solid AI tooling, commit hygiene, and spec-driven workflows. Their gaps are typically in metrics/observability, governance, or platform reuse. The workshop focuses exclusively on closing those gaps.

### Workshop Modules

| Module | Included | Reason |
|--------|----------|--------|
| 00 — Environment Setup | No | Already have a working setup |
| 01 — CLAUDE.md & Standards | No | Already adopted standards |
| 02 — Spec-Driven Development | No | Already practicing spec-driven dev |
| 03 — CI/CD & Eval Gates | Yes | Close eval and quality gaps |
| 04 — Metrics & Dashboards | Yes | Deploy advanced observability |
| 05 — Governance & Scaling | Yes | Formalize governance for scale |

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
| Pre-workshop | Async | — | Share gap analysis, confirm focus areas |
| Workshop day | Video call | 2 hr | Targeted Modules 03–05 |
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
| 00–05 | Optional | Used only to address specific regression areas |
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
3. Suggested timeline for re-assessment (typically 8–12 weeks)
4. Option for a lightweight consulting engagement to close prerequisite gaps

---

## SA Email Templates

These templates are designed for SAs to customize and send at key milestones during the onboarding process. Replace all `[PLACEHOLDER]` fields with customer-specific details. The tone should feel personal and considered — not automated.

---

### 1. Post-Assessment Email

**When to send**: Within 24 hours of completing the assessment
**Purpose**: Share assessment results, communicate track assignment, and set expectations for next steps

**Subject**: Your PRISM D1 Velocity Assessment Results — [CUSTOMER_NAME]

Hi [CONTACT_FIRST_NAME],

Thank you for taking the time to walk through the PRISM D1 assessment with me [YESTERDAY/TODAY]. I enjoyed learning about how [CUSTOMER_NAME] is approaching AI-assisted development, and I think there is a clear path to accelerating your team's velocity.

Here is a summary of where things stand:

**Your PRISM D1 Level: [LEVEL]**

[ONE_SENTENCE_NARRATIVE — e.g., "Your team has made solid progress adopting AI tools but has room to grow in metrics and observability."]

| Area | Score |
|------|-------|
| Scanner (automated repo analysis) | [SCANNER_SCORE]/100 |
| Interview (structured conversation) | [INTERVIEW_SCORE]/100 |
| Org Readiness | [ORG_READINESS_SCORE]/20 |
| **Blended Score** | **[BLENDED_SCORE]** |

**Top Strengths**
- [STRENGTH_1]
- [STRENGTH_2]
- [STRENGTH_3]

**Key Gaps to Address**
- [GAP_1]: [ONE_LINE_DESCRIPTION]
- [GAP_2]: [ONE_LINE_DESCRIPTION]
- [GAP_3]: [ONE_LINE_DESCRIPTION]

**Your Track: [TRACK_LETTER] — [TRACK_NAME]**

Based on your assessment, I am recommending [TRACK_DESCRIPTION — e.g., "the Full Workshop track, which includes all six modules plus an 8-week pilot engagement"]. This is the right fit because [RATIONALE — e.g., "you have the foundations in place but need the full metrics and governance framework to reach L3.0+"].

I have attached the full assessment report with detailed scores, gap analysis, and your personalized 90-day roadmap.

**Next Steps**
1. Review the attached assessment report
2. Complete the pre-work items (see attached checklist) by [PRE_WORK_DEADLINE]
3. Confirm the workshop date: [PROPOSED_WORKSHOP_DATE]

I will send the workshop invitation separately once we lock in the date. In the meantime, do not hesitate to reach out with any questions.

Best,
[SA_NAME]
[SA_TITLE], PRISM D1 Velocity
[SA_EMAIL] | [SA_PHONE]

---

### 2. Workshop Invitation

**When to send**: 1 week before the workshop
**Purpose**: Confirm logistics, remind about prerequisites, and set expectations for workshop day

**Subject**: PRISM D1 Workshop — [DATE] — Prep Checklist

Hi [CONTACT_FIRST_NAME],

Looking forward to our workshop [NEXT_WEEK/ON_DATE]. Here is everything your team needs to be ready.

**Workshop Details**
- **Date**: [WORKSHOP_DATE]
- **Time**: [START_TIME] — [END_TIME] [TIMEZONE]
- **Format**: [IN_PERSON at LOCATION / Video call via LINK]
- **Modules**: [MODULE_LIST — e.g., "All 6 modules (00-05)" or "Modules 03-05 (targeted)"]
- **Attendees**: [EXPECTED_ATTENDEES — e.g., "Full engineering team (8 people)"]

**Pre-Work Checklist**

Please make sure every attendee has completed these items before the workshop:

- [ ] [PRE_WORK_ITEM_1]
- [ ] [PRE_WORK_ITEM_2]
- [ ] [PRE_WORK_ITEM_3]
- [ ] [PRE_WORK_ITEM_4]

[IF_TRACK_B_OR_HIGHER]:
- [ ] AWS account access confirmed (EventBridge, Timestream, CloudWatch)
- [ ] CI/CD pipeline identified for instrumentation
- [ ] GitHub webhook integration approved

**What to Expect**

The workshop is hands-on. We will be working in your actual codebase, not a demo environment. By the end of the session, your team will have:

[DELIVERABLES_LIST — customize per track, e.g.:
- CLAUDE.md deployed and configured
- Spec templates in your repo
- First AI-tagged commits flowing
- (Track B+) Metrics pipeline bootstrapped
- (Track B+) Dashboard skeleton deployed]

If anyone on the team has trouble with any of the pre-work items, send me a message and we will sort it out before the workshop.

See you [DAY_OF_WEEK],
[SA_NAME]

---

### 3. Post-Workshop Follow-Up

**When to send**: Morning after the workshop
**Purpose**: Reinforce momentum, provide resources, and set first-week expectations

**Subject**: Great session yesterday — here is your first-week playbook

Hi [CONTACT_FIRST_NAME],

Thanks to you and the team for a productive workshop yesterday. [PERSONALIZED_OBSERVATION — e.g., "I was impressed by how quickly your team picked up the spec-driven workflow, especially the feature spec that Priya built for the notification service."]

Here is what matters most this week:

**This Week's Priorities**

1. **[PRIORITY_1]** — [DETAILS — e.g., "Verify CLAUDE.md is deployed to all active repos. Run `verify-setup.sh` in each repo and send me a screenshot of the output."]
2. **[PRIORITY_2]** — [DETAILS — e.g., "Start using spec templates for any new feature work. Your team committed to building the search API and the user profile update via specs — hold that line."]
3. **[PRIORITY_3]** — [DETAILS — e.g., "Check that git hooks are firing and AI-origin trailers are appearing in commits. If anyone sees the hook failing, check the troubleshooting guide below."]

**Resources**

- Bootstrapper deployment guide: [LINK]
- Spec template repository: [LINK]
- Troubleshooting FAQ: [LINK]
- [TRACK_B+] Dashboard access: [LINK]
- [TRACK_B+] Metrics pipeline status: [LINK]

**Troubleshooting**

If the git hooks are not working:
1. Make sure the hooks are executable: `chmod +x .git/hooks/prepare-commit-msg`
2. Verify the CLAUDE.md file is in the repo root
3. Check that Node.js 18+ is installed

**Our Next Check-In**

I have us scheduled for [NEXT_TOUCHPOINT_TYPE] on [DATE]. [DETAILS — e.g., "I will review your commit trailer adoption rates before then, so we can focus our time on any gaps."]

Keep the momentum going. The first two weeks are when habits form.

Best,
[SA_NAME]

---

### 4. Week 4 Checkpoint

**When to send**: 2 days before the Week 4 checkpoint meeting
**Purpose**: Prepare the customer for the midpoint review and request data

**Subject**: Week 4 checkpoint prep — [CUSTOMER_NAME]

Hi [CONTACT_FIRST_NAME],

We are coming up on the midpoint of [YOUR_PILOT/YOUR_FOUNDATIONS_ENGAGEMENT], and I want to make sure we get the most out of our checkpoint call on [DATE].

**What I Have Seen So Far**

Based on the data flowing through your dashboards [OR "based on the metrics I have pulled"]:

- **AI-origin commit percentage**: [CURRENT_%] (target: [TARGET_%])
- **[METRIC_2]**: [CURRENT_VALUE] (target: [TARGET_VALUE])
- **[METRIC_3]**: [CURRENT_VALUE] (target: [TARGET_VALUE])

[NARRATIVE — e.g., "You are ahead of target on commit adoption, which is great. The area I want to dig into is the eval gate — it looks like it has been bypassed on several PRs, and we should figure out whether that is a process issue or a tooling issue."]

**For Our Call, Please Prepare**

1. Any blockers or frustrations the team has encountered
2. Feedback on the spec-driven workflow — is it helping or creating friction?
3. [TRACK_B+] List of PRs where the eval gate was bypassed (and why)
4. Questions or topics you want to cover

**Agenda (Draft)**

| Time | Topic |
|------|-------|
| 0:00-0:10 | Metrics review and trend analysis |
| 0:10-0:25 | Blocker triage and resolution |
| 0:25-0:40 | [GAP_AREA] deep-dive |
| 0:40-0:50 | Adjust targets for remaining [4 weeks / engagement] |
| 0:50-1:00 | Next steps and action items |

Talk soon,
[SA_NAME]

---

### 5. Pilot Completion

**When to send**: 1 week before the final readout meeting
**Purpose**: Prepare the customer for the final readout and signal next steps

**Subject**: Wrapping up your PRISM D1 pilot — final readout on [DATE]

Hi [CONTACT_FIRST_NAME],

We are approaching the end of your [8-WEEK PILOT / FOUNDATIONS ENGAGEMENT], and I want to celebrate the progress your team has made while also setting up the final readout clearly.

**Your Journey**

- **Starting point**: PRISM D1 Level [STARTING_LEVEL] ([STARTING_DATE])
- **Current level**: PRISM D1 Level [CURRENT_LEVEL] (as of [CURRENT_DATE])
- **Level change**: +[DELTA] levels

[NARRATIVE — e.g., "When we started, your team had no AI metrics and inconsistent tool usage. Today, you have a live dashboard tracking AI acceptance rates across 3 repos, eval gates in your primary CI pipeline, and 45% of commits carrying AI-origin metadata. That is a meaningful transformation in 8 weeks."]

**For the Final Readout, I Need**

To build the complete readout, please make sure the following are available by [DATE - 3 DAYS]:

1. Access to your latest dashboard data (confirm my viewer access is still active)
2. Any qualitative feedback from team members (a short Slack thread or doc is fine)
3. Executive sponsor availability for the readout call
4. [TRACK_C/D] Updated architecture diagrams if any infra changes were made

**Final Readout Agenda**

| Time | Topic |
|------|-------|
| 0:00-0:15 | Executive summary and level progression |
| 0:15-0:30 | Detailed metrics walkthrough |
| 0:30-0:40 | Gap analysis: what improved, what remains |
| 0:40-0:50 | Recommended next track / engagement |
| 0:50-1:00 | Q&A and commitment to next steps |

**What Comes Next**

Based on your current trajectory, I am likely to recommend [NEXT_RECOMMENDATION — e.g., "moving to Track C (Accelerated) to close your remaining governance and observability gaps" or "scheduling a full cross-pillar PRISM assessment"]. We will finalize this during the readout.

It has been a pleasure working with your team on this. Looking forward to presenting the results.

Best,
[SA_NAME]
[SA_TITLE], PRISM D1 Velocity
[SA_EMAIL]

---

## Pre-Work Checklists

### Track A Pre-Work

**Complete all items before the workshop date.**
Estimated total time: 2-3 hours spread across 2 weeks.

#### For Every Developer on the Team

##### 1. Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

**Configure for AWS Bedrock**:

```bash
claude config set provider bedrock
claude config set bedrock.region us-west-2
claude "Hello, confirm you are running on Bedrock"
```

Troubleshooting:
- If you get an AWS credentials error, ensure your `~/.aws/credentials` file is configured or your IAM role has `bedrock:InvokeModel` permission.
- If Claude Code is not available via npm, check with your SA for the internal distribution method.

##### 2. Install Kiro IDE

1. Download Kiro from [https://kiro.dev](https://kiro.dev)
2. Install and launch
3. Sign in with your AWS Builder ID
4. Verify the spec panel is visible in the sidebar

##### 3. Run the Setup Verification Script

```bash
curl -sL https://prism-d1-assets.s3.amazonaws.com/verify-setup.sh | bash
```

The script checks: Claude Code installation and Bedrock connectivity, Kiro IDE installation, Git version (2.30+), Node.js version (18+), AWS CLI configured.

**Expected output**: All items should show a green checkmark. Screenshot the output and share with your team lead.

##### 4. Read: "Why Spec-Driven Development"

Before the workshop, read the Module 02 primer document. This is a 15-minute read that explains:
- Why unstructured prompting produces inconsistent results
- How specs create a contract between the developer and the AI
- The three spec types (feature, bug fix, refactor) and when to use each

Your SA will share the link. If you have not received it, ask your team lead.

#### For the Team Lead

##### 5. Identify 2 Features to Build During the Workshop

The workshop includes a hands-on exercise where the team builds real features using the spec-driven workflow. Choose 2 features that:

- Are scoped to 1-2 hours of work each
- Are on the team's actual backlog (not invented for the workshop)
- Are well-understood by the team (not exploratory R&D)
- Involve at least 2-3 files of changes

Good examples:
- Add a new API endpoint with validation and tests
- Implement a UI component with state management
- Add a new background job with error handling

Bad examples:
- "Rewrite the auth system" (too large)
- "Fix that CSS bug" (too small)
- "Explore a new ML model" (too uncertain)

**Deadline**: Share the 2 features with your SA at least 3 days before the workshop.

#### Checklist Summary

| Item | Owner | Deadline | Done |
|------|-------|----------|------|
| Install Claude Code + Bedrock config | Each developer | Before workshop | [ ] |
| Install Kiro IDE | Each developer | Before workshop | [ ] |
| Run verify-setup.sh (green output) | Each developer | Before workshop | [ ] |
| Read "Why Spec-Driven Development" | Each developer | 1 week before workshop | [ ] |
| Identify 2 workshop features | Team lead | 3 days before workshop | [ ] |

---

### Track B Pre-Work

**Complete all items before the workshop date.**
Estimated total time: 3-4 hours spread across 1 week.

Track B includes everything from Track A plus additional infrastructure and access requirements for the full metrics pipeline and dashboard deployment.

#### For Every Developer on the Team

##### 1. Install Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

**Configure for AWS Bedrock**:

```bash
claude config set provider bedrock
claude config set bedrock.region us-west-2
claude "Hello, confirm you are running on Bedrock"
```

##### 2. Install Kiro IDE

1. Download Kiro from [https://kiro.dev](https://kiro.dev)
2. Install, launch, and sign in with your AWS Builder ID
3. Verify the spec panel is visible in the sidebar

##### 3. Run the Setup Verification Script

```bash
curl -sL https://prism-d1-assets.s3.amazonaws.com/verify-setup.sh | bash
```

All items should show green checkmarks. Screenshot and share with your team lead.

##### 4. Read: "Why Spec-Driven Development"

Read the Module 02 primer document (15-minute read). Your SA will share the link.

#### For the Team Lead

##### 5. Identify 2 Features to Build During the Workshop

Choose 2 features from your actual backlog that are scoped to 1-2 hours each, well-understood by the team, and involve 2-3 files of changes.

Share with your SA at least 3 days before the workshop.

##### 6. Identify the Primary CI/CD Pipeline to Instrument

During the workshop, we will add an eval gate to your CI/CD pipeline. Before the workshop:

1. Identify which pipeline to instrument (your main PR / merge pipeline)
2. Confirm you have write access to the pipeline configuration
3. Note the pipeline platform (GitHub Actions, GitLab CI, Jenkins, CircleCI, etc.)
4. Ensure a test PR can be created and run through the pipeline during the workshop

#### For the Platform / DevOps Lead

##### 7. Ensure AWS Account Access

The metrics pipeline requires the following AWS services. Confirm your account has access and appropriate IAM permissions:

| Service | Required Permissions | Purpose |
|---------|---------------------|---------|
| Amazon EventBridge | `events:PutEvents`, `events:CreateRule`, `events:PutTargets` | Ingest metrics events |
| Amazon Timestream | `timestream:WriteRecords`, `timestream:CreateTable`, `timestream:DescribeEndpoints` | Store time-series metrics |
| Amazon CloudWatch | `cloudwatch:PutMetricData`, `cloudwatch:GetMetricData`, `logs:CreateLogGroup` | Monitoring and alerting |

**How to verify**:

```bash
aws events list-rules --region us-west-2
aws timestream-write describe-endpoints --region us-west-2
aws cloudwatch list-metrics --region us-west-2 --max-items 1
```

If any of these fail, work with your AWS administrator to grant access before the workshop.

##### 8. Approve GitHub Webhook Integration

The metrics pipeline uses a GitHub webhook to capture commit and PR events. Before the workshop:

1. Confirm you have admin access to the target GitHub organization or repository
2. Approve the creation of a webhook that will send events to an EventBridge API destination
3. Note any network restrictions (VPC, IP allowlists) that might block webhook delivery

If your organization uses GitHub Enterprise Server (not github.com), let your SA know — the webhook configuration differs.

#### For the Engineering Manager

##### 9. Designate an Executive Sponsor

The PRISM D1 pilot includes a weekly executive readout dashboard. Identify the executive sponsor who will:

- Review the weekly dashboard (5 minutes per week)
- Attend the Week 4 checkpoint meeting (1 hour)
- Attend the Week 8 pilot readout (1 hour)
- Champion the initiative if it needs organizational support

Good candidates: VP Engineering, CTO, Director of Engineering, Head of Platform.

Share the sponsor's name and email with your SA so they can be included in readout communications.

#### Checklist Summary

| Item | Owner | Deadline | Done |
|------|-------|----------|------|
| Install Claude Code + Bedrock config | Each developer | Before workshop | [ ] |
| Install Kiro IDE | Each developer | Before workshop | [ ] |
| Run verify-setup.sh (green output) | Each developer | Before workshop | [ ] |
| Read "Why Spec-Driven Development" | Each developer | 1 week before | [ ] |
| Identify 2 workshop features | Team lead | 3 days before | [ ] |
| Identify CI/CD pipeline to instrument | Team lead | 1 week before | [ ] |
| Verify EventBridge access | Platform/DevOps lead | 1 week before | [ ] |
| Verify Timestream access | Platform/DevOps lead | 1 week before | [ ] |
| Verify CloudWatch access | Platform/DevOps lead | 1 week before | [ ] |
| Approve GitHub webhook integration | Engineering manager | 1 week before | [ ] |
| Designate executive sponsor | Engineering manager | 1 week before | [ ] |

---

### Track C Pre-Work

**Complete all items before the workshop date.**
Estimated total time: 1-2 hours.

Track C is a targeted engagement for teams that already have strong foundations (L3.0-L3.5). The pre-work focuses on preparing for gap remediation, not foundational setup.

#### For the Team Lead

##### 1. Review the Assessment Report and Gap Analysis

Your assessment report identifies the specific gaps holding your team back from L4.0. Before the workshop:

1. Read the full assessment report, especially the Gap Analysis section
2. For each of the top-3 gaps, discuss with your team:
   - Do you agree this is a real gap? (If not, bring the counterargument to the workshop)
   - What has prevented you from closing this gap already?
   - What resources would you need to close it?
3. Prioritize: if you could only fix one gap, which would have the biggest impact?

Share your gap prioritization with your SA at least 3 days before the workshop.

##### 2. Schedule Executive Readout for Week 2

The accelerated track moves fast. Schedule a 30-minute executive readout for Week 2 of the pilot:

- **Attendees**: Executive sponsor, team lead, SA
- **Purpose**: Review gap remediation progress, confirm governance model, adjust if needed
- **Format**: Video call with dashboard screen-share

Send the calendar invite before the workshop so it is locked in.

#### For the Platform / DevOps Lead

##### 3. Prepare CI/CD Pipeline Access for Eval Gate Integration

If your top gaps include CI/CD, Eval & Quality, or Testing Maturity:

1. Ensure the SA has read access to your pipeline configuration (GitHub Actions YAML, Jenkinsfile, etc.)
2. Prepare a test branch where we can add an eval gate step during the workshop
3. Confirm the pipeline can be triggered manually for testing

##### 4. Identify the Production Endpoint for Bedrock Evaluation

If your gaps include Eval & Quality or AI Observability:

1. Identify the Bedrock model endpoint your team uses in production
2. Confirm the endpoint supports evaluation API calls
3. Note any rate limits or access restrictions that might affect eval runs
4. Prepare a sample prompt/response pair we can use for testing

```bash
aws bedrock list-evaluation-jobs --region us-west-2
```

#### For the Engineering Manager

##### 5. Confirm Governance Stakeholders

If governance is one of your top gaps:

1. Identify who should own the AI governance policy (usually a senior engineer or engineering manager)
2. Prepare a list of current AI usage policies (even informal ones)
3. Identify any compliance or security requirements that affect AI tool usage
4. Note any concerns from legal or security teams about AI-generated code

#### Checklist Summary

| Item | Owner | Deadline | Done |
|------|-------|----------|------|
| Review assessment report and gap analysis | Team lead | 3 days before | [ ] |
| Share gap prioritization with SA | Team lead | 3 days before | [ ] |
| Schedule Week 2 executive readout | Team lead | Before workshop | [ ] |
| Prepare CI/CD pipeline access | Platform/DevOps lead | Before workshop | [ ] |
| Identify Bedrock eval endpoint | Platform/DevOps lead | Before workshop | [ ] |
| Confirm governance stakeholders | Engineering manager | Before workshop | [ ] |
