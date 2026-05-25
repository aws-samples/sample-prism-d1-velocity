# Track C: Accelerated -- Pre-Work Checklist

**Complete all items before the workshop date.**
Estimated total time: 1-2 hours.

Track C is a targeted engagement for teams that already have strong foundations (L3.0-L3.5). The pre-work focuses on preparing for gap remediation, not foundational setup.

---

## For the Team Lead

### 1. Review the Assessment Report and Gap Analysis

Your assessment report identifies the specific gaps holding your team back from L4.0. Before the workshop:

1. Read the full assessment report, especially the Gap Analysis section
2. For each of the top-3 gaps, discuss with your team:
   - Do you agree this is a real gap? (If not, bring the counterargument to the workshop)
   - What has prevented you from closing this gap already?
   - What resources would you need to close it?
3. Prioritize: if you could only fix one gap, which would have the biggest impact?

Share your gap prioritization with your SA at least 3 days before the workshop.

### 2. Schedule Executive Readout for Week 2

The accelerated track moves fast. Schedule a 30-minute executive readout for Week 2 of the pilot:

- **Attendees**: Executive sponsor, team lead, SA
- **Purpose**: Review gap remediation progress, confirm governance model, adjust if needed
- **Format**: Video call with dashboard screen-share

Send the calendar invite before the workshop so it is locked in.

---

## For the Platform / DevOps Lead

### 3. Prepare CI/CD Pipeline Access for Eval Gate Integration

If your top gaps include CI/CD, Eval & Quality, or Testing Maturity:

1. Ensure the SA has read access to your pipeline configuration (GitHub Actions YAML, Jenkinsfile, etc.)
2. Prepare a test branch where we can add an eval gate step during the workshop
3. Confirm the pipeline can be triggered manually for testing

### 4. Identify the Production Endpoint for Bedrock Evaluation

If your gaps include Eval & Quality or AI Observability:

1. Identify the Bedrock model endpoint your team uses in production
2. Confirm the endpoint supports evaluation API calls
3. Note any rate limits or access restrictions that might affect eval runs
4. Prepare a sample prompt/response pair we can use for testing

```bash
# Verify Bedrock eval access
aws bedrock list-evaluation-jobs --region us-west-2
```

---

## For the Engineering Manager

### 5. Confirm Governance Stakeholders

If governance is one of your top gaps:

1. Identify who should own the AI governance policy (usually a senior engineer or engineering manager)
2. Prepare a list of current AI usage policies (even informal ones)
3. Identify any compliance or security requirements that affect AI tool usage
4. Note any concerns from legal or security teams about AI-generated code

---

## Checklist Summary

| Item | Owner | Deadline | Done |
|------|-------|----------|------|
| Review assessment report and gap analysis | Team lead | 3 days before | [ ] |
| Share gap prioritization with SA | Team lead | 3 days before | [ ] |
| Schedule Week 2 executive readout | Team lead | Before workshop | [ ] |
| Prepare CI/CD pipeline access | Platform/DevOps lead | Before workshop | [ ] |
| Identify Bedrock eval endpoint | Platform/DevOps lead | Before workshop | [ ] |
| Confirm governance stakeholders | Engineering manager | Before workshop | [ ] |
