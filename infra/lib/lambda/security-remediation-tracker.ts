import {
  DynamoDBClient,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';

const dynamoClient = new DynamoDBClient({});
const eventBridgeClient = new EventBridgeClient({});

const EVENTS_TABLE = process.env.EVENTS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface PrEvent {
  source: string;
  'detail-type': string;
  detail: {
    team_id: string;
    repo: string;
    timestamp: string;
    ai_context?: { origin: string };
    pr?: { merged_at?: string; number?: number };
  };
}

/**
 * Triggered by merged PR events.
 * Queries for open Security Agent findings on this repo,
 * checks if the PR resolves any, and emits remediation events.
 */
export async function handler(event: PrEvent): Promise<void> {
  const detail = event.detail;
  const mergedAt = detail.pr?.merged_at ?? detail.timestamp;

  console.log(`Checking for resolved security findings in ${detail.repo}`);

  try {
    // Query for open security findings on this repo (unremediated)
    const securityDetailTypes = [
      'prism.d1.security.design_review',
      'prism.d1.security.code_review',
      'prism.d1.security.pen_test',
    ];

    for (const detailType of securityDetailTypes) {
      const result = await dynamoClient.send(
        new QueryCommand({
          TableName: EVENTS_TABLE,
          IndexName: 'by-detail-type',
          KeyConditionExpression: 'detail_type = :dt',
          ExpressionAttributeValues: {
            ':dt': { S: detailType },
          },
          ScanIndexForward: false,
          Limit: 50,
        }),
      );

      if (!result.Items || result.Items.length === 0) continue;

      for (const item of result.Items) {
        const data = JSON.parse(item.data?.S ?? '{}');
        const finding = data.security_agent_finding;
        if (!finding || finding.remediated_at) continue;

        // Check if finding matches this repo
        if (data.repo !== detail.repo) continue;

        // Calculate remediation time
        const foundAt = new Date(finding.found_at);
        const mergedTime = new Date(mergedAt);
        const remediationHours = (mergedTime.getTime() - foundAt.getTime()) / (1000 * 60 * 60);

        if (remediationHours < 0) continue; // Finding is newer than PR

        const remediationEvent = {
          team_id: detail.team_id,
          repo: detail.repo,
          timestamp: mergedAt,
          prism_level: 3,
          metric: {
            name: 'security_remediation',
            value: remediationHours,
            unit: 'hours',
          },
          ai_context: detail.ai_context,
          security_remediation: {
            finding_id: finding.finding_id,
            severity: finding.severity,
            remediation_time_hours: Math.round(remediationHours * 100) / 100,
            remediated_by_origin: detail.ai_context?.origin ?? 'unknown',
            fix_pr_number: detail.pr?.number ?? null,
            finding_phase: finding.phase,
          },
        };

        await eventBridgeClient.send(
          new PutEventsCommand({
            Entries: [
              {
                Source: 'prism.d1.velocity',
                DetailType: 'prism.d1.security.remediation',
                EventBusName: EVENT_BUS_NAME,
                Detail: JSON.stringify(remediationEvent),
              },
            ],
          }),
        );

        console.log(
          `Remediation event: finding ${finding.finding_id} (${finding.severity}) fixed in ${remediationHours.toFixed(1)}h by ${detail.ai_context?.origin ?? 'unknown'}`,
        );
      }
    }
  } catch (err) {
    console.error('Failed to track security remediation:', err);
  }
}
