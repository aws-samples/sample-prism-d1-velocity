# AWS Security Agent — Complete Setup Guide

This guide walks you through connecting AWS Security Agent to the PRISM D1 metrics pipeline. Follow every step in order. Each step tells you exactly what to do, where to do it, and how to verify it worked.

---

## Before You Start

You need all of these before proceeding:

| Requirement | How to Check | If Missing |
|---|---|---|
| AWS account with Security Agent access | `aws securityagent list-agent-spaces --region us-west-2` should not error | Request access via your AWS account team |
| PRISM D1 CDK stack deployed | `aws cloudformation describe-stacks --stack-name PrismD1MetricsPipelineStack --query 'Stacks[0].StackStatus'` should return `CREATE_COMPLETE` or `UPDATE_COMPLETE` | Run `prism-cli securityagent setup` |
| GitHub repository (private) | Code review requires a private repo | Create one or make existing repo private |
| Domain you own | For pen testing — you must prove ownership | Use a staging domain |
| `jq` installed | `jq --version` | `brew install jq` or `apt install jq` |
| `aws` CLI v2 (latest) | `aws securityagent help` should not error | Install from [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) — do NOT use package managers |

**Save these values — you'll need them throughout:**

```bash
export PRISM_API_URL=$(aws cloudformation describe-stacks \
  --stack-name PrismD1ApiStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
  --output text)

export PRISM_API_KEY_ID=$(aws cloudformation describe-stacks \
  --stack-name PrismD1ApiStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiKeyId`].OutputValue' \
  --output text)

export PRISM_API_KEY=$(aws apigateway get-api-key \
  --api-key "${PRISM_API_KEY_ID}" \
  --include-value \
  --query 'value' --output text)

export AGENT_SPACE_ID=$(aws securityagent list-agent-spaces \
  --region us-west-2 \
  --query "agentSpaceSummaries[?name=='prism-d1-security'].agentSpaceId" \
  --output text)

echo "API URL:        ${PRISM_API_URL}"
echo "API Key:        ${PRISM_API_KEY:0:8}..."
echo "Agent Space ID: ${AGENT_SPACE_ID}"
```

If `AGENT_SPACE_ID` is empty, run `prism-cli securityagent setup` first.

---

## Step 1: Deploy Security Agent Infrastructure

**Where:** Terminal, from the prism-d1-velocity repo root

The CLI command handles CDK deployment, application creation, and role attachment in one step:

```bash
prism-cli securityagent setup --profile your-profile --region us-west-2
```

This:
1. Runs `cdk deploy --all --context enableSecurityAgent=true`
2. Creates a Security Agent application (or finds existing)
3. Attaches the `prism-d1-security-agent-prism-d1-security` IAM role
4. Prints the web console URL

**Verify:**

```bash
aws securityagent list-agent-spaces --region us-west-2 --output table
# Should show: prism-d1-security | as-xxxxxxxxxxxx | ACTIVE
```

**If you see errors:**
- `UnrecognizedClientException` → Security Agent not enabled for your account
- `AccessDeniedException` → Your IAM role needs `securityagent:*` permissions
- KMS 403 errors → The `securityagent.amazonaws.com` service principal needs `kms:Encrypt/Decrypt` on the KMS key. Also ensure `logs.amazonaws.com` has `kms:Encrypt/Decrypt/GenerateDataKey*/DescribeKey` with a Condition for the log group ARN pattern.

---

## Step 2: Register Your Domain for Pen Testing

**Where:** Terminal

> **Skip this step** if you only need code review (domain is only required for pen testing).

Pen testing requires proving you own the domain. Choose ONE method:

### Option A: DNS TXT Record (recommended)

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

Wait 1-5 minutes for DNS propagation, then verify:

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

Then verify:
```bash
curl -s https://api.yourcompany.com/.well-known/security-agent-verification
# Must return: {"tokens": ["<token>"]}

aws securityagent verify-target-domain \
  --target-domain-name api.yourcompany.com \
  --region us-west-2
```

### Associate Domain with Agent Space

**⚠️ Required:** A verified domain is NOT automatically usable for pen tests. You must explicitly associate it:

```bash
# Get the domain ID
DOMAIN_ID=$(aws securityagent batch-get-target-domains \
  --target-domain-names api.yourcompany.com \
  --region us-west-2 \
  --query 'targetDomains[0].targetDomainId' --output text)

