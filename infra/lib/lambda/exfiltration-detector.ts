import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';

const eventBridgeClient = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const ALERT_THRESHOLD_READS = parseInt(process.env.ALERT_THRESHOLD_READS ?? '100', 10);

interface CloudTrailDynamoDBEvent {
  detail: {
    eventSource: string;
    eventName: string;
    eventTime: string;
    userIdentity: {
      type: string;
      arn: string;
      principalId: string;
      accountId: string;
    };
    requestParameters?: {
      tableName?: string;
    };
    responseElements?: unknown;
    readOnly?: boolean;
  };
}

// Simple in-memory rate tracking (reset on cold start)
const readCounts = new Map<string, { count: number; firstSeen: string }>();

/**
 * Monitors CloudTrail DynamoDB read events for anomalous patterns.
 * Emits prism.d1.security events when thresholds are exceeded.
 */
export async function handler(event: CloudTrailDynamoDBEvent): Promise<void> {
  const detail = event.detail;

  // Only process read operations on PRISM tables
  const tableName = detail.requestParameters?.tableName ?? '';
  if (!tableName.startsWith('prism-')) {
    return;
  }

  const principal = detail.userIdentity?.arn ?? 'unknown';
  const key = `${principal}:${tableName}`;

  // Track read count per principal per table
  const existing = readCounts.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    readCounts.set(key, { count: 1, firstSeen: detail.eventTime });
  }

  const current = readCounts.get(key)!;

  // Check if threshold exceeded
  if (current.count >= ALERT_THRESHOLD_READS) {
    console.warn(
      `Exfiltration alert: ${principal} made ${current.count} reads on ${tableName} since ${current.firstSeen}`,
    );

    const securityEvent = {
      team_id: 'security',
      repo: 'platform',
      timestamp: detail.eventTime,
      prism_level: 1,
      metric: {
        name: 'ExfiltrationAlertCount',
        value: current.count,
        unit: 'count',
      },
      security: {
        alert_type: 'high_read_volume',
        table_name: tableName,
        principal_arn: principal,
        read_count: current.count,
        window_start: current.firstSeen,
        window_end: detail.eventTime,
      },
    };

    await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: 'prism.d1.velocity',
            DetailType: 'prism.d1.security',
            EventBusName: EVENT_BUS_NAME,
            Detail: JSON.stringify(securityEvent),
          },
        ],
      }),
    );

    // Reset counter after alert
    readCounts.delete(key);
  }
}
