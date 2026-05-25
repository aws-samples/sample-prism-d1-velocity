# PRISM D1 Velocity -- SA Interview Guide

## Purpose

This guide provides AWS Solutions Architects with a structured interview framework for assessing AI-native software development lifecycle maturity at startups. The interview score contributes 40% of the final PRISM D1 Velocity assessment.

## How to Use This Guide

1. **Before the interview**: Complete the [Pre-Interview Checklist](pre-interview-checklist.md)
2. **During the interview**: Follow the [Interview Guide](interview-guide.md) section by section, scoring each question 0-5 on the [Scoring Sheet](scoring-sheet.md)
3. **After the interview**: Enter scores into the scoring model to compute the blended PRISM D1 level

## Who to Interview

Conduct the interview with the following participants present (or in separate sessions if scheduling requires):

| Role | Required | Why |
|------|----------|-----|
| Engineering Lead / VP Eng / CTO | Required | Strategic decisions, metrics visibility, governance |
| 2 Individual Contributors (senior) | Required | Ground truth on daily workflows, tool usage, friction |
| Platform / DevEx Lead | If exists | CI/CD details, tooling infrastructure, measurement |

If the company has fewer than 30 engineers, the eng lead + 1 IC may suffice. For 100+ engineer orgs, consider adding a second eng lead from a different team to check for consistency.

## Interview Duration

- **Total**: 60-90 minutes
- **Section timing** (suggested, not rigid):
  - Section 1 -- AI Tooling Landscape: 10 min
  - Section 2 -- Development Workflow & Specs: 15 min
  - Section 3 -- CI/CD & Quality: 15 min
  - Section 4 -- Metrics & Visibility: 10 min
  - Section 5 -- Governance & Security: 10 min
  - Section 6 -- Organization & Culture: 10 min
  - Buffer / follow-ups: 10 min

## Scoring Approach

- Score each question 0-5 in real time using the scoring sheet
- Use the "listening for" guidance to calibrate -- these are the signals that differentiate scores
- When in doubt between two scores, pick the lower one; the assessment should be conservative
- It is normal for startups to score unevenly across sections -- this is valuable signal
- The 20 questions yield a raw total out of 100 (20 questions x 5 points max)

## Important Notes

- This is a conversation, not an interrogation. Frame questions as genuine curiosity about their engineering practices.
- The "Show me" questions (e.g., Q2.4) are critical -- ask them to share their screen or pull up actual PRs/dashboards. Demonstrated evidence scores higher than verbal claims.
- If the automated scanner has already been run, use its findings to inform your follow-up probes. Discrepancies between scanner results and interview answers are important signal.
- Do not share scoring criteria or level definitions with the customer during the interview.
