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
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS ?? '24', 10);

interface DeployEvent {
  source: string;
  'detail-type': string;
  detail: {
    team_id: string;
    repo: string;
    timestamp: string;
    dora?: {
      change_failure_rate?: number;
    };
  };
}

/**
 * Triggered by failed deployment events.
 * Queries recent commits by AI origin, calculates AI vs human defect rates,
 * and emits a prism.d1.quality event.
 */
export async function handler(event: DeployEvent): Promise<void> {
  const detail = event.detail;

  // Only process deployment failures
  const cfr = detail.dora?.change_failure_rate ?? 0;
  if (cfr === 0) {
    console.log('Deployment succeeded, no defect correlation needed');
    return;
  }

  console.log(`Processing failed deployment for ${detail.team_id}/${detail.repo}`);

  const deployTime = new Date(detail.timestamp);
  const lookbackStart = new Date(deployTime.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);

  // Query recent commit events for this repo
  try {
    const result = await dynamoClient.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':pk': { S: `${detail.team_id}#${detail.repo}` },
          ':start': { S: lookbackStart.toISOString() },
          ':end': { S: deployTime.toISOString() },
        },
      }),
    );

    if (!result.Items || result.Items.length === 0) {
      console.log('No recent commits found in lookback window');
      return;
    }

    // Count commits by AI origin
    let aiCommitCount = 0;
    let humanCommitCount = 0;

    for (const item of result.Items) {
      const detailType = item.detail_type?.S ?? '';
      if (detailType !== 'prism.d1.commit') continue;

      const data = JSON.parse(item.data?.S ?? '{}');
      const origin = data.ai_context?.origin ?? 'human';

      if (origin === 'ai-generated' || origin === 'ai-assisted') {
        aiCommitCount++;
      } else {
        humanCommitCount++;
      }
    }

    const totalCommits = aiCommitCount + humanCommitCount;
    if (totalCommits === 0) {
      console.log('No commit events in lookback window');
      return;
    }

    // Calculate defect rates using proportional distribution.
    // Since we can't attribute a specific failure to a specific commit,
    // we distribute the change failure rate proportionally by code origin.
    // This gives a directional signal: if 80% of commits are AI and the
    // deploy failed, AI code carries 80% of the attributed failure weight.
    const aiDefectRate = aiCommitCount > 0 ? (cfr * aiCommitCount) / totalCommits : 0;
    const humanDefectRate = humanCommitCount > 0 ? (cfr * humanCommitCount) / totalCommits : 0;

    const qualityEvent = {
      team_id: detail.team_id,
      repo: detail.repo,
      timestamp: detail.timestamp,
      prism_level: 2,
      metric: {
        name: 'post_merge_defect_rate',
        value: cfr,
        unit: 'percent',
      },
      ai_dora: {
        post_merge_defect_rate: cfr,
      },
      quality: {
        deployment_id: `deploy-${Date.now()}`,
        ai_defect_rate: Math.round(aiDefectRate * 10000) / 10000,
        human_defect_rate: Math.round(humanDefectRate * 10000) / 10000,
        total_ai_commits: aiCommitCount,
        total_human_commits: humanCommitCount,
      },
    };

    await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: 'prism.d1.velocity',
            DetailType: 'prism.d1.quality',
            EventBusName: EVENT_BUS_NAME,
            Detail: JSON.stringify(qualityEvent),
          },
        ],
      }),
    );

    console.log(
      `Emitted quality event: AI defect rate ${aiDefectRate.toFixed(4)}, Human defect rate ${humanDefectRate.toFixed(4)}, ${aiCommitCount} AI commits, ${humanCommitCount} human commits`,
    );
  } catch (err) {
    console.error('Failed to correlate defects:', err);
  }
}
