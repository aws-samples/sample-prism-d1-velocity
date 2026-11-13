import { homedir } from 'node:os';
import { ownVersion } from './version.js';
import { runStdio } from '../../mcp/server.js';

export default {
  description: 'MCP server on stdio for Kiro, Claude Code and other MCP clients: read-only codewatch findings and reports, cached spend and the setup checklist, plus a static dashboard snapshot file. No network listener; exits when stdin closes.',
  options: [],
  async action() {
    await runStdio({ cwd: process.cwd(), home: homedir(), version: ownVersion() });
  },
};
