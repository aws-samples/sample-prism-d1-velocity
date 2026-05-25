# Spec: [Agent Workflow Name]

> Template: `agent-workflow` | PRISM D1 Velocity
> Recommended for: PRISM Level 3+ teams
> Implementation: Strands Agents SDK | MCP for tools | AgentCore for deployment

## Summary

_One-paragraph description of the agentic workflow — what it autonomously accomplishes, what triggers it, and what value it delivers._

## Technology Stack

| Component | Technology | Purpose |
|---|---|---|
| Agent Framework | [Strands Agents SDK](https://github.com/strands-agents/sdk-python) | Agent orchestration, tool dispatch, reasoning loops |
| Tool Integration | [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) | Standardized tool discovery and invocation |
| Production Runtime | [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/) | Managed agent hosting, memory, gateway, guardrails |
| LLM Inference | Amazon Bedrock | Claude model access via Bedrock API |
| Content Safety | Bedrock Guardrails | Content filtering, topic denial, PII protection |
| Metrics Pipeline | EventBridge + DynamoDB | PRISM metric collection and storage |

## Workflow Overview

- **Trigger**: `user-initiated | event-driven | scheduled | API call`
- **Agent Model**: `anthropic.claude-sonnet-4-20250514`
- **Agent Framework**: Strands Agents SDK
- **Tool Integration**: MCP servers (see Tool Definitions below)
- **Deployment Target**: Amazon Bedrock AgentCore
- **Tool Access**: _[List tools/APIs the agent can invoke]_
- **Guardrails**: _[List safety boundaries]_
- **Max Steps**: _[Maximum number of tool-use iterations]_
- **Timeout**: _[Maximum wall-clock time]_

## Requirements

1. The agent MUST accomplish [describe the goal] by orchestrating [list the tools/steps].
2. The agent MUST operate within the defined guardrails — it MUST NOT [list prohibited actions].
3. The agent MUST complete within [N] steps and [N] seconds.
4. The agent MUST produce a structured output conforming to the output schema.
5. The agent MUST log every tool invocation with: `tool_name`, `input_summary`, `output_summary`, `duration_ms`.
6. The agent MUST handle tool failures gracefully — retry once, then degrade or report the failure.
7. The agent MUST include its reasoning trace in the output for auditability.
8. All agent invocations MUST be evaluated via Bedrock Evaluation before production use.
9. _[Add additional requirements]_

## Agent Configuration

### System Prompt

```
You are an agent that [describe role and goal].

You have access to the following tools:
- [tool_1]: [description]
- [tool_2]: [description]

Rules:
- Always [rule 1].
- Never [rule 2].
- If you are unsure, [fallback behavior].
```

### Tools

| Tool Name | Purpose | Input | Output | Side Effects |
|---|---|---|---|---|
| _[tool_1]_ | _[what it does]_ | _[input schema summary]_ | _[output schema summary]_ | _[e.g., writes to DB, sends email]_ |
| _[tool_2]_ | | | | |

### Guardrails

| Guardrail | Type | Description |
|---|---|---|
| Max steps | Hard limit | Agent stops after [N] iterations |
| Timeout | Hard limit | Agent stops after [N] seconds |
| Prohibited actions | Deny list | Agent MUST NOT [list actions] |
| Data access scope | Allowlist | Agent can only access [list scopes] |
| Human approval gate | Checkpoint | Agent pauses for human approval before [action] |

## Input Schema

```json
{
  "task": "string — description of what the agent should accomplish",
  "context": {
    "key": "value — any relevant context"
  },
  "constraints": {
    "max_steps": 10,
    "timeout_seconds": 120
  }
}
```

## Output Schema

```json
{
  "status": "success | failure | partial",
  "result": {
    "summary": "string — human-readable summary of what was done",
    "artifacts": ["list of produced artifacts (file paths, URLs, etc.)"],
    "reasoning_trace": ["step 1 reasoning", "step 2 reasoning"]
  },
  "metrics": {
    "steps_taken": 5,
    "tools_invoked": 3,
    "duration_ms": 4500,
    "tokens_used": 12000
  }
}
```

## Acceptance Criteria

### Successful Completion

**Given** a valid task input within the agent's capabilities,
**When** the agent workflow is triggered,
**Then** it completes within the step and time limits, producing a structured output with `status: success`.

### Guardrail Enforcement

**Given** a task that would require a prohibited action,
**When** the agent encounters the guardrail,
**Then** it stops, reports the constraint, and returns `status: failure` with explanation.

### Tool Failure Recovery

**Given** a tool invocation that fails,
**When** the agent encounters the failure,
**Then** it retries once, and if still failing, either uses an alternative path or returns `status: partial`.

### Human Approval Gate

**Given** the workflow reaches an action requiring human approval,
**When** the agent reaches that step,
**Then** it pauses execution and waits for explicit approval before proceeding.

### Timeout

**Given** a task that takes longer than the configured timeout,
**When** the timeout is reached,
**Then** the agent stops gracefully, returns what it has so far with `status: partial`.

### Eval Quality Gate

**Given** the agent's output,
**When** Bedrock Evaluation is run against the output,
**Then** the output scores >= 0.82 on the relevant rubric.

### _[Add scenario-specific criteria]_

**Given** _[precondition]_,
**When** _[action]_,
**Then** _[expected result]_.

## Design Constraints

- The agent MUST be stateless between invocations — all state lives in the input/output.
- Tool implementations MUST be idempotent where possible.
- The agent MUST NOT make irreversible changes without human approval.
- All agent invocations MUST be auditable via the reasoning trace.
- Tools MUST be exposed via MCP servers for discoverability and reuse across agents.
- The agent MUST be deployable to AgentCore without code changes (configuration-driven).
- _[Add project-specific constraints]_

## Strands SDK Implementation

```python
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.tools.mcp import MCPClient
from mcp import StdioServerParameters

# Connect to MCP tool servers
mcp_client = MCPClient(
    lambda: StdioServerParameters(
        command="node",
        args=["path/to/mcp-server.js"],
    )
)

model = BedrockModel(
    model_id="anthropic.claude-sonnet-4-20250514",
    region_name="us-west-2",
)

with mcp_client:
    agent = Agent(
        model=model,
        system_prompt="You are an agent that [describe role]. ...",
        tools=mcp_client.list_tools_sync(),
        max_steps=15,
    )
    result = agent("[Task description from input]")
```

_Customize the system prompt, model, MCP server, and max_steps for your workflow._

## AgentCore Deployment Configuration

Deploy this agent to production using AgentCore. Configuration templates are in `agent-configs/`.

| Config File | Purpose |
|---|---|
| `agent-configs/agentcore-runtime.json` | Runtime: handler, timeout, model, environment |
| `agent-configs/agentcore-memory.json` | Session memory: TTL, storage, context management |
| `agent-configs/agentcore-gateway.json` | Gateway: endpoint, auth, rate limits, MCP servers |
| `agent-configs/guardrails-template.json` | Guardrails: content filters, denied topics, PII |

Deployment steps:

1. Customize each config file — replace `<PLACEHOLDER>` values.
2. Package the agent handler as a Lambda function.
3. Deploy via CDK or AWS CLI:
   ```bash
   aws bedrock-agentcore create-runtime \
     --cli-input-json file://agent-configs/agentcore-runtime.json
   ```
4. Attach guardrails and configure the gateway endpoint.
5. Validate with the agent eval workflow (`.github/workflows/prism-agent-eval.yml`).

## Dependencies

- **Bedrock**: Model access for the configured `agent_model`.
- **Strands SDK**: `strands-agents` and `strands-agents-tools` Python packages.
- **MCP SDK**: `@modelcontextprotocol/sdk` (TypeScript) or `mcp` (Python) for tool servers.
- **AgentCore**: AWS Bedrock AgentCore for production runtime, memory, and gateway.
- **Tools**: _[List tool implementations and their dependencies]_
- **Auth**: _[How the agent authenticates to tools — IAM role, service account, etc.]_

## Metrics to Emit

| Event Type | When | Key Fields |
|---|---|---|
| `prism.d1.commit` | Agent code committed | `ai_context.origin`, `ai_context.tool` |
| `prism.d1.eval` | Agent output evaluated | `metric.name: "eval_score"`, `metric.value` |

Agent-specific runtime metrics:

- `agent.invocation.duration` — Histogram of total workflow duration.
- `agent.invocation.steps` — Histogram of steps per invocation.
- `agent.invocation.tokens` — Counter of tokens consumed.
- `agent.tool.invocation_count` — Counter by tool name.
- `agent.tool.error_rate` — Rate of tool failures by tool name.
- `agent.guardrail.trigger_count` — Counter of guardrail activations.

## Eval Criteria

Bedrock Evaluation should check:

- **Task completion**: Did the agent accomplish the stated goal?
- **Correctness**: Are the produced artifacts accurate and complete?
- **Efficiency**: Did the agent complete in a reasonable number of steps?
- **Safety**: Did the agent respect all guardrails?
- **Traceability**: Is the reasoning trace complete and coherent?

Rubrics: `.prism/.prism/eval-harness/rubrics/agent-quality.json`, `.prism/.prism/eval-harness/rubrics/code-quality.json`, `.prism/.prism/eval-harness/rubrics/security-compliance.json`
