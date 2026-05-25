/**
 * PRISM D1 Velocity -- Interview Agent
 *
 * Conversational AI agent that conducts the SA interview via chat.
 * Uses Amazon Bedrock (Claude) to ask questions, probe responses,
 * and score answers against the rubrics from interview-guide.md.
 *
 * Runs locally — no AgentCore required. Just needs AWS credentials
 * with Bedrock invoke-model access.
 */

import type { ScanResult } from '../../scanner/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface QuestionResult {
  questionId: string;
  label: string;
  section: string;
  score: number;
  evidence: string;
  notes: string;
}

export interface AgentSessionState {
  phase: 'intro' | 'interview' | 'org_readiness' | 'closing' | 'complete';
  currentSectionIdx: number;
  currentQuestionIdx: number;
  followUpCount: number;
  maxFollowUps: number;
  results: QuestionResult[];
  orgReadiness: Record<string, boolean>;
  customerName: string;
  saName: string;
  fundingStage: string;
  teamSize: number;
  closingNotes: string;
  messages: AgentMessage[];
  scanData: ScanResult;
  /** Curated summary of prior answers relevant to remaining questions */
  runningContext: string;
}

// Re-export the interview sections structure from web.ts for shared use
export interface InterviewQuestion {
  id: string;
  label: string;
  max: number;
  ask: string;
  listenFor: string[];
  rubric: string[]; // index = score (0-5)
}

export interface InterviewSection {
  id: string;
  name: string;
  maxScore: number;
  time: string;
  questions: InterviewQuestion[];
}

// ---------------------------------------------------------------------------
// Interview sections — same data as web.ts, extracted for agent use
// ---------------------------------------------------------------------------

