# CLAUDE.md -- Agent Development Teams

> PRISM D1 Velocity -- AI-native SDLC bootstrapper.
> Paste this section into your repo's `CLAUDE.md` if your project includes agentic workflows.

## Agent Development Rules

### 1. Spec-First for Agents

Every agent workflow MUST have a corresponding spec in `specs/` before implementation begins. Use the `agent-workflow` template for orchestration agents and the `mcp-server` template for tool servers. The spec defines the agent's goal, tools, guardrails, input/output schemas, and acceptance criteria. Do not write agent code without a spec.

### 2. Guardrails Are Non-Negotiable

Every agent MUST have explicitly defined guardrails in its spec and enforced in its runtime configuration. Guardrails include: max step count, wall-clock timeout, prohibited actions (deny list), data access scope (allow list), and human approval gates for irreversible actions. Use Bedrock Guardrails (`agent-configs/guardrails-template.json`) for content filtering and topic denial. Never deploy an agent without guardrails -- even in development.

### 3. Idempotent Tool Implementations

All tools exposed to agents (whether via MCP servers or direct function calls) MUST be idempotent for read operations and safely retriable for write operations. Agents retry on failure by design -- tools that produce duplicate side effects on retry are a production hazard. Use idempotency keys for any tool that creates, updates, or deletes resources.

### 4. Agent Metrics Emission

Every agent invocation MUST emit structured PRISM metric events. At minimum, emit:
- `prism.d1.agent.invocation` -- on every agent run (duration, steps, tokens, status)
- `prism.d1.agent.tool_call` -- on every tool invocation within the agent (tool name, duration, success/failure)
- `prism.d1.agent.guardrail` -- when a guardrail is triggered (guardrail name, action taken)
- `prism.d1.agent.eval` -- when an agent output is evaluated (eval score, rubric, pass/fail)

Use the metric hooks in `metric-hooks/` and the EventBridge bus `prism-d1-metrics`.

### 5. MCP Server Validation

Before connecting an agent to an MCP server, validate the server independently:
- Confirm it responds to `initialize` and `tools/list` correctly.
- Test each tool with valid and invalid inputs.
- Verify error responses use proper MCP error codes.
- Check that no credentials or internal details leak in tool outputs.
- Run the MCP server spec's acceptance criteria as integration tests.

### 6. Reviewer Agents for Critical Paths

For agents that perform high-impact actions (deployments, data mutations, customer-facing changes), implement a reviewer agent pattern: a second agent that evaluates the primary agent's plan before execution. The reviewer agent should check the plan against the spec's guardrails and acceptance criteria. Log the reviewer's assessment as part of the reasoning trace.

## Agent Conventions

### Strands Agents SDK

Use the [Strands Agents SDK](https://github.com/strands-agents/sdk-python) as the standard framework for building agents in this project.

```python
from strands import Agent
from strands.models.bedrock import BedrockModel

# Standard agent setup pattern
model = BedrockModel(
    model_id="anthropic.claude-sonnet-4-20250514",
    region_name="us-west-2",
)

agent = Agent(
    model=model,
    system_prompt="You are an agent that [describe role]. ...",
    tools=[tool_one, tool_two],  # Decorated @tool functions
    max_steps=15,
)

result = agent("Perform the task described in the input.")
```

- Decorate tool functions with `@tool` from `strands.tools`.
- Keep tool functions focused -- one tool, one responsibility.
- Always set `max_steps` to prevent runaway agents.
- Use callback handlers for logging, metrics emission, and guardrail checks.

### Model Selection

| Use Case | Model | Rationale |
|---|---|---|
| Complex multi-step reasoning | `anthropic.claude-sonnet-4-20250514` | Best balance of capability and cost for agentic loops |
| Simple single-tool tasks | `anthropic.claude-haiku-3-20250318` | Lower latency and cost for straightforward tasks |
| Code generation within agent | `anthropic.claude-sonnet-4-20250514` | Strong code generation with tool use |
| Reviewer / evaluator agent | `anthropic.claude-sonnet-4-20250514` | Needs strong reasoning for plan evaluation |

### AgentCore Deployment

For production deployment, use Amazon Bedrock AgentCore:

- **Runtime**: Package agents with `agentcore-runtime.json` for managed execution.
- **Memory**: Configure session memory with `agentcore-memory.json` for multi-turn conversations.
- **Gateway**: Expose agents via API Gateway using `agentcore-gateway.json`.
- **Guardrails**: Attach Bedrock Guardrails using `guardrails-template.json`.

Configuration templates are in `agent-configs/`. Customize the placeholders and deploy via CDK or CLI.

```bash
# Deploy agent runtime
aws bedrock-agentcore create-runtime --cli-input-json file://agent-configs/agentcore-runtime.json

# Attach guardrails
aws bedrock create-guardrail --cli-input-json file://agent-configs/guardrails-template.json
```

### MCP Integration

Agents connect to external capabilities via MCP (Model Context Protocol) servers:

- Use `stdio` transport for local development and testing.
- Use `streamable-http` transport for production deployments.
- Define MCP server specs using the `mcp-server` template before implementation.
- Register MCP servers in the agent's gateway configuration (`agentcore-gateway.json`).

## Agent Metrics Schema Reference

Agent-specific metrics extend the base PRISM metrics schema:

```json
{
  "source": "prism.d1.velocity",
  "detail-type": "prism.d1.agent.invocation",
  "detail": {
    "team_id": "string",
    "repo": "string",
    "timestamp": "ISO8601",
    "agent": {
      "name": "string",
      "version": "string",
      "model": "string",
      "steps_taken": "number",
      "tools_invoked": "number",
      "tokens_used": "number",
      "duration_ms": "number",
      "status": "success | failure | partial",
      "guardrails_triggered": "number",
      "error": "string | null"
    },
    "ai_context": {
      "tool": "strands-agent",
      "model": "anthropic.claude-sonnet-4-20250514",
      "session_id": "string",
      "origin": "ai-generated"
    }
  }
}
```

## Quick Reference

| Item | Location |
|---|---|
| Agent workflow spec template | `spec-templates/agent-workflow.md` |
| MCP server spec template | `spec-templates/mcp-server.md` |
| Agent eval rubric | `.prism/.prism/eval-harness/rubrics/agent-quality.json` |
| AgentCore configs | `agent-configs/` |
| Guardrails template | `agent-configs/guardrails-template.json` |
| Agent eval workflow | `.github/workflows/prism-agent-eval.yml` |
| MCP server patterns | `mcp-servers/` |
