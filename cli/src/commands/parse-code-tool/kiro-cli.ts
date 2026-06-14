import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CHARS_PER_TOKEN = 4;

const MODEL_COSTS: Record<string, [number, number]> = {
  'claude-sonnet-4-6': [0.003, 0.015],
  'claude-sonnet-4-5': [0.003, 0.015],
  'claude-sonnet-4': [0.003, 0.015],
  'claude-haiku-4-5': [0.0008, 0.004],
  'claude-opus-4-6': [0.015, 0.075],
  'kiro-auto': [0.003, 0.015],
};

function calculateCost(model: string, input: number, output: number): number {
  const [inCost, outCost] = MODEL_COSTS[model] ?? [0.003, 0.015];
  return (input * inCost + output * outCost) / 1000;
}

function getCliSessionsDir(): string {
  return join(homedir(), '.kiro', 'sessions', 'cli');
}

interface SessionEntry {
  version?: string;
  kind?: string;
  data?: { content?: Array<{ kind?: string; data?: any }> };
}

export default {
  description: 'Parse Kiro CLI session files and output token usage (codeburn-compatible JSON)',
  options: [
    { flags: '--session-id <id>', description: 'Kiro CLI session ID (defaults to KIRO_SESSION_ID env)' },
    { flags: '--project <name>', description: 'Project name for output (defaults to basename of cwd)' },
    { flags: '--format <fmt>', description: 'Output format: json, summary', default: 'json' },
  ],
  async action(opts: { sessionId?: string; project?: string; format: string }) {
    const sessionId = opts.sessionId || process.env.KIRO_SESSION_ID;
    if (!sessionId) {
      console.error('No session ID: pass --session-id or set KIRO_SESSION_ID');
      process.exit(1);
    }

    const filePath = join(getCliSessionsDir(), `${sessionId}.jsonl`);
    let raw: string;
    try { raw = await readFile(filePath, 'utf-8'); } catch {
      // No session file — output zero tokens
      const output = { overview: { cost: 0, calls: 0, sessions: 0 }, models: [], projects: [] };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    let inputChars = 0, outputChars = 0, calls = 0;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: SessionEntry;
      try { entry = JSON.parse(line); } catch { continue; }

      const kind = entry.kind;
      const content = entry.data?.content;
      if (!content || !Array.isArray(content)) continue;

      for (const item of content) {
        if (item.kind === 'text' && typeof item.data === 'string') {
          if (kind === 'Prompt' || kind === 'ToolResults') inputChars += item.data.length;
          else if (kind === 'AssistantMessage') { outputChars += item.data.length; }
        } else if (item.kind === 'toolUse' && item.data) {
          // Tool calls are output (assistant decided to call a tool)
          outputChars += JSON.stringify(item.data.input ?? '').length;
        } else if (item.kind === 'toolResult' && item.data) {
          // Tool results are input (fed back to model)
          const rc = item.data.content;
          if (Array.isArray(rc)) {
            for (const r of rc) inputChars += typeof r.data === 'string' ? r.data.length : JSON.stringify(r.data ?? '').length;
          }
        }
      }

      if (kind === 'AssistantMessage') calls++;
    }

    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
    const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
    const model = 'kiro-auto';
    const cost = calculateCost(model, inputTokens, outputTokens);
    const projectName = opts.project || 'unknown';

    const output = {
      overview: { cost: Math.round(cost * 100) / 100, calls, sessions: 1 },
      models: [{ name: model, inputTokens, outputTokens }],
      projects: [{ name: projectName, cost: Math.round(cost * 100) / 100, calls }],
    };

    if (opts.format === 'summary') {
      console.log(`Kiro CLI Token Usage (session: ${sessionId.slice(0, 8)}...)`);
      console.log(`  Calls: ${calls}`);
      console.log(`  Cost:  $${output.overview.cost}`);
      console.log(`  ${model}: ${inputTokens} in / ${outputTokens} out`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  },
};
