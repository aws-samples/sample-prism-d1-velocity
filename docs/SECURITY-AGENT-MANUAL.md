# AWS Security Agent: manual steps

> **Legacy path.** Most teams do not need this page. [`prism-cli enable security`](../USER_GUIDE.md#security-agent-setup-enable-security)
> sets up Security Agent, and [`prism-cli security code-review`, `threat-model` and `pentest`](../USER_GUIDE.md#security-scans-from-your-machine)
> run its jobs. `security pentest` deploys a private copy of your app to test, so it needs no domain
> verification. This page keeps the console and raw AWS CLI steps for what no prism-cli command
> covers: Security Agent's own GitHub integration (OAuth), and penetration-testing an app that is
> already deployed at a public URL.

These commands need AWS CLI v2.36 or later. They read the agent space id that `enable security`
stores in SSM:

```bash
AGENT_SPACE_ID=$(aws ssm get-parameter --name /prism/continuum/agent-space-id \
  --query Parameter.Value --output text --region us-west-2)
```

## Setup Script (forward findings to the PRISM API)

`bootstrapper/security-agent/setup.sh` forwards findings to the PRISM API independently of the eval gate. No prism-cli command uses it:

```bash
/path/to/bootstrapper/security-agent/setup.sh \
  --api-url https://your-api.execute-api.us-west-2.amazonaws.com/v1 \
  --api-key your-prism-api-key \
  --team-id your-team-name
```

Creates `.prism/security-agent.json` with scan trigger configuration and remediation SLAs.

## Domain Registration for Pen Testing

> **Skip this step** unless you pen-test an app that is already deployed at a public URL.
> `prism-cli security pentest` needs no domain.

### Option A: DNS TXT Record (Recommended)

```bash
aws securityagent create-target-domain \
  --target-domain-name api.yourcompany.com \
  --verification-method DNS_TXT \
  --region us-west-2
```

Add the DNS TXT record at your DNS provider:

```
Type:   TXT
Name:   _securityagent.api.yourcompany.com
Value:  <paste the verification token from the command output>
TTL:    300
```

Verify:

```bash
dig TXT _securityagent.api.yourcompany.com

aws securityagent verify-target-domain \
  --target-domain-name api.yourcompany.com \
  --region us-west-2

aws securityagent batch-get-target-domains \
  --target-domain-names api.yourcompany.com \
  --region us-west-2 \
  --query 'targetDomains[0].verificationStatus'
```

**Expected:** `VERIFIED`

### Option B: HTTP Route

```bash
aws securityagent create-target-domain \
  --target-domain-name api.yourcompany.com \
  --verification-method HTTP_ROUTE \
  --region us-west-2
```

Host a verification endpoint at:
`https://api.yourcompany.com/.well-known/security-agent-verification`

> **⚠️ Critical:** The endpoint must return JSON in this exact format:
> ```json
> {"tokens": ["<your-verification-token>"]}
> ```
> Not `{"token": "..."}` or plain text — it must be `{"tokens": [...]}` with an array.

### Associate Domain with Agent Space

**⚠️ Required:** A verified domain is NOT automatically usable for pen tests. You must explicitly associate it:

```bash
DOMAIN_ID=$(aws securityagent batch-get-target-domains \
  --target-domain-names api.yourcompany.com \
  --region us-west-2 \
  --query 'targetDomains[0].targetDomainId' --output text)

aws securityagent update-agent-space \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --target-domain-ids "${DOMAIN_ID}" \
  --region us-west-2
```

## Connect GitHub for Code Review

> **⚠️ Important:** GitHub integration requires an OAuth authorization code from AWS's pre-registered GitHub OAuth App. You **cannot** bypass this with `gh` CLI tokens or PATs. The initial setup must be done via the web console.

1. Open [Security Agent console](https://console.aws.amazon.com/securityagent)
2. Click your agent space (`prism-d1-security`)
3. Go to **Integrations** → **Add Integration**
4. Select **GitHub**
5. Complete the OAuth authorization flow
6. Select the repositories to monitor (must be **private** repos)
7. Save

**After initial OAuth setup**, manage repos via CLI:

```bash
aws securityagent list-integrations \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --region us-west-2 --output table

aws securityagent update-integrated-resources \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --integration-id <integration-id> \
  --add-resources '["your-org/new-repo"]' \
  --region us-west-2
```

After this, Security Agent automatically reviews every PR opened against the connected repositories. It posts as `aws-security-agent[bot]` with inline review comments on specific lines.

> **Note:** Code reviews only work on **private repositories**. Public repos will not show the code review option.

## Create a Pen Test Configuration

```bash
SERVICE_ROLE_ARN=$(aws iam list-roles \
  --query "Roles[?contains(RoleName, 'security-agent')].Arn" \
  --output text | head -1)

# ⚠️ Title only allows: letters, numbers, hyphens, underscores. No spaces. Max 100 chars.
PENTEST_RESULT=$(aws securityagent create-pentest \
  --title "PRISM-D1-Application-Pen-Test" \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --service-role "${SERVICE_ROLE_ARN}" \
  --assets '{
    "endpoints": [
      {"url": "https://api.yourcompany.com"}
    ]
  }' \
  --code-remediation-strategy DISABLED \
  --region us-west-2 \
  --output json)

PENTEST_ID=$(echo "${PENTEST_RESULT}" | jq -r '.pentestId')
echo "Pen Test ID: ${PENTEST_ID}"
```

## Verify End-to-End

**Test Code Review:**

```bash
git checkout -b test-security-review
echo "// test change" >> src/index.ts
git add src/index.ts
git commit -m "Test code for security review"
git push -u origin test-security-review
# Open a PR via GitHub UI
```

What happens:
1. Security Agent GitHub App automatically reviews the PR
2. Posts inline review comments on specific lines (as `aws-security-agent[bot]`)
3. Eval gate workflow collects findings and blocks on critical/high findings
4. Findings forwarded to EventBridge carrying Continuum's `riskLevel` as severity, plus the CWE id as metadata

**Test Pen Test:**

> ⚠️ Pen tests take several hours to complete. Not suitable for blocking CI.

```bash
# Warm the verification Lambda
for i in {1..3}; do
  curl -s https://api.yourcompany.com/.well-known/security-agent-verification > /dev/null
  sleep 2
done

# Start
aws securityagent start-pentest-job \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" \
  --region us-west-2

# Monitor
aws securityagent list-pentest-jobs-for-pentest \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" \
  --region us-west-2 \
  --query 'pentestJobSummaries[0].{JobId:pentestJobId,Status:status}' \
  --output table
```

## Quick Reference: All Continuum Commands

```bash
# Deploy Security Agent (plan first with --dry-run; check later with --status)
prism-cli enable security --profile your-profile --region us-west-2

# List agent spaces
aws securityagent list-agent-spaces --region us-west-2

# Register and verify a domain
aws securityagent create-target-domain \
  --target-domain-name api.example.com \
  --verification-method DNS_TXT --region us-west-2
aws securityagent verify-target-domain \
  --target-domain-name api.example.com --region us-west-2

# Associate domain with agent space (required before pen test)
aws securityagent update-agent-space \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --target-domain-ids "<domain-id>" --region us-west-2

# Upload spec as context for pen tests
aws securityagent add-artifact \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --artifact-content fileb://specs/my-spec.md \
  --artifact-type MD --file-name my-spec.md --region us-west-2

# Start a pen test
aws securityagent start-pentest-job \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" --region us-west-2

# Check pen test status
aws securityagent list-pentest-jobs-for-pentest \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" \
  --query 'pentestJobSummaries[0].status' --region us-west-2

# Get findings from a pen test job
aws securityagent list-findings \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-job-id <job-id> --region us-west-2

# Manage GitHub integration repos (after initial OAuth via console)
aws securityagent list-integrations \
  --agent-space-id "${AGENT_SPACE_ID}" --region us-west-2
aws securityagent update-integrated-resources \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --integration-id <id> \
  --add-resources '["org/repo"]' --region us-west-2
```

## Troubleshooting the manual path

| Problem | Likely Cause | Fix |
|---|---|---|
| Domain verification stuck (DNS) | DNS not propagated | Wait 5 min; verify with `dig TXT _securityagent.yourdomain.com` |
| Domain verification stuck (HTTP) | Wrong JSON format | Must return `{"tokens": ["<token>"]}` — not `{"token": "..."}` |
| `create-pentest` title rejected | Invalid characters | Only letters, numbers, hyphens, underscores. No spaces. Max 100 chars |
| Pen test start times out | Domain re-verification + Lambda cold start | Warm the verification Lambda first; add retry logic |
| Code review not triggering | Repo is public or not connected | Must be private; re-authorize via web console OAuth |
| GitHub integration CLI fails | OAuth not completed | Initial setup requires web console; CLI only works after OAuth |

Other Security Agent problems (CLI version, KMS, log groups, access errors) are in the User Guide's
[Security Agent Issues](../USER_GUIDE.md#security-agent-issues).
