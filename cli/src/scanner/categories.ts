import type { CategoryScore, Evidence, ScanConfig } from './types.js';
import { findFiles, readSafe, buildContentCache, searchCache, dirExists, fileExists } from './utils.js';
import _simpleGit from 'simple-git';
// simple-git exports differently under ESM vs CJS; normalize the callable
const git = (p: string) => ((_simpleGit as any).default ?? _simpleGit)(p);
import { join } from 'node:path';

type ScanFn = (repoPath: string, config: ScanConfig) => Promise<CategoryScore>;

// ---------------------------------------------------------------------------
// Helper: accumulate evidence into a category result
// ---------------------------------------------------------------------------
function result(category: string, maxPoints: number, evidence: Evidence[]): CategoryScore {
  return { category, maxPoints, earnedPoints: evidence.reduce((s, e) => s + e.points, 0), evidence };
}

function ev(signal: string, found: boolean, points: number, detail: string): Evidence {
  return { signal, found, points: found ? points : 0, detail };
}

// ---------------------------------------------------------------------------
// 1. AI Tool Config (10 pts)
// ---------------------------------------------------------------------------
const aiToolConfig: ScanFn = async (repo, cfg) => {
  const evidence: Evidence[] = [];

  // CLAUDE.md (3 pts)
  const hasClaude = fileExists(repo, 'CLAUDE.md');
  evidence.push(ev('CLAUDE.md exists', hasClaude, 3, hasClaude ? 'Found CLAUDE.md' : 'No CLAUDE.md in repo root'));

  // Spec-first rules in CLAUDE.md (2 pts)
  let hasSpec = false;
  if (hasClaude) {
    const c = readSafe(repo, 'CLAUDE.md').toLowerCase();
    hasSpec = ['spec', 'specification', 'spec-first', 'acceptance criteria', 'before coding'].some(p => c.includes(p));
  }
  evidence.push(ev('CLAUDE.md has spec-first enforcement', hasSpec, 2, hasSpec ? 'Spec-driven patterns found' : 'No spec-first rules in CLAUDE.md'));

  // Kiro config (2 pts)
  const hasKiro = dirExists(repo, '.kiro') || dirExists(repo, '.kiro/steering') || dirExists(repo, '.kiro/specs') || (await findFiles(repo, '**/.kiro*')).length > 0;
  evidence.push(ev('Kiro configuration exists', hasKiro, 2, hasKiro ? 'Kiro config found' : 'No .kiro directory'));

  // AI IDE config (1 pt)
  const ideFiles = await findFiles(repo, ['**/.github/copilot*', '**/.copilot*', '**/.amazonq*', '**/.cursor*', '**/.continue*', '**/.aider*']);
  evidence.push(ev('AI IDE config exists', ideFiles.length > 0, 1, ideFiles.length > 0 ? `Found: ${ideFiles[0]}` : 'No AI IDE config'));

  // Model references (2 pts)
  const cache = await buildContentCache(repo, '**/*.{json,yaml,yml,toml,md}', 100);
  const modelMatch = searchCache(cache, [/bedrock/i, /anthropic\.claude/i, /claude-\d/i, /gpt-4/i, /amazon\.titan/i, /model[_-]?id/i]);
  evidence.push(ev('Bedrock or model references', !!modelMatch, 2, modelMatch ? `${modelMatch.file} references ${modelMatch.pattern}` : 'No model references'));

  return result('AI Tool Config', 10, evidence);
};

