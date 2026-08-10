import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Dirent } from 'node:fs';
import type { CodeburnOutput } from './kiro-cli.js';

const CHARS_PER_TOKEN = 4;
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000;

type ParsedCall = { model: string; inputTokens: number; outputTokens: number; costUSD: number; timestamp: string; project: string };

// Simple cost estimation (Claude pricing per 1K tokens)
const MODEL_COSTS: Record<string, [number, number]> = {
  'claude-sonnet-4-6': [0.003, 0.015],
  'claude-sonnet-4-5': [0.003, 0.015],
  'claude-sonnet-4': [0.003, 0.015],
  'claude-haiku-4-5': [0.0008, 0.004],
  'kiro-auto': [0.003, 0.015],
};

function calculateCost(model: string, input: number, output: number): number {
  const [inCost, outCost] = MODEL_COSTS[model] ?? [0.003, 0.015];
  return (input * inCost + output * outCost) / 1000;
}

function getKiroAgentDir(): string {
  const kiroServer = join(homedir(), '.kiro-server', 'data', 'User', 'globalStorage', 'kiro.kiroagent');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
  return existsSync(kiroServer) ? kiroServer : join(homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent');
}

function getKiroWorkspaceStorageDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'workspaceStorage');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'workspaceStorage');
  return join(homedir(), '.config', 'Kiro', 'User', 'workspaceStorage');
}

async function readWorkspaceProject(workspaceDir: string): Promise<string> {
  try {
    const raw = await readFile(join(workspaceDir, 'workspace.json'), 'utf-8');
    const data = JSON.parse(raw) as { folder?: string };
    if (data.folder) return basename(decodeURIComponent(data.folder.replace(/^file:\/\//, '')));
  } catch {}
  return basename(workspaceDir);
}

function extractProjectFromContent(raw: string): string | null {
  // Linux/macOS: /home/<user>/workplace/<project>/
  const unix = raw.match(/\/(?:local\/)?home\/[^/]+\/(?:workplace|workspace|projects?)\/([a-zA-Z0-9_.-]+)/);
  if (unix) return unix[1]!;
  // Windows: C:\Users\<user>\projects\<project>\ (known dev parent dirs)
  const win = raw.match(/[A-Z]:\\\\Users\\\\[^\\]+\\\\(?:projects?|workspace|dev|repos|source)\\\\([a-zA-Z0-9_.-]+)/i);
  if (win) return win[1]!;
  // Windows fallback: first non-system folder after Users\<user>\ 
  const SYSTEM_DIRS = new Set(['appdata', 'desktop', 'documents', 'downloads', 'onedrive', '.vscode', '.config', '.local', '.kiro-server']);
  const winFallback = raw.match(/[A-Z]:\\\\Users\\\\[^\\]+\\\\([a-zA-Z0-9_.-]+)\\\\([a-zA-Z0-9_.-]+)/i);
  if (winFallback) {
    const dir1 = winFallback[1]!.toLowerCase();
    if (SYSTEM_DIRS.has(dir1)) return null; // skip system dirs
    return winFallback[1]!;
  }
  return null;
}

function normalizeModelId(raw: string): string {
  return raw.replace(/(\d+)\.(\d+)/g, '$1-$2');
}

function parseTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let parsed: number | string = typeof value === 'string' ? value.trim() : value as number;
  if (typeof parsed === 'string' && /^-?\d+(\.\d+)?$/.test(parsed)) parsed = Number(parsed);
  if (typeof parsed === 'number') {
    if (!Number.isFinite(parsed)) return null;
    const ms = parsed < MIN_REASONABLE_TIMESTAMP_MS ? parsed * 1000 : parsed;
    const d = new Date(ms);
    return d.getTime() >= MIN_REASONABLE_TIMESTAMP_MS ? d.toISOString() : null;
  }
  const d = new Date(parsed);
  return d.getTime() >= MIN_REASONABLE_TIMESTAMP_MS ? d.toISOString() : null;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['content', 'text', 'message', 'value', 'parts', 'entries']) {
      const text = extractText((value as Record<string, unknown>)[key]);
      if (text) return text;
    }
  }
  return '';
}

