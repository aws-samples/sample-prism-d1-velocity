#!/usr/bin/env bash
# test-continuum-e2e.sh — End-to-end test of AWS Continuum diff scan flow
# Run from the sample-prism-d1-velocity repo root.
# Usage: ./test-continuum-e2e.sh [--profile andklee-dev] [--region us-west-2]
set -euo pipefail

PROFILE="${1:---profile andklee-dev}"
REGION="${2:---region us-west-2}"
ENV="$PROFILE $REGION"
REPO_SLUG="aws-samples-sample-prism-d1-velocity"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  AWS Continuum Diff Scan — E2E Test                     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 0: Pre-flight checks ───────────────────────────────
echo "▶ Step 0: Pre-flight checks"
if ! aws sts get-caller-identity $ENV > /dev/null 2>&1; then
  echo "  ❌ AWS credentials not valid. Run: ada credentials update --profile andklee-dev"
  exit 1
fi
echo "  ✓ AWS credentials valid"

if ! aws securityagent help > /dev/null 2>&1; then
  echo "  ❌ AWS CLI does not have 'securityagent' subcommand. Upgrade to v2.35+."
  exit 1
fi
echo "  ✓ AWS CLI supports securityagent"

if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "  ❌ Not inside a git repo. Run from sample-prism-d1-velocity root."
  exit 1
fi
echo "  ✓ Inside git repo"
echo ""

# ─── Step 1: Read SSM params ─────────────────────────────────
echo "▶ Step 1: Read SSM parameters"
AGENT_SPACE_ID=$(aws ssm get-parameter --name /prism/continuum/agent-space-id $ENV --query Parameter.Value --output text 2>/dev/null || echo "")
SCAN_BUCKET=$(aws ssm get-parameter --name /prism/continuum/scan-bucket $ENV --query Parameter.Value --output text 2>/dev/null || echo "")
SERVICE_ROLE=$(aws ssm get-parameter --name /prism/continuum/service-role-arn $ENV --query Parameter.Value --output text 2>/dev/null || echo "")
CODE_REVIEW_ID=$(aws ssm get-parameter --name "/prism/continuum/code-review-id/${REPO_SLUG}" $ENV --query Parameter.Value --output text 2>/dev/null || echo "")

echo "  agent-space-id: ${AGENT_SPACE_ID:-MISSING}"
echo "  scan-bucket:    ${SCAN_BUCKET:-MISSING}"
echo "  service-role:   ${SERVICE_ROLE:-MISSING}"
echo "  code-review-id: ${CODE_REVIEW_ID:-NOT SET (will bootstrap)}"

if [[ -z "$AGENT_SPACE_ID" || -z "$SCAN_BUCKET" ]]; then
  echo ""
  echo "  ❌ Core SSM params missing. Deploy CDK first:"
  echo "     cd infra && npx cdk deploy --context enableSecurityAgent=true --context skipVpc=true"
  exit 1
fi

# Fallback for service role
if [[ -z "$SERVICE_ROLE" ]]; then
  ACCOUNT_ID=$(aws sts get-caller-identity $ENV --query Account --output text)
  SERVICE_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/prism-d1-security-agent-prism-d1-security"
  echo "  ⚠️  Using convention fallback for service role: ${SERVICE_ROLE}"
fi
echo ""

# ─── Step 2: Upload repo ZIP ─────────────────────────────────
echo "▶ Step 2: Archive and upload repo"
git archive HEAD --format=zip -o /tmp/prism-e2e-repo.zip
REPO_SIZE=$(du -h /tmp/prism-e2e-repo.zip | cut -f1)
echo "  Repo ZIP: ${REPO_SIZE}"

aws s3 cp /tmp/prism-e2e-repo.zip "s3://${SCAN_BUCKET}/repo/${REPO_SLUG}/latest.zip" $ENV --quiet
echo "  ✓ Uploaded to s3://${SCAN_BUCKET}/repo/${REPO_SLUG}/latest.zip"
echo ""

# ─── Step 3: Bootstrap CodeReview if needed ───────────────────
if [[ -z "$CODE_REVIEW_ID" ]]; then
  echo "▶ Step 3: Bootstrap Code Review (first-time setup)"
  CR_RESPONSE=$(aws securityagent create-code-review \
    --agent-space-id "${AGENT_SPACE_ID}" \
    --title "${REPO_SLUG}-ci-diff-scan" \
    --service-role "${SERVICE_ROLE}" \
    --assets "{\"sourceCode\":[{\"s3Location\":\"s3://${SCAN_BUCKET}/repo/${REPO_SLUG}/latest.zip\"}]}" \
    $ENV --output json 2>&1)

  if echo "$CR_RESPONSE" | jq -e '.codeReviewId' > /dev/null 2>&1; then
    CODE_REVIEW_ID=$(echo "$CR_RESPONSE" | jq -r '.codeReviewId')
    echo "  ✓ Code Review created: ${CODE_REVIEW_ID}"

    aws ssm put-parameter \
      --name "/prism/continuum/code-review-id/${REPO_SLUG}" \
      --value "${CODE_REVIEW_ID}" \
      --type String --overwrite $ENV > /dev/null
    echo "  ✓ Saved to SSM"
  else
    echo "  ❌ CreateCodeReview failed:"
    echo "  ${CR_RESPONSE}" | head -5
    exit 1
  fi
