import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { collectKiroCli, type CodeburnOutput } from '../parse-code-tool/kiro-cli.js';
import { collectKiroIde } from '../parse-code-tool/kiro-ide.js';

/**
 * Emits AI-origin git commit trailers. This is the Node port of the former
 * bash prepare-commit-msg hook logic — it does everything the hook used jq/bc/
 * sed/grep for, so the hook itself becomes a thin `prism-cli` delegator and the
 * whole flow is portable (Windows/macOS/Linux) with only git + node required.
 */

interface Snapshot { inputTokens: number; outputTokens: number; cost: number; }

const DEFAULT_CLAUDE_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

function gitRoot(explicit?: string): string {
  if (explicit) return explicit;
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return process.cwd();
}

/** Detect the AI tool that produced this commit from the environment. */
function detectTool(): { origin: string; tool: string; model: string } {
  const env = process.env;
  let origin = 'human', tool = '', model = '';

  // Claude Code
  if (env.CLAUDE_CODE || env.CLAUDE_CODE_SESSION_ID) {
    origin = 'ai-generated';
    tool = 'claude-code';
    model = env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL;
  }

  // Kiro CLI (KIRO_SESSION_ID) / IDE terminal (TERM_PROGRAM) / Source Control panel (askpass paths)
  if (
    env.KIRO_SESSION_ID ||
    env.KIRO_SESSION ||
    env.TERM_PROGRAM === 'kiro' ||
    (env.VSCODE_GIT_ASKPASS_NODE || '').includes('kiro') ||
    (env.GIT_ASKPASS || '').includes('kiro')
  ) {
    origin = 'ai-generated';
    tool = 'kiro';
    model = '';
  }

  // Amazon Q Developer
  if (env.Q_DEVELOPER_SESSION) {
    origin = 'ai-generated';
    tool = 'q-developer';
  }

  // Cursor (VS Code fork). Checked LAST so any commit made from within Cursor
  // wins the single AI-Tool slot, even when another agent's session env vars are
  // also present (e.g. a CLI agent run inside Cursor's integrated terminal).
  // TERM_PROGRAM=vscode is NOT usable (Cursor inherits VS Code's value), so key
  // off CURSOR_AGENT / CURSOR_TRACE_ID or the askpass path Cursor injects into
  // its terminal + Source Control panel, which contains 'cursor'.
  const cursorAskpass = `${env.VSCODE_GIT_ASKPASS_NODE || ''} ${env.VSCODE_GIT_ASKPASS_MAIN || ''} ${env.GIT_ASKPASS || ''}`.toLowerCase();
  if (env.CURSOR_AGENT === '1' || env.CURSOR_TRACE_ID || cursorAskpass.includes('cursor')) {
    origin = 'ai-generated';
    tool = 'cursor';
    model = '';
  }

  return { origin, tool, model };
}

/** Find a spec reference: an explicit Spec-Ref in the message wins, else a staged spec file. */
function detectSpecRef(repoRoot: string, msg: string): string {
  const explicit = msg.match(/^Spec-Ref:\s*(.+)$/m);
  if (explicit) return explicit[1]!.trim();

  const r = spawnSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8', cwd: repoRoot });
  if (r.status === 0 && r.stdout) {
    for (const f of r.stdout.split('\n')) {
      if (/specs\/|\.kiro\/specs\//.test(f)) return f.trim();
    }
  }
  return '';
}

/** Run `codeburn report` and parse its JSON. Returns null if codeburn is absent or errors.
 *  `provider` (optional) maps to codeburn's `--provider` filter (e.g. 'cursor', 'claude').
 *  It is always a fixed internal literal — never user/LLM input — so the Windows shell
 *  interpolation below is not an injection vector. */
function runCodeburn(projectFilter: string, provider?: string): CodeburnOutput | null {
  const isWin = process.platform === 'win32';
  const providerArgs = provider ? ['--provider', provider] : [];
  const providerCmd = provider ? `--provider ${provider} ` : '';
  const r = isWin
    ? spawnSync(`codeburn report -p all ${providerCmd}--project "${projectFilter}" --format json`, { encoding: 'utf8', shell: true })
    : spawnSync('codeburn', ['report', '-p', 'all', ...providerArgs, '--project', projectFilter, '--format', 'json'], { encoding: 'utf8' });
  if (!r || r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout) as CodeburnOutput; } catch { return null; }
}

/** Collect cumulative token usage for the given tool + project. */
async function collectUsage(tool: string, projectBasename: string, projectFilter: string): Promise<CodeburnOutput | null> {
  if (tool === 'kiro') {
    let out: CodeburnOutput | null = null;
    if (process.env.KIRO_SESSION_ID) {
      out = await collectKiroCli(process.env.KIRO_SESSION_ID, projectBasename);
    }
    if (!out || out.overview.calls === 0) {
      out = await collectKiroIde(projectBasename);
    }
    return out;
  }
  // cursor → codeburn with the cursor provider filter (codeburn natively tracks
  // Cursor usage). Isolating to --provider cursor keeps its snapshot delta from
  // being polluted by other providers' totals.
  if (tool === 'cursor') {
    let out = runCodeburn(projectFilter, 'cursor');
    if (!out || out.overview.calls === 0) out = runCodeburn(projectBasename, 'cursor');
    return out;
  }
  // claude-code / q-developer → codeburn (full-path slug, then basename fallback)
  let out = runCodeburn(projectFilter);
  if (!out || out.overview.calls === 0) out = runCodeburn(projectBasename);
  return out;
}

