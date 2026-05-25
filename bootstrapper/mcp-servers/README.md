# MCP Server Patterns

> PRISM D1 Velocity -- Model Context Protocol server patterns and reference implementations.

## Overview

MCP (Model Context Protocol) servers expose tools and resources that agents can discover and invoke at runtime. This directory contains patterns and guidance for building MCP servers that integrate with the PRISM D1 agent development workflow.

## What Is an MCP Server?

An MCP server is a process that speaks the [Model Context Protocol](https://modelcontextprotocol.io/) -- an open standard for connecting AI models to external tools and data sources. Instead of hard-coding tool integrations into your agent, you expose them as MCP servers that any compatible agent can discover and use.

Key concepts:
- **Tools**: Functions the agent can call (e.g., `query_database`, `create_ticket`, `run_test`)
- **Resources**: Read-only data the agent can access (e.g., configuration, documentation, schemas)
- **Transports**: How the client and server communicate (`stdio` for local, `streamable-http` for production)

## Server Patterns

### Pattern 1: Database Query Server

Exposes read-only database queries as tools. The agent can search, filter, and aggregate data without direct database access.

```
Tools: query_table, get_record_by_id, search_records
Resources: table_schemas, query_examples
Transport: stdio (dev), streamable-http (prod)
```

### Pattern 2: CI/CD Integration Server

Exposes CI/CD operations -- check build status, trigger deployments, read logs.

```
Tools: get_build_status, trigger_deploy, get_deploy_logs, rollback
Resources: pipeline_config, environment_list
Transport: streamable-http
```

### Pattern 3: Code Analysis Server

Exposes static analysis, linting, and code search capabilities.

```
Tools: search_codebase, run_linter, get_file_ast, find_references
Resources: lint_rules, project_structure
Transport: stdio
```

### Pattern 4: Notification/Communication Server

Exposes messaging capabilities -- send alerts, post to channels, create tickets.

```
Tools: send_slack_message, create_jira_ticket, send_email
Resources: channel_list, ticket_templates
Transport: streamable-http
```

## Building an MCP Server

### 1. Write the spec first

Use the `spec-templates/mcp-server.md` template:

```bash
cp bootstrapper/spec-templates/mcp-server.md specs/my-mcp-server.md
# Edit the spec with your tools, resources, and requirements
```

### 2. Implement with the MCP SDK

**TypeScript:**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "your-org/your-server",
  version: "1.0.0",
});

// Register a tool
server.tool(
  "query_records",
  "Search records by filter criteria",
  { filter: { type: "string", description: "Search query" } },
  async ({ filter }) => {
    const results = await db.search(filter);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Python:**

```python
from mcp.server import Server
from mcp.server.stdio import stdio_server

server = Server("your-org/your-server")

@server.tool()
async def query_records(filter: str) -> str:
    """Search records by filter criteria."""
    results = await db.search(filter)
    return json.dumps(results)

async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write)
```

### 3. Test independently

Test your MCP server before connecting it to an agent:

```bash
# Use the MCP Inspector for interactive testing
npx @modelcontextprotocol/inspector your-server-command

# Or run your acceptance criteria as automated tests
npm test  # / pytest
```

### 4. Register in agent config

Add the server to your agent's gateway configuration (`agent-configs/agentcore-gateway.json`):

```json
{
  "mcp_servers": [
    {
      "name": "your-server",
      "transport": "stdio",
      "command": "node",
      "args": ["dist/server.js"]
    }
  ]
}
```

## Connecting MCP Servers to Strands Agents

```python
from strands import Agent
from strands.tools.mcp import MCPClient
from mcp import StdioServerParameters

# Connect to an MCP server
mcp_client = MCPClient(
    lambda: StdioServerParameters(
        command="node",
        args=["path/to/server.js"],
    )
)

with mcp_client:
    agent = Agent(
        tools=mcp_client.list_tools_sync(),
    )
    result = agent("Use the tools to complete the task.")
```

## Directory Structure

```
mcp-servers/
  README.md              -- This file
  # Add your MCP server implementations here:
  # my-server/
  #   src/
  #   package.json
  #   spec.md -> ../../specs/my-mcp-server.md
```

## Related Resources

| Resource | Location |
|---|---|
| MCP server spec template | `spec-templates/mcp-server.md` |
| Agent eval rubric | `.prism/.prism/eval-harness/rubrics/agent-quality.json` |
| AgentCore gateway config | `agent-configs/agentcore-gateway.json` |
| Agent CLAUDE.md template | `claude-code/CLAUDE-agent.md` |
| MCP specification | https://modelcontextprotocol.io/ |
