import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';

const dynamoClient = new DynamoDBClient({});
const eventBridgeClient = new EventBridgeClient({});

const EVENTS_TABLE = process.env.EVENTS_TABLE!;
const METADATA_TABLE = process.env.METADATA_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
// Optional: unset when the OTEL collector is skipped, in which case no
// attribution exists to join against and AI origin stays 'unknown'.
const AI_USAGE_TABLE = process.env.AI_USAGE_TABLE;

interface SecurityAgentPayload {
  findings: Array<{
    id: string;
    type: string; // 'design_review' | 'code_review' | 'pen_test'
    severity: string;
    cvss?: number;
    title: string;
    description: string;
    category: string;
    cwe_id?: string;
    exploit_validated?: boolean;
    remediation: string;
    compliance?: string[];
    repository: string;
    pr_number?: number;
    commit_sha?: string;
    spec_ref?: string;
    environment?: string;
    found_at: string;
  }>;
}

/**
 * Processes AWS Security Agent findings.
 * Normalizes payloads, enriches with PRISM context (team_id, ai_origin),
 * and emits prism.d1.security.<phase> events to EventBridge.
 *
 * Triggered by:
 * - POST /security-findings (webhook from Security Agent)
 * - Scheduled poll (15-min fallback for preview)
 */
export async function handler(event: any): Promise<any> {
  // Handle API Gateway events
  let payload: SecurityAgentPayload;
  if (event.body) {
    payload = JSON.parse(typeof event.body === 'string' ? event.body : JSON.stringify(event.body));
  } else if (event.findings) {
    payload = event;
  } else {
    console.log('No findings in event, skipping');
    return { statusCode: 200, body: JSON.stringify({ message: 'No findings' }) };
  }

  console.log(`Processing ${payload.findings.length} Security Agent findings`);

  const entries = [];

  for (const finding of payload.findings) {
    const phase = normalizePhase(finding.type);
    const detailType = `prism.d1.security.${phase}`;

    // Enrich with team_id from metadata table
    const teamId = await lookupTeamId(finding.repository);

    // Enrich with AI origin from commit events
    const aiOrigin = await lookupAiOrigin(
      teamId,
      finding.repository,
      finding.commit_sha ?? null,
      finding.pr_number ?? null,
    );

    const prismEvent = {
      team_id: teamId,
      repo: finding.repository,
      timestamp: finding.found_at,
      prism_level: 3,
      metric: {
        name: 'security_finding',
        value: 1,
        unit: 'count',
      },
      ai_context: {
        tool: 'security-agent',
        model: 'aws-security-agent',
        origin: aiOrigin,
      },
      security_agent_finding: {
        finding_id: finding.id,
        phase,
        severity: finding.severity.toUpperCase(),
        cvss_score: finding.cvss ?? null,
        title: finding.title,
        description: finding.description,
        category: finding.category,
        cwe_id: finding.cwe_id ?? null,
        exploit_validated: finding.exploit_validated ?? false,
        remediation_guidance: finding.remediation,
        compliance_mappings: finding.compliance ?? [],
        ai_origin: aiOrigin,
        pr_number: finding.pr_number ?? null,
        commit_sha: finding.commit_sha ?? null,
        spec_ref: finding.spec_ref ?? null,
        environment: finding.environment ?? 'unknown',
        found_at: finding.found_at,
        remediated_at: null,
      },
    };

    entries.push({
      Source: 'prism.d1.velocity',
      DetailType: detailType,
      EventBusName: EVENT_BUS_NAME,
      Detail: JSON.stringify(prismEvent),
    });
  }

  // Emit in batches of 10
  for (let i = 0; i < entries.length; i += 10) {
    await eventBridgeClient.send(
      new PutEventsCommand({ Entries: entries.slice(i, i + 10) }),
    );
  }

  console.log(`Emitted ${entries.length} security finding events`);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'OK', findingsProcessed: entries.length }),
  };
}

function normalizePhase(type: string): string {
  const phaseMap: Record<string, string> = {
    design_review: 'design_review',
    code_review: 'code_review',
    pen_test: 'pen_test',
    penetration_test: 'pen_test',
    design: 'design_review',
    code: 'code_review',
    pentest: 'pen_test',
  };
  return phaseMap[type.toLowerCase()] ?? 'code_review';
}