export const SECTIONS: InterviewSection[] = [
  {
    id: 'ai_tooling_landscape', name: 'AI Tooling Landscape', maxScore: 15, time: '~10 min',
    questions: [
      { id: 'q1_1', label: 'AI Tool Usage Overview', max: 5,
        ask: 'Walk me through how your engineers use AI tools today — from IDE to deployment. What tools are in play, and how consistently are they used?',
        listenFor: ['Specific tool names vs. vague answers', 'Standardization vs. individual choice', 'Whether tools span the full lifecycle', 'Shared configuration (team-wide settings, prompt libraries)'],
        rubric: ['No AI tools in use', 'A few engineers use AI tools ad hoc', 'Multiple tools but no standardization', 'Standardized primary tool, some shared config', 'Standardized toolset covering multiple phases', 'Fully standardized and managed AI toolchain with usage tracking'] },
      { id: 'q1_2', label: 'Tool Adoption Process', max: 5,
        ask: 'How do you decide which AI tools to adopt? Is there a process, or does it happen organically?',
        listenFor: ['Governance vs. grassroots adoption', 'Evaluation criteria (security, cost, effectiveness)', 'Budget ownership', 'Speed of adoption'],
        rubric: ['No process; engineers install whatever', 'Informal process, no framework', 'Some evaluation criteria but inconsistent', 'Defined process with security review, but slow', 'Streamlined evaluation with clear criteria', 'Formal but fast governance with ongoing measurement'] },
      { id: 'q1_3', label: 'Usage Measurement', max: 5,
        ask: 'What percentage of your engineers use AI tools weekly? How do you know that number?',
        listenFor: ['Actual data vs. guessing', 'Telemetry or license dashboards', 'Usage depth tracking', 'Awareness of adoption gaps'],
        rubric: ['"I don\'t know" or clearly guessing', 'Rough guess based on anecdotes', 'Knows license count but not usage', 'Some usage data but not actively monitored', 'Actively tracks with team breakdowns', 'Real-time dashboards with usage depth and trends'] },
    ],
  },
  {
    id: 'dev_workflow_specs', name: 'Development Workflow & Specs', maxScore: 20, time: '~15 min',
    questions: [
      { id: 'q2_1', label: 'Feature Development Flow', max: 5,
        ask: 'When a new feature comes in, what does the journey from idea to first PR look like? Walk me through a recent example.',
        listenFor: ['Defined process or varies by person', 'Where AI enters the workflow', 'Handoff points and bottlenecks', 'Whether process is documented'],
        rubric: ['No consistent process', 'Loose process, AI only during coding', 'Some features get specs inconsistently', 'Defined workflow with spec phase for major features', 'Consistent spec-first workflow with AI in coding and testing', 'Fully spec-driven with AI at every phase'] },
      { id: 'q2_2', label: 'Spec Quality and Structure', max: 5,
        ask: 'Do engineers write specs or design docs before coding? How structured are they?',
        listenFor: ['Spec existence and consistency', 'Template usage and enforcement', 'Quality (vague vs. structured with ACs)', 'Whether specs live in the repo'],
        rubric: ['No specs; code from tickets directly', 'Occasional design docs, no format', 'Specs exist but quality varies, no template', 'Template used for most features', 'Structured specs with enforcement and review', 'Rigorous spec process with ACs, constraints, AI-consumable format'] },
      { id: 'q2_3', label: 'AI in the Design Phase', max: 5,
        ask: 'How does AI participate in the design phase vs. just the coding phase? Is AI involved before the first line of code is written?',
        listenFor: ['AI usage beyond code completion', 'Prompt engineering for design tasks', 'Whether specs feed into AI for implementation', 'Left-shift maturity'],
        rubric: ['AI only for inline code completion', 'Code completion + occasional ChatGPT queries', 'Some engineers use AI for spec drafting', 'AI regularly used for specs and planning', 'AI integrated into design phase with structured prompts', 'AI across full design lifecycle: spec drafts, gap review, implementation plans'] },
      { id: 'q2_4', label: 'AI Attribution and Traceability', max: 5,
        ask: 'Look at your last 3 merged PRs. Can you tell which parts were AI-assisted?',
        listenFor: ['Can they identify AI-assisted code at all', 'Commit trailers or metadata', 'PR descriptions mentioning AI', 'Automated tagging'],
        rubric: ['Cannot tell which code is AI-assisted', 'Can guess from memory but no tracking', 'Some PRs mention AI inconsistently', 'Convention exists but not enforced', 'Consistent attribution via trailers, enforced', 'Automated attribution: tooling tags, searchable, auditable'] },
    ],
  },
  {
    id: 'cicd_quality', name: 'CI/CD & Quality', maxScore: 20, time: '~15 min',
    questions: [
      { id: 'q3_1', label: 'AI Validation in CI/CD', max: 5,
        ask: 'Walk me through your CI/CD pipeline. Where does AI-generated code get validated differently from human-written code?',
        listenFor: ['AI-specific validation steps', 'Eval gates', 'Bedrock Evaluations or similar', 'Security scanning for AI risks'],
        rubric: ['Standard CI only, no AI-specific steps', 'Awareness but no action', 'Extra review for AI PRs but no automation', 'Some automated checks for AI code', 'Dedicated AI validation: eval gates, security scanning', 'Comprehensive: eval gates, Bedrock Evaluations, rollback triggers, feedback loops'] },
      { id: 'q3_2', label: 'AI Bug Tracking', max: 5,
        ask: 'Have you ever had an AI-generated bug reach production? What happened, and what did you learn?',
        listenFor: ['Honesty and self-awareness', 'Whether they track AI-origin bugs separately', 'Post-mortem process', 'Process improvements from incidents'],
        rubric: ['Don\'t track AI origin for bugs or denial', 'Aware of at least one bug, no tracking', 'Can describe incidents, response was ad hoc', 'AI bugs discussed in retros, some changes', 'AI bugs tagged in tracker, post-mortems address AI', 'Systematic tracking with defect attribution and feedback loops'] },
      { id: 'q3_3', label: 'AI Code Quality Measurement', max: 5,
        ask: 'How do you measure the quality of AI-generated code vs. human-written code? Is there a difference?',
        listenFor: ['Whether they measure quality at all', 'Defect rate comparison', 'Acceptance rate tracking', 'Quality metrics with AI dimension'],
        rubric: ['No systematic quality measurement', 'General metrics but no AI dimension', 'Anecdotal awareness, no measurement', 'Some metrics with AI awareness', 'Explicit AI vs. human quality comparison', 'Comprehensive: defect rates, review times, acceptance rates, dashboards'] },
      { id: 'q3_4', label: 'Deployment Metrics and AI Impact', max: 5,
        ask: 'What\'s your deployment frequency and lead time? How has AI affected these numbers?',
        listenFor: ['DORA metrics awareness', 'Actual measurement', 'AI impact attribution', 'Before/after data'],
        rubric: ['Don\'t track deployment metrics', 'Rough awareness, no formal tracking', 'Track frequency/lead time but no AI analysis', 'Track DORA, anecdotal AI impact', 'DORA with trend analysis and before/after data', 'Full DORA with AI-attributed impact analysis'] },
    ],
  },
  {
    id: 'metrics_visibility', name: 'Metrics & Visibility', maxScore: 15, time: '~10 min',
    questions: [
      { id: 'q4_1', label: 'Executive Visibility', max: 5,
        ask: 'If your CTO asked right now, "What is AI doing for our engineering velocity?" — what would you show them?',
        listenFor: ['Data vs. anecdotes', 'Dashboard existence and quality', 'Real-time vs. quarterly', 'Whether leadership actually asks'],
        rubric: ['Nothing; would rely on anecdotes', 'License costs and adoption numbers only', 'Could assemble a deck with effort', 'Periodic report or dashboard, monthly/quarterly', 'Real-time dashboard with AI contribution metrics', 'Executive-ready dashboard with ROI, trends, automated reporting'] },
      { id: 'q4_2', label: 'Engineering Metrics with AI Dimensions', max: 5,
        ask: 'What engineering metrics do you currently track? Which ones include an AI dimension?',
        listenFor: ['Baseline metrics maturity', 'AI dimensions on existing metrics', 'DORA, cycle time, throughput', 'Whether metrics drive decisions'],
        rubric: ['Minimal or no engineering metrics', 'Basic metrics, no AI dimension', 'Standard metrics, no AI dimension', 'Good metrics + 1-2 AI-specific', 'Comprehensive with AI dimensions', 'Enhanced DORA with full AI dimensions, actively driving decisions'] },
      { id: 'q4_3', label: 'AI ROI Reporting', max: 5,
        ask: 'How do you report AI ROI to leadership? What\'s the cadence and what does it include?',
        listenFor: ['Whether ROI is reported at all', 'Quantitative vs. qualitative', 'Cadence and audience', 'Cost + benefit included'],
        rubric: ['No AI ROI reporting', 'Occasional informal updates', 'Periodic updates with some data', 'Quarterly with quantified metrics', 'Regular with quantified ROI and exec audience', 'Structured readouts with full ROI model, trends, forecasts'] },
    ],
  },
  {
    id: 'governance_security', name: 'Governance & Security', maxScore: 15, time: '~10 min',
    questions: [
      { id: 'q5_1', label: 'AI Guardrails', max: 5,
        ask: 'What guardrails do you have around AI-generated code and AI agents? How do you limit what AI can do autonomously?',
        listenFor: ['Whether guardrails exist at all', 'Specificity (vague vs. concrete rules)', 'Autonomy tiers', 'Agent-specific controls'],
        rubric: ['No guardrails; AI has developer access', 'Informal guidance only', 'AI PRs require review but no formal policy', 'Documented guardrails with basic autonomy rules', 'Formal framework: autonomy tiers enforced by tooling', 'Comprehensive: tiers, sandboxing, restricted zones, audit trail'] },
      { id: 'q5_2', label: 'AI Access and Permissions', max: 5,
        ask: 'How do you handle AI access to sensitive data, credentials, or production systems? Does AI get the same access as the developer?',
        listenFor: ['Scoped permissions vs. inherited access', 'IAM for AI agents', 'Credential management', 'Audit trails'],
        rubric: ['AI has same access as developer, no audit', 'Awareness but no action', 'Basic controls (no prod access)', 'Scoped permissions, credential isolation, basic audit', 'Comprehensive: scoped IAM, audit trails, trust boundaries', 'Full governance: least-privilege, audit attribution, regular reviews'] },
      { id: 'q5_3', label: 'AI Incident Response', max: 5,
        ask: 'Do you have an AI-specific incident response process? If an AI agent causes a production issue, what happens?',
        listenFor: ['AI-specific failure mode awareness', 'Runbooks or escalation paths', 'Post-mortem process for AI causes', 'Automated detection'],
        rubric: ['No AI-specific incident response', 'Awareness but no specific process', 'Some ad hoc handling, not documented', 'AI considerations added to existing runbooks', 'Dedicated AI runbooks and escalation paths', 'Comprehensive: runbooks, automated detection, drills, feedback to guardrails'] },
    ],
  },
  {
    id: 'org_culture', name: 'Organization & Culture', maxScore: 15, time: '~10 min',
    questions: [
      { id: 'q6_1', label: 'AI Ownership and Sponsorship', max: 5,
        ask: 'Who owns AI engineering transformation in your org? Is there a dedicated person, team, or budget?',
        listenFor: ['Named individual or team', 'Executive sponsorship', 'Dedicated budget', 'Strategic intent vs. organic'],
        rubric: ['Nobody owns it; grassroots only', 'Informal champion with no authority', 'Leadership supportive but no dedicated owner', 'Named owner with partial responsibility and budget', 'Dedicated owner with mandate, budget, exec backing', 'Named owner + team, C-level sponsorship, on company roadmap with OKRs'] },
      { id: 'q6_2', label: 'AI Onboarding', max: 5,
        ask: 'How do new engineers get onboarded to your AI toolchain? What does their first week look like with respect to AI tools?',
        listenFor: ['Whether onboarding includes AI', 'Documentation and guides', 'Time-to-productivity', 'Ongoing training'],
        rubric: ['AI not part of onboarding', 'Mentioned informally, no structured setup', 'Tools set up but no usage guidance', 'Structured: tools installed, usage guide, conventions', 'Comprehensive: codebase-specific tips, mentoring, first-week tasks', 'Full program: prompt libraries, benchmarks, ongoing training, feedback loop'] },
      { id: 'q6_3', label: 'Blockers and Self-Awareness', max: 5,
        ask: 'What\'s blocking you from getting more value from AI in engineering? If you could fix one thing tomorrow, what would it be?',
        listenFor: ['Self-awareness and honesty', 'Specificity of blockers', 'Organizational vs. technical vs. cultural', 'Willingness to change'],
        rubric: ['"Nothing, we\'re fine" or "AI isn\'t useful"', 'Vague blockers with no specifics', 'Specific blockers but no action taken', 'Specific blockers with some efforts underway', 'Clear gaps with prioritized action plan', 'Deep self-awareness with root cause analysis and evidence of iterating'] },
    ],
  },
];