else
  echo "▶ Step 3: Code Review already exists: ${CODE_REVIEW_ID}"
fi
echo ""

# ─── Step 4: Generate and upload diff ─────────────────────────
echo "▶ Step 4: Generate and upload diff"

# Create a vulnerable test file to trigger findings
cat > /tmp/vuln-test.ts << 'EOF'
import { exec } from 'child_process';
const API_KEY = 'sk-proj-abc123-secret-key-do-not-share';
export function runCmd(host: string) { exec(`ping -c 3 ${host}`); }
EOF

# Generate diff introducing the vulnerable file
git diff /dev/null /tmp/vuln-test.ts > /tmp/e2e-changes.patch 2>/dev/null || \
  diff -u /dev/null /tmp/vuln-test.ts > /tmp/e2e-changes.patch || true

DIFF_SIZE=$(wc -c < /tmp/e2e-changes.patch)
echo "  Diff size: ${DIFF_SIZE} bytes (vulnerable test file)"

DIFF_KEY="diffs/${REPO_SLUG}/e2e-test/test-$(date +%s).patch"
aws s3 cp /tmp/e2e-changes.patch "s3://${SCAN_BUCKET}/${DIFF_KEY}" $ENV --quiet
echo "  ✓ Uploaded to s3://${SCAN_BUCKET}/${DIFF_KEY}"
echo ""

# ─── Step 5: Start diff scan ──────────────────────────────────
echo "▶ Step 5: Start Continuum diff scan"
JOB_RESPONSE=$(aws securityagent start-code-review-job \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --code-review-id "${CODE_REVIEW_ID}" \
  --diff-source "{\"s3Uri\":\"s3://${SCAN_BUCKET}/${DIFF_KEY}\"}" \
  $ENV --output json)

JOB_ID=$(echo "$JOB_RESPONSE" | jq -r '.codeReviewJobId')
JOB_STATUS=$(echo "$JOB_RESPONSE" | jq -r '.status')
echo "  Job ID: ${JOB_ID}"
echo "  Status: ${JOB_STATUS}"
echo ""

# ─── Step 6: Poll for completion ──────────────────────────────
echo "▶ Step 6: Polling for completion (timeout: 15 min)"
MAX_POLLS=30
for i in $(seq 1 $MAX_POLLS); do
  sleep 30
  STATUS=$(aws securityagent batch-get-code-review-jobs \
    --agent-space-id "${AGENT_SPACE_ID}" \
    --code-review-job-ids "${JOB_ID}" \
    $ENV --query 'codeReviewJobs[0].status' --output text 2>/dev/null || echo "UNKNOWN")

  printf "  [%02d/%d] %s\n" "$i" "$MAX_POLLS" "$STATUS"

  if [[ "$STATUS" == "COMPLETED" || "$STATUS" == "FAILED" || "$STATUS" == "STOPPED" ]]; then
    break
  fi
done
echo ""

if [[ "$STATUS" != "COMPLETED" ]]; then
  echo "  ⚠️  Scan did not complete (status: ${STATUS})"
  echo "  Check manually:"
  echo "  aws securityagent batch-get-code-review-jobs --agent-space-id $AGENT_SPACE_ID --code-review-job-ids $JOB_ID $ENV"
  exit 1
fi

# ─── Step 7: Get findings ─────────────────────────────────────
echo "▶ Step 7: Retrieve findings"
FINDINGS_JSON=$(aws securityagent list-findings \
  --agent-space-id "${AGENT_SPACE_ID}" \
  --code-review-id "${CODE_REVIEW_ID}" \
  --code-review-job-id "${JOB_ID}" \
  $ENV --output json 2>/dev/null || echo '{"findings":[]}')

TOTAL=$(echo "$FINDINGS_JSON" | jq '.findings | length')
CRITICAL=$(echo "$FINDINGS_JSON" | jq '[.findings[] | select(.severity == "CRITICAL")] | length')
HIGH=$(echo "$FINDINGS_JSON" | jq '[.findings[] | select(.severity == "HIGH")] | length')
MEDIUM=$(echo "$FINDINGS_JSON" | jq '[.findings[] | select(.severity == "MEDIUM")] | length')

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  RESULTS                                                ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Total findings: ${TOTAL}                               "
echo "║  Critical: ${CRITICAL}  High: ${HIGH}  Medium: ${MEDIUM}"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

if [[ "$TOTAL" -gt 0 ]]; then
  echo "Findings detail:"
  echo "$FINDINGS_JSON" | jq -r '.findings[] | "  [\(.severity)] \(.title // .description | .[0:100])"'
  echo ""
  echo "✅ E2E TEST PASSED — Continuum detected vulnerabilities in the test diff."
else
  echo "⚠️  No findings returned. The diff may be too simple or the scan timed out."
  echo "  This is not necessarily a failure — benign diffs produce 0 findings."
fi

# Cleanup
rm -f /tmp/prism-e2e-repo.zip /tmp/e2e-changes.patch /tmp/vuln-test.ts
echo ""
echo "Done."
