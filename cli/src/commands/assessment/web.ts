import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runScan } from '../../scanner/index.js';
import type { ScanResult } from '../../scanner/types.js';
import {
  createSession,
  processMessage,
  agentResultsToFormData,
  checkBedrockAccess,
  SECTIONS as AGENT_SECTIONS,
  type AgentSessionState,
} from './interview-agent.js';

// Detect ECS mode — disables repo scanning, only allows JSON import
const isEcsMode = !!(process.env.PRISM_ECS_MODE || process.env.ECS_CONTAINER_METADATA_URI);

// ---------------------------------------------------------------------------
// Interview section definitions — enriched from interview-guide.md
// ---------------------------------------------------------------------------
interface InterviewQuestion {
  id: string;
  label: string;
  max: number;
  ask: string;
  listenFor: string[];
  rubric: string[];  // index = score (0-5)
}

interface InterviewSection {
  id: string;
  name: string;
  maxScore: number;
  time: string;
  questions: InterviewQuestion[];
}

const INTERVIEW_SECTIONS: InterviewSection[] = [
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
// Scanner runner — uses the built-in scanner module directly
// ---------------------------------------------------------------------------
type ScanResultJSON = ScanResult;

// ---------------------------------------------------------------------------
// Scoring (inline — mirrors assessment/scoring/scoring-model.ts)
// ---------------------------------------------------------------------------
interface BlendedResult {
  scannerScore: number;
  interviewScore: number;
  orgReadinessScore: number;
  blendedScore: number;
  level: string;
  verdict: string;
}

function computeBlended(scannerTotal: number, scannerMax: number, interviewTotal: number, org: Record<string, boolean>): BlendedResult {
  const scannerScore = scannerMax > 0 ? (scannerTotal / scannerMax) * 100 : 0;
  const interviewScore = interviewTotal; // already 0-100
  let orgRaw = 0;
  if (org.executiveSponsor) orgRaw += 4;
  if (org.budgetAllocated) orgRaw += 4;
  if (org.dedicatedOwner) orgRaw += 4;
  if (org.awsRelationship) orgRaw += 4;
  if (org.appropriateTeamSize) orgRaw += 4;
  const orgScaled = (orgRaw / 20) * 100;
  const blended = Math.round((scannerScore * 0.4 + interviewScore * 0.4 + orgScaled * 0.2) * 100) / 100;

  const thresholds: [number, string][] = [
    [81, 'L5.0'], [71, 'L4.5'], [61, 'L4.0'], [51, 'L3.5'],
    [41, 'L3.0'], [31, 'L2.5'], [21, 'L2.0'], [11, 'L1.5'], [0, 'L1.0'],
  ];
  let level = 'L1.0';
  for (const [t, l] of thresholds) { if (blended >= t) { level = l; break; } }

  let verdict = 'NOT_QUALIFIED';
  if (blended >= 21 && orgRaw >= 12) verdict = 'READY_FOR_PILOT';
  else if (blended >= 11 && orgRaw >= 8) verdict = 'NEEDS_FOUNDATIONS';

  return { scannerScore: Math.round(scannerScore * 100) / 100, interviewScore, orgReadinessScore: orgRaw, blendedScore: blended, level, verdict };
}

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------
const PAGE_STYLE = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Amazon Ember',ember-display,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9f9fb;color:#232F3E;line-height:1.6}
  .page-bg-wash{position:fixed;top:0;left:0;width:100%;height:100%;z-index:-20;pointer-events:none}
  .page-bg-wash svg{width:100%;height:100%}
  .hero{background:#f9f9fb;position:relative;overflow:hidden;padding:56px 24px 64px}
  .hero-inner{max-width:900px;margin:0 auto;position:relative;z-index:1;display:flex;align-items:center;gap:40px}
  .hero-text{flex:1}
  .hero h1{font-size:2.75rem;font-weight:700;color:#232F3E;margin-bottom:12px;line-height:1.2}
  .hero .subtitle{color:#544F69;font-size:1.25rem;line-height:2rem}
  .hero-cta{display:inline-block;margin-top:24px;background:linear-gradient(90deg,#DF2A5D 0.41%,#7C5AED 99.55%);color:#fff;border:none;padding:14px 28px;border-radius:100px;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 4px 32px 4px rgba(8,37,70,.18);transition:.3s;text-decoration:none}
  .hero-cta:hover{background:linear-gradient(90deg,#7A55F4 0.41%,#DD1D53 99.11%);transform:scale(1.02)}
  .hero-image{position:relative;flex:0 0 300px;height:220px;border-radius:20px}
  .hero-image::before{content:'';position:absolute;inset:-30px -70px;z-index:0;border-radius:24px;background:linear-gradient(135deg,rgba(223,42,93,.12),rgba(124,90,237,.10),rgba(124,232,244,.12));filter:blur(25px)}
  .hero-image img,.hero-image .placeholder{position:relative;z-index:1;width:100%;height:100%;object-fit:cover;border-radius:20px}
  .hero-image .placeholder{background:linear-gradient(135deg,rgba(124,90,237,.7) 0%,rgba(124,232,244,.7) 100%);display:flex;align-items:center;justify-content:center;font-size:48px}
  .page{max-width:900px;margin:0 auto;padding:32px 24px 40px}
  h1{font-size:1.5rem;font-weight:700;margin-bottom:8px}
  h2{font-size:1.25rem;font-weight:700;margin:24px 0 12px;padding-bottom:8px;border-bottom:none;color:#232F3E}
  .card{position:relative;background:#fff;border-radius:16px;box-shadow:0 4px 40px rgba(51,0,102,.05);padding:32px;margin-bottom:24px;overflow:visible}
  .card::before{content:'';position:absolute;inset:-20px -40px;z-index:-1;border-radius:24px;background:linear-gradient(135deg,rgba(223,42,93,.12),rgba(124,90,237,.10),rgba(124,232,244,.12));filter:blur(25px)}

  .card h2{margin-top:0;padding-bottom:0}
  label{display:block;font-weight:500;margin-bottom:4px;font-size:14px}
  input[type=text],input[type=number],select{width:100%;padding:10px 14px;border:1px solid #DBDBE1;border-radius:8px;font-size:14px;margin-bottom:12px;transition:border-color .2s}
  input[type=text]:focus,input[type=number]:focus,select:focus{outline:none;border-color:#2074D5;box-shadow:0 0 0 3px rgba(32,116,213,.12)}
  input[type=number]{width:80px}
  button{background:#2074D5;color:#fff;border:none;padding:12px 24px;border-radius:100px;font-size:14px;font-weight:700;cursor:pointer;margin-right:8px;transition:.3s;letter-spacing:.4px}
  button:hover{background:#1766C2}
  button.gradient{background:linear-gradient(90deg,#DF2A5D 0.41%,#7C5AED 99.55%);box-shadow:0 4px 32px 4px rgba(8,37,70,.18)}
  button.gradient:hover{background:linear-gradient(90deg,#7A55F4 0.41%,#DD1D53 99.11%)}
  button.secondary{background:white;color:#2074D5;border:1px solid #2074D5}
  button.secondary:hover{background:#F6F9FF}
  .badge{display:inline-block;padding:4px 14px;border-radius:100px;font-size:13px;font-weight:700;color:#fff}
  .badge-green{background:#37A04D}.badge-amber{background:#FF9900}.badge-red{background:#D13212}
  table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
  th{background:#F4F3F4;color:#544F69;font-weight:700;text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
  td{padding:10px 12px;border-bottom:1px solid #EEEDF2}
  .progress-bg{background:#EEEDF2;border-radius:100px;height:8px;width:100%}
  .progress-fill{border-radius:100px;height:8px}
  .fill-green{background:#37A04D}.fill-amber{background:#FF9900}.fill-red{background:#D13212}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .score-big{font-size:2.75rem;font-weight:700;background:linear-gradient(90deg,#7CE8F4,#7C5AED);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
  .subtitle{color:#544F69;font-size:14px}
  .section-q{display:flex;align-items:center;gap:12px;margin-bottom:8px}
  .section-q label{margin:0;flex:1}
  .section-q input{margin:0;width:70px}
  .checkbox-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .checkbox-row input{width:auto;margin:0}
  .notes{width:100%;min-height:60px;padding:10px;border:1px solid #DBDBE1;border-radius:8px;font-size:13px;resize:vertical}
  .hidden{display:none!important}
  .spinner{display:inline-block;width:18px;height:18px;border:3px solid #EEEDF2;border-top-color:#7C5AED;border-radius:50%;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:768px){.hero-inner{flex-direction:column;text-align:center}.hero-image{display:none}.hero h1{font-size:2rem}}
`;

function scanPage(): string {
  const scanSection = isEcsMode ? '' : `<div class="card" style="margin-top:20px">
  <h2>Option A: Scan a Repository</h2>
  <form id="scanForm" method="POST" action="/scan">
    <label for="repoPath">Local repository path</label>
    <input type="text" id="repoPath" name="repoPath" placeholder="/home/user/my-project" required>
    <button type="submit">Scan Repository</button>
    <span id="spinner" class="spinner hidden"></span>
  </form>
</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PRISM D1 Assessment</title><meta name="theme-color" content="#f9f9fb"><style>${PAGE_STYLE}</style></head><body>
<div class="page-bg-wash"><svg viewBox="0 0 1440 415" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none"><path d="M0 0h1440v235L0 415V0Z" fill="url(#pgbg)"/><defs><linearGradient id="pgbg" x1="0" y1="208" x2="1440" y2="208" gradientUnits="userSpaceOnUse"><stop stop-color="#7CE8F4" stop-opacity="0.08"/><stop offset="1" stop-color="#7C5AED" stop-opacity="0.04"/></linearGradient></defs></svg></div>
<div class="hero">
  <div class="hero-inner">
    <div class="hero-text">
      <h1>PRISM D1 Velocity Assessment</h1>
      <p class="subtitle">AI-Assisted Development Lifecycle Maturity Scanner${isEcsMode ? ' — Cloud Mode' : ''}</p>
    </div>
    <div class="hero-image">
      <div class="placeholder">🚀</div>
    </div>
  </div>
</div>
<div class="page">
${scanSection}
<div class="card"${isEcsMode ? ' style="margin-top:20px"' : ''}>
  <h2>${isEcsMode ? 'Import Scan Results' : 'Option B: Import Previous Scan Results'}</h2>
  <p class="subtitle" style="margin-bottom:12px">Upload a JSON file from a previous scan to view results and continue to the interview.</p>
  <form id="importForm" method="POST" action="/import" enctype="multipart/form-data">
    <input type="file" id="importFile" accept=".json" style="margin-bottom:12px" required>
    <input type="hidden" name="scanData" id="scanDataInput">
    <button type="submit">Import &amp; Start Interview →</button>
  </form>
</div>
</div>
<script>
var sf = document.getElementById('scanForm');
if (sf) { sf.addEventListener('submit', function() { document.getElementById('spinner').classList.remove('hidden'); }); }
window.addEventListener('pageshow', function() { var s = document.getElementById('spinner'); if (s) s.classList.add('hidden'); });
document.getElementById('importForm').addEventListener('submit', function(e) {
  var fileInput = document.getElementById('importFile');
  console.log('[PRISM] Submit fired, file:', fileInput.files ? fileInput.files[0] : 'none');
  if (!fileInput.files || !fileInput.files[0]) { e.preventDefault(); alert('Select a JSON file first.'); return; }
  e.preventDefault();
  var reader = new FileReader();
  reader.onload = function(ev) {
    console.log('[PRISM] FileReader loaded, length:', ev.target.result.length);
    try {
      var data = JSON.parse(ev.target.result);
      console.log('[PRISM] Parsed OK, repoName:', data.repoName, 'categories:', !!data.categories);
      if (!data.repoName || !data.categories) { alert('Invalid scan JSON. Expected a PRISM scanner output file.'); return; }
      var hiddenInput = document.getElementById('scanDataInput');
      hiddenInput.value = ev.target.result;
      console.log('[PRISM] Hidden input value length:', hiddenInput.value.length);
      console.log('[PRISM] Submitting form, enctype:', document.getElementById('importForm').enctype);
      document.getElementById('importForm').submit();
    } catch(err) { alert('Could not parse JSON: ' + err.message); }
  };
  reader.readAsText(fileInput.files[0]);
});
</script>
</body></html>`;
}

function scanResultsPage(scan: ScanResultJSON, imported: boolean = false): string {
  const catRows = scan.categories.map(c => {
    const pct = c.maxPoints > 0 ? Math.round((c.earnedPoints / c.maxPoints) * 100) : 0;
    const cls = pct >= 60 ? 'green' : pct >= 30 ? 'amber' : 'red';
    return `<tr><td>${c.category}</td><td><strong>${c.earnedPoints}/${c.maxPoints}</strong></td>
      <td><div class="progress-bg"><div class="progress-fill fill-${cls}" style="width:${pct}%"></div></div></td>
      <td>${pct}%</td></tr>`;
  }).join('');

  const strengthsHtml = (scan.strengths || []).map(s => `<li>${s}</li>`).join('');
  const gapsHtml = (scan.gaps || []).map(g => `<li>${g}</li>`).join('');
  const recsHtml = (scan.recommendations || []).map(r => `<li>${r}</li>`).join('');

  // Encode scan data for passing to interview form
  const scanB64 = Buffer.from(JSON.stringify(scan)).toString('base64');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Scan Results — ${scan.repoName}</title><style>${PAGE_STYLE}</style></head><body><div class="page">
<h1>Scan Results: ${scan.repoName}</h1>
<p class="subtitle">Scanned ${scan.scanDate}</p>

<div class="card">
  <div class="grid-2">
    <div><div class="score-big">${scan.totalScore}/${scan.maxScore}</div><div class="subtitle">Scanner Score</div></div>
    <div><div class="score-big">${scan.prismLevel.level}</div><div class="subtitle">${scan.prismLevel.label} — ${scan.prismLevel.description}</div></div>
  </div>
</div>

<div class="card">
  <h2>Category Breakdown</h2>
  <table><thead><tr><th>Category</th><th>Score</th><th>Progress</th><th>%</th></tr></thead>
  <tbody>${catRows}</tbody></table>
</div>

<div class="card grid-2">
  <div><h2>Strengths</h2><ol>${strengthsHtml || '<li>None detected</li>'}</ol></div>
  <div><h2>Gaps</h2><ol>${gapsHtml || '<li>None detected</li>'}</ol></div>
</div>

${recsHtml ? `<div class="card"><h2>Recommendations</h2><ul>${recsHtml}</ul></div>` : ''}

<div class="card">
  <h2>Next Steps</h2>
  <p style="color:#475569;font-size:14px;line-height:1.7;margin-bottom:16px">The scanner covers 40% of the assessment. The remaining 60% comes from a structured interview (40%) and org readiness check (20%). The interview takes <strong>30–60 minutes</strong> and covers AI tooling, workflow, CI/CD, metrics, governance, and org culture. You have three options:</p>
  <div style="display:grid;grid-template-columns:${imported ? '1fr 1fr' : '1fr 1fr 1fr'};gap:12px">
    ${imported ? '' : `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center">
      <div style="font-size:24px;margin-bottom:8px">📤</div>
      <div style="font-weight:600;margin-bottom:4px">Hand off to SA</div>
      <p class="subtitle" style="margin-bottom:12px">Export the scan results and send them to your Solutions Architect to conduct the interview.</p>
      <form method="POST" action="/export-json"><input type="hidden" name="scanData" value="${scanB64}">
        <button type="submit" class="secondary" style="width:100%">Export JSON</button></form>
    </div>`}
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center">
      <div style="font-size:24px;margin-bottom:8px">📋</div>
      <div style="font-weight:600;margin-bottom:4px">Manual Interview</div>
      <p class="subtitle" style="margin-bottom:12px">Fill out the scoring form yourself using the rubrics. Best if you're the SA running the assessment.</p>
      <form method="POST" action="/interview"><input type="hidden" name="scanData" value="${scanB64}">
        <button type="submit" style="width:100%">Manual Form →</button></form>
    </div>
    <div style="border:1px solid #7c3aed;border-radius:8px;padding:16px;text-align:center;background:#faf5ff">
      <div style="font-size:24px;margin-bottom:8px">🤖</div>
      <div style="font-weight:600;margin-bottom:4px">AI Agent Interview</div>
      <p class="subtitle" style="margin-bottom:8px">An AI agent conducts the interview conversationally and scores your responses automatically.</p>
      <p style="font-size:12px;color:#7c3aed;margin-bottom:12px">Requires Amazon Bedrock access · <a href="#" onclick="document.getElementById('bedrockModal').classList.remove('hidden');return false" style="color:#7c3aed;text-decoration:underline">Setup guide</a></p>
      <form method="POST" action="/interview-agent"><input type="hidden" name="scanData" value="${scanB64}">
        <button type="submit" style="width:100%;background:linear-gradient(135deg,#7c3aed,#0066ff)">Start AI Interview →</button></form>
    </div>
  </div>
</div>

<div id="bedrockModal" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.classList.add('hidden')">
  <div style="background:#fff;border-radius:12px;max-width:560px;width:90%;max-height:85vh;overflow-y:auto;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.2)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="margin:0;border:none;padding:0">Bedrock Setup Guide</h2>
      <button onclick="document.getElementById('bedrockModal').classList.add('hidden')" style="background:none;color:#64748b;font-size:20px;padding:4px 8px;cursor:pointer">✕</button>
    </div>
    <p style="color:#475569;font-size:14px;margin-bottom:16px">The AI interview agent uses <strong>Amazon Bedrock</strong> to run Claude locally. It calls the model from your machine using your AWS credentials — nothing is deployed or hosted.</p>
    <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-size:12px;color:#64748b;text-transform:uppercase;font-weight:600;margin-bottom:6px">Model Used</div>
      <code style="font-size:14px;color:#7c3aed">us.anthropic.claude-sonnet-4-6</code>
      <p style="font-size:12px;color:#64748b;margin-top:4px">Claude Sonnet 4.6 via cross-region inference (US)</p>
    </div>
    <h3 style="font-size:14px;font-weight:600;margin-bottom:8px">1. Enable model access</h3>
    <ol style="font-size:13px;color:#475569;padding-left:20px;margin-bottom:16px;line-height:1.8">
      <li>Open the <a href="https://console.aws.amazon.com/bedrock/home#/modelaccess" target="_blank" style="color:#0066ff">Bedrock Model Access</a> page in the AWS Console</li>
      <li>Click <strong>Manage model access</strong></li>
      <li>Find <strong>Anthropic → Claude Sonnet 4.6</strong> and enable it</li>
      <li>Wait for status to show "Access granted" (usually instant)</li>
    </ol>
    <h3 style="font-size:14px;font-weight:600;margin-bottom:8px">2. Configure AWS credentials</h3>
    <p style="font-size:13px;color:#475569;margin-bottom:8px">Any of these methods work:</p>
    <div style="background:#1e293b;color:#e2e8f0;border-radius:6px;padding:12px;font-size:12px;font-family:monospace;margin-bottom:8px;line-height:1.6">
      <span style="color:#94a3b8"># Option A: AWS CLI (recommended)</span><br>
      aws configure<br><br>
      <span style="color:#94a3b8"># Option B: SSO</span><br>
      aws sso login --profile your-profile<br><br>
      <span style="color:#94a3b8"># Option C: Environment variables</span><br>
      export AWS_ACCESS_KEY_ID=AKIA...<br>
      export AWS_SECRET_ACCESS_KEY=...<br>
      export AWS_REGION=us-west-2
    </div>
    <h3 style="font-size:14px;font-weight:600;margin-bottom:8px">3. Start the interview</h3>
    <p style="font-size:13px;color:#475569;margin-bottom:16px">Once model access is enabled and credentials are configured, click "Start AI Interview" on the scan results page. The agent will verify your access automatically before beginning.</p>
    <p style="font-size:12px;color:#64748b">The agent will verify your access when the interview starts. If something is misconfigured, you'll see specific instructions on what to fix.</p>
    <div style="text-align:center;margin-top:16px">
      <button onclick="document.getElementById('bedrockModal').classList.add('hidden')">Got it</button>
    </div>
  </div>
</div>
</div></body></html>`;
}

function interviewPage(scan: ScanResultJSON): string {
  const scanB64 = Buffer.from(JSON.stringify(scan)).toString('base64');

  // Build scanner-informed probes (from pre-interview-checklist.md)
  const probes: string[] = [];
  for (const cat of scan.categories) {
    const pct = cat.maxPoints > 0 ? (cat.earnedPoints / cat.maxPoints) * 100 : 0;
    if (pct < 30) {
      if (cat.category.includes('Commit')) probes.push(`Scanner: low AI commit attribution (${cat.earnedPoints}/${cat.maxPoints}). Probe: "How do you track which code is AI-assisted?"`);
      else if (cat.category.includes('CI')) probes.push(`Scanner: no AI eval gates in CI (${cat.earnedPoints}/${cat.maxPoints}). Probe: "Your CI doesn't have AI-specific validation. Is that intentional?"`);
      else if (cat.category.includes('Spec')) probes.push(`Scanner: no structured specs detected (${cat.earnedPoints}/${cat.maxPoints}). Probe: "Where do design decisions live?"`);
      else if (cat.category.includes('Test')) probes.push(`Scanner: low test coverage (${cat.earnedPoints}/${cat.maxPoints}). Probe: "How does AI factor into your testing strategy?"`);
      else if (cat.category.includes('Observ')) probes.push(`Scanner: no AI observability (${cat.earnedPoints}/${cat.maxPoints}). Probe: "How do you measure AI's impact on velocity?"`);
    }
  }
  const probesHtml = probes.length > 0
    ? `<div class="card" style="border-left:4px solid #f59e0b"><h2>Scanner-Informed Focus Areas</h2><p class="subtitle" style="margin-bottom:8px">Based on scanner gaps — consider these areas carefully during the interview.</p><ul>${probes.map(p => `<li>${p}</li>`).join('')}</ul></div>`
    : '';

  let sectionsHtml = '';
  for (const sec of INTERVIEW_SECTIONS) {
    let questionsHtml = '';
    for (const q of sec.questions) {
      const listenHtml = q.listenFor.map(l => `<li>${l}</li>`).join('');
      const rubricHtml = q.rubric.map((r, i) => `<tr><td style="text-align:center;font-weight:600;width:30px">${i}</td><td>${r}</td></tr>`).join('');

      questionsHtml += `
      <div data-qid="${q.id}" data-qlabel="${q.label}" style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;transition:all .2s">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:12px">
          <div style="flex:1">
            <label for="${q.id}" style="font-size:15px;font-weight:600">${q.label}</label>
            <p class="q-ask" style="color:#475569;font-size:13px;margin:6px 0;font-style:italic">"${q.ask}"</p>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <select id="${q.id}" name="${q.id}" required style="width:60px"><option value="" selected>—</option><option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select>
            <span class="subtitle">/ ${q.max}</span>
          </div>
        </div>
        <div class="q-detail" style="margin-top:10px;font-size:13px">
            <div style="margin-bottom:8px"><strong style="font-size:12px;color:#64748b">WHAT TO CONSIDER:</strong><ul style="margin:4px 0 0 16px;color:#475569">${listenHtml}</ul></div>
            <table style="font-size:12px"><thead><tr><th style="width:30px">Score</th><th>Evidence</th></tr></thead><tbody>${rubricHtml}</tbody></table>
          </div>
      </div>`;
    }
    sectionsHtml += `<div class="card">
      <h2>${sec.name} <span class="subtitle">(max ${sec.maxScore}, ${sec.time})</span></h2>
      ${questionsHtml}
      <label>Key findings / notes</label>
      <textarea class="notes" name="${sec.id}_notes" placeholder="Observations for this section..."></textarea>
    </div>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Interview — ${scan.repoName}</title><style>${PAGE_STYLE}
  [data-qid].answered{border-color:#22c55e;background:#f0fdf4;padding:10px 16px}
  [data-qid].answered .q-detail{display:none}
  [data-qid].answered .q-ask{display:none}
  [data-qid].answered label{color:#16a34a}
</style></head><body><div class="page">
<h1>Assessment Interview: ${scan.repoName}</h1>
<p class="subtitle">Scanner score: ${scan.totalScore}/${scan.maxScore} (${scan.prismLevel.level}) · 20 questions · 60-90 minutes</p>

<div class="card" style="background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff;margin-top:16px">
  <p style="font-size:14px;line-height:1.7;color:#e2e8f0">This interview covers how your team builds software today, with a focus on how AI tools fit into your workflow. There are no wrong answers — the goal is to understand where you are so we can identify the most useful next steps.</p>
  <p class="subtitle" style="color:#94a3b8;margin-top:8px">Tip: When in doubt between two scores, pick the lower one. For each question, use the scoring rubric to calibrate your answer.</p>
</div>

${probesHtml}

<form method="POST" action="/report">
<input type="hidden" name="scanData" value="${scanB64}">

<div class="card">
  <h2>Assessment Info</h2>
  <div class="grid-2">
    <div><label for="customerName">Customer name</label><input type="text" id="customerName" name="customerName" required></div>
    <div><label for="saName">Completed by</label><input type="text" id="saName" name="saName" required></div>
    <div><label for="fundingStage">Funding stage</label><select id="fundingStage" name="fundingStage"><option value="">Select...</option><option>Pre-Seed</option><option>Seed</option><option>Series A</option><option>Series B</option><option>Series C</option><option>Series D+</option><option>Growth / Late Stage</option><option>Public</option><option>Bootstrapped</option></select></div>
    <div><label for="teamSize">Team size (engineers)</label><input type="number" id="teamSize" name="teamSize" min="1" value="10"></div>
  </div>
</div>

${sectionsHtml}

<div class="card">
  <h2>Org Readiness</h2>
  <div class="checkbox-row"><input type="checkbox" id="executiveSponsor" name="executiveSponsor"><label for="executiveSponsor">Executive sponsor identified</label></div>
  <div class="checkbox-row"><input type="checkbox" id="budgetAllocated" name="budgetAllocated"><label for="budgetAllocated">Budget allocated for AI tooling</label></div>
  <div class="checkbox-row"><input type="checkbox" id="dedicatedOwner" name="dedicatedOwner"><label for="dedicatedOwner">Dedicated AI/platform team or owner</label></div>
  <div class="checkbox-row"><input type="checkbox" id="awsRelationship" name="awsRelationship"><label for="awsRelationship">Existing AWS commitment/relationship</label></div>
  <div class="checkbox-row"><input type="checkbox" id="appropriateTeamSize" name="appropriateTeamSize"><label for="appropriateTeamSize">Team size appropriate (20-200 engineers)</label></div>
</div>

<div class="card"><button type="submit" id="submitBtn">Generate Report →</button>
  <div id="validationMsg" style="color:#ef4444;font-size:14px;margin-top:8px" class="hidden"></div>
</div>
</form>
</div>
<script>
// Question IDs for validation
var qIds = [${INTERVIEW_SECTIONS.flatMap(s => s.questions.map(q => `'${q.id}'`)).join(',')}];
var infoIds = ['customerName','saName'];

// Collapse answered questions
document.querySelectorAll('select[id^="q"]').forEach(function(sel) {
  sel.addEventListener('change', function() {
    var card = this.closest('[data-qid]');
    if (!card) return;
    if (this.value !== '') {
      card.classList.add('answered');
    } else {
      card.classList.remove('answered');
    }
  });
});

// Validation on submit
document.getElementById('submitBtn').closest('form').addEventListener('submit', function(e) {
  var missing = [];
  infoIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el || !el.value.trim()) missing.push(el ? (el.previousElementSibling ? el.previousElementSibling.textContent : id) : id);
  });
  qIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    var val = el.value;
    if (val === '' || val === null || val === undefined) {
      var card = el.closest('[data-qid]');
      var name = card ? card.getAttribute('data-qlabel') : id;
      missing.push(name);
    }
  });
  if (missing.length > 0) {
    e.preventDefault();
    var msg = document.getElementById('validationMsg');
    msg.innerHTML = 'Please complete: ' + missing.map(function(m) { return '<strong>' + m + '</strong>'; }).join(', ');
    msg.classList.remove('hidden');
    msg.scrollIntoView({behavior:'smooth', block:'center'});
  }
});
</script>
</body></html>`;
}

function reportPage(scan: ScanResultJSON, interview: Record<string, any>, blended: BlendedResult): string {
  const customerName = interview.customerName || scan.repoName;
  const saName = interview.saName || 'N/A';
  const fundingStage = interview.fundingStage || 'N/A';
  const teamSize = interview.teamSize || 'N/A';

  // Build interview section scores
  let interviewRows = '';
  let interviewTotal = 0;
  for (const sec of INTERVIEW_SECTIONS) {
    let secScore = 0;
    for (const q of sec.questions) {
      secScore += parseInt(interview[q.id] || '0', 10);
    }
    interviewTotal += secScore;
    const pct = sec.maxScore > 0 ? Math.round((secScore / sec.maxScore) * 100) : 0;
    const cls = pct >= 60 ? 'green' : pct >= 30 ? 'amber' : 'red';
    const notes = interview[`${sec.id}_notes`] || '';
    const notesHtml = notes ? `<br><span class="subtitle">${notes}</span>` : '';
    interviewRows += `<tr><td><strong>${sec.name}</strong>${notesHtml}</td>
      <td>${secScore}/${sec.maxScore}</td><td><span class="badge badge-${cls}">${pct}%</span></td></tr>`;
  }

  // Scanner category rows + radar chart data
  const catData = scan.categories.map(c => {
    const pct = c.maxPoints > 0 ? Math.round((c.earnedPoints / c.maxPoints) * 100) : 0;
    const cls = pct >= 60 ? 'green' : pct >= 30 ? 'amber' : 'red';
    return { name: c.category, earned: c.earnedPoints, max: c.maxPoints, pct, cls };
  });
  const scanRows = catData.map(c =>
    `<tr><td>${c.name}</td><td>${c.earned}/${c.max}</td>
      <td><div class="progress-bg"><div class="progress-fill fill-${c.cls}" style="width:${c.pct}%"></div></div></td>
      <td>${c.pct}%</td></tr>`
  ).join('');

  // SVG Radar chart
  const cx = 190, cy = 190, maxR = 150, n = catData.length;
  const angleStep = (2 * Math.PI) / n;
  const radarGrid = [0.25, 0.5, 0.75, 1.0].map(r =>
    `<circle cx="${cx}" cy="${cy}" r="${Math.round(maxR * r)}" fill="none" stroke="#e2e8f0" stroke-width="1"/>`
  ).join('');
  const radarAxes = catData.map((_, i) => {
    const a = -Math.PI / 2 + i * angleStep;
    const x2 = Math.round(cx + maxR * Math.cos(a));
    const y2 = Math.round(cy + maxR * Math.sin(a));
    return `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#e2e8f0" stroke-width="1"/>`;
  }).join('');
  const radarPoints = catData.map((c, i) => {
    const a = -Math.PI / 2 + i * angleStep;
    const r = (c.pct / 100) * maxR;
    return `${Math.round(cx + r * Math.cos(a))},${Math.round(cy + r * Math.sin(a))}`;
  }).join(' ');
  const radarDots = catData.map((c, i) => {
    const a = -Math.PI / 2 + i * angleStep;
    const r = (c.pct / 100) * maxR;
    const color = c.cls === 'green' ? '#22c55e' : c.cls === 'amber' ? '#f59e0b' : '#ef4444';
    return `<circle cx="${Math.round(cx + r * Math.cos(a))}" cy="${Math.round(cy + r * Math.sin(a))}" r="5" fill="${color}" stroke="#fff" stroke-width="2"/>`;
  }).join('');
  const radarLabels = catData.map((c, i) => {
    const a = -Math.PI / 2 + i * angleStep;
    const lr = maxR + 20;
    const x = Math.round(cx + lr * Math.cos(a));
    const y = Math.round(cy + lr * Math.sin(a));
    const anchor = Math.abs(Math.cos(a)) < 0.1 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
    const shortName = c.name.length > 14 ? c.name.slice(0, 12) + '…' : c.name;
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="10" fill="#64748b">${shortName}</text>`;
  }).join('');
  const radarSvg = `<svg viewBox="0 0 380 380" width="380" height="380" xmlns="http://www.w3.org/2000/svg">
    ${radarGrid}${radarAxes}
    <polygon points="${radarPoints}" fill="rgba(124,58,237,0.15)" stroke="#7c3aed" stroke-width="2"/>
    ${radarDots}${radarLabels}
  </svg>`;

  // Gap analysis (bottom 5 categories by percentage)
  const allScored = [
    ...catData.map(c => ({ name: c.name, source: 'scanner' as const, pct: c.pct, score: c.earned, max: c.max })),
    ...(() => {
      const result: { name: string; source: 'interview'; pct: number; score: number; max: number }[] = [];
      for (const sec of INTERVIEW_SECTIONS) {
        let s = 0;
        for (const q of sec.questions) s += parseInt(interview[q.id] || '0', 10);
        const p = sec.maxScore > 0 ? Math.round((s / sec.maxScore) * 100) : 0;
        result.push({ name: sec.name, source: 'interview', pct: p, score: s, max: sec.maxScore });
      }
      return result;
    })(),
  ];
  const gaps = [...allScored].sort((a, b) => a.pct - b.pct).slice(0, 5);
  const strengths = [...allScored].sort((a, b) => b.pct - a.pct).slice(0, 3);

  const REMEDIATION: Record<string, string> = {
    'AI Tool Config': 'Configure Bedrock access for every developer. Establish tool version pinning policy.',
    'Spec-Driven Dev': 'Adopt the three spec types as mandatory pre-work for AI-assisted tasks.',
    'Commit Hygiene': 'Deploy git hooks for AI-Origin and AI-Confidence trailers.',
    'CI/CD Integration': 'Add Bedrock Evaluation step to the primary PR pipeline.',
    'Eval & Quality': 'Define quality rubrics for AI-generated code. Implement automated scoring.',
    'Testing Maturity': 'Increase test coverage targets for AI-generated code.',
    'AI Observability': 'Deploy the EventBridge metrics pipeline. Enable token tracking and cost attribution.',
    'Governance': 'Create an AI usage governance charter. Define approval workflows.',
    'Agent Workflows': 'Identify first candidate for a multi-step agent workflow.',
    'Platform Reuse': 'Audit for reusable AI components. Create a shared prompt library.',
    'Documentation': 'Add AI-assisted documentation generation to the build process.',
    'Dependencies': 'Maintain dependency freshness and security scanning.',
    'AI Tooling Landscape': 'Standardize AI toolset across all squads with shared configuration.',
    'Development Workflow & Specs': 'Formalize spec-driven workflow. Ensure every AI task starts with a spec.',
    'CI/CD & Quality': 'Integrate eval gates into all active pipelines. Define quality baselines.',
    'Metrics & Visibility': 'Deploy the executive dashboard. Define key metrics and review cadence.',
    'Governance & Security': 'Draft AI governance charter. Address data residency and PII concerns.',
    'Organization & Culture': 'Run team enablement workshops. Create an internal AI champions program.',
  };
  const gapRows = gaps.map((g, i) =>
    `<tr><td style="text-align:center;font-weight:700">#${i + 1}</td><td>${g.name}</td>
      <td style="text-align:center"><span class="badge badge-${g.pct >= 60 ? 'green' : g.pct >= 30 ? 'amber' : 'red'}">${g.source}</span></td>
      <td style="text-align:center">${g.score}/${g.max} (${g.pct}%)</td>
      <td style="font-size:13px">${REMEDIATION[g.name] || 'Develop a targeted improvement plan with your SA.'}</td></tr>`
  ).join('');
  const strengthRows = strengths.map((s, i) =>
    `<tr><td style="text-align:center;font-weight:700">#${i + 1}</td><td>${s.name}</td>
      <td style="text-align:center"><span class="badge badge-${s.pct >= 60 ? 'green' : s.pct >= 30 ? 'amber' : 'red'}">${s.source}</span></td>
      <td style="text-align:center">${s.score}/${s.max} (${s.pct}%)</td></tr>`
  ).join('');

  // Onboarding track routing
  const level = parseFloat(blended.level.replace('L', ''));
  const track = level >= 3.5 ? { letter: 'D', name: 'Advanced', desc: 'Custom engagement, L4+ optimization' }
    : level >= 2.5 ? { letter: 'C', name: 'Accelerated', desc: 'Modules 03-05, targeted gaps' }
    : level >= 2.0 ? { letter: 'B', name: 'Full Workshop', desc: 'All modules, 8-week pilot' }
    : { letter: 'A', name: 'Foundations', desc: 'Modules 00-02, 2-week pre-work' };

  // 90-day roadmap
  const milestones = [
    { week: '1-2', milestone: 'Environment Setup & Baseline', measurable: 'All engineers have Bedrock access, baseline metrics captured' },
    { week: '3-4', milestone: 'Workshop Delivery', measurable: `Track ${track.letter} modules completed, eval gates configured` },
    { week: '5-8', milestone: 'Pilot Execution', measurable: 'AI acceptance rate ≥30%, spec-driven workflow adopted' },
    { week: '9-12', milestone: 'Measurement & Optimization', measurable: 'Dashboard live, PRISM level re-assessed, ROI documented' },
  ];
  const milestoneRows = milestones.map(m =>
    `<tr><td style="text-align:center;font-weight:600">Week ${m.week}</td><td>${m.milestone}</td><td style="font-size:13px">${m.measurable}</td></tr>`
  ).join('');

  // Success metrics
  const successMetrics = [
    { metric: 'AI Acceptance Rate', target: '≥30%', by: 'Week 8' },
    { metric: 'Eval Gate Pass Rate', target: '≥80%', by: 'Week 6' },
    { metric: 'Lead Time Reduction', target: '≥20%', by: 'Week 12' },
    { metric: 'PRISM Level Increase', target: '+1.0', by: 'Week 12' },
  ];
  const metricsRows = successMetrics.map(m =>
    `<tr><td>${m.metric}</td><td style="font-weight:600">${m.target}</td><td>${m.by}</td></tr>`
  ).join('');

  const verdictCls = blended.verdict === 'READY_FOR_PILOT' ? 'green' : blended.verdict === 'NEEDS_FOUNDATIONS' ? 'amber' : 'red';
  const verdictLabel = blended.verdict.replace(/_/g, ' ');

  // Org readiness items
  const orgKeys = ['executiveSponsor', 'budgetAllocated', 'dedicatedOwner', 'awsRelationship', 'appropriateTeamSize'];
  const orgLabels = ['Executive Sponsor', 'Budget Allocated', 'Dedicated Owner', 'AWS Relationship', 'Appropriate Team Size'];
  let orgHtml = '';
  orgKeys.forEach((k, i) => {
    const checked = !!interview[k];
    const icon = checked ? '✓' : '✗';
    const color = checked ? '#22c55e' : '#ef4444';
    orgHtml += `<span style="margin-right:16px"><span style="color:${color};font-weight:700">${icon}</span> ${orgLabels[i]}</span>`;
  });

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Assessment Report — ${customerName}</title><style>${PAGE_STYLE}
  @media print{.no-print{display:none}.card{box-shadow:none;border:1px solid #e2e8f0}}
</style></head><body><div class="page">

<div style="background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff;padding:36px 32px;border-radius:12px;margin-bottom:24px">
  <h1 style="color:#fff;margin-bottom:2px">PRISM D1 Velocity Assessment</h1>
  <div class="subtitle" style="color:#94a3b8;margin-bottom:16px">AI-Assisted Development Lifecycle Maturity Report</div>
  <div class="grid-2" style="font-size:14px">
    <div><span style="color:#94a3b8">Customer</span><br><strong>${customerName}</strong></div>
    <div><span style="color:#94a3b8">Team Size</span><br><strong>${teamSize} engineers</strong></div>
    <div><span style="color:#94a3b8">Funding Stage</span><br><strong>${fundingStage}</strong></div>
    <div><span style="color:#94a3b8">Completed By</span><br><strong>${saName}</strong></div>
    <div><span style="color:#94a3b8">Repository</span><br><strong style="font-family:monospace">${scan.repoName}</strong></div>
    <div><span style="color:#94a3b8">Date</span><br><strong>${scan.scanDate}</strong></div>
  </div>
</div>

<div class="card">
  <h2>Executive Summary</h2>
  <div style="display:flex;align-items:center;gap:24px;margin-bottom:16px">
    <div style="width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,#0066ff,#7c3aed);display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;font-weight:800;flex-shrink:0">${blended.level}</div>
    <div>
      <div style="font-size:20px;font-weight:700">PRISM D1 Level ${blended.level}</div>
      <span class="badge badge-${verdictCls}">${verdictLabel}</span>
    </div>
  </div>
  <div class="grid-2" style="gap:12px;margin-top:16px">
    <div class="card" style="text-align:center;margin:0"><div class="score-big">${Math.round(blended.scannerScore)}</div><div class="subtitle">Scanner (40%)</div></div>
    <div class="card" style="text-align:center;margin:0"><div class="score-big">${blended.interviewScore}</div><div class="subtitle">Interview (40%)</div></div>
  </div>
  <div class="grid-2" style="gap:12px;margin-top:12px">
    <div class="card" style="text-align:center;margin:0"><div class="score-big">${blended.orgReadinessScore}</div><div class="subtitle">Org Readiness /20 (20%)</div></div>
    <div class="card" style="text-align:center;margin:0"><div class="score-big">${blended.blendedScore}</div><div class="subtitle">Blended Score</div></div>
  </div>
</div>

<div class="card">
  <h2>Scanner Category Breakdown</h2>
  <div style="text-align:center;margin:20px 0">${radarSvg}</div>
  <table><thead><tr><th>Category</th><th>Score</th><th>Progress</th><th>%</th></tr></thead>
  <tbody>${scanRows}</tbody></table>
</div>

<div class="card">
  <h2>Interview Scores</h2>
  <table><thead><tr><th>Section</th><th>Score</th><th>Status</th></tr></thead>
  <tbody>${interviewRows}</tbody></table>
</div>

<div class="card">
  <h2>Organizational Readiness</h2>
  <div style="margin:8px 0">${orgHtml}</div>
  <p class="subtitle">Score: ${blended.orgReadinessScore}/20</p>
</div>

<div class="card">
  <h2>Top Strengths</h2>
  <p class="subtitle" style="margin-bottom:12px">Top 3 capabilities to build on:</p>
  <table><thead><tr><th style="text-align:center">Rank</th><th>Area</th><th style="text-align:center">Source</th><th style="text-align:center">Score</th></tr></thead>
  <tbody>${strengthRows}</tbody></table>
</div>

<div class="card">
  <h2>Gap Analysis &amp; Remediation</h2>
  <p class="subtitle" style="margin-bottom:12px">Top 5 areas with the largest opportunity for improvement:</p>
  <table><thead><tr><th style="text-align:center">Rank</th><th>Area</th><th style="text-align:center">Source</th><th style="text-align:center">Score</th><th>Recommended Action</th></tr></thead>
  <tbody>${gapRows}</tbody></table>
</div>

<div class="card">
  <h2>Onboarding Recommendation</h2>
  <div style="margin-bottom:16px">
    <span style="display:inline-block;padding:6px 18px;border-radius:6px;background:linear-gradient(135deg,#0066ff,#7c3aed);color:#fff;font-size:18px;font-weight:700">Track ${track.letter}: ${track.name}</span>
  </div>
  <p style="color:#64748b;font-size:14px">${track.desc}</p>
</div>

<div class="card">
  <h2>90-Day Roadmap</h2>
  <table><thead><tr><th style="text-align:center">When</th><th>Milestone</th><th>Measurable Outcome</th></tr></thead>
  <tbody>${milestoneRows}</tbody></table>
</div>

<div class="card">
  <h2>Success Metrics</h2>
  <table><thead><tr><th>Metric</th><th>Target</th><th>Measure By</th></tr></thead>
  <tbody>${metricsRows}</tbody></table>
</div>

${scan.recommendations.length > 0 ? `<div class="card"><h2>Recommendations</h2><ul>${scan.recommendations.map(r => `<li>${r}</li>`).join('')}</ul></div>` : ''}

<div class="card no-print" style="display:flex;gap:12px">
  <button onclick="window.print()">Print / Save as PDF</button>
  <a href="/"><button type="button" class="secondary">New Assessment</button></a>
</div>

<div style="text-align:center;padding:24px;color:#94a3b8;font-size:13px">
  PRISM D1 Velocity Assessment Report — ${scan.scanDate}
</div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Agent interview — chat UI and session management
// ---------------------------------------------------------------------------

// In-memory session store (single-user local tool, so this is fine)
const agentSessions = new Map<string, AgentSessionState>();

function agentInterviewPage(scan: ScanResultJSON): string {
  const scanB64 = Buffer.from(JSON.stringify(scan)).toString('base64');
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI Interview — ${scan.repoName}</title><style>${PAGE_STYLE}
  .chat-container{display:flex;flex-direction:column;flex:1;min-height:0}
  .chat-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;min-height:0}
  .msg{max-width:80%;padding:12px 16px;border-radius:12px;font-size:14px;line-height:1.6;word-wrap:break-word}
  .msg-assistant{background:#f0f4ff;color:#1e293b;align-self:flex-start;border-bottom-left-radius:4px}
  .msg-user{background:linear-gradient(135deg,#0066ff,#7c3aed);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
  .msg-assistant strong{color:#0066ff}
  .chat-input-area{display:flex;gap:8px;padding:16px;border-top:1px solid #e2e8f0;background:#fff;flex-shrink:0}
  .chat-input-area textarea{flex:1;padding:10px 14px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;resize:none;min-height:44px;max-height:120px;font-family:inherit;line-height:1.5}
  .chat-input-area textarea:focus{outline:none;border-color:#0066ff;box-shadow:0 0 0 3px rgba(0,102,255,.1)}
  .chat-input-area button{align-self:flex-end}
  .chat-input-area button:disabled{opacity:.5;cursor:not-allowed}
  .typing-indicator{display:flex;gap:4px;padding:8px 16px;align-self:flex-start}
  .typing-indicator span{width:8px;height:8px;background:#94a3b8;border-radius:50%;animation:bounce .6s infinite alternate}
  .typing-indicator span:nth-child(2){animation-delay:.2s}
  .typing-indicator span:nth-child(3){animation-delay:.4s}
  @keyframes bounce{to{transform:translateY(-6px);opacity:.4}}
  .progress-bar-wrap{display:flex;align-items:center;gap:12px;padding:8px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:13px;color:#64748b;flex-shrink:0}
  .progress-bar-wrap .progress-bg{flex:1;max-width:300px}
  .agent-complete-bar{padding:16px;background:#f0fdf4;border-top:1px solid #bbf7d0;text-align:center}
  .status-panel{display:flex;gap:6px;padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;flex-wrap:wrap;align-items:center;flex-shrink:0}
  .status-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:500;border:1px solid #e2e8f0;background:#fff;color:#64748b;transition:all .3s}
  .status-chip.active{border-color:#0066ff;background:#eff6ff;color:#0066ff;font-weight:600}
  .status-chip.done{border-color:#22c55e;background:#f0fdf4;color:#16a34a}
  .status-chip .chip-icon{font-size:11px}
  .info-bar{display:flex;gap:16px;padding:8px 16px;background:#fefce8;border-bottom:1px solid #fef08a;font-size:12px;color:#854d0e;flex-wrap:wrap;flex-shrink:0}
  .info-bar.complete{background:#f0fdf4;border-color:#bbf7d0;color:#166534}
  .info-item{display:inline-flex;align-items:center;gap:4px}
  .info-item .check{color:#22c55e}
  .info-item .missing{color:#f59e0b}
</style></head><body><div class="page" style="padding-bottom:0;height:100vh;display:flex;flex-direction:column;overflow:hidden">
<h1 style="flex-shrink:0">AI-Assisted Interview: ${scan.repoName}</h1>
<p class="subtitle" style="flex-shrink:0">Scanner score: ${scan.totalScore}/${scan.maxScore} (${scan.prismLevel.level}) · The AI agent will conduct the interview conversationally</p>

<div class="card" style="margin-top:16px;padding:0;overflow:hidden;flex:1;display:flex;flex-direction:column;min-height:0">
  <div class="status-panel" id="statusPanel">
    <span class="status-chip active" id="chip-intro"><span class="chip-icon">●</span> Info</span>
    <span class="status-chip" id="chip-s1"><span class="chip-icon">○</span> AI Tooling</span>
    <span class="status-chip" id="chip-s2"><span class="chip-icon">○</span> Workflow</span>
    <span class="status-chip" id="chip-s3"><span class="chip-icon">○</span> CI/CD</span>
    <span class="status-chip" id="chip-s4"><span class="chip-icon">○</span> Metrics</span>
    <span class="status-chip" id="chip-s5"><span class="chip-icon">○</span> Governance</span>
    <span class="status-chip" id="chip-s6"><span class="chip-icon">○</span> Org</span>
    <span class="status-chip" id="chip-readiness"><span class="chip-icon">○</span> Readiness</span>
  </div>
  <div class="info-bar" id="infoBar">
    <span class="info-item" id="info-name"><span class="missing">○</span> Company</span>
    <span class="info-item" id="info-team"><span class="missing">○</span> Team size</span>
    <span class="info-item" id="info-funding"><span class="missing">○</span> Funding</span>
    <span style="margin-left:auto;font-size:11px;color:#a16207" id="infoHint">Collecting background info...</span>
  </div>
  <div class="progress-bar-wrap">
    <span id="progressLabel">Starting interview...</span>
    <div class="progress-bg"><div id="progressFill" class="progress-fill fill-green" style="width:0%"></div></div>
    <span id="progressPct">0/20</span>
  </div>

  <div class="chat-container">
    <div class="chat-messages" id="chatMessages"></div>
    <div id="typingIndicator" class="typing-indicator hidden"><span></span><span></span><span></span></div>
    <div class="chat-input-area" id="inputArea">
      <textarea id="userInput" placeholder="Type your response..." rows="2"></textarea>
      <button id="sendBtn" onclick="sendMessage()">Send</button>
    </div>
    <div id="completeBar" class="agent-complete-bar hidden">
      <form method="POST" action="/agent-report">
        <input type="hidden" name="sessionId" id="sessionIdInput" value="${sessionId}">
        <button type="submit">View Full Report →</button>
      </form>
    </div>
  </div>
</div>
</div>

<script>
var sessionId = '${sessionId}';
var scanB64 = '${scanB64}';
var isDone = false;

// Initialize session
fetch('/api/agent/init', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({ sessionId: sessionId, scanData: scanB64 })
}).then(function(r) { return r.json(); }).then(function(data) {
  if (data.setupError) {
    // Show setup instructions instead of chat
    var container = document.getElementById('chatMessages');
    container.innerHTML = '<div style="padding:24px;max-width:600px;margin:0 auto">'
      + '<div style="text-align:center;font-size:48px;margin-bottom:16px">⚠️</div>'
      + '<h2 style="text-align:center;margin-bottom:16px;color:#ef4444">Bedrock Access Required</h2>'
      + '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:20px;font-size:14px;line-height:1.7">'
      + data.instructions
      + '</div>'
      + '<div style="text-align:center;margin-top:20px">'
      + '<button onclick="location.reload()" style="margin-right:8px">🔄 Retry</button>'
      + '<a href="/"><button type="button" class="secondary">← Back to Scanner</button></a>'
      + '</div></div>';
    document.getElementById('inputArea').classList.add('hidden');
    return;
  }
  if (data.reply) appendMessage('assistant', data.reply);
  updateProgress(data.progress || 0, data.progressLabel || '', data.status || null);
}).catch(function(err) {
  appendMessage('assistant', 'Error initializing interview agent: ' + err.message + '. Make sure you have AWS credentials configured with Bedrock access.');
});

function appendMessage(role, text) {
  var container = document.getElementById('chatMessages');
  var div = document.createElement('div');
  div.className = 'msg msg-' + role;
  // Simple markdown-ish rendering
  div.innerHTML = text
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\n/g, '<br>');
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function updateProgress(pct, label, status) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressPct').textContent = (status ? status.questionsAnswered || 0 : 0) + '/20';
  if (label) document.getElementById('progressLabel').textContent = label;

  if (!status) return;

  // Update info bar
  var infoBar = document.getElementById('infoBar');
  var fields = [
    { id: 'info-name', key: 'customerName', label: 'Company' },
    { id: 'info-team', key: 'teamSize', label: 'Team size' },
    { id: 'info-funding', key: 'fundingStage', label: 'Funding' },
  ];
  var allCollected = true;
  fields.forEach(function(f) {
    var el = document.getElementById(f.id);
    var val = status[f.key];
    if (val && val !== 'Unknown' && val !== '' && val !== 0 && val !== '0') {
      el.innerHTML = '<span class="check">✓</span> ' + f.label + ': <strong>' + val + '</strong>';
    } else {
      el.innerHTML = '<span class="missing">○</span> ' + f.label;
      allCollected = false;
    }
  });
  var hint = document.getElementById('infoHint');
  if (allCollected) {
    infoBar.className = 'info-bar complete';
    hint.textContent = '✓ All info collected';
    hint.style.color = '#166534';
  } else if (status.phase !== 'intro') {
    hint.textContent = '';
  }

  // Update phase chips
  var chipMap = {
    'intro': 'chip-intro',
    's1': 'chip-s1', 's2': 'chip-s2', 's3': 'chip-s3',
    's4': 'chip-s4', 's5': 'chip-s5', 's6': 'chip-s6',
    'readiness': 'chip-readiness',
  };
  // Reset all chips
  Object.values(chipMap).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.className = 'status-chip'; el.querySelector('.chip-icon').textContent = '○'; }
  });

  // Mark completed phases
  if (status.completedSections) {
    status.completedSections.forEach(function(s) {
      var el = document.getElementById(chipMap[s]);
      if (el) { el.className = 'status-chip done'; el.querySelector('.chip-icon').textContent = '✓'; }
    });
  }

  // Mark active phase
  var activeChip = status.activeChip;
  if (activeChip && chipMap[activeChip]) {
    var el = document.getElementById(chipMap[activeChip]);
    if (el && !el.classList.contains('done')) {
      el.className = 'status-chip active';
      el.querySelector('.chip-icon').textContent = '●';
    }
  }
}

function sendMessage() {
  if (isDone) return;
  var input = document.getElementById('userInput');
  var text = input.value.trim();
  if (!text) return;

  appendMessage('user', text);
  input.value = '';
  input.disabled = true;
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('typingIndicator').classList.remove('hidden');

  fetch('/api/agent/chat', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ sessionId: sessionId, message: text })
  }).then(function(r) { return r.json(); }).then(function(data) {
    document.getElementById('typingIndicator').classList.add('hidden');
    input.disabled = false;
    document.getElementById('sendBtn').disabled = false;

    if (data.error) {
      appendMessage('assistant', 'Error: ' + data.error);
      return;
    }

    appendMessage('assistant', data.reply);
    updateProgress(data.progress || 0, data.progressLabel || '', data.status || null);

    if (data.done) {
      isDone = true;
      document.getElementById('inputArea').classList.add('hidden');
      document.getElementById('completeBar').classList.remove('hidden');
    } else {
      input.focus();
    }
  }).catch(function(err) {
    document.getElementById('typingIndicator').classList.add('hidden');
    input.disabled = false;
    document.getElementById('sendBtn').disabled = false;
    appendMessage('assistant', 'Connection error: ' + err.message);
  });
}

// Send on Enter (Shift+Enter for newline)
document.getElementById('userInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const params: Record<string, string> = {};
      for (const pair of body.split('&')) {
        const idx = pair.indexOf('=');
        const k = idx > -1 ? pair.slice(0, idx) : pair;
        const v = idx > -1 ? pair.slice(idx + 1) : '';
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
      }
      resolve(params);
    });
    req.on('error', reject);
  });
}

function parseMultipartBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('No multipart boundary'));
    const boundary = '--' + boundaryMatch[1];
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const parts = body.split(boundary).slice(1, -1);
      const params: Record<string, string> = {};
      for (const part of parts) {
        const nameMatch = part.match(/name="([^"]+)"/);
        if (!nameMatch) continue;
        const valStart = part.indexOf('\r\n\r\n');
        if (valStart === -1) continue;
        params[nameMatch[1]] = part.slice(valStart + 4).replace(/\r\n$/, '');
      }
      resolve(params);
    });
    req.on('error', reject);
  });
}

function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: string) {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Agent status builder — provides rich status for the chat UI
// ---------------------------------------------------------------------------

const SECTION_CHIP_IDS = ['s1', 's2', 's3', 's4', 's5', 's6'];

function buildAgentStatus(state: AgentSessionState) {
  const totalQuestions = AGENT_SECTIONS.reduce((sum, s) => sum + s.questions.length, 0);
  const answered = state.results.length;

  // Determine which sections are complete
  const completedSections: string[] = [];
  // Intro is done once we leave intro phase
  if (state.phase !== 'intro') completedSections.push('intro');

  // Check each interview section
  for (let i = 0; i < AGENT_SECTIONS.length; i++) {
    const sec = AGENT_SECTIONS[i];
    const sectionDone = sec.questions.every(q => state.results.some(r => r.questionId === q.id));
    if (sectionDone) completedSections.push(SECTION_CHIP_IDS[i]);
  }

  // Org readiness done if we're past it
  if (state.phase === 'closing' || state.phase === 'complete') {
    completedSections.push('readiness');
  }

  // Determine active chip
  let activeChip = 'intro';
  if (state.phase === 'interview') {
    activeChip = SECTION_CHIP_IDS[state.currentSectionIdx] || 's1';
  } else if (state.phase === 'org_readiness') {
    activeChip = 'readiness';
  } else if (state.phase === 'closing' || state.phase === 'complete') {
    activeChip = 'readiness'; // will be marked done
  }

  return {
    phase: state.phase,
    questionsAnswered: answered,
    totalQuestions,
    customerName: state.customerName || '',
    teamSize: state.teamSize || 0,
    fundingStage: state.fundingStage || '',
    completedSections,
    activeChip,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
function startServer(port: number) {
  const server = createServer(async (req, res) => {
    try {
      const url = req.url || '/';

      if (req.method === 'GET' && url === '/') {
        return send(res, 200, 'text/html', scanPage());
      }

      if (req.method === 'POST' && url === '/scan') {
        if (isEcsMode) {
          return send(res, 403, 'text/html', '<h1>Repo scanning is disabled in cloud mode. Please import scan results.</h1>');
        }
        const form = await parseFormBody(req);
        const repoPath = form.repoPath?.trim();

        const scanError = (title: string, detail: string) =>
          send(res, 400, 'text/html', `<!DOCTYPE html><html><head><style>${PAGE_STYLE}</style></head><body><div class="page">
            <div class="card" style="border-left:4px solid #ef4444">
              <h2 style="color:#ef4444">${title}</h2>
              <p style="margin:12px 0;color:#475569">${detail}</p>
              <button onclick="history.back()">← Go Back</button>
            </div></div></body></html>`);

        if (!repoPath) return scanError('Repository path is required', 'Please enter the full path to a local git repository.');
        if (!existsSync(repoPath)) return scanError('Path not found', `The directory <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${repoPath}</code> does not exist. Check for typos or trailing characters.`);

        try {
          const scan = await runScan(repoPath, { output: 'json' });
          return send(res, 200, 'text/html', scanResultsPage(scan));
        } catch (err: any) {
          return scanError('Scan failed', `Something went wrong while scanning <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">${repoPath}</code>:<br><pre style="margin-top:8px;padding:12px;background:#f8fafc;border-radius:6px;font-size:13px;overflow-x:auto">${err.message || err}</pre>`);
        }
      }

      if (req.method === 'POST' && url === '/export-json') {
        const form = await parseFormBody(req);
        const scan = JSON.parse(Buffer.from(form.scanData, 'base64').toString());
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${scan.repoName}-scan.json"`,
        });
        return res.end(JSON.stringify(scan, null, 2));
      }

      if (req.method === 'POST' && url === '/import') {
        const form = await parseMultipartBody(req);
        if (!form.scanData) return send(res, 400, 'text/plain', 'Empty scanData field');
        let scan: any;
        try { scan = JSON.parse(form.scanData); } catch (e: any) {
          return send(res, 400, 'text/plain', `Invalid JSON (${form.scanData.length} bytes): ${e.message}`);
        }
        if (!scan.repoName || !scan.categories) {
          return send(res, 400, 'text/html', '<h1>Invalid scan JSON — missing repoName or categories</h1>');
        }
        return send(res, 200, 'text/html', scanResultsPage(scan, true));
      }

      if (req.method === 'POST' && url === '/interview') {
        const form = await parseFormBody(req);
        const scan = JSON.parse(Buffer.from(form.scanData, 'base64').toString());
        return send(res, 200, 'text/html', interviewPage(scan));
      }

      if (req.method === 'POST' && url === '/report') {
        const form = await parseFormBody(req);
        const scan: ScanResultJSON = JSON.parse(Buffer.from(form.scanData, 'base64').toString());

        // Server-side validation: check all question scores are filled
        const missing: string[] = [];
        if (!form.customerName?.trim()) missing.push('Customer name');
        if (!form.saName?.trim()) missing.push('Completed by');
        for (const sec of INTERVIEW_SECTIONS) {
          for (const q of sec.questions) {
            const val = form[q.id];
            if (val === undefined || val === null || val === '') {
              missing.push(q.label);
            }
          }
        }
        if (missing.length > 0) {
          return send(res, 400, 'text/html', `<!DOCTYPE html><html><head><style>${PAGE_STYLE}</style></head><body><div class="page"><div class="card">
            <h2>Missing Required Fields</h2>
            <p>Please go back and complete the following:</p>
            <ul>${missing.map(m => `<li><strong>${m}</strong></li>`).join('')}</ul>
            <button onclick="history.back()">← Go Back</button>
          </div></div></body></html>`);
        }

        // Sum interview scores
        let interviewTotal = 0;
        for (const sec of INTERVIEW_SECTIONS) {
          for (const q of sec.questions) {
            interviewTotal += parseInt(form[q.id] || '0', 10);
          }
        }

        const org: Record<string, boolean> = {
          executiveSponsor: form.executiveSponsor === 'on',
          budgetAllocated: form.budgetAllocated === 'on',
          dedicatedOwner: form.dedicatedOwner === 'on',
          awsRelationship: form.awsRelationship === 'on',
          appropriateTeamSize: form.appropriateTeamSize === 'on',
        };

        const blended = computeBlended(scan.totalScore, scan.maxScore, interviewTotal, org);
        return send(res, 200, 'text/html', reportPage(scan, form, blended));
      }

      // --- Agent interview routes ---

      if (req.method === 'POST' && url === '/interview-agent') {
        const form = await parseFormBody(req);
        const scan = JSON.parse(Buffer.from(form.scanData, 'base64').toString());
        return send(res, 200, 'text/html', agentInterviewPage(scan));
      }

      if (req.method === 'POST' && url === '/api/agent/init') {
        const body = await parseJsonBody(req);
        const { sessionId, scanData } = body;

        // Pre-flight check: verify Bedrock access before starting
        const check = await checkBedrockAccess(body.modelId, body.region);
        if (!check.ok) {
          const instructions: Record<string, string> = {
            sdk_missing: `The AWS SDK is not installed.<br><br>Run this in the <code>cli/</code> directory:<pre style="margin:8px 0;padding:10px;background:#1e293b;color:#e2e8f0;border-radius:6px">npm install @aws-sdk/client-bedrock-runtime</pre>Then restart the server and try again.`,
            no_credentials: `No AWS credentials found. The agent needs credentials with Bedrock access.<br><br><strong>Option 1 — AWS CLI profile:</strong><pre style="margin:8px 0;padding:10px;background:#1e293b;color:#e2e8f0;border-radius:6px">aws configure</pre><strong>Option 2 — Environment variables:</strong><pre style="margin:8px 0;padding:10px;background:#1e293b;color:#e2e8f0;border-radius:6px">export AWS_ACCESS_KEY_ID=your-key\nexport AWS_SECRET_ACCESS_KEY=your-secret\nexport AWS_REGION=us-west-2</pre><strong>Option 3 — SSO:</strong><pre style="margin:8px 0;padding:10px;background:#1e293b;color:#e2e8f0;border-radius:6px">aws sso login --profile your-profile</pre>After configuring credentials, restart the server and try again.`,
            no_model_access: `Bedrock model access denied.<br><br><strong>To enable model access:</strong><ol style="margin:8px 0;padding-left:20px"><li>Go to the <a href="https://console.aws.amazon.com/bedrock/home#/modelaccess" target="_blank" style="color:#0066ff">Amazon Bedrock Model Access</a> page</li><li>Click "Manage model access"</li><li>Enable <strong>Anthropic → Claude Sonnet 4.6</strong> (or the model you want to use)</li><li>Wait for access to be granted (usually instant)</li></ol>Then restart the server and try again.<br><br><span style="color:#64748b;font-size:12px">Error: ${check.error}</span>`,
            wrong_region: `The model is not available in the configured region.<br><br>Try a different region by setting <code>AWS_REGION</code>:<pre style="margin:8px 0;padding:10px;background:#1e293b;color:#e2e8f0;border-radius:6px">export AWS_REGION=us-east-1</pre>Or use a cross-region inference ID like <code>us.anthropic.claude-sonnet-4-6</code>.<br><br><span style="color:#64748b;font-size:12px">Error: ${check.error}</span>`,
            unknown: `An unexpected error occurred while connecting to Bedrock.<br><br><pre style="margin:8px 0;padding:10px;background:#1e293b;color:#e2e8f0;border-radius:6px;white-space:pre-wrap">${check.error}</pre>Check your AWS credentials and Bedrock model access, then restart the server.`,
          };

          return send(res, 200, 'application/json', JSON.stringify({
            setupError: true,
            errorType: check.errorType,
            instructions: instructions[check.errorType || 'unknown'] || instructions.unknown,
          }));
        }

        try {
          const scan = JSON.parse(Buffer.from(scanData, 'base64').toString());
          const session = createSession(scan);
          agentSessions.set(sessionId, session);

          // Send the first message (greeting)
          const result = await processMessage(session, '', body.modelId, body.region);
          agentSessions.set(sessionId, result.state);

          const totalQuestions = AGENT_SECTIONS.reduce((sum, s) => sum + s.questions.length, 0);
          const answered = result.state.results.length;
          const progress = (answered / totalQuestions) * 100;

          return send(res, 200, 'application/json', JSON.stringify({
            reply: result.reply,
            done: result.done,
            progress,
            progressLabel: 'Introduction',
            status: buildAgentStatus(result.state),
          }));
        } catch (err: any) {
          return send(res, 500, 'application/json', JSON.stringify({
            error: err.message || 'Failed to initialize agent session',
          }));
        }
      }

      if (req.method === 'POST' && url === '/api/agent/chat') {
        const body = await parseJsonBody(req);
        const { sessionId, message, modelId, region } = body;
        const session = agentSessions.get(sessionId);
        if (!session) {
          return send(res, 400, 'application/json', JSON.stringify({
            error: 'Session not found. Please refresh and start over.',
          }));
        }

        try {
          const result = await processMessage(session, message, modelId, region);
          agentSessions.set(sessionId, result.state);

          const totalQuestions = AGENT_SECTIONS.reduce((sum, s) => sum + s.questions.length, 0);
          const answered = result.state.results.length;
          const progress = (answered / totalQuestions) * 100;

          let progressLabel = 'Introduction';
          if (result.state.phase === 'interview') {
            const sec = AGENT_SECTIONS[result.state.currentSectionIdx];
            progressLabel = sec ? `${sec.name} — Q${result.state.currentQuestionIdx + 1}/${sec.questions.length}` : 'Interview';
          } else if (result.state.phase === 'org_readiness') {
            progressLabel = 'Org Readiness';
          } else if (result.state.phase === 'closing') {
            progressLabel = 'Closing';
          } else if (result.state.phase === 'complete') {
            progressLabel = 'Complete';
          }

          return send(res, 200, 'application/json', JSON.stringify({
            reply: result.reply,
            done: result.done,
            progress: Math.min(100, progress),
            progressLabel,
            status: buildAgentStatus(result.state),
          }));
        } catch (err: any) {
          return send(res, 500, 'application/json', JSON.stringify({
            error: err.message || 'Agent processing error',
          }));
        }
      }

      if (req.method === 'POST' && url === '/agent-report') {
        const form = await parseFormBody(req);
        const session = agentSessions.get(form.sessionId);
        if (!session) {
          return send(res, 400, 'text/html', `<h1>Session expired. Please run the interview again.</h1>`);
        }

        // Convert agent results to the same format as the manual form
        const formData = agentResultsToFormData(session);
        const scan: ScanResultJSON = session.scanData;

        let interviewTotal = 0;
        for (const sec of INTERVIEW_SECTIONS) {
          for (const q of sec.questions) {
            interviewTotal += parseInt(formData[q.id] || '0', 10);
          }
        }

        const org: Record<string, boolean> = {
          executiveSponsor: formData.executiveSponsor === 'on',
          budgetAllocated: formData.budgetAllocated === 'on',
          dedicatedOwner: formData.dedicatedOwner === 'on',
          awsRelationship: formData.awsRelationship === 'on',
          appropriateTeamSize: formData.appropriateTeamSize === 'on',
        };

        const blended = computeBlended(scan.totalScore, scan.maxScore, interviewTotal, org);
        return send(res, 200, 'text/html', reportPage(scan, formData, blended));
      }

      send(res, 404, 'text/html', '<h1>Not Found</h1>');
    } catch (err: any) {
      console.error('Server error:', err);
      send(res, 500, 'text/html', `<div class="page"><div class="card"><h2>Error</h2><pre>${err.message || err}</pre></div></div>`);
    }
  });

  const host = isEcsMode ? '0.0.0.0' : 'localhost';
  server.listen(port, host, () => {
    const url = isEcsMode ? `http://0.0.0.0:${port}` : `http://localhost:${port}`;
    console.log(`\n  PRISM D1 Assessment Web UI${isEcsMode ? ' (ECS Mode - Import Only)' : ''}`);
    console.log(`  Running at: ${url}\n`);
    // Try to open browser (skip in ECS)
    if (!isEcsMode) {
      try {
        const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execSync(`${open} http://localhost:${port}`, { stdio: 'ignore' });
      } catch { /* ignore if browser can't open */ }
    }
  });
}

// ---------------------------------------------------------------------------
// CLI command export
// ---------------------------------------------------------------------------
export { startServer };

export default {
  description: 'Launch the assessment web interface',
  options: [
    { flags: '-p, --port <number>', description: 'Port to listen on', default: '3120' },
  ],
  action(options: { port: string }) {
    const port = parseInt(options.port, 10) || 3120;
    startServer(port);
  },
};