// ---------------------------------------------------------------------------
// Bedrock client — calls Claude via AWS SDK locally
// ---------------------------------------------------------------------------

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface BedrockResponse {
  content: Array<{ type: string; text: string }>;
}

async function callBedrock(
  system: string,
  messages: BedrockMessage[],
  modelId: string = 'us.anthropic.claude-sonnet-4-6',
  region: string = 'us-west-2',
): Promise<string> {
  // Dynamic import so the CLI doesn't hard-fail if SDK isn't installed
  const { BedrockRuntimeClient, InvokeModelCommand } = await import(
    '@aws-sdk/client-bedrock-runtime'
  );

  const client = new BedrockRuntimeClient({ region });
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2048,
    temperature: 0.3,
    system,
    messages,
  });

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: new TextEncoder().encode(body),
  });

  const response = await client.send(command);
  const decoded = JSON.parse(new TextDecoder().decode(response.body)) as BedrockResponse;
  return decoded.content?.[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// Bedrock access check — validates credentials + model access before starting
// ---------------------------------------------------------------------------

export interface BedrockCheckResult {
  ok: boolean;
  error?: string;
  errorType?: 'no_credentials' | 'no_model_access' | 'wrong_region' | 'sdk_missing' | 'unknown';
}

export async function checkBedrockAccess(
  modelId: string = 'us.anthropic.claude-sonnet-4-6',
  region: string = 'us-west-2',
): Promise<BedrockCheckResult> {
  try {
    // Check SDK is installed
    const { BedrockRuntimeClient, InvokeModelCommand } = await import(
      '@aws-sdk/client-bedrock-runtime'
    );

    const client = new BedrockRuntimeClient({ region });

    // Minimal request — 1 token max to keep it cheap and fast
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1,
      temperature: 0,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const command = new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: new TextEncoder().encode(body),
    });

    await client.send(command);
    return { ok: true };
  } catch (err: any) {
    const msg = err.message || String(err);
    const name = err.name || '';

    // SDK not installed
    if (msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')) {
      return { ok: false, error: 'AWS SDK not installed. Run: npm install @aws-sdk/client-bedrock-runtime', errorType: 'sdk_missing' };
    }

    // No credentials configured
    if (name === 'CredentialsProviderError' || msg.includes('Could not load credentials') || msg.includes('credential')) {
      return { ok: false, error: 'No AWS credentials found.', errorType: 'no_credentials' };
    }

    // Access denied — model not enabled or wrong permissions
    if (name === 'AccessDeniedException' || msg.includes('Access denied') || msg.includes('not authorized') || msg.includes('Legacy')) {
      return { ok: false, error: msg, errorType: 'no_model_access' };
    }

    // Model not found in region
    if (msg.includes('model identifier is invalid') || msg.includes('Could not resolve')) {
      return { ok: false, error: msg, errorType: 'wrong_region' };
    }

    // Unknown error
    return { ok: false, error: msg, errorType: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

function buildInterviewerSystemPrompt(scan: ScanResult, state: AgentSessionState): string {
  const section = SECTIONS[state.currentSectionIdx];
  const question = section?.questions[state.currentQuestionIdx];

  // Build scanner context for probing
  const scannerContext = scan.categories
    .map(c => {
      const pct = c.maxPoints > 0 ? Math.round((c.earnedPoints / c.maxPoints) * 100) : 0;
      return `- ${c.category}: ${c.earnedPoints}/${c.maxPoints} (${pct}%)`;
    })
    .join('\n');

  const scannerGaps = scan.gaps?.length > 0
    ? `\nScanner-detected gaps:\n${scan.gaps.map(g => `- ${g}`).join('\n')}`
    : '';

  let questionContext = '';
  if (question) {
    questionContext = `
CURRENT QUESTION: ${question.id} — ${question.label}
ASK: "${question.ask}"

WHAT TO LISTEN FOR:
${question.listenFor.map(l => `- ${l}`).join('\n')}

SCORING RUBRIC (0-5):
${question.rubric.map((r, i) => `  ${i}: ${r}`).join('\n')}

Follow-ups used so far for this question: ${state.followUpCount}/${state.maxFollowUps}
`;
  }

  // Use curated running context instead of full evidence dump
  const contextSection = state.runningContext
    ? `\nRELEVANT CONTEXT FROM PRIOR ANSWERS (use this to ask smarter questions and avoid re-asking what we already know):\n${state.runningContext}`
    : '';

  // Brief score summary for progress tracking
  const scoreSummary = state.results.length > 0
    ? `\nSCORES SO FAR: ${state.results.map(r => `${r.questionId}=${r.score}`).join(', ')}`
    : '';

  return `You are an expert AWS Solutions Architect conducting a PRISM D1 Velocity assessment interview. You are evaluating the AI-native software development lifecycle maturity of a startup.

ROLE: You are warm, conversational, and genuinely curious. This is a conversation, not an interrogation. You ask one question at a time, listen carefully, and use follow-up probes to dig deeper when answers are vague or surface-level.

RULES:
1. Ask ONE question at a time. Never ask multiple questions in a single message.
2. After the interviewee responds, decide: do you need a follow-up probe (max ${state.maxFollowUps} per question), or is the answer sufficient to score?
3. When you have enough evidence to score, output a JSON scoring block at the END of your message (after your conversational response) in this exact format:
   <!--SCORE:{"questionId":"${question?.id || ''}","score":N,"evidence":"brief summary of key evidence","notes":"any additional observations"}-->
4. After scoring, naturally transition to the next question.
5. Be conservative: when in doubt between two scores, pick the lower one.
6. Reference scanner findings when relevant to probe discrepancies (e.g., "I noticed your repo doesn't have spec files — where do design decisions live?").
7. Keep responses concise — 2-4 sentences for transitions, 1-2 sentences for follow-ups.
8. Do NOT reveal the scoring rubric or your scores to the interviewee.
9. USE CONTEXT from previous answers. If the interviewee already mentioned relevant details in an earlier answer, acknowledge that and build on it rather than asking them to repeat themselves. For example, if they already described their CI/CD pipeline, reference that when asking about AI validation in CI.
10. If a previous answer partially addresses the current question, acknowledge what you already know and ask only about the gap.

SCANNER RESULTS (for context and probing):
Repository: ${scan.repoName}
Scanner Score: ${scan.totalScore}/${scan.maxScore}
${scannerContext}
${scannerGaps}

INTERVIEW PROGRESS:
Section ${state.currentSectionIdx + 1}/${SECTIONS.length}: ${section?.name || 'Complete'}
Question ${state.currentQuestionIdx + 1}/${section?.questions.length || 0} in this section
${scoreSummary}
${contextSection}

${questionContext}

CUSTOMER INFO:
Name: ${state.customerName || 'Not yet collected'}
Team Size: ${state.teamSize || 'Unknown'}
Funding: ${state.fundingStage || 'Unknown'}`;
}

function buildScoringPrompt(question: InterviewQuestion, conversation: AgentMessage[]): string {
  // Extract just the Q&A for this question from the conversation
  return `You are scoring an interview response. Based on the conversation below, assign a score from 0-5.

QUESTION: ${question.label}
"${question.ask}"

SCORING RUBRIC:
${question.rubric.map((r, i) => `  ${i}: ${r}`).join('\n')}

WHAT TO LISTEN FOR:
${question.listenFor.map(l => `- ${l}`).join('\n')}

CONVERSATION:
${conversation.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')}

Respond with ONLY a JSON object:
{"score": N, "evidence": "brief summary of key evidence from their answer", "notes": "any observations"}`;
}

// ---------------------------------------------------------------------------
// Agent session management
// ---------------------------------------------------------------------------

export function createSession(scan: ScanResult): AgentSessionState {
  return {
    phase: 'intro',
    currentSectionIdx: 0,
    currentQuestionIdx: 0,
    followUpCount: 0,
    maxFollowUps: 2,
    results: [],
    orgReadiness: {
      executiveSponsor: false,
      budgetAllocated: false,
      dedicatedOwner: false,
      awsRelationship: false,
      appropriateTeamSize: false,
    },
    customerName: '',
    saName: 'AI Interview Agent',
    fundingStage: '',
    teamSize: 0,
    closingNotes: '',
    messages: [],
    scanData: scan,
    runningContext: '',
  };
}

export async function processMessage(
  state: AgentSessionState,
  userMessage: string,
  modelId?: string,
  region?: string,
): Promise<{ reply: string; state: AgentSessionState; done: boolean }> {
  // Add user message to history
  if (userMessage) {
    state.messages.push({ role: 'user', content: userMessage });
  }

  // --- INTRO PHASE: collect basic info ---
  if (state.phase === 'intro') {
    return handleIntro(state, userMessage, modelId, region);
  }

  // --- INTERVIEW PHASE: ask questions, score responses ---
  if (state.phase === 'interview') {
    return handleInterview(state, userMessage, modelId, region);
  }

  // --- ORG READINESS PHASE ---
  if (state.phase === 'org_readiness') {
    return handleOrgReadiness(state, userMessage, modelId, region);
  }

  // --- CLOSING PHASE ---
  if (state.phase === 'closing') {
    return handleClosing(state, userMessage);
  }

  return { reply: 'Interview complete.', state, done: true };
}

async function handleIntro(
  state: AgentSessionState,
  userMessage: string,
  modelId?: string,
  region?: string,
): Promise<{ reply: string; state: AgentSessionState; done: boolean }> {
  // First message — greet and ask for info
  if (state.messages.length <= 1) {
    const greeting = `Thanks for making time for this! I'm going to walk through how your team builds software today, with a focus on how AI tools fit into your workflow.

There are no wrong answers — we're trying to understand where you are so we can figure out the most useful next steps. I'll ask questions across six areas: AI tooling, development workflow, CI/CD, metrics, governance, and org structure.

Before we dive in, could you share:
1. **Your name and role**
2. **Company/team name**
3. **Approximate engineering team size**
4. **Funding stage** (Seed, Series A/B/C, etc.)`;

    state.messages.push({ role: 'assistant', content: greeting });
    return { reply: greeting, state, done: false };
  }

  // Parse intro info from the full conversation so far using the LLM
  const allUserMessages = state.messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join('\n');

  const parsePrompt = `Extract the following from the user's messages. Return ONLY a JSON object with these exact keys:
- "customerName": the company or team name (string, or "" if not mentioned)
- "teamSize": number of engineers (number, or 0 if not mentioned)  
- "fundingStage": funding stage like "Seed", "Series A", etc. (string, or "" if not mentioned)
- "intervieweeName": their personal name and role (string, or "" if not mentioned)

IMPORTANT: Use empty string "" for missing text fields and 0 for missing numbers. Never use null.

User messages:
${allUserMessages}`;

  try {
    const raw = await callBedrock(
      'You are a data extraction assistant. Return only valid JSON, no markdown.',
      [{ role: 'user', content: parsePrompt + '\n\nUser messages:\n' + allUserMessages }],
      modelId,
      region,
    );
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const info = JSON.parse(cleaned);
    
    const name = String(info.customerName || '').trim();
    const size = parseInt(String(info.teamSize || '0'), 10);
    const funding = String(info.fundingStage || '').trim();
    
    if (name && name !== 'null' && name !== 'Unknown') state.customerName = name;
    if (size > 0) state.teamSize = size;
    if (funding && funding !== 'null' && funding !== 'Unknown') state.fundingStage = funding;
  } catch (err) {
    // Log for debugging, then check what's missing below
    console.error('Intro parse error:', err);
  }

  // Check what's still missing and ask follow-up
  const missing: string[] = [];
  if (!state.customerName) missing.push('your **company or team name**');
  if (!state.teamSize || state.teamSize === 0) missing.push('your **approximate engineering team size**');
  if (!state.fundingStage) missing.push('your **funding stage** (Seed, Series A/B/C, etc.)');

  // Also check for interviewee name — stored in messages but useful context
  const hasName = state.messages.some(m => m.role === 'user') && !missing.length;

  if (missing.length > 0) {
    const followUp = `Thanks for that! I just want to make sure I have everything — could you also share ${missing.join(' and ')}?`;
    state.messages.push({ role: 'assistant', content: followUp });
    return { reply: followUp, state, done: false };
  }

  // All info collected — transition to interview
  state.phase = 'interview';
  state.currentSectionIdx = 0;
  state.currentQuestionIdx = 0;
  state.followUpCount = 0;

  const section = SECTIONS[0];
  const question = section.questions[0];
  const transition = `Great, thanks for that context! Let's get started.

**Section 1: ${section.name}** (${section.time})

${question.ask}`;

  state.messages.push({ role: 'assistant', content: transition });
  return { reply: transition, state, done: false };
}

async function handleInterview(
  state: AgentSessionState,
  userMessage: string,
  modelId?: string,
  region?: string,
): Promise<{ reply: string; state: AgentSessionState; done: boolean }> {
  const section = SECTIONS[state.currentSectionIdx];
  const question = section.questions[state.currentQuestionIdx];

  // Build the system prompt and call the LLM
  const systemPrompt = buildInterviewerSystemPrompt(state.scanData, state);
  const bedrockMessages: BedrockMessage[] = state.messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  const reply = await callBedrock(systemPrompt, bedrockMessages, modelId, region);

  // Check if the LLM included a score
  const scoreMatch = reply.match(/<!--SCORE:(.*?)-->/s);
  let cleanReply = reply.replace(/<!--SCORE:.*?-->/s, '').trim();
  let scoredThisTurn = false;

  if (scoreMatch) {
    try {
      const scoreData = JSON.parse(scoreMatch[1]);
      state.results.push({
        questionId: question.id,
        label: question.label,
        section: section.name,
        score: Math.min(5, Math.max(0, scoreData.score)),
        evidence: scoreData.evidence || '',
        notes: scoreData.notes || '',
      });
      scoredThisTurn = true;
    } catch {
      // If score parsing fails, use fallback scoring
      const fallbackScore = await scoreFallback(question, state.messages, modelId, region, section.name);
      state.results.push(fallbackScore);
      scoredThisTurn = true;
    }

    // Advance to next question
    state.followUpCount = 0;
    state.currentQuestionIdx++;

    // Check if section is complete
    if (state.currentQuestionIdx >= section.questions.length) {
      state.currentSectionIdx++;
      state.currentQuestionIdx = 0;

      // Check if all sections are complete
      if (state.currentSectionIdx >= SECTIONS.length) {
        state.phase = 'org_readiness';
        cleanReply += `\n\nWe've covered all the interview questions. Just a few more quick items about organizational readiness.

Does your organization have an **executive sponsor** (CTO/VP level) who actively champions AI adoption in engineering?`;
      } else {
        const nextSection = SECTIONS[state.currentSectionIdx];
        cleanReply += `\n\n**Section ${state.currentSectionIdx + 1}: ${nextSection.name}** (${nextSection.time})`;
      }
    }
  } else {
    // No score yet — this is a follow-up probe
    state.followUpCount++;

    // If we've hit max follow-ups, force a score on the next round
    if (state.followUpCount >= state.maxFollowUps) {
      // Score based on what we have
      const fallbackScore = await scoreFallback(question, state.messages, modelId, region, section.name);
      state.results.push(fallbackScore);
      scoredThisTurn = true;

      state.followUpCount = 0;
      state.currentQuestionIdx++;

      if (state.currentQuestionIdx >= section.questions.length) {
        state.currentSectionIdx++;
        state.currentQuestionIdx = 0;

        if (state.currentSectionIdx >= SECTIONS.length) {
          state.phase = 'org_readiness';
          cleanReply += `\n\nGreat, we've covered all the interview questions. A few quick organizational readiness items now.

Does your organization have an **executive sponsor** (CTO/VP level) who actively champions AI adoption in engineering?`;
        }
      }
    }
  }

  state.messages.push({ role: 'assistant', content: cleanReply });

  // Refresh running context only when a question was scored this turn
  if (scoredThisTurn && state.phase === 'interview') {
    state.runningContext = await refreshRunningContext(state, modelId, region);
  }

  return { reply: cleanReply, state, done: false };
}

async function scoreFallback(
  question: InterviewQuestion,
  messages: AgentMessage[],
  modelId?: string,
  region?: string,
  sectionName: string = '',
): Promise<QuestionResult> {
  try {
    const prompt = buildScoringPrompt(question, messages.slice(-6));
    const result = await callBedrock(
      'You are a scoring assistant. Return only valid JSON.',
      [{ role: 'user', content: prompt }],
      modelId,
      region,
    );
    const parsed = JSON.parse(result.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
    return {
      questionId: question.id,
      label: question.label,
      section: sectionName,
      score: Math.min(5, Math.max(0, parsed.score || 0)),
      evidence: parsed.evidence || '',
      notes: parsed.notes || '',
    };
  } catch {
    return {
      questionId: question.id,
      label: question.label,
      section: sectionName,
      score: 0,
      evidence: 'Could not score — insufficient evidence',
      notes: 'Fallback scoring failed',
    };
  }
}

// ---------------------------------------------------------------------------
// Running context — curate relevant facts for remaining questions
// ---------------------------------------------------------------------------

async function refreshRunningContext(
  state: AgentSessionState,
  modelId?: string,
  region?: string,
): Promise<string> {
  // Gather remaining question labels
  const remaining: string[] = [];
  for (let s = state.currentSectionIdx; s < SECTIONS.length; s++) {
    const startQ = s === state.currentSectionIdx ? state.currentQuestionIdx : 0;
    for (let q = startQ; q < SECTIONS[s].questions.length; q++) {
      remaining.push(`${SECTIONS[s].name}: ${SECTIONS[s].questions[q].label}`);
    }
  }

  if (remaining.length === 0 || state.results.length === 0) return '';

  // Build evidence from all scored questions
  const evidence = state.results
    .map(r => `[${r.section} — ${r.label}] Score: ${r.score}/5. ${r.evidence}${r.notes ? ' ' + r.notes : ''}`)
    .join('\n');

  const prompt = `You are helping an interviewer prepare context for upcoming questions.

SCORED ANSWERS SO FAR:
${evidence}

REMAINING QUESTIONS (topics only):
${remaining.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Extract ONLY the facts from the scored answers that are directly relevant to the remaining questions. Be concise — short bullet points, no fluff. Drop anything that only mattered for already-scored questions. Max 10 bullets.

Format:
- fact 1
- fact 2`;

  try {
    const result = await callBedrock(
      'You are a concise summarizer. Return only bullet points.',
      [{ role: 'user', content: prompt }],
      modelId,
      region,
    );
    return result.trim();
  } catch (err) {
    console.error('Running context refresh failed:', err);
    return state.runningContext; // keep previous context on failure
  }
}

const ORG_READINESS_QUESTIONS: Array<{ key: string; label: string; ask: string }> = [
  { key: 'executiveSponsor', label: 'Executive Sponsor', ask: 'Does your organization have an executive sponsor (CTO/VP level) who actively champions AI adoption in engineering?' },
  { key: 'budgetAllocated', label: 'Budget Allocated', ask: 'Is there a dedicated budget allocated for AI tooling and transformation?' },
  { key: 'dedicatedOwner', label: 'Dedicated Owner', ask: 'Is there a dedicated AI/platform team or named owner responsible for AI engineering transformation?' },
  { key: 'awsRelationship', label: 'AWS Relationship', ask: 'Does your organization have an existing AWS commitment or relationship?' },
  { key: 'appropriateTeamSize', label: 'Team Size', ask: 'Is your engineering team in the 20-200 engineer range?' },
];

async function handleOrgReadiness(
  state: AgentSessionState,
  userMessage: string,
  modelId?: string,
  region?: string,
): Promise<{ reply: string; state: AgentSessionState; done: boolean }> {
  // Parse yes/no from the user's response
  const answeredCount = Object.values(state.orgReadiness).filter(v => v !== false).length;
  // Actually count how many we've asked (based on conversation flow)
  const orgAsked = state.messages.filter(m =>
    m.role === 'assistant' && ORG_READINESS_QUESTIONS.some(q => m.content.includes(q.label) || m.content.includes(q.ask.substring(0, 30)))
  ).length;

  // Determine which question was just answered
  const currentOrgIdx = Math.min(orgAsked - 1, ORG_READINESS_QUESTIONS.length - 1);
  if (currentOrgIdx >= 0 && currentOrgIdx < ORG_READINESS_QUESTIONS.length) {
    const currentQ = ORG_READINESS_QUESTIONS[currentOrgIdx];
    // Use LLM to interpret yes/no
    try {
      const parseResult = await callBedrock(
        `The user was asked: "${currentQ.ask}". Based on their response, is the answer yes or no? Respond with ONLY "yes" or "no".`,
        [{ role: 'user', content: userMessage }],
        modelId,
        region,
      );
      state.orgReadiness[currentQ.key] = parseResult.trim().toLowerCase().startsWith('yes');
    } catch {
      state.orgReadiness[currentQ.key] = userMessage.trim().toLowerCase().startsWith('y');
    }
  }

  // Ask next org readiness question
  const nextIdx = currentOrgIdx + 1;
  if (nextIdx < ORG_READINESS_QUESTIONS.length) {
    const nextQ = ORG_READINESS_QUESTIONS[nextIdx];
    const reply = nextQ.ask;
    state.messages.push({ role: 'assistant', content: reply });
    return { reply, state, done: false };
  }

  // All org readiness done — move to closing
  state.phase = 'closing';
  const closingReply = `Thanks for those details! That covers everything I needed to ask.

A couple of wrap-up questions:
1. Is there anything about your AI engineering practices that I didn't ask about but you think is important?
2. What's the most impactful change you've made in the last quarter related to AI in engineering?`;

  state.messages.push({ role: 'assistant', content: closingReply });
  return { reply: closingReply, state, done: false };
}

async function handleClosing(
  state: AgentSessionState,
  userMessage: string,
): Promise<{ reply: string; state: AgentSessionState; done: boolean }> {
  state.closingNotes = userMessage;
  state.phase = 'complete';

  const totalScore = state.results.reduce((sum, r) => sum + r.score, 0);
  const reply = `Thank you so much for your time — this was really helpful. We'll compile everything into a detailed report.

**Interview complete!** Your responses have been scored across all 20 questions.

Click "View Report" below to see the full assessment results.`;

  state.messages.push({ role: 'assistant', content: reply });
  return { reply, state, done: true };
}

// ---------------------------------------------------------------------------
// Utility: convert agent results to the form data format expected by reportPage
// ---------------------------------------------------------------------------

export function agentResultsToFormData(state: AgentSessionState): Record<string, string> {
  const form: Record<string, string> = {
    customerName: state.customerName || 'Unknown',
    saName: state.saName,
    fundingStage: state.fundingStage || '',
    teamSize: String(state.teamSize || 10),
  };

  // Map question scores
  for (const result of state.results) {
    form[result.questionId] = String(result.score);
  }

  // Map section notes from evidence
  for (const section of SECTIONS) {
    const sectionResults = state.results.filter(r =>
      section.questions.some(q => q.id === r.questionId)
    );
    const notes = sectionResults
      .map(r => `${r.label}: ${r.evidence}`)
      .join('; ');
    form[`${section.id}_notes`] = notes;
  }

  // Org readiness
  for (const [key, val] of Object.entries(state.orgReadiness)) {
    if (val) form[key] = 'on';
  }

  // Encode scan data
  form.scanData = Buffer.from(JSON.stringify(state.scanData)).toString('base64');

  return form;
}
