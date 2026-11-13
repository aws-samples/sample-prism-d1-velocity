import { homedir } from 'node:os';
import { ownVersion } from './version.js';
import { runStdio } from '../../mcp/server.js';

export default {
  description: 'MCP server on stdio for Kiro, Claude Code and other MCP clients: read-only codewatch findings and reports, cached spend and the setup checklist, a static dashboard snapshot file, and the live dashboard on 127.0.0.1 as a child process. The MCP server itself opens no port; it exits when stdin closes, stopping that dashboard.',
  options: [],
  async action() {
    await runStdio({ cwd: process.cwd(), home: homedir(), version: ownVersion() });
  },
};
