/**
 * Canonical PRISM event schema — the contract between emitters and the pipeline.
 *
 * WHY THIS EXISTS
 * ---------------
 * The event payload is a wide union of optional sections that producers fill
 * selectively. Nothing validated it, and every silent failure in this pipeline
 * traced back to that gap:
 *
 *   - prism-dora-weekly.yml emitted `dora.lead_time_hours` while the processor
 *     read `lead_time_seconds`. The `!= null` guard skipped it, so the
 *     LeadTimeForChanges metric was never published and nothing errored.
 *   - It emitted `dora.mttr_hours` against `mttr_seconds`, so the MTTR metric
 *     was never published at all.
 *   - `ai_dora.ai_adoption_rate` matched no key the processor consumed.
 *   - The `pr` section was emitted by producers for months but missing from the
 *     processor's persisted-section list, so every field was dropped at write.
 *   - GitHub emitted `pr` while GitLab emitted `mr` for the same concept.
 *
 * None of those threw. They produced plausible-looking dashboards with missing
 * data. Declaring the shape here and validating against it converts that class
 * of failure from silent to loud.
 */

/** Sections persisted to the events table. Anything not listed is DROPPED. */
export const PERSISTED_SECTIONS = [
  'metric',
  'ai_context',
  'dora',
  'ai_dora',
  'eval',
  'guardrail',
  'mcp_tool_call',
  'agent',
  'security',
  'security_agent_finding',
  'security_remediation',
  'pr',
] as const;

export type PersistedSection = (typeof PERSISTED_SECTIONS)[number];

/**
 * Known field names per section. Used by validateEventShape to flag fields a
 * producer emits that no consumer reads — the `lead_time_hours` class of bug.
 *
 * This is intentionally a denylist-by-omission: unknown fields are WARNED about,
 * not rejected, so adding a field is never a hard outage. The CI guard
 * (scripts/check-metric-coverage.ts) is what fails the build.
 */
export const SECTION_FIELDS: Record<PersistedSection, readonly string[]> = {
  metric: ['name', 'value', 'unit'],
  ai_context: ['tool', 'model', 'origin', 'origin_source'],
  dora: [
    'deployment_frequency',
    'lead_time_seconds',
    'change_failure_rate',
    'mttr_seconds',
    'is_failure_fix',
  ],
  ai_dora: ['eval_gate_pass_rate'],
  eval: ['eval_id', 'rubric', 'result', 'score', 'findings', 'high_findings', 'pr_number', 'criterion_scores'],
  guardrail: ['guardrail_id', 'trigger_category', 'trigger_type', 'action_taken', 'agent_name'],
  mcp_tool_call: ['session_id', 'client_id', 'tool_name', 'scopes', 'authorized', 'risk_level', 'result_status', 'duration_ms'],
  agent: ['agent_name', 'status', 'duration_ms', 'steps_taken', 'tools_invoked', 'tokens_used', 'guardrails_triggered'],
  security: ['alert_type', 'table_name', 'principal_arn', 'read_count'],
  security_agent_finding: [
    'finding_id', 'phase', 'severity', 'cvss_score', 'title', 'description',
    'category', 'cwe_id', 'exploit_validated', 'remediation_guidance',
    'compliance_mappings', 'ai_origin', 'commit_shas', 'pr_number',
    'commit_sha', 'spec_ref', 'environment', 'found_at', 'remediated_at',
  ],
  security_remediation: [
    'finding_id', 'severity', 'remediation_time_hours', 'remediated_by_origin',
    'remediated_by_origin_source', 'fix_commit_shas', 'fix_pr_number', 'finding_phase',
  ],
  pr: [
    'number', 'author', 'reviews_approved', 'reviews_changes_requested',
    'total_commits', 'commit_shas',
  ],
};

/**
 * Units matter: these fields have caused real bugs by carrying the wrong unit
 * under a plausible name. A producer emitting `lead_time_hours` is emitting a
 * field this pipeline does not read — the suffix is load-bearing.
 */
export const UNIT_SUFFIXED_FIELDS = [
  'lead_time_seconds',
  'mttr_seconds',
  'remediation_time_hours',
  'duration_ms',
] as const;

export interface ShapeWarning {
  section: string;
  field?: string;
  message: string;
}

/**
 * Non-throwing shape validation. Returns warnings for the processor to log so
 * field drift shows up in CloudWatch Logs Insights instead of vanishing.
 *
 * Deliberately does NOT reject: dropping a real event because a producer added
 * a field would be a worse failure than logging it.
 */
export function validateEventShape(detail: Record<string, unknown>): ShapeWarning[] {
  const warnings: ShapeWarning[] = [];
  const known = new Set<string>(PERSISTED_SECTIONS);

  for (const [key, value] of Object.entries(detail)) {
    // Envelope fields live alongside sections and are handled separately.
    if (['team_id', 'repo', 'timestamp', 'prism_level'].includes(key)) continue;

    if (!known.has(key)) {
      warnings.push({
        section: key,
        message: `section '${key}' is not in PERSISTED_SECTIONS and will be DROPPED at write time`,
      });
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const allowed = SECTION_FIELDS[key as PersistedSection];
      for (const field of Object.keys(value as Record<string, unknown>)) {
        if (!allowed.includes(field)) {
          // Near-miss on a unit suffix is the highest-signal case.
          const nearMiss = UNIT_SUFFIXED_FIELDS.find(
            f => f.split('_').slice(0, -1).join('_') === field.split('_').slice(0, -1).join('_'),
          );
          warnings.push({
            section: key,
            field,
            message: nearMiss
              ? `'${key}.${field}' is not consumed — did you mean '${nearMiss}'? Unit suffixes are load-bearing.`
              : `'${key}.${field}' is not consumed by any reader`,
          });
        }
      }
    }
  }
  return warnings;
}