async function parseSessionFile(filePath: string, project: string, sessionProjectMap: Map<string, string>, targetProject?: string): Promise<ParsedCall | null> {
  let raw: string;
  try { raw = await readFile(filePath, 'utf-8'); } catch { return null; }
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object') return null;

  // Resolve project: (1) chatSessionId map, (2) content regex with multi-project split, (3) hash fallback
  let resolvedProject = project;
  let projectFraction = 1.0;
  if (/^[0-9a-f]{32}$/.test(project)) {
    const chatSessionId = typeof data.chatSessionId === 'string' ? data.chatSessionId : '';
    if (chatSessionId && sessionProjectMap.has(chatSessionId)) {
      resolvedProject = sessionProjectMap.get(chatSessionId)!;
    } else {
      // Find all unique projects referenced in session content using /<name>/ pattern
      // Use known parent dirs for discovery, but simple /<name>/ for matching
      const projectPattern = /\/([a-zA-Z0-9_][a-zA-Z0-9_.-]{2,})\/(?:src|lib|bin|cli|infra|app|docs|test|scripts?|config|public|bootstrapper|\.kiro|\.github|\.prism|package\.json|tsconfig|README)/g;
      const discoveredProjects = new Set<string>();
      let match;
      while ((match = projectPattern.exec(raw)) !== null) {
        const name = match[1]!;
        // Skip common non-project dirs
        if (['home', 'local', 'usr', 'var', 'tmp', 'etc', 'opt', 'node_modules', 'dist', 'build', 'out', '.git'].includes(name)) continue;
        discoveredProjects.add(name);
      }

      // If target project specified, use simple /<name>/ containment check
      if (targetProject && raw.includes(`/${targetProject}/`)) {
        resolvedProject = targetProject;
        // Count how many other projects are also in this session for splitting
        const otherProjects = [...discoveredProjects].filter(p => p !== targetProject && raw.includes(`/${p}/`));
        projectFraction = 1.0 / (1 + otherProjects.length);
      } else if (discoveredProjects.size > 0) {
        resolvedProject = [...discoveredProjects][0]!;
        projectFraction = 1.0 / discoveredProjects.size;
      } else {
        resolvedProject = project; // hash fallback
      }
    }
  }

  const metadata = data.metadata as Record<string, unknown> | undefined;

  // Resolve model
  let modelId = normalizeModelId(
    String(data.modelId ?? data.model ?? metadata?.modelId ?? metadata?.modelName ?? '') || ''
  );
  if (modelId === 'auto' || !modelId) modelId = 'kiro-auto';

  // Resolve timestamp
  const ts = parseTimestamp(data.startTime ?? data.createdAt ?? data.timestamp ?? metadata?.startTime ?? metadata?.createdAt);
  if (!ts) return null;

  // Count chars from messages
  let inputChars = 0, outputChars = 0;
  const msgKeys = ['messages', 'conversation', 'chat', 'transcript', 'entries', 'events'];
  const context = data.context as Record<string, unknown> | undefined;

  // Find message arrays
  const arrays: unknown[][] = [];
  if (context) for (const k of msgKeys) { if (Array.isArray(context[k])) { arrays.push(context[k] as unknown[]); break; } }
  for (const k of msgKeys) { if (Array.isArray(data[k])) { arrays.push(data[k] as unknown[]); break; } }

  // Direct input/output fields
  for (const k of ['prompt', 'input', 'userMessage', 'request']) {
    const t = extractText(data[k]); if (t) { inputChars += t.length; break; }
  }
  for (const k of ['response', 'output', 'assistantMessage', 'result']) {
    const t = extractText(data[k]); if (t) { outputChars += t.length; break; }
  }

  for (const messages of arrays) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const rec = msg as Record<string, unknown>;
      const role = String(rec.role ?? rec.type ?? rec.author ?? '').toLowerCase();
      const text = extractText(msg);
      if (role === 'human' || role === 'user') inputChars += text.length;
      else if (role === 'bot' || role === 'assistant' || role === 'ai') outputChars += text.length;
      else if (role === 'tool' || role === 'system') inputChars += text.length;
    }
  }

  if (outputChars === 0) return null;

  const inputTokens = Math.ceil((inputChars / CHARS_PER_TOKEN) * projectFraction);
  const outputTokens = Math.ceil((outputChars / CHARS_PER_TOKEN) * projectFraction);
  return { model: modelId, inputTokens, outputTokens, costUSD: calculateCost(modelId, inputTokens, outputTokens), timestamp: ts, project: resolvedProject };
}

