# PRISM D1 Velocity -- SA Email Templates

These templates are designed for SAs to customize and send at key milestones during the onboarding process. Replace all `[PLACEHOLDER]` fields with customer-specific details. The tone should feel personal and considered -- not automated.

---

## 1. Post-Assessment Email

**When to send**: Within 24 hours of completing the assessment
**Purpose**: Share assessment results, communicate track assignment, and set expectations for next steps

---

**Subject**: Your PRISM D1 Velocity Assessment Results -- [CUSTOMER_NAME]

Hi [CONTACT_FIRST_NAME],

Thank you for taking the time to walk through the PRISM D1 assessment with me [YESTERDAY/TODAY]. I enjoyed learning about how [CUSTOMER_NAME] is approaching AI-assisted development, and I think there is a clear path to accelerating your team's velocity.

Here is a summary of where things stand:

**Your PRISM D1 Level: [LEVEL]**

[ONE_SENTENCE_NARRATIVE -- e.g., "Your team has made solid progress adopting AI tools but has room to grow in metrics and observability."]

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

**Your Track: [TRACK_LETTER] -- [TRACK_NAME]**

Based on your assessment, I am recommending [TRACK_DESCRIPTION -- e.g., "the Full Workshop track, which includes all six modules plus an 8-week pilot engagement"]. This is the right fit because [RATIONALE -- e.g., "you have the foundations in place but need the full metrics and governance framework to reach L3.0+"].

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

## 2. Workshop Invitation

**When to send**: 1 week before the workshop
**Purpose**: Confirm logistics, remind about prerequisites, and set expectations for workshop day

---

**Subject**: PRISM D1 Workshop -- [DATE] -- Prep Checklist

Hi [CONTACT_FIRST_NAME],

Looking forward to our workshop [NEXT_WEEK/ON_DATE]. Here is everything your team needs to be ready.

**Workshop Details**
- **Date**: [WORKSHOP_DATE]
- **Time**: [START_TIME] -- [END_TIME] [TIMEZONE]
- **Format**: [IN_PERSON at LOCATION / Video call via LINK]
- **Modules**: [MODULE_LIST -- e.g., "All 6 modules (00-05)" or "Modules 03-05 (targeted)"]
- **Attendees**: [EXPECTED_ATTENDEES -- e.g., "Full engineering team (8 people)"]

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

[DELIVERABLES_LIST -- customize per track, e.g.:
- CLAUDE.md deployed and configured
- Spec templates in your repo
- First AI-tagged commits flowing
- (Track B+) Metrics pipeline bootstrapped
- (Track B+) Dashboard skeleton deployed]

If anyone on the team has trouble with any of the pre-work items, send me a message and we will sort it out before the workshop.

See you [DAY_OF_WEEK],
[SA_NAME]

---

## 3. Post-Workshop Follow-Up

**When to send**: Morning after the workshop
**Purpose**: Reinforce momentum, provide resources, and set first-week expectations

---

**Subject**: Great session yesterday -- here is your first-week playbook

Hi [CONTACT_FIRST_NAME],

Thanks to you and the team for a productive workshop yesterday. [PERSONALIZED_OBSERVATION -- e.g., "I was impressed by how quickly your team picked up the spec-driven workflow, especially the feature spec that Priya built for the notification service."]

Here is what matters most this week:

**This Week's Priorities**

1. **[PRIORITY_1]** -- [DETAILS -- e.g., "Verify CLAUDE.md is deployed to all active repos. Run `verify-setup.sh` in each repo and send me a screenshot of the output."]
2. **[PRIORITY_2]** -- [DETAILS -- e.g., "Start using spec templates for any new feature work. Your team committed to building the search API and the user profile update via specs -- hold that line."]
3. **[PRIORITY_3]** -- [DETAILS -- e.g., "Check that git hooks are firing and AI-origin trailers are appearing in commits. If anyone sees the hook failing, check the troubleshooting guide below."]

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

I have us scheduled for [NEXT_TOUCHPOINT_TYPE] on [DATE]. [DETAILS -- e.g., "I will review your commit trailer adoption rates before then, so we can focus our time on any gaps."]

Keep the momentum going. The first two weeks are when habits form.

Best,
[SA_NAME]

---

## 4. Week 4 Checkpoint

**When to send**: 2 days before the Week 4 checkpoint meeting
**Purpose**: Prepare the customer for the midpoint review and request data

---

**Subject**: Week 4 checkpoint prep -- [CUSTOMER_NAME]

Hi [CONTACT_FIRST_NAME],

We are coming up on the midpoint of [YOUR_PILOT/YOUR_FOUNDATIONS_ENGAGEMENT], and I want to make sure we get the most out of our checkpoint call on [DATE].

**What I Have Seen So Far**

Based on the data flowing through your dashboards [OR "based on the metrics I have pulled"]:

- **AI-origin commit percentage**: [CURRENT_%] (target: [TARGET_%])
- **[METRIC_2]**: [CURRENT_VALUE] (target: [TARGET_VALUE])
- **[METRIC_3]**: [CURRENT_VALUE] (target: [TARGET_VALUE])

[NARRATIVE -- e.g., "You are ahead of target on commit adoption, which is great. The area I want to dig into is the eval gate -- it looks like it has been bypassed on several PRs, and we should figure out whether that is a process issue or a tooling issue."]

**For Our Call, Please Prepare**

1. Any blockers or frustrations the team has encountered
2. Feedback on the spec-driven workflow -- is it helping or creating friction?
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

## 5. Pilot Completion

**When to send**: 1 week before the final readout meeting
**Purpose**: Prepare the customer for the final readout and signal next steps

---

**Subject**: Wrapping up your PRISM D1 pilot -- final readout on [DATE]

Hi [CONTACT_FIRST_NAME],

We are approaching the end of your [8-WEEK PILOT / FOUNDATIONS ENGAGEMENT], and I want to celebrate the progress your team has made while also setting up the final readout clearly.

**Your Journey**

- **Starting point**: PRISM D1 Level [STARTING_LEVEL] ([STARTING_DATE])
- **Current level**: PRISM D1 Level [CURRENT_LEVEL] (as of [CURRENT_DATE])
- **Level change**: +[DELTA] levels

[NARRATIVE -- e.g., "When we started, your team had no AI metrics and inconsistent tool usage. Today, you have a live dashboard tracking AI acceptance rates across 3 repos, eval gates in your primary CI pipeline, and 45% of commits carrying AI-origin metadata. That is a meaningful transformation in 8 weeks."]

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

Based on your current trajectory, I am likely to recommend [NEXT_RECOMMENDATION -- e.g., "moving to Track C (Accelerated) to close your remaining governance and observability gaps" or "scheduling a full cross-pillar PRISM assessment"]. We will finalize this during the readout.

It has been a pleasure working with your team on this. Looking forward to presenting the results.

Best,
[SA_NAME]
[SA_TITLE], PRISM D1 Velocity
[SA_EMAIL]