# Associate with agent space
aws securityagent update-agent-space \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --target-domain-ids "${DOMAIN_ID}" \
  --region us-west-2
```

---

## Step 3: Connect GitHub for Code Review

**Where:** AWS Console (web browser) — OAuth handshake required

> **⚠️ Important:** GitHub integration requires an OAuth authorization code from AWS's pre-registered GitHub OAuth App. You **cannot** bypass this with `gh` CLI tokens or PATs. The initial setup must be done via the web console.

1. Open [Security Agent console](https://console.aws.amazon.com/securityagent)
2. Click your agent space (`prism-d1-security`)
3. Go to **Integrations** → **Add Integration**
4. Select **GitHub**
5. Complete the OAuth authorization flow (grants Security Agent access to your org)
6. Select the repositories to monitor (must be **private** repos)
7. Save

**After initial OAuth setup**, you can manage repos via CLI:

```bash
# List integrations
aws securityagent list-integrations \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --region us-west-2 --output table

# Add/remove repos from an existing integration
aws securityagent update-integrated-resources \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --integration-id <integration-id> \
  --add-resources '["your-org/new-repo"]' \
  --region us-west-2
```

**Expected:** GitHub integration listed with status `ACTIVE`.

After this, Security Agent automatically reviews every PR opened against the connected repositories. It posts as `aws-security-agent[bot]` with inline review comments on specific lines.

> **Note:** Code reviews only work on **private repositories**. Public repos will not show the code review option.

---

## Step 4: Create a Pen Test Configuration

**Where:** Terminal

```bash
# Get the service role ARN
SERVICE_ROLE_ARN=$(aws iam list-roles \
  --query "Roles[?contains(RoleName, 'security-agent')].Arn" \
  --output text | head -1)

echo "Service Role: ${SERVICE_ROLE_ARN}"

# Create the pen test configuration
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

**Save the `PENTEST_ID`** — you'll need it for the GitHub workflow.

**Verify:**

```bash
aws securityagent list-pentests \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --region us-west-2 --output table
```

---

## Step 5: Configure the PRISM Webhook

**Where:** AWS Console → Security Agent → Settings

This tells Security Agent to send pen test findings directly to your PRISM API.

1. In the Security Agent console, go to **Settings** → **Notifications** (or **Webhooks**)
2. Click **Add Webhook**
3. Fill in:

| Field | Value |
|---|---|
| **URL** | `${PRISM_API_URL}/security-findings` |
| **Method** | POST |
| **Header name** | `x-api-key` |
| **Header value** | Your PRISM API key |
| **Events** | All finding types |
| **Format** | JSON |

4. Click **Test** → should return `200 OK`
5. Save

**Verify:**

```bash
curl -s -w "\nHTTP Status: %{http_code}\n" \
  -X POST "${PRISM_API_URL}/security-findings" \
  -H "x-api-key: ${PRISM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "findings": [{
      "finding_id": "test-001",
      "type": "pen_test",
      "severity": "LOW",
      "title": "Test finding - safe to ignore",
      "description": "Verifying webhook connectivity",
      "category": "Test",
      "repository": "your-org/your-repo",
      "team_id": "your-team",
      "found_at": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }]
  }'
```

**Expected:** `HTTP Status: 200`

> **Note:** This webhook is for pen test findings only. Code review findings are collected by the eval gate workflow directly from GitHub PR comments — they don't go through this webhook.

---

## Step 6: Configure GitHub Repository Variables

**Where:** GitHub → your repo → Settings → Secrets and Variables → Actions

| Type | Name | Value | Where to Find It |
|---|---|---|---|
| **Secret** | `PRISM_API_KEY` | Your PRISM API key | "Before You Start" section |
| Variable | `PRISM_API_URL` | `https://xxx.execute-api.us-west-2.amazonaws.com/v1` | CDK output `ApiUrl` |
| Variable | `PRISM_TEAM_ID` | `team-alpha` (your team name) | Your choice |
| Variable | `PRISM_AWS_ROLE_ARN` | `arn:aws:iam::123456789012:role/GitHubActionsRole` | Your OIDC role |
| Variable | `PRISM_AGENT_SPACE_ID` | `as-xxxxxxxxxxxx` | Step 1 output |
| Variable | `PRISM_PENTEST_ID` | `pt-xxxxxxxxxxxx` | Step 4 output |

---

