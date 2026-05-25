# Pre-Interview Checklist

Complete these steps before the SA interview. Allow 30-60 minutes of preparation time.

## 1. Run the Automated Scanner

- [ ] Obtain read access to at least one primary application repository
- [ ] Run the PRISM D1 scanner and review the output report
- [ ] Note the scanner score and any flagged gaps -- these inform follow-up probes
- [ ] If scanner could not be run (access issues, monorepo complexity), note this and plan to spend extra time on CI/CD and workflow questions

## 2. Review GitHub / Source Control Activity

- [ ] Review the last 30 days of merged PRs in their primary repo
- [ ] Note PR size distribution (small/focused vs. large/monolithic)
- [ ] Look for AI-related commit trailers or metadata (e.g., `Co-authored-by: github-copilot`, `ai-assisted: true`)
- [ ] Check PR review turnaround times
- [ ] Look for spec documents, design docs, or RFC links in PR descriptions

## 3. Check AWS Account Activity (if accessible)

- [ ] Check for Amazon Bedrock usage (API calls, model invocations)
- [ ] Check for Amazon Q Developer license count and activity
- [ ] Note any CodeWhisperer, CodeGuru, or CodePipeline usage
- [ ] Review their AWS spend trajectory (relevant for org readiness scoring)

## 4. Company Context

- [ ] Confirm funding stage (Series A, B, C, D)
- [ ] Confirm engineering team size (target: 20-200 engineers)
- [ ] Identify the company's primary tech stack and languages
- [ ] Review their product briefly (what they build, who their customers are)
- [ ] Check for any public blog posts or talks about their AI/engineering practices

## 5. Logistics

- [ ] Confirm interview participants and their roles
- [ ] Send calendar invite with clear agenda (do not share scoring criteria)
- [ ] Print or prepare digital copies of the [Scoring Sheet](scoring-sheet.md)
- [ ] Ensure screen-sharing capability (you will ask them to show PRs and dashboards)
- [ ] Prepare a quiet room or reliable video connection

## 6. Prepare Follow-Up Probes from Scanner Results

If the scanner has been run, prepare specific follow-up questions based on its findings:

| Scanner Finding | Interview Probe |
|----------------|-----------------|
| Low AI commit attribution | "I noticed your commits don't have AI attribution trailers. How do you track which code is AI-assisted?" |
| No eval gates in CI | "Your CI pipeline doesn't appear to have AI-specific validation steps. Is that intentional?" |
| High PR size variance | "Some of your PRs are quite large. How do you handle review for big AI-generated PRs?" |
| No spec files detected | "I didn't see structured spec documents in the repo. Where do design decisions live?" |
| Low test-to-code ratio | "Your test coverage seems light relative to code volume. How does AI factor into your testing strategy?" |

These probes turn scanner data into conversation starters. They signal to the customer that you have done your homework and ground the discussion in their actual codebase.