// ---------------------------------------------------------------------------
// 2. Spec-Driven Dev (10 pts)
// ---------------------------------------------------------------------------
const specDriven: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];

  const specDir = ['specs', 'spec', 'specifications', '.kiro/specs', '.kiro/steering'].find(d => dirExists(repo, d));
  evidence.push(ev('Specs directory exists', !!specDir, 2, specDir ? `Found: ${specDir}/` : 'No specs/ directory'));

  const specFiles = await findFiles(repo, ['**/specs/**/*.{md,yaml,yml,json}', '**/spec/**/*.{md,yaml,yml,json}', '**/.kiro/specs/**/*.{md,yaml,yml,json}', '**/.kiro/steering/**/*.md', '**/*spec*.md'],
    ['**/*.test.*', '**/*.spec.ts', '**/*.spec.js']);
  const count = new Set(specFiles).size;
  const pts = count >= 10 ? 6 : count >= 4 ? 4 : count >= 1 ? 2 : 0;
  evidence.push(ev('Spec file count', count > 0, pts, `Found ${count} spec files`));

  let structured = false;
  const structPats = [/## requirements/i, /## acceptance criteria/i, /acceptance[_\s-]?criteria/i, /## scope/i, /## summary/i, /## tasks/i, /## endpoint definition/i, /## request schema/i, /## design/i];
  for (const f of specFiles.slice(0, 20)) {
    const c = readSafe(repo, f);
    if (structPats.filter(p => p.test(c)).length >= 2) { structured = true; break; }
  }
  evidence.push(ev('Specs follow structured format', structured, 2, structured ? 'Structured spec format detected' : 'No structured format'));

  return result('Spec-Driven Dev', 10, evidence);
};

// ---------------------------------------------------------------------------
// 3. Commit Hygiene (15 pts)
// ---------------------------------------------------------------------------
const commitHygiene: ScanFn = async (repo, cfg) => {
  const evidence: Evidence[] = [];
  const gitClient = git(repo);

  let commits: { hash: string; message: string; body: string }[] = [];
  try {
    const log = await gitClient.log({ maxCount: cfg.commitDepth || 200 });
    commits = log.all.map((e: any) => ({ hash: e.hash, message: e.message, body: e.body || '' }));
  } catch {
    evidence.push(ev('Git repository accessible', false, 0, 'Could not read git log'));
    return result('Commit Hygiene', 15, evidence);
  }
  if (!commits.length) {
    evidence.push(ev('Git commits found', false, 0, 'No commits'));
    return result('Commit Hygiene', 15, evidence);
  }

  const aiPats = [/AI-Origin:/i, /AI-Generated:/i, /AI-Assisted:/i, /Co-Authored-By:.*\b(claude|copilot|gpt|anthropic|amazon\s*q)\b/i, /\[ai[- ]generated\]/i, /AI-Tool:/i];
  let aiCount = 0;
  for (const c of commits) {
    if (aiPats.some(p => p.test(`${c.message}\n${c.body}`))) aiCount++;
  }
  const pct = (aiCount / commits.length) * 100;
  const aiPts = pct > 50 ? 12 : pct > 30 ? 9 : pct > 10 ? 6 : pct > 0 ? 3 : 0;
  evidence.push(ev('AI-Origin trailers in commits', aiCount > 0, aiPts, `${aiCount}/${commits.length} (${pct.toFixed(1)}%) have AI trailers`));

  const modelPats = [/AI-Model:/i, /claude-\d/i, /gpt-4/i, /sonnet/i, /opus/i, /haiku/i];
  let hasModel = false;
  for (const c of commits) {
    if (modelPats.some(p => p.test(`${c.message}\n${c.body}`))) { hasModel = true; break; }
  }
  evidence.push(ev('AI-Model trailer present', hasModel, 3, hasModel ? 'Model trailers found' : 'No AI-Model trailers'));

  return result('Commit Hygiene', 15, evidence);
};

// ---------------------------------------------------------------------------
// 4. CI/CD Integration (15 pts)
// ---------------------------------------------------------------------------
const ciIntegration: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];

  const ciFiles = await findFiles(repo, ['.github/workflows/*.{yml,yaml}', '.gitlab-ci.yml', 'Jenkinsfile', 'buildspec.yml', '.circleci/config.yml', 'cdk.json']);
  evidence.push(ev('CI/CD configuration exists', ciFiles.length > 0, 2, ciFiles.length > 0 ? `Found: ${ciFiles.slice(0, 3).join(', ')}` : 'No CI config'));

  let ciContent = '';
  for (const f of ciFiles.slice(0, 20)) ciContent += '\n' + readSafe(repo, f);

  const hasAiCi = [/bedrock/i, /eval[_-]?gate/i, /ai[_-]?eval/i, /claude/i, /guardrail/i, /agent[_-]?eval/i].some(p => p.test(ciContent));
  evidence.push(ev('CI references AI evaluation / eval gates', hasAiCi, 5, hasAiCi ? 'AI eval references in CI' : 'No AI eval in CI'));

  const hasMetrics = [/eventbridge/i, /cloudwatch/i, /put[_-]?events/i, /metrics/i, /dora/i].some(p => p.test(ciContent));
  evidence.push(ev('CI emits metrics/events', hasMetrics, 4, hasMetrics ? 'Metrics emission in CI' : 'No metrics in CI'));

  const hasAiTests = [/ai[_-]?test/i, /hallucination/i, /groundedness/i, /toxicity/i].some(p => p.test(ciContent));
  evidence.push(ev('CI has AI-specific test steps', hasAiTests, 2, hasAiTests ? 'AI test steps found' : 'No AI test steps'));

  let tagCount = 0;
  try { tagCount = (await git(repo).tags()).all.length; } catch { /* ignore */ }
  evidence.push(ev('Deployment frequency from tags', tagCount >= 3, 2, `${tagCount} git tags`));

  return result('CI/CD Integration', 15, evidence);
};

