#!/usr/bin/env bash
#
# deploy-harness.sh — build the agent image and create the AgentCore harness in
# your own AWS account. Run once per account/region, not per repository.
#
# Every repository that installs the coding agent then points at the one harness
# ARN this prints, via the PRISM_HARNESS_ARN org variable. Nothing about the agent
# is copied into those repositories.
#
#   ./deploy-harness.sh --account 123456789012 --region us-west-2
#   ./deploy-harness.sh --profile my-dev --tag v2          # rebuild and update
#
# Idempotent: re-running rebuilds the image, pushes a new tag, and updates the
# existing harness rather than creating a second one.
#
# WHY THIS IS A SCRIPT AND NOT A CDK STACK
#   CloudFormation has no resource type for an AgentCore harness, and the AWS CLI
#   has no `create-harness` (checked on 2.36.19 — the operation exists only in
#   boto3). So the create/update call goes through a small inline Python block.
#   When a CFN resource type ships, this becomes a stack.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "${HERE}")"

REGION="us-west-2"
ACCOUNT=""
PROFILE=""
TAG="v1"
NAME="PrismCodingAgent"
ECR_REPO="prism/coding-agent-harness"
ROLE_NAME="PrismCodingAgentHarnessRole"
MODEL_ID="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
# Matches agentcore.contract.MAX_ITERATIONS. The client passes maxIterations on
# every InvokeHarness call, so this is only the fallback for callers that do not.
MAX_ITERATIONS=100
TIMEOUT_SECONDS=1800

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)  REGION="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --tag)     TAG="$2"; shift 2 ;;
    --name)    NAME="$2"; shift 2 ;;
    --model)   MODEL_ID="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -n "${PROFILE}" ]] && export AWS_PROFILE="${PROFILE}"
export AWS_DEFAULT_REGION="${REGION}"

for tool in aws docker python3; do
  command -v "${tool}" >/dev/null || { echo "Missing required tool: ${tool}" >&2; exit 1; }
done
python3 -c 'import boto3' 2>/dev/null || {
  echo "boto3 is required (the AWS CLI has no create-harness): pip install boto3" >&2
  exit 1
}

if [[ -z "${ACCOUNT}" ]]; then
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
fi
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${ECR_REPO}:${TAG}"

echo "Account : ${ACCOUNT}"
echo "Region  : ${REGION}"
echo "Image   : ${IMAGE}"
echo "Harness : ${NAME}"
echo

# ---- 1. ECR repository -------------------------------------------------------
echo "==> ECR repository"
if ! aws ecr describe-repositories --repository-names "${ECR_REPO}" >/dev/null 2>&1; then
  aws ecr create-repository \
    --repository-name "${ECR_REPO}" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 >/dev/null
  echo "    created ${ECR_REPO}"
else
  echo "    ${ECR_REPO} exists"
fi

# ---- 2. Build and push (arm64) ----------------------------------------------
# AgentCore runs arm64. Building the host's native arch on an x86 laptop produces
# an image the harness cannot start, and the failure surfaces at invoke time
# rather than at build time -- so the platform is pinned explicitly.
echo "==> Build and push (linux/arm64)"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${REGISTRY}" >/dev/null
docker buildx build \
  --platform linux/arm64 \
  --tag "${IMAGE}" \
  --file "${HERE}/Dockerfile" \
  --push \
  "${HERE}"
echo "    pushed ${IMAGE}"

# ---- 3. Execution role -------------------------------------------------------
echo "==> Execution role ${ROLE_NAME}"
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"bedrock-agentcore.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

# The memory statement is the one that is easy to miss and hard to diagnose. A
# harness provisions its own AgentCore Memory resource on first invocation, so the
# actions cannot be scoped to an ARN that exists when the role is written --
# omitting them fails the first real invocation as AccessDenied on ListEvents
# against a resource that did not exist yet, wrapped in a runtimeClientError.
POLICY=$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"EcrPull","Effect":"Allow","Action":[
   "ecr:GetAuthorizationToken","ecr:BatchCheckLayerAvailability",
   "ecr:GetDownloadUrlForLayer","ecr:BatchGetImage"],"Resource":"*"},
 {"Sid":"Logs","Effect":"Allow","Action":[
   "logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents",
   "logs:DescribeLogGroups","logs:DescribeLogStreams"],
  "Resource":"arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/bedrock-agentcore/*"},
 {"Sid":"KmsForLogGroups","Effect":"Allow","Action":["kms:DescribeKey"],"Resource":"*"},
 {"Sid":"InvokeModel","Effect":"Allow","Action":[
   "bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream",
   "bedrock:Converse","bedrock:ConverseStream"],"Resource":"*"},
 {"Sid":"HarnessMemory","Effect":"Allow","Action":[
   "bedrock-agentcore:ListEvents","bedrock-agentcore:CreateEvent",
   "bedrock-agentcore:GetEvent","bedrock-agentcore:DeleteEvent",
   "bedrock-agentcore:ListActors","bedrock-agentcore:ListSessions",
   "bedrock-agentcore:RetrieveMemoryRecords","bedrock-agentcore:ListMemoryRecords",
   "bedrock-agentcore:GetMemoryRecord","bedrock-agentcore:GetMemory",
   "bedrock-agentcore:CreateMemory","bedrock-agentcore:ListMemories"],
  "Resource":"*"}
]}
JSON
)

if ! aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  aws iam create-role --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST}" \
    --description "Execution role for the PRISM coding agent AgentCore harness" >/dev/null
  echo "    created ${ROLE_NAME}"
else
  echo "    ${ROLE_NAME} exists"
fi
aws iam put-role-policy --role-name "${ROLE_NAME}" \
  --policy-name PrismCodingAgentHarness --policy-document "${POLICY}"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"
echo "    policy applied"

# ---- 4. Create or update the harness ----------------------------------------
echo "==> Harness"
HARNESS_ARN=$(
  AGENTCORE_REGION="${REGION}" \
  AGENTCORE_NAME="${NAME}" \
  AGENTCORE_IMAGE="${IMAGE}" \
  AGENTCORE_ROLE="${ROLE_ARN}" \
  AGENTCORE_MODEL="${MODEL_ID}" \
  AGENTCORE_MAX_ITERATIONS="${MAX_ITERATIONS}" \
  AGENTCORE_TIMEOUT="${TIMEOUT_SECONDS}" \
  python3 "${HERE}/create_harness.py"
)
echo "    ${HARNESS_ARN}"

cat <<EOF

✅ Harness ready

  ${HARNESS_ARN}

Set it once as an organization variable and every repository inherits it:

  gh variable set PRISM_HARNESS_ARN --org <your-org> \\
    --body "${HARNESS_ARN}"

An ARN is an identifier, not a credential, so it belongs in a variable rather
than a secret. Then, per repository:

  prism-cli bootstrapper install-coding-agent
  gh label create agent-fix --description "Hand this issue to the PRISM coding agent"

Nothing about the agent is copied into those repositories -- the workflow fetches
the thin client at run time and calls this harness.
EOF
