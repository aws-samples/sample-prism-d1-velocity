#!/usr/bin/env bash
# run-eval.sh — Evaluate a single file against a rubric using Bedrock.
#
# Usage: ./run-eval.sh <rubric-file> <input-file> [--spec <spec-file>]
#
# Output (stdout, parsed by workflow):
#   Score: <0-1>
#   Result: PASS|FAIL
#
# Exit: 0=pass, 1=fail, 2=error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/eval-config.json"

# --- Args ---
RUBRIC_FILE=""
INPUT_FILE=""
SPEC_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec) SPEC_FILE="$2"; shift 2 ;;
    *) if [[ -z "${RUBRIC_FILE}" ]]; then RUBRIC_FILE="$1"
       elif [[ -z "${INPUT_FILE}" ]]; then INPUT_FILE="$1"
       fi; shift ;;
  esac
done

[[ -f "${RUBRIC_FILE}" ]] || { echo "Error: rubric not found: ${RUBRIC_FILE}" >&2; exit 2; }
[[ -f "${INPUT_FILE}" ]] || { echo "Error: file not found: ${INPUT_FILE}" >&2; exit 2; }
[[ -f "${CONFIG_FILE}" ]] || { echo "Error: eval-config.json not found" >&2; exit 2; }

# --- Config ---
EVAL_MODEL=$(jq -r '.eval_model_id' "${CONFIG_FILE}")
PASS_THRESHOLD=$(jq -r '.pass_threshold' "${CONFIG_FILE}")
AWS_REGION=$(jq -r '.aws_region' "${CONFIG_FILE}")

RUBRIC_NAME=$(jq -r '.rubric_name' "${RUBRIC_FILE}")
CODE_CONTENT=$(cat "${INPUT_FILE}")

# --- Filter criteria: skip requires_spec criteria when no spec provided ---
CRITERIA_FILTER='if $spec == "" then .criteria | map(select(.requires_spec != true)) else .criteria end'
ACTIVE_CRITERIA=$(jq --arg spec "${SPEC_FILE}" "${CRITERIA_FILTER}" "${RUBRIC_FILE}")
ACTIVE_COUNT=$(echo "${ACTIVE_CRITERIA}" | jq 'length')

if [[ "${ACTIVE_COUNT}" -eq 0 ]]; then
  echo "Skipped: ${RUBRIC_NAME} (all criteria require spec)"
  echo "Score: 0"
  echo "Result: SKIP"
  echo "Hallucinations: 0"
  exit 0
fi

# --- Build rubric text for prompt ---
RUBRIC_CRITERIA=$(echo "${ACTIVE_CRITERIA}" | jq -r '.[] | "- \(.name) [weight=\(.weight)]: \(.description)\n  Scoring: \(.scoring | if type == "object" then to_entries | map("\(.key): \(.value)") | join("; ") else . end)"')

SPEC_SECTION="No spec provided. Evaluate based on code quality criteria only."
if [[ -n "${SPEC_FILE}" && -f "${SPEC_FILE}" ]]; then
  SPEC_SECTION=$(cat "${SPEC_FILE}")
fi

# --- Prompt (ask for per-criterion scores, we calculate weighted average) ---
EVAL_PROMPT="You are a code quality evaluator. Evaluate the following code against the rubric criteria.

## Spec
${SPEC_SECTION}

## Code Under Evaluation
--- FILE: ${INPUT_FILE} ---
${CODE_CONTENT}

## Rubric Criteria
${RUBRIC_CRITERIA}

Respond in this exact JSON format (no other text):
{\"evaluations\": [{\"criterion\": \"<name>\", \"score\": <0.0-1.0>, \"rationale\": \"<brief>\"}]}"

# --- Call Bedrock ---
BODY_FILE=$(mktemp)
RESP_FILE=$(mktemp)
trap 'rm -f "${BODY_FILE}" "${RESP_FILE}"' EXIT

jq -n --arg p "${EVAL_PROMPT}" \
  '{anthropic_version:"bedrock-2023-05-31",max_tokens:2000,messages:[{role:"user",content:$p}]}' > "${BODY_FILE}"

aws bedrock-runtime invoke-model \
  --region "${AWS_REGION}" \
  --model-id "${EVAL_MODEL}" \
  --content-type "application/json" \
  --accept "application/json" \
  --body "fileb://${BODY_FILE}" \
  "${RESP_FILE}" 2>/dev/null || { echo "Error: Bedrock invoke failed" >&2; exit 2; }

# --- Parse response ---
EVAL_JSON=$(jq -r '.content[0].text' "${RESP_FILE}" 2>/dev/null | sed -n '/^{/,/^}/p') || true
[[ -n "${EVAL_JSON}" ]] || { echo "Error: could not parse model response" >&2; exit 2; }

# --- Calculate weighted score (client-side, don't trust LLM math) ---
OVERALL=$(echo "${EVAL_JSON}" | jq --argjson criteria "${ACTIVE_CRITERIA}" '
  ($criteria | map(.weight) | add) as $total_weight |
  [.evaluations[] as $e |
    ($criteria[] | select(.name == $e.criterion)) as $c |
    ($e.score * $c.weight)
  ] | (add // 0) / $total_weight')

# --- Detect hallucinations ---
HALLUCINATIONS=$(echo "${EVAL_JSON}" | jq '[.evaluations[] | select(.rationale | test("hallucinated|does not exist|not found"; "i"))] | length')

# --- Output (workflow parses these lines) ---
echo "${EVAL_JSON}" | jq -r '.evaluations[] | "\(.criterion): \(.score) — \(.rationale)"'
echo ""
printf "Score: %.4f\n" "${OVERALL}"
echo "Result: $(echo "${OVERALL} >= ${PASS_THRESHOLD}" | bc -l | grep -q '^1' && echo "PASS" || echo "FAIL")"
echo "Hallucinations: ${HALLUCINATIONS}"

# --- Exit ---
if (( $(echo "${OVERALL} < ${PASS_THRESHOLD}" | bc -l) )); then
  exit 1
fi
exit 0
