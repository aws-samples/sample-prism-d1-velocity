import {
  DynamoDBClient,
  QueryCommand,
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

async function lookupAiOrigin(
  teamId: string,
  repo: string,
  commitSha: string | null,
  prNumber: number | null,
): Promise<'ai-generated' | 'ai-assisted' | 'human' | 'unknown'> {
  if (!commitSha && !prNumber) return 'unknown';

  try {
    // Query recent commit events for this repo to find AI origin
    const pk = `${teamId}#${repo}`;
    const now = new Date();
    const lookback = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days

    const result = await dynamoClient.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: 'pk = :pk AND sk >= :start',
        FilterExpression: 'detail_type = :dt',
        ExpressionAttributeValues: {
          ':pk': { S: pk },
          ':start': { S: lookback.toISOString() },
          ':dt': { S: 'prism.d1.commit' },
        },
        ScanIndexForward: false, // Most recent first
        Limit: 20,
      }),
    );

    if (result.Items && result.Items.length > 0) {
      // Count AI vs human commits to determine predominant origin
      let aiCount = 0;
      let humanCount = 0;
      for (const item of result.Items) {
        const data = JSON.parse(item.data?.S ?? '{}');
        const origin = data.ai_context?.origin ?? 'human';
        if (origin === 'ai-generated' || origin === 'ai-assisted') {
          aiCount++;
        } else {
          humanCount++;
        }
      }
      if (aiCount > humanCount) return 'ai-assisted';
      if (humanCount > aiCount) return 'human';
    }

    return 'unknown';
  } catch (err) {
    console.error('Failed to look up AI origin:', err);
    return 'unknown';
  }
}