// ---------------------------------------------------------------------------
// 5. Eval & Quality (10 pts)
// ---------------------------------------------------------------------------
const evalQuality: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];

  const evalFiles = await findFiles(repo, ['**/eval*.*', '**/rubric*.*', '**/*eval*.{json,yaml,yml}', '**/evals/**'], ['**/*.test.*', '**/*.spec.*']);
  evidence.push(ev('Eval rubrics or config files exist', evalFiles.length > 0, 3, evalFiles.length > 0 ? `Found: ${evalFiles.slice(0, 3).join(', ')}` : 'No eval configs'));

  const cache = await buildContentCache(repo, '**/*.{ts,js,py,yaml,yml,json}');
  const brMatch = searchCache(cache, [/bedrock.*eval/i, /EvaluationJob/i, /bedrock.*guardrail/i, /ApplyGuardrail/i]);
  evidence.push(ev('Bedrock Evaluation references', !!brMatch, 3, brMatch ? `${brMatch.file} references ${brMatch.pattern}` : 'No Bedrock eval refs'));

  const testCache = await buildContentCache(repo, ['**/*.test.{ts,js,py}', '**/*.spec.{ts,js,py}', '**/test*/**/*.{ts,js,py}'], 100);
  const judgeMatch = searchCache(testCache, [/llm.*judge/i, /ai.*judge/i, /evaluate.*response/i, /quality.*score/i]);
  evidence.push(ev('LLM-as-Judge patterns', !!judgeMatch, 2, judgeMatch ? `${judgeMatch.file}` : 'No LLM-as-Judge patterns'));

  const threshMatch = searchCache(cache, [/eval.*threshold/i, /quality[_-]?gate/i, /pass[_-]?criteria/i, /min[_-]?score/i]);
  evidence.push(ev('Eval threshold configuration', !!threshMatch, 2, threshMatch ? `${threshMatch.file}` : 'No eval thresholds'));

  return result('Eval & Quality', 10, evidence);
};

// ---------------------------------------------------------------------------
// 6. Testing Maturity (10 pts)
// ---------------------------------------------------------------------------
const testingMaturity: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];

  const testFiles = await findFiles(repo, ['**/*.test.{ts,tsx,js,jsx}', '**/*.spec.{ts,tsx,js,jsx}', '**/test_*.py', '**/*_test.py', '**/*_test.go', '**/Test*.java', '**/test/**/*.{ts,js,py,go,java}']);
  const testCount = new Set(testFiles).size;
  evidence.push(ev('Test files exist', testCount > 0, 2, `Found ${testCount} test files`));

  const srcFiles = await findFiles(repo, ['src/**/*.{ts,tsx,js,jsx}', 'lib/**/*.{ts,tsx,js,jsx}', '**/*.py', '**/*.go', '**/*.java'],
    ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/test_*', '**/*_test.*']);
  const srcCount = new Set(srcFiles).size;
  const ratio = srcCount > 0 ? testCount / srcCount : 0;
  const ratioPts = ratio >= 0.5 ? 6 : ratio >= 0.3 ? 4 : ratio >= 0.1 ? 2 : 0;
  evidence.push(ev('Test-to-source ratio', ratio >= 0.1, ratioPts, `${testCount}/${srcCount} = ${ratio.toFixed(2)}`));

  const testCache = await buildContentCache(repo, ['**/*.test.{ts,js,py}', '**/*.spec.{ts,js,py}', '**/test_*.py'], 100);
  const aiMatch = searchCache(testCache, [/hallucination/i, /groundedness/i, /toxicity/i, /faithfulness/i, /prompt.*test/i]);
  evidence.push(ev('AI-specific test patterns', !!aiMatch, 2, aiMatch ? `${aiMatch.file}` : 'No AI test patterns'));

  return result('Testing Maturity', 10, evidence);
};

