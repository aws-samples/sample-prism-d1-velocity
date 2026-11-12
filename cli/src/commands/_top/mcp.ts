import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageDir } from './version.js';
import { runStdio } from '../../mcp/server.js';

function cliVersion(): string {
  const dir = findPackageDir(dirname(fileURLToPath(import.meta.url)));
  try {
    return dir ? String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version) : 'unknown';
  } catch {
    return 'unknown';
  }
}

export default {
  description: 'MCP server on stdio for Kiro, Claude Code and other MCP clients: read-only codewatch findings and reports, cached spend and the setup checklist. No network listener; exits when stdin closes.',
  options: [],
  async action() {
    await runStdio({ cwd: process.cwd(), home: homedir(), version: cliVersion() });
  },
};