async function lookupTeamId(repo: string): Promise<string> {
  try {
    // The metadata table has PK=team_id, SK=repo.
    // We can't query by repo directly without a GSI, so we scan
    // with a filter. This is acceptable because the metadata table
    // has one row per team+repo (small table).
    const result = await dynamoClient.send(
      new ScanCommand({
        TableName: METADATA_TABLE,
        FilterExpression: 'repo = :repo',
        ExpressionAttributeValues: {
          ':repo': { S: repo },
        },
        Limit: 1,
      }),
    );

    if (result.Items && result.Items.length > 0) {
      return result.Items[0].team_id?.S ?? 'unknown';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Candidate `REPO#` partition keys for one repository name.
 *
 * The two sides of this join spell the repo differently and nothing normalizes
 * either. codeburn sets the `git.repo` span attribute from the git remote, so
 * the attribution store holds a host-qualified path (`github.com/owner/name`).
 * CI sends `GITHUB_REPOSITORY`, which is bare (`owner/name`). A single GetItem
 * on whichever form the caller happened to pass would miss roughly half the
 * time — and miss silently, since a missing item is indistinguishable from an
 * unattributed commit.
 *
 * Rather than guess, try the value as given and then the plausible
 * translations: add a host if it looks bare, strip one if it looks qualified.
 */
function repoKeyCandidates(repo: string): string[] {
  const bare = repo.replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const candidates = [bare];
  const segments = bare.split('/');
  if (segments.length === 2) {
    // owner/name → try the hosts codeburn would have recorded.
    candidates.push(`github.com/${bare}`, `gitlab.com/${bare}`);
  } else if (segments.length > 2) {
    // host/owner/name → try dropping the host.
    candidates.push(segments.slice(1).join('/'));
  }
  return [...new Set(candidates)];
}

/**
 * Resolves whether the code a finding lands on was AI-written.
 *
 * Reads the attribution store, which is the only place that answer now lives.
 * This previously queried the events table for `prism.d1.commit` and counted
 * ai vs human across the last 7 days — but nothing emits `prism.d1.commit`.
 * The git hooks that were once expected to only ever wrote commit-message
 * trailers, so the query never matched and every finding was tagged 'unknown',
 * silently, with the CISO dashboard's AI-code-risk panel downstream of it.
 *
 * The per-commit verdict is frozen onto the COMMIT# item at ingest by
 * otel-receiver (`ai_origin`), so a point lookup is enough — no span join, and
 * no dependence on a span TTL that is shorter than the commit TTL.
 */
async function lookupAiOrigin(
  teamId: string,
  repo: string,
  commitSha: string | null,
  prNumber: number | null,
): Promise<'ai-generated' | 'ai-assisted' | 'human' | 'unknown'> {
  // A PR number alone cannot identify a commit in the attribution store, whose
  // key is REPO#<repo>/COMMIT#<sha>. Returning 'unknown' is correct here rather
  // than guessing from the repo's recent history.
  if (!commitSha) return 'unknown';
  if (!AI_USAGE_TABLE) return 'unknown';

  for (const candidate of repoKeyCandidates(repo)) {
    try {
      const result = await dynamoClient.send(
        new GetItemCommand({
          TableName: AI_USAGE_TABLE,
          Key: {
            pk: { S: `REPO#${candidate}` },
            sk: { S: `COMMIT#${commitSha}` },
          },
          ProjectionExpression: 'ai_origin',
        }),
      );
      const origin = result.Item?.ai_origin?.S;
      if (origin === 'ai-generated' || origin === 'human') return origin;
      // Item exists but carries no frozen verdict (written before write-time
      // resolution). Treat as unresolved rather than trying another key.
      if (result.Item) return 'unknown';
    } catch (err) {
      console.error(`AI origin lookup failed for REPO#${candidate}:`, err);
      return 'unknown';
    }
  }

  // No attribution for this commit — the author's machine is not onboarded to
  // codeburn sync. Distinct from 'human', which is a positive verdict.
  console.log(`No attribution found for ${repo}@${commitSha} (team ${teamId}, PR ${prNumber ?? 'n/a'})`);
  return 'unknown';
}