// ---------------------------------------------------------------------------
// 7. AI Observability (10 pts)
// ---------------------------------------------------------------------------
const aiObservability: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];
  const cache = await buildContentCache(repo, '**/*.{ts,js,py,yaml,yml,json,tf,hcl}');

  const metricsMatch = searchCache(cache, [/cloudwatch/i, /timestream/i, /prometheus/i, /grafana/i, /opentelemetry/i, /put[_-]?metric/i]);
  evidence.push(ev('Metrics infrastructure references', !!metricsMatch, 2, metricsMatch ? `${metricsMatch.file}` : 'No metrics infra'));

  const aiMatch = searchCache(cache, [/prism/i, /ai[_-]?metrics/i, /dora[_-]?metrics/i, /token[_-]?usage/i, /acceptance[_-]?rate/i, /ai[_-]?latency/i]);
  evidence.push(ev('Custom AI metrics namespace', !!aiMatch, 3, aiMatch ? `${aiMatch.file}` : 'No AI metrics namespace'));

  const dashFiles = await findFiles(repo, ['**/dashboard*.{json,yaml,yml}', '**/dashboards/**', '**/grafana/**/*.{json,yaml,yml}']);
  evidence.push(ev('Dashboard definitions exist', dashFiles.length > 0, 2, dashFiles.length > 0 ? `Found: ${dashFiles.slice(0, 3).join(', ')}` : 'No dashboards'));

  const doraMatch = searchCache(cache, [/dora/i, /lead[_-]?time/i, /deployment[_-]?frequency/i, /change[_-]?failure/i, /mttr/i]);
  evidence.push(ev('DORA metric tracking', !!doraMatch, 3, doraMatch ? `${doraMatch.file}` : 'No DORA tracking'));

  return result('AI Observability', 10, evidence);
};

// ---------------------------------------------------------------------------
// 8. Governance (5 pts)
// ---------------------------------------------------------------------------
const governance: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];
  const cache = await buildContentCache(repo, '**/*.{ts,js,py,yaml,yml,json,tf,hcl,md}');

  const guardMatch = searchCache(cache, [/bedrock.*guardrail/i, /guardrail.*config/i, /content[_-]?filter/i, /responsible[_-]?ai/i]);
  evidence.push(ev('Bedrock Guardrails config', !!guardMatch, 2, guardMatch ? `${guardMatch.file}` : 'No guardrails'));

  const autoMatch = searchCache(cache, [/autonomy[_-]?tier/i, /agent[_-]?permission/i, /human[_-]?in[_-]?the[_-]?loop/i, /approval[_-]?gate/i, /agent[_-]?governance/i]);
  evidence.push(ev('Autonomy tier definitions', !!autoMatch, 2, autoMatch ? `${autoMatch.file}` : 'No autonomy tiers'));

  const secMatch = searchCache(cache, [/ai.*iam/i, /bedrock.*policy/i, /invoke[_-]?model.*policy/i, /ai[_-]?security[_-]?review/i]);
  evidence.push(ev('AI-specific IAM or security', !!secMatch, 1, secMatch ? `${secMatch.file}` : 'No AI IAM'));

  return result('Governance', 5, evidence);
};

