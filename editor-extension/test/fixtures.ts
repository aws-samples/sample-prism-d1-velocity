import type { DashboardPayload, Finding, RepoPayload } from '../src/payload';

export const ROOT = '/work/repo';

export function finding(over: Partial<Finding> = {}): Finding {
  return { severity: 'medium', category: 'quality', rule: 'R1', file: 'src/a.ts', line: 12, message: 'Unchecked result', branch: 'main', started_at: '2026-11-10T10:00:00.000Z', ...over };
}

export function repo(over: Partial<RepoPayload> = {}): RepoPayload {
  return {
    name: 'repo', label: 'repo', path: ROOT, current: true, spend: { cost: 3.5, sessions: 2 },
    codewatch: {
      hasResults: true,
      findingsTruncated: false,
      findings: [
        finding({ severity: 'high', category: 'security', file: 'src/b.ts', line: 3, message: 'Token logged' }),
        finding(),
        finding({ branch: 'feature', started_at: '2026-11-11T10:00:00.000Z', message: 'other branch' }),
      ],
      scans: [
        { id: 'abc-20261111T100000000Z-pre-push-review', started_at: '2026-11-11T10:00:00.000Z', branch: 'feature', tool: 'claude', status: 'findings', high: 0, medium: 1, low: 0, reason: null },
        { id: 'def-20261110T100000000Z-pre-push-review', started_at: '2026-11-10T10:00:00.000Z', branch: 'main', tool: 'kiro', status: 'findings', high: 1, medium: 1, low: 0, reason: null },
      ],
    },
    setup: { status: 'ok', reviewer: 'kiro', detail: 'pre-commit and pre-push installed', fix: '' },
    security: { status: 'missing', detail: 'not set up', fix: 'prism-cli enable security' },
    ...over,
  };
}

export function payload(over: Partial<DashboardPayload> = {}, r: RepoPayload = repo()): DashboardPayload {
  return {
    schema: 'prism.dashboard.v2',
    generated_at: '2026-11-11T12:00:00.000Z',
    repos: [r],
    machine: {
      setup: [
        { id: 'codeburn', label: 'codeburn installed', status: 'ok', detail: '0.9.24', fix: '' },
        { id: 'gitleaks', label: 'gitleaks available', status: 'missing', detail: 'not on PATH', fix: 'brew install gitleaks' },
      ],
      codeburnSync: { mode: 'local' },
    },
    summary: {
      spend: { status: 'ok', currency: 'USD', today: 12.4, month: 210, message: null },
      warnings: { count: 1, first: 'gitleaks available: not on PATH' },
    },
    ...over,
  };
}