// ---------------------------------------------------------------------------
// Per-file parse cache (keyed by mtime)
//
// Parsing every Kiro session file on every invocation is the dominant cost,
// especially on hosts where all sessions live under one hash workspace. Since
// the commit hook re-runs on every commit, we cache each file's parsed result
// keyed by its mtime and only re-parse files that changed. Lifetime totals are
// preserved (we still sum every current file), so the snapshot-delta math in
// `git commit-trailers` stays correct.
//
// The cache is scoped per target project (the resolved project + token split
// depend on the target), so we key the cache file by target project name.
// `null` results are cached too, to avoid re-parsing files that yield no usage.
// Bump CACHE_VERSION whenever parsing/costing logic changes to force a rebuild.
// ---------------------------------------------------------------------------
const CACHE_VERSION = 1;
type CacheEntry = { mtimeMs: number; call: ParsedCall | null };
interface CacheFile { version: number; entries: Record<string, CacheEntry>; }

function cachePath(targetProject?: string): string {
  const key = (targetProject && targetProject.length ? targetProject : '__all__').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return join(homedir(), '.prism', 'tokentracker', 'kiro-ide-cache', `${key}.json`);
}

function loadCache(targetProject?: string): CacheFile {
  try {
    const data = JSON.parse(readFileSync(cachePath(targetProject), 'utf-8')) as CacheFile;
    if (data && data.version === CACHE_VERSION && data.entries && typeof data.entries === 'object') return data;
  } catch { /* missing/corrupt/stale-version cache → rebuild */ }
  return { version: CACHE_VERSION, entries: {} };
}

function saveCache(targetProject: string | undefined, cache: CacheFile): void {
  try {
    const p = cachePath(targetProject);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cache));
  } catch { /* non-fatal — cache is an optimization only */ }
}

const EMPTY_OUTPUT: CodeburnOutput = { overview: { cost: 0, calls: 0, sessions: 0 }, models: [], projects: [] };

/**
 * Parse Kiro IDE session files into codeburn-compatible token usage.
 * Returns a zero-usage object when the Kiro agent dir is not present.
 */
