# Track B: Full Workshop -- Pre-Work Checklist

**Complete all items before the workshop date.**
Estimated total time: 3-4 hours spread across 1 week.

Track B includes everything from Track A plus additional infrastructure and access requirements for the full metrics pipeline and dashboard deployment.

---

## For Every Developer on the Team

### 1. Install Claude Code

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

### 2. Install Kiro IDE

1. Download Kiro from [https://kiro.dev](https://kiro.dev)
2. Install, launch, and sign in with your AWS Builder ID
3. Verify the spec panel is visible in the sidebar

### 3. Run the Setup Verification Script

```bash
curl -sL https://prism-d1-assets.s3.amazonaws.com/verify-setup.sh | bash
```

All items should show green checkmarks. Screenshot and share with your team lead.

### 4. Read: "Why Spec-Driven Development"

Read the Module 02 primer document (15-minute read). Your SA will share the link.

---

## For the Team Lead

### 5. Identify 2 Features to Build During the Workshop

Choose 2 features from your actual backlog that are:
- Scoped to 1-2 hours each
- Well-understood by the team
- Involve 2-3 files of changes

Share with your SA at least 3 days before the workshop.

### 6. Identify the Primary CI/CD Pipeline to Instrument

During the workshop, we will add an eval gate to your CI/CD pipeline. Before the workshop:

1. Identify which pipeline to instrument (your main PR / merge pipeline)
2. Confirm you have write access to the pipeline configuration
3. Note the pipeline platform (GitHub Actions, GitLab CI, Jenkins, CircleCI, etc.)
4. Ensure a test PR can be created and run through the pipeline during the workshop

---

## For the Platform / DevOps Lead

### 7. Ensure AWS Account Access

The metrics pipeline requires the following AWS services. Confirm your account has access and appropriate IAM permissions:

| Service | Required Permissions | Purpose |
|---------|---------------------|---------|
| Amazon EventBridge | `events:PutEvents`, `events:CreateRule`, `events:PutTargets` | Ingest metrics events |
| Amazon Timestream | `timestream:WriteRecords`, `timestream:CreateTable`, `timestream:DescribeEndpoints` | Store time-series metrics |
| Amazon CloudWatch | `cloudwatch:PutMetricData`, `cloudwatch:GetMetricData`, `logs:CreateLogGroup` | Monitoring and alerting |
| Amazon QuickSight | `quicksight:CreateDashboard`, `quicksight:CreateDataSet` | Dashboard visualization |

**How to verify**:

```bash
# Check EventBridge access
aws events list-rules --region us-west-2

# Check Timestream access
aws timestream-write describe-endpoints --region us-west-2

# Check CloudWatch access
aws cloudwatch list-metrics --region us-west-2 --max-items 1
```

If any of these fail, work with your AWS administrator to grant access before the workshop.

### 8. Approve GitHub Webhook Integration

The metrics pipeline uses a GitHub webhook to capture commit and PR events. Before the workshop:

1. Confirm you have admin access to the target GitHub organization or repository
2. Approve the creation of a webhook that will send events to an EventBridge API destination
3. Note any network restrictions (VPC, IP allowlists) that might block webhook delivery

If your organization uses GitHub Enterprise Server (not github.com), let your SA know -- the webhook configuration differs.

---

## For the Engineering Manager

### 9. Designate an Executive Sponsor

The PRISM D1 pilot includes a weekly executive readout dashboard. Identify the executive sponsor who will:

- Review the weekly dashboard (5 minutes per week)
- Attend the Week 4 checkpoint meeting (1 hour)
- Attend the Week 8 pilot readout (1 hour)
- Champion the initiative if it needs organizational support

Good candidates: VP Engineering, CTO, Director of Engineering, Head of Platform.

Share the sponsor's name and email with your SA so they can be included in readout communications.

---

## Checklist Summary

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
| Verify QuickSight access | Platform/DevOps lead | 1 week before | [ ] |
| Approve GitHub webhook integration | Engineering manager | 1 week before | [ ] |
| Designate executive sponsor | Engineering manager | 1 week before | [ ] |
