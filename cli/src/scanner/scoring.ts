import { basename, resolve } from 'node:path';
import type { CategoryScore, PRISMLevelInfo, ScanResult } from './types.js';

const LEVEL_MAP: { threshold: number; level: string; label: string; description: string }[] = [
  { threshold: 96, level: 'L5.0', label: 'Autonomous', description: 'Agents contributing to architecture. >20% autonomous deployments.' },
  { threshold: 91, level: 'L4.5', label: 'Orchestrated+', description: 'Near-autonomous. Multi-agent governance mature.' },
  { threshold: 81, level: 'L4.0', label: 'Orchestrated', description: 'Multi-agent governance. Autonomy tiering. AI FinOps.' },
  { threshold: 71, level: 'L3.5', label: 'Integrated+', description: 'Strong integration with emerging orchestration patterns.' },
  { threshold: 56, level: 'L3.0', label: 'Integrated', description: 'Eval gates in CI/CD. First agentic workflow. AI SRE practices.' },
  { threshold: 41, level: 'L2.5', label: 'Structured+', description: 'Structured with emerging integration patterns.' },
  { threshold: 26, level: 'L2.0', label: 'Structured', description: 'AI tooling standardized. Spec-driven dev. Acceptance rate tracked.' },
  { threshold: 16, level: 'L1.5', label: 'Experimental+', description: 'Some AI tooling adoption, but not yet structured.' },
  { threshold: 0, level: 'L1.0', label: 'Experimental', description: 'Ad hoc AI use. No metrics. No shared tooling.' },
];

export function computeLevel(totalScore: number): PRISMLevelInfo {
  for (const e of LEVEL_MAP) {
    if (totalScore >= e.threshold) return { level: e.level, label: e.label, description: e.description };
  }
  return LEVEL_MAP[LEVEL_MAP.length - 1];
}

export function identifyStrengths(categories: CategoryScore[]): string[] {
  return categories
    .filter(c => c.earnedPoints > 0)
    .sort((a, b) => (b.earnedPoints / b.maxPoints) - (a.earnedPoints / a.maxPoints))
    .slice(0, 3)
    .map(c => `${c.category} (${c.earnedPoints}/${c.maxPoints})`);
}

export function identifyGaps(categories: CategoryScore[]): string[] {
  return categories
    .filter(c => c.earnedPoints < c.maxPoints)
    .sort((a, b) => (b.maxPoints - b.earnedPoints) - (a.maxPoints - a.earnedPoints))
    .slice(0, 3)
    .map(c => {
      const pct = Math.round((c.earnedPoints / c.maxPoints) * 100);
      return c.earnedPoints === 0
        ? `No ${c.category.toLowerCase()} signals detected (0/${c.maxPoints})`
        : `Limited ${c.category.toLowerCase()} (${c.earnedPoints}/${c.maxPoints}, ${pct}%)`;
    });
}

const RECS: Record<string, string> = {
  'AI Tool Config': 'Add a CLAUDE.md file with spec-first enforcement rules',
  'Spec-Driven Dev': 'Create a specs/ directory and adopt spec templates',
  'Commit Hygiene': 'Add AI-Origin and AI-Model trailers to commit conventions',
  'CI/CD Integration': 'Add AI evaluation steps to your CI pipeline',
  'Eval & Quality': 'Set up Bedrock Evaluation or promptfoo for automated eval',
  'Testing Maturity': 'Increase test coverage and add AI-specific test patterns',
  'AI Observability': 'Deploy the PRISM metrics pipeline (CDK in infra/)',
  'Governance': 'Configure Bedrock Guardrails and define autonomy tiers',
  'Agent Workflows': 'Define your first agentic workflow with Strands SDK',
  'Platform & Reuse': 'Create a shared prompt library for team reuse',
  'Documentation': 'Document AI development guidelines for the team',
  'Dependencies': 'Add AI SDKs (@anthropic-ai/sdk, @aws-sdk/client-bedrock-runtime)',
};

export function generateRecommendations(categories: CategoryScore[]): string[] {
  return categories
    .filter(c => c.earnedPoints < c.maxPoints)
    .sort((a, b) => (b.maxPoints - b.earnedPoints) - (a.maxPoints - a.earnedPoints))
    .slice(0, 3)
    .map(c => RECS[c.category])
    .filter(Boolean) as string[];
}

export function buildScanResult(repoPath: string, categories: CategoryScore[]): ScanResult {
  const totalScore = categories.reduce((s, c) => s + c.earnedPoints, 0);
  const maxScore = categories.reduce((s, c) => s + c.maxPoints, 0);
  return {
    repoPath: resolve(repoPath),
    repoName: basename(resolve(repoPath)),
    scanDate: new Date().toISOString().split('T')[0],
    totalScore,
    maxScore,
    prismLevel: computeLevel(totalScore),
    categories,
    strengths: identifyStrengths(categories),
    gaps: identifyGaps(categories),
    recommendations: generateRecommendations(categories),
  };
}