// ---------------------------------------------------------------------------
// 9. Agent Workflows (8 pts)
// ---------------------------------------------------------------------------
const agentWorkflows: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];
  const cache = await buildContentCache(repo, '**/*.{ts,js,py,yaml,yml,json,toml}');

  let hasAgent = false;
  const agentMatch = searchCache(cache, [/\bstrands\b/i, /\bagentcore\b/i, /multi[_-]?agent/i, /agentic/i, /bedrock[_-]?agent/i, /crew[_-]?ai/i, /langgraph/i]);
  if (agentMatch) hasAgent = true;
  if (!hasAgent) { const dirs = await findFiles(repo, '**/{agent,agents}/**'); if (dirs.length > 0) hasAgent = true; }
  evidence.push(ev('Agent definitions or orchestration', hasAgent, 2, hasAgent ? 'Agent patterns found' : 'No agent definitions'));

  const mcpFiles = await findFiles(repo, ['**/.mcp*', '**/mcp/**']);
  const mcpMatch = mcpFiles.length > 0 ? { file: mcpFiles[0] } : searchCache(cache, [/McpServer/i, /model[_-]?context[_-]?protocol/i, /@modelcontextprotocol/i, /tool[_-]?registration/i]);
  evidence.push(ev('MCP server configs or tool registrations', !!mcpMatch, 2, mcpMatch ? `Found MCP: ${'file' in mcpMatch ? mcpMatch.file : ''}` : 'No MCP'));

  const auditMatch = searchCache(cache, [/agent.*audit/i, /agent.*trace/i, /execution[_-]?log/i, /agent.*monitor/i]);
  evidence.push(ev('Agent audit trail', !!auditMatch, 1, auditMatch ? `${auditMatch.file}` : 'No audit trail'));

  const acFiles = await findFiles(repo, '**/agentcore.json');
  const acMatch = acFiles.length > 0 ? true : !!searchCache(cache, [/AgentCoreRuntime/i, /agentcore[_-]?deploy/i]);
  evidence.push(ev('AgentCore deployment config', acMatch, 1, acMatch ? 'AgentCore config found' : 'No AgentCore'));

  const testFiles = await findFiles(repo, '**/*{test_agent,agent_test,agent.test,agent.spec}*');
  const agentTestMatch = testFiles.length > 0 ? true : !!searchCache(cache, [/test[_-]?agent/i, /agent.*eval/i, /mock.*agent/i]);
  evidence.push(ev('Agent testing and eval rubrics', agentTestMatch, 1, agentTestMatch ? 'Agent tests found' : 'No agent tests'));

  const metricMatch = searchCache(cache, [/prism\.d1\.agent/i, /agent[_-]?invocation/i, /AgentInvocationCount/i, /agent[_-]?metric/i]);
  evidence.push(ev('Agent metrics emission', !!metricMatch, 1, metricMatch ? `${metricMatch.file}` : 'No agent metrics'));

  return result('Agent Workflows', 8, evidence);
};

// ---------------------------------------------------------------------------
// 10. Platform & Reuse (5 pts)
// ---------------------------------------------------------------------------
const platformReuse: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];
  const cache = await buildContentCache(repo, '**/*.{ts,js,py,yaml,yml,json,toml,md}');

  const promptDirs = await findFiles(repo, '**/{prompts,prompt-library,prompt-templates}/**');
  const promptMatch = promptDirs.length > 0 ? true : !!searchCache(cache, [/prompt[_-]?registry/i, /prompt[_-]?library/i, /shared[_-]?prompt/i]);
  evidence.push(ev('Shared prompt library', promptMatch, 2, promptMatch ? 'Prompt library found' : 'No prompt library'));

  const gwMatch = searchCache(cache, [/model[_-]?gateway/i, /ai[_-]?gateway/i, /llm[_-]?gateway/i, /litellm/i, /ai[_-]?platform/i]);
  evidence.push(ev('Model gateway or centralized AI config', !!gwMatch, 2, gwMatch ? `${gwMatch.file}` : 'No model gateway'));

  const ragMatch = searchCache(cache, [/knowledge[_-]?base/i, /retrieval[_-]?augment/i, /vector[_-]?store/i, /embedding/i, /pinecone/i, /chromadb/i, /pgvector/i]);
  evidence.push(ev('RAG / Knowledge Base configs', !!ragMatch, 1, ragMatch ? `${ragMatch.file}` : 'No RAG configs'));

  return result('Platform & Reuse', 5, evidence);
};

