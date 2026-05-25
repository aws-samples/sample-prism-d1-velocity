# AgentCore Deployment Templates

> PRISM D1 Velocity -- Configuration templates for deploying agents with Amazon Bedrock AgentCore.

## Overview

This directory contains configuration templates for deploying production agents using Amazon Bedrock AgentCore. Each template is a JSON file with placeholder values that you customize for your agent before deployment.

| Template | Purpose |
|---|---|
| `agentcore-runtime.json` | Agent runtime configuration -- handler, memory, timeout, model access |
| `agentcore-memory.json` | Session memory configuration -- TTL, branching, storage backend |
| `agentcore-gateway.json` | API Gateway configuration -- endpoint, auth, rate limits, MCP servers |
| `guardrails-template.json` | Bedrock Guardrails -- content filters, denied topics, sensitive info filters |

## Getting Started

### 1. Copy and customize

```bash
# Copy templates into your project
cp -r bootstrapper/agent-configs/ .prism/agent-configs/

# Edit each template -- replace all <PLACEHOLDER> values
# with your actual configuration
```

### 2. Customize placeholders

Every template uses `<PLACEHOLDER>` syntax for values you must replace. Search for `<` in the files to find all placeholders:

```bash
grep -r '<' .prism/agent-configs/*.json
```

### 3. Deploy the runtime

```bash
# Create the agent runtime
aws bedrock-agentcore create-runtime \
  --cli-input-json file://.prism/agent-configs/agentcore-runtime.json

# Create guardrails
aws bedrock create-guardrail \
  --cli-input-json file://.prism/agent-configs/guardrails-template.json
```

### 4. Validate the deployment

After deployment, verify:
- The agent runtime is active and responding to invocations.
- Guardrails are attached and enforcing content policies.
- The gateway endpoint is accessible with the configured authentication.
- Session memory is persisting across multi-turn conversations.

## Configuration Relationships

```
agentcore-gateway.json
  |
  +-- agentcore-runtime.json (the agent that handles requests)
  |     |
  |     +-- agentcore-memory.json (session memory for the runtime)
  |     +-- guardrails-template.json (content safety for the runtime)
  |
  +-- mcp_servers[] (external tool servers the agent connects to)
```

## Integration with PRISM Metrics

All AgentCore configurations should include the PRISM team ID and event bus name in their environment variables. This enables automatic metric emission:

```json
{
  "PRISM_TEAM_ID": "your-team-id",
  "PRISM_EVENT_BUS": "prism-d1-metrics"
}
```

Agents deployed via AgentCore emit metrics through the standard PRISM pipeline. See `claude-code/CLAUDE-agent.md` for the agent metrics schema.

## Prerequisites

- AWS account with Bedrock AgentCore access enabled
- IAM role with permissions for `bedrock-agentcore:*`, `bedrock:*`, and `events:PutEvents`
- PRISM D1 infrastructure deployed (`infra/` CDK stacks)
- Agent code packaged and tested locally before deployment
