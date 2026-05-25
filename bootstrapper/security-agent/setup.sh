#!/usr/bin/env bash
# setup.sh — Configure AWS Security Agent integration with PRISM D1
#
# Usage:
#   ./setup.sh --api-url <prism-api-url> --api-key <api-key> [--region us-west-2]
#
# This script:
#   1. Verifies AWS Security Agent access
#   2. Configures the PRISM webhook endpoint for Security Agent findings
#   3. Sets up a scheduled poll as fallback (Security Agent is in preview)
#   4. Creates the .prism/security-agent.json config file

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
API_URL=""
API_KEY=""
AWS_REGION="${AWS_REGION:-us-west-2}"
TEAM_ID="${PRISM_TEAM_ID:-unknown}"

usage() {
    echo "Usage: $0 --api-url <prism-api-url> --api-key <api-key> [--region <region>] [--team-id <team>]"
    echo ""
    echo "Arguments:"
    echo "  --api-url   PRISM D1 API Gateway URL (e.g., https://xxx.execute-api.us-west-2.amazonaws.com/v1)"
    echo "  --api-key   PRISM D1 API key for authentication"
    echo "  --region    AWS region (default: us-west-2)"
    echo "  --team-id   Team identifier (default: \$PRISM_TEAM_ID or 'unknown')"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --api-url) API_URL="$2"; shift 2 ;;
        --api-key) API_KEY="$2"; shift 2 ;;
        --region) AWS_REGION="$2"; shift 2 ;;
        --team-id) TEAM_ID="$2"; shift 2 ;;
        --help|-h) usage ;;
        *) echo "Unknown argument: $1"; usage ;;
    esac
done

if [[ -z "${API_URL}" || -z "${API_KEY}" ]]; then
    echo "Error: --api-url and --api-key are required."
    usage
fi

echo "=== PRISM D1 — Security Agent Setup ==="
echo "API URL:  ${API_URL}"
echo "Region:   ${AWS_REGION}"
echo "Team ID:  ${TEAM_ID}"
echo ""

# ---------------------------------------------------------------------------
# Verify AWS Security Agent access
# ---------------------------------------------------------------------------
echo "Checking AWS Security Agent access..."
AGENT_SPACES=$(aws securityagent list-agent-spaces --region "${AWS_REGION}" --query 'agentSpaceSummaries[].name' --output text 2>/dev/null || echo "")
if [[ -n "${AGENT_SPACES}" ]]; then
    echo "  AWS Security Agent: accessible"
    echo "  Agent Spaces: ${AGENT_SPACES}"

    # Check if our agent space exists
    SPACE_ID=$(aws securityagent list-agent-spaces --region "${AWS_REGION}" \
      --query "agentSpaceSummaries[?name=='prism-d1-security'].agentSpaceId" \
      --output text 2>/dev/null || echo "")
    if [[ -n "${SPACE_ID}" && "${SPACE_ID}" != "None" ]]; then
        echo "  PRISM Agent Space ID: ${SPACE_ID}"
    else
        echo "  PRISM Agent Space not found — deploy CDK stack first: npx cdk deploy --all"
    fi
else
    echo "  AWS Security Agent: not accessible or no agent spaces configured"
    echo "  Deploy the CDK stack first: cd infra && npx cdk deploy --all"
    echo "  The setup will continue — findings can be submitted via the API endpoint."
fi

# ---------------------------------------------------------------------------
# Create configuration
# ---------------------------------------------------------------------------
mkdir -p .prism

cat > .prism/security-agent.json << EOF
{
  "team_id": "${TEAM_ID}",
  "api_url": "${API_URL}",
  "api_key_parameter": "prism-d1-api-key",
  "aws_region": "${AWS_REGION}",
  "webhook_endpoint": "${API_URL}/security-findings",
  "polling": {
    "enabled": true,
    "interval_minutes": 15
  },
  "scan_config": {
    "design_review": {
      "enabled": true,
      "trigger": "on_spec_commit",
      "spec_patterns": ["specs/*.md", "docs/design/*.md"]
    },
    "code_review": {
      "enabled": true,
      "trigger": "on_pr",
      "github_integration": true
    },
    "pen_test": {
      "enabled": true,
      "trigger": "on_deploy_to_staging",
      "environments": ["staging"]
    }
  },
  "severity_thresholds": {
    "block_merge": ["CRITICAL", "HIGH"],
    "alert_on": ["CRITICAL", "HIGH", "MEDIUM"],
    "remediation_sla_hours": {
      "CRITICAL": 24,
      "HIGH": 72,
      "MEDIUM": 720
    }
  }
}
EOF

echo ""
echo "Created .prism/security-agent.json"

# ---------------------------------------------------------------------------
# Verify webhook endpoint
# ---------------------------------------------------------------------------
echo ""
echo "Testing webhook endpoint..."
TEST_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${API_URL}/security-findings" \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"findings":[]}' 2>/dev/null || echo "000")

if [[ "${TEST_RESPONSE}" == "200" ]]; then
    echo "  Webhook endpoint: OK (${TEST_RESPONSE})"
else
    echo "  Webhook endpoint: returned ${TEST_RESPONSE} (may need API deployment)"
fi

# ---------------------------------------------------------------------------
# Copy GitHub workflow
# ---------------------------------------------------------------------------
if [[ -d ".github/workflows" ]]; then
    if [[ -f "${SCRIPT_DIR}/prism-security-agent-scan.yml" ]]; then
        cp "${SCRIPT_DIR}/prism-security-agent-scan.yml" .github/workflows/
        echo ""
        echo "Copied Security Agent workflow to .github/workflows/"
    fi
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Store the API key in AWS Secrets Manager or GitHub Secrets"
echo "  2. Configure Security Agent to send webhooks to: ${API_URL}/security-findings"
echo "  3. Review .prism/security-agent.json and adjust scan triggers"
echo "  4. Deploy the PRISM CDK stack if not already deployed: cd infra && npx cdk deploy --all"
echo "  5. Check the CISO Compliance dashboard after the first scan completes"
