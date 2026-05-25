# Task Assistant Agent

A Strands Agents SDK-based AI agent that manages tasks via natural language, built on AWS-native services.

## Architecture

```
User (CLI / API)
      |
  Strands Agent (Python)
      |
  MCP Client ────── MCP Server (TypeScript, stdio)
      |                    |
  Amazon Bedrock      Task Store (in-memory)
  (Claude Sonnet)          |
      |              Express REST API
  AgentCore
  (Runtime + Memory + Gateway)
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 20+ (for the MCP server / task API)
- AWS credentials with Bedrock access (or use `--mock` flag)

### Setup

```bash
# 1. Start the task API
cd ../
npm install && npm run dev

# 2. Install agent dependencies
cd agent/
pip install -e ".[dev]"

# 3. Run the interactive agent
python scripts/run-agent.py

# 4. Or run the demo (no AWS required)
python scripts/run-demo.py --mock
```

### MCP Server

The agent connects to the task API via MCP. Start the MCP server:

```bash
cd ../
npx ts-node src/mcp/server.ts
```

The agent auto-discovers tools (list_tasks, create_task, etc.) via the MCP protocol.

## Agent Types

### Single Agent (Module 06, Exercise 1)
- `src/task_assistant/agent.py` — conversational task manager
- Uses `@tool` decorated functions or MCP for tool access

### Multi-Agent (Module 06, Exercise 3)
- `src/multi_agent/orchestrator.py` — planner + executor + reviewer
- Demonstrates the "agents-as-tools" pattern from Strands SDK

## Metrics

Every agent invocation emits a `prism.d1.agent` event to EventBridge with:
- `agent_name`, `steps_taken`, `tools_invoked`, `duration_ms`, `tokens_used`, `status`

## Testing

```bash
pytest                    # All tests (mocked Bedrock)
pytest tests/test_agent.py  # Agent tests only
pytest tests/test_tools.py  # Tool tests only
```

## Deploy to AgentCore

```bash
bash scripts/deploy-agentcore.sh
```

Options:
- `--plan` — preview deployment changes without deploying
- `--local` — run locally with `agentcore dev`
- `--destroy` — tear down deployed resources
- `-v, --verbose` — verbose output