## Step 7: Run the PRISM Setup Script (Optional)

**Where:** Terminal, in your project repo

```bash
/path/to/bootstrapper/security-agent/setup.sh \
  --api-url "${PRISM_API_URL}" \
  --api-key "${PRISM_API_KEY}" \
  --team-id team-alpha \
  --region us-west-2
```

This creates `.prism/security-agent.json` with scan trigger configuration and remediation SLAs.

---

## Step 8: Verify End-to-End

### Test 1: Code Review

```bash
git checkout -b test-security-review
echo "// test change" >> src/index.ts
git add src/index.ts
git commit -m "Test code for security review"
git push -u origin test-security-review
# Open a PR via GitHub UI
```

**What happens:**
1. Security Agent GitHub App automatically reviews the PR
2. Posts inline review comments on specific lines (as `aws-security-agent[bot]`)
3. Eval gate workflow collects findings and blocks if count > 0
4. Findings forwarded to EventBridge with CWE-based severity mapping

**Check:** PR has inline comments from `aws-security-agent[bot]` → eval gate status check shows findings count.

### Test 2: Pen Test

> **⚠️ Pen tests take several hours to complete.** This is not suitable for blocking CI pipelines.

```bash
# Warm the verification Lambda (prevents cold start timeouts)
for i in {1..3}; do
  curl -s https://api.yourcompany.com/.well-known/security-agent-verification > /dev/null
  sleep 2
done

# Start the pen test
aws securityagent start-pentest-job \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" \
  --region us-west-2

# Monitor status (check periodically — takes hours)
aws securityagent list-pentest-jobs-for-pentest \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --pentest-id "${PENTEST_ID}" \
  --region us-west-2 \
  --query 'pentestJobSummaries[0].{JobId:pentestJobId,Status:status}' \
  --output table
```

> **⚠️ Domain re-verification:** Security Agent re-verifies domain ownership at `start-pentest-job` time. If your verification endpoint is behind a Lambda, cold starts can cause timeout failures. Warm the Lambda with multiple requests before starting, and add retry logic.

**Check:** Wait for `COMPLETED` status → run `list-findings` with the job ID → findings visible in CISO Compliance dashboard.

### Test 3: Dashboards

| Dashboard | What to Check |
|---|---|
| Team Velocity | "Security Agent Findings" section has data |
| CISO Compliance | Security posture + AI risk profile populated |
| Alarms | `SecurityCriticalFinding` alarm in OK state |

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---|---|---|
| `aws securityagent` command not found | AWS CLI too old | Install from [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) — not package managers |
| Agent space not found | CDK not deployed with Security Agent | Run `prism-cli securityagent setup` |
| KMS 403 on agent space creation | `securityagent.amazonaws.com` lacks KMS grants | Add `kms:Encrypt/Decrypt` grant for the service principal |
| Pen test fails at PREFLIGHT | `logs.amazonaws.com` lacks KMS permissions | Grant `kms:Encrypt/Decrypt/GenerateDataKey*/DescribeKey` with log group ARN condition |
| Domain verification stuck (DNS) | DNS not propagated | Wait 5 min; verify with `dig TXT _securityagent.yourdomain.com` |
| Domain verification stuck (HTTP) | Wrong JSON format | Must return `{"tokens": ["<token>"]}` — not `{"token": "..."}` |
| `create-pentest` title rejected | Invalid characters | Only letters, numbers, hyphens, underscores. No spaces. Max 100 chars |
| Pen test start times out | Domain re-verification + Lambda cold start | Warm the verification Lambda first; add retry logic |
| Code review not triggering | Repo is public or not connected | Must be private; re-authorize via web console OAuth |
| GitHub integration CLI fails | OAuth not completed | Initial setup requires web console; CLI only works after OAuth |
| No findings in PRISM dashboards | Webhook misconfigured or eval gate not collecting | Check Lambda logs; verify GitHub variables are set |
| Eval gate not blocking | Security Agent hasn't posted yet | Gate polls for up to 10 min; check if bot posted comments |
| Pen test log group missing | IAM path wrong | Logs go to `/aws/securityagent/<space-name>/pt-<id>`, not `/prism/security-agent/*` |

---

## Quick Reference: All Commands

```bash
# Deploy Security Agent (recommended first step)
prism-cli securityagent setup --profile your-profile --region us-west-2

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

# Get findings from a pen test job (only works for pen tests, not code reviews)
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
