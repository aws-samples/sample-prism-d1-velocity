import {
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';

const dynamoClient = new DynamoDBClient({});
const eventBridgeClient = new EventBridgeClient({});

const EVENTS_TABLE = process.env.EVENTS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID ?? '';

interface SecurityFindingEvent {
  source: string;
  'detail-type': string;
  detail: {
    team_id: string;
    repo: string;
    timestamp: string;
    security_agent_finding?: {
      finding_id: string;
      phase: string;
      severity: string;
      category: string;
      exploit_validated: boolean;
      title: string;
    };
  };
}

/**
 * Auto-responds to critical/high Security Agent findings.
 * Actions:
 * 1. Write "security penalty" to events table for eval gate consumption
 * 2. Emit SecurityCriticalFindingCount metric (triggers alarm)
 * 3. Log for SNS escalation (SNS topic wired via alarm action)
 */
export async function handler(event: SecurityFindingEvent): Promise<void> {
  const detail = event.detail;
  const finding = detail.security_agent_finding;

  if (!finding) {
    console.log('No security_agent_finding in event, skipping');
    return;
  }

  const severity = finding.severity.toUpperCase();
  if (severity !== 'CRITICAL' && severity !== 'HIGH') {
    console.log(`Finding severity ${severity} does not require automated response`);
    return;
  }

  console.log(
    `CRITICAL/HIGH security finding: ${finding.finding_id} (${severity}) - ${finding.title}`,
  );

  // 1. Write security penalty record for eval gate consumption
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  try {
    await dynamoClient.send(
      new PutItemCommand({
        TableName: EVENTS_TABLE,
        Item: {
          pk: { S: `${detail.team_id}#${detail.repo}` },
          sk: { S: `penalty#${detail.timestamp}` },
          detail_type: { S: 'prism.d1.security.penalty' },
          finding_id: { S: finding.finding_id },
          data: {
            S: JSON.stringify({
              team_id: detail.team_id,
              repo: detail.repo,
              finding_id: finding.finding_id,
              severity,
              category: finding.category,
              exploit_validated: finding.exploit_validated,
              title: finding.title,
              phase: finding.phase,
            }),
          },
          ttl: { N: ttl.toString() },
        },
      }),
    );
    console.log(`Security penalty written for finding ${finding.finding_id}`);
  } catch (err) {
    console.error('Failed to write security penalty:', err);
  }

  // 2. Emit critical finding metric (triggers SecurityCriticalFinding alarm)
  try {
    const alertEvent = {
      team_id: detail.team_id,
      repo: detail.repo,
      timestamp: detail.timestamp,
      prism_level: 1,
      metric: {
        name: 'SecurityCriticalFindingCount',
        value: 1,
        unit: 'count',
      },
      security_agent_finding: finding,
    };

    await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: 'prism.d1.velocity',
            DetailType: event['detail-type'],
            EventBusName: EVENT_BUS_NAME,
            Detail: JSON.stringify(alertEvent),
          },
        ],
      }),
    );
  } catch (err) {
    console.error('Failed to emit critical finding alert:', err);
  }

  // 3. Log for operational awareness
  console.warn(
    `ACTION REQUIRED: ${severity} security finding in ${detail.repo}: ${finding.title} (${finding.finding_id}). ` +
      `Phase: ${finding.phase}. Exploit validated: ${finding.exploit_validated}. ` +
      `Category: ${finding.category}. Guardrail ID: ${GUARDRAIL_ID || 'not configured'}.`,
  );
}
