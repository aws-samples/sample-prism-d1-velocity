#!/usr/bin/env bash
# Deploy the Task Assistant Agent to Amazon Bedrock AgentCore.
#
# Uses the AgentCore CLI (@aws/agentcore). On first run, scaffolds the
# project with 'agentcore create', then copies the agent entrypoint into
# the generated project structure before deploying.
#
# Prerequisites:
#   npm install -g @aws/agentcore
#   AWS CDK bootstrapped: cdk bootstrap
#
# Usage:
#   bash scripts/deploy-agentcore.sh
#   bash scripts/deploy-agentcore.sh --local
#   bash scripts/deploy-agentcore.sh --plan
#   bash scripts/deploy-agentcore.sh --destroy

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
AGENT_NAME="prismtaskassistant"
CDK_DIR="$AGENT_DIR/agentcore/cdk"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
run_cmd() {
  echo "  \$ $*"
  "$@"
}

check_cli() {
  if ! command -v agentcore &> /dev/null; then
    echo ""
    echo "Error: AgentCore CLI not found."
    echo "Install with: npm install -g @aws/agentcore"
    exit 1
  fi
  echo "AgentCore CLI: $(agentcore --version)"
}

needs_create() {
  [[ ! -d "$CDK_DIR" ]]
}

create_project() {
  echo ""
  echo "Scaffolding AgentCore project..."

  local tmp_dir="$AGENT_DIR/.agentcore-tmp"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"

  if ! (cd "$tmp_dir" && run_cmd agentcore create \
    --name "$AGENT_NAME" \
    --framework Strands \
    --protocol HTTP \
    --build Container \
    --model-provider Bedrock \
    --memory shortTerm) \
    2>&1; then
    echo ""
    echo "agentcore create failed"
    rm -rf "$tmp_dir"
    exit 1
  fi

  # Move the generated agentcore/ directory into our project
  local generated="$tmp_dir/$AGENT_NAME/agentcore"
  if [[ -d "$generated" ]]; then
    rm -rf "$AGENT_DIR/agentcore"
    mv "$generated" "$AGENT_DIR/agentcore"
    echo "  Moved agentcore/ config into project"
  fi

  rm -rf "$tmp_dir"
  update_entrypoint
}

update_entrypoint() {
  local config="$AGENT_DIR/agentcore/agentcore.json"
  [[ ! -f "$config" ]] && return

  # Use a temp file for safe in-place edit
  local tmp
  tmp=$(mktemp)
  jq '
    if .runtimes then
      .runtimes |= map(
        .build = "Container" |
        .entrypoint = "task_assistant/agentcore_app.py" |
        .codeLocation = "src/" |
        .runtimeVersion = "PYTHON_3_13"
      )
    else . end
  ' "$config" > "$tmp" && mv "$tmp" "$config"

  echo "  Updated agentcore.json: codeLocation=src/, entrypoint=task_assistant/agentcore_app.py"
}

resolve_account_id() {
  local targets_path="$AGENT_DIR/agentcore/aws-targets.json"
  [[ ! -f "$targets_path" ]] && return

  # Check if all required fields are already set
  local existing_account existing_region existing_name
  existing_account=$(jq -r '.[0].account // ""' "$targets_path" 2>/dev/null || echo "")
  existing_region=$(jq -r '.[0].region // ""' "$targets_path" 2>/dev/null || echo "")
  existing_name=$(jq -r '.[0].name // ""' "$targets_path" 2>/dev/null || echo "")
  [[ -n "$existing_account" && -n "$existing_region" && -n "$existing_name" ]] && return

  if ! command -v aws &> /dev/null; then
    echo "Warning: AWS CLI not found. Fill agentcore/aws-targets.json manually."
    return
  fi

  local account_id region
  account_id=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || {
    echo "Warning: Could not resolve AWS account ID. Fill agentcore/aws-targets.json manually."
    return
  }

  region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  if [[ -z "$region" ]]; then
    region=$(aws configure get region 2>/dev/null || echo "")
  fi
  if [[ -z "$region" ]]; then
    region="us-west-2"
    echo "  No AWS region configured, defaulting to $region"
  fi

  local tmp
  tmp=$(mktemp)
  jq --arg acct "$account_id" --arg rgn "$region" \
    '.[0].account = $acct | .[0].region = $rgn | .[0].name = "default"' \
    "$targets_path" > "$tmp" && mv "$tmp" "$targets_path"
  echo "  Resolved AWS account: $account_id, region: $region"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
ACTION="deploy"
VERBOSE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)   ACTION="local"; shift ;;
    --destroy) ACTION="destroy"; shift ;;
    --plan)    ACTION="plan"; shift ;;
    -v|--verbose) VERBOSE="-v"; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--local|--destroy|--plan] [-v|--verbose]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
cd "$AGENT_DIR"

check_cli

if needs_create; then
  create_project
fi

resolve_account_id

case "$ACTION" in
  destroy)
    echo ""
    echo "Destroying resources..."
    run_cmd agentcore remove all
    run_cmd agentcore deploy -y
    ;;
  local)
    echo ""
    echo "Starting local dev server..."
    run_cmd agentcore dev --no-browser
    ;;
  plan)
    echo ""
    echo "Previewing deployment changes..."
    run_cmd agentcore deploy --plan $VERBOSE
    ;;
  deploy)
    echo ""
    echo "Deploying to AgentCore Runtime..."
    if ! run_cmd agentcore deploy -y $VERBOSE; then
      echo ""
      echo "Deployment failed"
      exit 1
    fi

    echo ""
    echo "Checking status..."
    run_cmd agentcore status

    echo ""
    echo "✓ Done! Next steps:"
    echo "  agentcore invoke 'List all tasks'"
    echo "  agentcore logs"
    echo "  agentcore status"
    ;;
esac
