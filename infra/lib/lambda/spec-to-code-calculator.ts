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

interface PrMergedEvent {
  source: string;
  'detail-type': string;
  detail: {
    team_id: string;
    repo: string;
    timestamp: string;
    ai_context?: {
      tool: string;
      model: string;
      origin: string;
    };
    pr?: {
      spec_ref?: string;
      merged_at?: string;
    };
  };
}

/**
 * Triggered by merged PR events that have a Spec-Ref.
 * Calculates spec-to-code hours by finding the earliest commit
 * referencing the same spec and computing the time delta to PR merge.
 */
export async function handler(event: PrMergedEvent): Promise<void> {
  const detail = event.detail;
  const specRef = detail.pr?.spec_ref;

  if (!specRef) {
    console.log('No spec reference in PR event, skipping');
    return;
  }

  console.log(`Calculating spec-to-code for spec: ${specRef}`);

  // Query for the earliest commit event in this repo that references this spec.
  // spec_ref is stored as a top-level DynamoDB attribute by the metrics-processor.
  try {
    const result = await dynamoClient.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: 'pk = :pk',
        FilterExpression: 'spec_ref = :spec_ref AND detail_type = :dt',
        ExpressionAttributeValues: {
          ':pk': { S: `${detail.team_id}#${detail.repo}` },
          ':spec_ref': { S: specRef },
          ':dt': { S: 'prism.d1.commit' },
        },
        ScanIndexForward: true, // Oldest first
        Limit: 1,
      }),
    );

    if (!result.Items || result.Items.length === 0) {
      console.log(`No commit events found referencing spec: ${specRef}`);
      return;
    }

    const earliestSpecCommitTime = result.Items[0].sk?.S;
    if (!earliestSpecCommitTime) {
      console.log('Could not determine spec commit timestamp');
      return;
    }

    const mergedAt = detail.pr?.merged_at ?? detail.timestamp;
    const specTime = new Date(earliestSpecCommitTime);
    const mergeTime = new Date(mergedAt);
    const specToCodeHours = (mergeTime.getTime() - specTime.getTime()) / (1000 * 60 * 60);

    if (specToCodeHours < 0) {
      console.log('Negative spec-to-code time, likely data issue');
      return;
    }

    const specEvent = {
      team_id: detail.team_id,
      repo: detail.repo,
      timestamp: detail.timestamp,
      prism_level: 3,
      metric: {
        name: 'spec_to_code_hours',
        value: Math.round(specToCodeHours * 100) / 100,
        unit: 'hours',
      },
      ai_context: detail.ai_context,
      ai_dora: {
        spec_to_code_hours: Math.round(specToCodeHours * 100) / 100,
      },
    };

    await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: 'prism.d1.velocity',
            DetailType: 'prism.d1.pr',
            EventBusName: EVENT_BUS_NAME,
            Detail: JSON.stringify(specEvent),
          },
        ],
      }),
    );

    console.log(`Spec-to-code: ${specToCodeHours.toFixed(2)} hours for spec ${specRef}`);
  } catch (err) {
    console.error('Failed to calculate spec-to-code hours:', err);
  }
}
