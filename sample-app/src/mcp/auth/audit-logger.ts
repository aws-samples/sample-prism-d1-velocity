/**
 * MCP Audit Logger — emits prism.d1.mcp.tool_call events to EventBridge.
 *
 * Non-blocking: audit failures are logged but never crash the server.
 */

export interface MCPToolCallAudit {
  session_id: string;
  client_id: string;
  tool_name: string;
  scopes_used: string[];
  authorized: boolean;
  risk_level: string;
  timestamp: string;
  duration_ms: number;
  result_status: 'success' | 'error' | 'denied';
}

export interface AuditLoggerConfig {
  teamId: string;
  repo: string;
  eventBusName: string;
  awsRegion: string;
  enabled: boolean;
}

export class MCPAuditLogger {
  private config: AuditLoggerConfig;

  constructor(config: AuditLoggerConfig) {
    this.config = config;
  }

  async log(audit: MCPToolCallAudit): Promise<void> {
    if (!this.config.enabled) return;

    const event = {
      team_id: this.config.teamId,
      repo: this.config.repo,
      timestamp: audit.timestamp,
      prism_level: 3,
      metric: {
        name: 'mcp_tool_call',
        value: 1,
        unit: 'count',
      },
      mcp_tool_call: {
        session_id: audit.session_id,
        client_id: audit.client_id,
        tool_name: audit.tool_name,
        scopes_used: audit.scopes_used,
        authorized: audit.authorized,
        risk_level: audit.risk_level,
        duration_ms: audit.duration_ms,
        result_status: audit.result_status,
      },
    };

    try {
      // Dynamic import to avoid requiring AWS SDK at module load time
      const { EventBridgeClient, PutEventsCommand } = await import(
        '@aws-sdk/client-eventbridge'
      );
      const client = new EventBridgeClient({ region: this.config.awsRegion });
      await client.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: 'prism.d1.velocity',
              DetailType: 'prism.d1.mcp.tool_call',
              EventBusName: this.config.eventBusName,
              Detail: JSON.stringify(event),
            },
          ],
        }),
      );
    } catch (err) {
      // Non-blocking — audit should never crash the MCP server
      console.error('Warning: Failed to emit MCP audit event:', err);
    }
  }
}