function sumTokens(o: CodeburnOutput, key: 'inputTokens' | 'outputTokens'): number {
  return (o.models || []).reduce((s, m) => s + (m[key] || 0), 0);
}

function readBounds(repoRoot: string): { maxTokens: number; maxCost: number } {
  let maxTokens = 1_000_000, maxCost = 100;
  const cfg = resolve(repoRoot, '.prism', 'config.json');
  if (existsSync(cfg)) {
    try {
      const j = JSON.parse(readFileSync(cfg, 'utf8'));
      if (typeof j.max_tokens === 'number') maxTokens = j.max_tokens;
      if (typeof j.max_cost === 'number') maxCost = j.max_cost;
    } catch { /* fall through to defaults */ }
  }
  return { maxTokens, maxCost };
}

/** Format a USD cost: up to 4 dp, trailing zeros trimmed (matches the old bc output style). */
function formatCost(c: number): string {
  return (Math.round(c * 10000) / 10000).toString();
}

export default {
  description: 'Emit AI-origin git commit trailers (used by prepare-commit-msg). Portable: no jq/bc/sed required.',
  options: [
    { flags: '--commit-msg-file <path>', description: 'Commit message file to append trailers to (git hook $1). If omitted, prints to stdout' },
    { flags: '--source <source>', description: 'Commit source (git hook $2): merge, squash, message, template, commit' },
    { flags: '--repo <path>', description: 'Repository root (defaults to git rev-parse --show-toplevel)' },
  ],
  async action(opts: { commitMsgFile?: string; source?: string; repo?: string }) {
    // Skip merge/squash commits
    if (opts.source === 'merge' || opts.source === 'squash') return;

    const repoRoot = gitRoot(opts.repo);

    let existingMsg = '';
    if (opts.commitMsgFile && existsSync(opts.commitMsgFile)) {
      try { existingMsg = readFileSync(opts.commitMsgFile, 'utf8'); } catch { /* ignore */ }
    }
    // Don't double-add trailers
    if (/^AI-Origin:/m.test(existingMsg)) return;

    const { origin, tool, model } = detectTool();
    const specRef = detectSpecRef(repoRoot, existingMsg);

    const projectBasename = basename(repoRoot);
    const projectFilter = repoRoot.replace(/^\//, '').replace(/\//g, '-');

    // Token tracking (snapshot delta) — only when an AI tool is detected
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cost: number | null = null;

    if (tool) {
      const usage = await collectUsage(tool, projectBasename, projectFilter);
      if (usage) {
        const curIn = sumTokens(usage, 'inputTokens');
        const curOut = sumTokens(usage, 'outputTokens');
        const curCost = usage.overview?.cost ?? 0;

        const trackerDir = resolve(homedir(), '.prism', 'tokentracker');
        // Snapshot baselines are keyed by (project, tool) so each tool's cumulative
        // usage is isolated. Mixing tools in a single file corrupts deltas because
        // their cumulative bases are not comparable — e.g. a per-session Kiro CLI
        // total vs a lifetime Kiro IDE total, or codeburn's real provider counts vs
        // char-estimated counts. Older un-keyed <project>.json files from before this
        // change are left orphaned (never read again); the first commit per
        // (project, tool) finds no baseline and correctly reports a 0 delta while
        // establishing the new baseline.
        const trackerFile = resolve(trackerDir, `${projectBasename}.${tool}.json`);

        if (existsSync(trackerFile)) {
          try {
            const prev = JSON.parse(readFileSync(trackerFile, 'utf8')) as Snapshot;
            inputTokens = Math.max(0, curIn - (prev.inputTokens || 0));
            outputTokens = Math.max(0, curOut - (prev.outputTokens || 0));
            cost = Math.max(0, curCost - (prev.cost || 0));
          } catch {
            inputTokens = 0; outputTokens = 0; cost = 0;
          }
        } else {
          // First commit for this project — no delta baseline yet
          inputTokens = 0; outputTokens = 0; cost = 0;
        }

        // Persist the new snapshot for the next commit's delta
        try {
          mkdirSync(trackerDir, { recursive: true });
          const snap: Snapshot = { inputTokens: curIn, outputTokens: curOut, cost: curCost };
          writeFileSync(trackerFile, JSON.stringify(snap) + '\n');
        } catch { /* non-fatal */ }
      }
    }

    // Clamp to configured bounds
    const { maxTokens, maxCost } = readBounds(repoRoot);
    if (inputTokens !== null) inputTokens = Math.min(inputTokens, maxTokens);
    if (outputTokens !== null) outputTokens = Math.min(outputTokens, maxTokens);
    if (cost !== null && cost > maxCost) cost = maxCost;

    // Build trailer block
    const lines: string[] = [`AI-Origin: ${origin}`];
    if (tool) lines.push(`AI-Tool: ${tool}`);
    if (model) lines.push(`AI-Model: ${model}`);
    if (inputTokens !== null) lines.push(`AI-Input-Tokens: ${inputTokens}`);
    if (outputTokens !== null) lines.push(`AI-Output-Tokens: ${outputTokens}`);
    if (cost !== null) lines.push(`AI-Cost: $${formatCost(cost)}`);
    if (specRef) lines.push(`Spec-Ref: ${specRef}`);
    const block = lines.join('\n');

    if (opts.commitMsgFile) {
      // Ensure a blank line separates the message body from the trailers
      let out = existingMsg;
      if (out.length > 0) out = out.replace(/\n+$/, '') + '\n\n';
      out += block + '\n';
      try { writeFileSync(opts.commitMsgFile, out); } catch { /* fail open — never block the commit */ }
    } else {
      console.log(block);
    }
  },
};