export async function collectKiroIde(targetProject?: string, period: string = 'all'): Promise<CodeburnOutput> {
  const agentDir = getKiroAgentDir();
  const wsStorageDir = getKiroWorkspaceStorageDir();

  // Build chatSessionId -> project name map from workspace-sessions
  const sessionProjectMap = new Map<string, string>();
  try {
    const wsSessionsDir = join(agentDir, 'workspace-sessions');
    const wsDirs = await readdir(wsSessionsDir).catch(() => [] as string[]);
    for (const dir of wsDirs) {
      let decoded = '';
      try { decoded = Buffer.from(dir.replace(/_/g, '='), 'base64').toString('utf-8'); } catch { continue; }
      if (!decoded) continue;
      const projectName = basename(decoded);
      if (!projectName || projectName === basename(homedir())) continue; // skip bare home dir
      try {
        const sessionsJson = await readFile(join(wsSessionsDir, dir, 'sessions.json'), 'utf-8');
        const sessions = JSON.parse(sessionsJson) as { sessionId?: string }[];
        if (Array.isArray(sessions)) for (const s of sessions) { if (s.sessionId) sessionProjectMap.set(s.sessionId, projectName); }
      } catch {}
    }
  } catch {}

  let workspaceDirs: string[];
  try {
    const entries = await readdir(agentDir, { withFileTypes: true });
    workspaceDirs = entries.filter(e => e.isDirectory() && e.name.length === 32).map(e => e.name);
  } catch {
    return EMPTY_OUTPUT;
  }

  const calls: ParsedCall[] = [];

  // Collect candidate session files (with their workspace project) first, then
  // resolve each through the mtime cache — only changed/new files are parsed.
  const candidates: { filePath: string; project: string }[] = [];

  for (const wsHash of workspaceDirs) {
    const wsPath = join(agentDir, wsHash);
    const project = await readWorkspaceProject(join(wsStorageDir, wsHash));

    if (targetProject && project !== targetProject && !/^[0-9a-f]{32}$/.test(project)) continue;

    let entries: Dirent[];
    try { entries = await readdir(wsPath, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = join(wsPath, entry.name);

      if (entry.isFile() && (entry.name.endsWith('.chat') || extname(entry.name) === '')) {
        candidates.push({ filePath: entryPath, project });
        continue;
      }

      if (!entry.isDirectory()) continue;
      const children = await readdir(entryPath, { withFileTypes: true }).catch(() => [] as Dirent[]);
      for (const child of children) {
        if (child.name.startsWith('.') || !child.isFile() || extname(child.name) !== '') continue;
        candidates.push({ filePath: join(entryPath, child.name), project });
      }
    }
  }

  // Process candidates through the mtime cache. Unchanged files reuse their
  // cached parse result; changed/new files are re-parsed. Deleted files simply
  // don't appear in `candidates`, so they fall out of the rebuilt cache.
  const prevCache = loadCache(targetProject);
  const nextEntries: Record<string, CacheEntry> = {};

  for (const { filePath, project } of candidates) {
    let mtimeMs: number;
    try { mtimeMs = (await stat(filePath)).mtimeMs; } catch { continue; }

    const cached = prevCache.entries[filePath];
    const call = (cached && cached.mtimeMs === mtimeMs)
      ? cached.call
      : await parseSessionFile(filePath, project, sessionProjectMap, targetProject);

    nextEntries[filePath] = { mtimeMs, call };
    if (call && (!targetProject || call.project === targetProject)) calls.push(call);
  }

  saveCache(targetProject, { version: CACHE_VERSION, entries: nextEntries });

  // Period filter
  const now = Date.now();
  const cutoffs: Record<string, number> = { today: 86400000, week: 604800000, '30days': 2592000000, all: Infinity };
  const cutoff = now - (cutoffs[period] ?? Infinity);
  const filtered = calls.filter(c => new Date(c.timestamp).getTime() >= cutoff);

  // Aggregate into codeburn-compatible format
  const byModel = new Map<string, { inputTokens: number; outputTokens: number }>();
  let totalCost = 0;
  for (const c of filtered) {
    const m = byModel.get(c.model) ?? { inputTokens: 0, outputTokens: 0 };
    m.inputTokens += c.inputTokens;
    m.outputTokens += c.outputTokens;
    byModel.set(c.model, m);
    totalCost += c.costUSD;
  }

  return {
    overview: { cost: Math.round(totalCost * 100) / 100, calls: filtered.length, sessions: new Set(filtered.map(c => c.timestamp.slice(0, 10))).size },
    models: [...byModel.entries()].map(([name, t]) => ({ name, inputTokens: t.inputTokens, outputTokens: t.outputTokens })),
    projects: [...new Set(filtered.map(c => c.project))].map(p => ({
      name: p,
      cost: Math.round(filtered.filter(c => c.project === p).reduce((s, c) => s + c.costUSD, 0) * 100) / 100,
      calls: filtered.filter(c => c.project === p).length,
    })),
  };
}

export default {
  description: 'Parse Kiro IDE session files and output token usage (codeburn-compatible JSON)',
  options: [
    { flags: '--project <name>', description: 'Filter by project name (basename of workspace folder)' },
    { flags: '--period <period>', description: 'Period: today, week, 30days, all', default: 'all' },
    { flags: '--format <fmt>', description: 'Output format: json, summary', default: 'json' },
  ],
  async action(opts: { project?: string; period: string; format: string }) {
    const output = await collectKiroIde(opts.project, opts.period);

    if (opts.format === 'summary') {
      console.log(`Kiro IDE Token Usage (${opts.period})`);
      console.log(`  Calls: ${output.overview.calls}`);
      console.log(`  Cost:  $${output.overview.cost}`);
      for (const m of output.models) console.log(`  ${m.name}: ${m.inputTokens} in / ${m.outputTokens} out`);
      if (output.projects.length > 1) for (const p of output.projects) console.log(`  [${p.name}] $${p.cost} (${p.calls} calls)`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  },
};