// ---------------------------------------------------------------------------
// 11. Documentation (3 pts)
// ---------------------------------------------------------------------------
const documentation: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];
  const cache = await buildContentCache(repo, '**/*.md', 100);

  const guideMatch = searchCache(cache, [/ai.*guideline/i, /ai.*development.*guide/i, /ai.*coding.*standard/i, /prompt.*engineering.*guide/i]);
  evidence.push(ev('AI development guidelines', !!guideMatch, 1, guideMatch ? `${guideMatch.file}` : 'No AI guidelines'));

  const adrFiles = await findFiles(repo, '**/{adr,ADR,decisions,architecture-decisions}/**/*.md');
  let hasAiAdr = false;
  for (const f of adrFiles.slice(0, 20)) {
    if (/\bai\b|llm|bedrock|agent/i.test(readSafe(repo, f))) { hasAiAdr = true; break; }
  }
  evidence.push(ev('ADRs mentioning AI', hasAiAdr, 1, hasAiAdr ? 'AI-related ADR found' : 'No AI ADRs'));

  let hasOnboard = false;
  for (const [file, content] of cache) {
    if (/onboard|getting[_-]?started|contributing/i.test(file + content.slice(0, 500))) {
      if (/\bai\b|claude|copilot|amazon\s*q|cursor|bedrock/i.test(content)) { hasOnboard = true; break; }
    }
  }
  evidence.push(ev('Onboarding docs reference AI', hasOnboard, 1, hasOnboard ? 'AI in onboarding docs' : 'No AI in onboarding'));

  return result('Documentation', 3, evidence);
};

// ---------------------------------------------------------------------------
// 12. Dependencies (2 pts)
// ---------------------------------------------------------------------------
const AI_DEPS = ['@anthropic-ai/sdk', 'anthropic', '@aws-sdk/client-bedrock', '@aws-sdk/client-bedrock-runtime', 'openai', 'langchain', '@langchain/core', '@langchain/anthropic', '@langchain/aws', 'llamaindex', 'autogen', 'crewai', 'ragas', 'deepeval', 'promptfoo', 'chromadb', 'pinecone', '@modelcontextprotocol/sdk', 'strands-agents', 'strands-agents-tools'];
const PY_DEPS = ['anthropic', 'boto3', 'openai', 'langchain', 'llama-index', 'autogen', 'crewai', 'ragas', 'deepeval', 'chromadb', 'pinecone', 'bedrock', 'strands-agents', 'strands-agents-tools'];

const dependencies: ScanFn = async (repo) => {
  const evidence: Evidence[] = [];
  const found: string[] = [];

  // package.json
  if (fileExists(repo, 'package.json')) {
    try {
      const pkg = JSON.parse(readSafe(repo, 'package.json'));
      const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      for (const d of AI_DEPS) { if (all[d]) found.push(`${d} (package.json)`); }
    } catch { /* skip */ }
  }

  // Python deps
  for (const f of await findFiles(repo, '{requirements*.txt,pyproject.toml,Pipfile,setup.py,setup.cfg}')) {
    const c = readSafe(repo, f).toLowerCase();
    for (const d of PY_DEPS) { if (c.includes(d)) found.push(`${d} (${f})`); }
  }

  // go.mod / Cargo.toml
  for (const f of ['go.mod', 'Cargo.toml']) {
    if (fileExists(repo, f) && /anthropic|bedrock|openai|langchain|llm/i.test(readSafe(repo, f))) found.push(`AI SDK (${f})`);
  }

  const unique = [...new Set(found)];
  evidence.push(ev('AI SDKs in dependency files', unique.length > 0, 1, unique.length > 0 ? `Found: ${unique.slice(0, 5).join(', ')}` : 'No AI SDKs'));
  evidence.push(ev('Multiple AI dependencies (breadth)', unique.length >= 2, 1, `${unique.length} AI deps`));

  return result('Dependencies', 2, evidence);
};

// ---------------------------------------------------------------------------
// Export all scanners in order
// ---------------------------------------------------------------------------
export const scanners: { name: string; scan: ScanFn }[] = [
  { name: 'AI Tool Config', scan: aiToolConfig },
  { name: 'Spec-Driven Dev', scan: specDriven },
  { name: 'Commit Hygiene', scan: commitHygiene },
  { name: 'CI/CD Integration', scan: ciIntegration },
  { name: 'Eval & Quality', scan: evalQuality },
  { name: 'Testing Maturity', scan: testingMaturity },
  { name: 'AI Observability', scan: aiObservability },
  { name: 'Governance', scan: governance },
  { name: 'Agent Workflows', scan: agentWorkflows },
  { name: 'Platform & Reuse', scan: platformReuse },
  { name: 'Documentation', scan: documentation },
  { name: 'Dependencies', scan: dependencies },
];
