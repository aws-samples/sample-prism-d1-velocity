import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';

// ---- Types ----

interface ApiGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: Record<string, string> | null;
  queryStringParameters?: Record<string, string> | null;
  body?: string | null;
  headers?: Record<string, string>;
}

interface ApiGatewayResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface MetricPayload {
  'detail-type': string;
  detail: {
    team_id: string;
    repo: string;
    timestamp: string;
    prism_level?: string;
    metric?: { name: string; value: number; unit: string };
    ai_context?: {
      tool: string;
      model: string;
      origin: string;
    };
    dora?: Record<string, number | null>;
    ai_dora?: Record<string, number | null>;
  };
}

// ---- Clients ----

const eventBridgeClient = new EventBridgeClient({});
const dynamoClient = new DynamoDBClient({});

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const EVENTS_TABLE = process.env.EVENTS_TABLE!;
const METADATA_TABLE = process.env.METADATA_TABLE!;

const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,Authorization',
};

// ---- Handler ----

export async function handler(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  console.log('API request:', JSON.stringify(event, null, 2));

  try {
    // OPTIONS preflight
    if (event.httpMethod === 'OPTIONS') {
      return respond(200, { message: 'OK' });
    }

    // Route requests
    if (event.httpMethod === 'POST' && event.path === '/metrics') {
      return await handlePostMetrics(event);
    }

    if (event.httpMethod === 'POST' && event.path === '/assessment') {
      return await handlePostAssessment(event);
    }

    if (event.httpMethod === 'GET' && event.path.startsWith('/metrics/')) {
      return await handleGetMetrics(event);
    }

    if (event.httpMethod === 'POST' && event.path === '/security-findings') {
      return await handlePostSecurityFindings(event);
    }

    if (event.httpMethod === 'GET' && event.path.startsWith('/security-findings/')) {
      return await handleGetSecurityFindings(event);
    }

    return respond(404, { error: 'Not Found', message: `No route for ${event.httpMethod} ${event.path}` });
  } catch (err) {
    console.error('Unhandled error:', err);
    return respond(500, { error: 'Internal Server Error', message: (err as Error).message });
  }
}

// ---- POST /metrics ----

async function handlePostMetrics(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  if (!event.body) {
    return respond(400, { error: 'Bad Request', message: 'Request body is required' });
  }

  let payload: MetricPayload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Bad Request', message: 'Invalid JSON body' });
  }

  const validationError = validateMetricPayload(payload);
  if (validationError) {
    return respond(400, { error: 'Bad Request', message: validationError });
  }

  await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'prism.d1.velocity',
          DetailType: payload['detail-type'],
          Detail: JSON.stringify(payload.detail),
          EventBusName: EVENT_BUS_NAME,
        },
      ],
    }),
  );

  return respond(202, {
    message: 'Event accepted',
    detail_type: payload['detail-type'],
    team_id: payload.detail.team_id,
    repo: payload.detail.repo,
  });
}

// ---- POST /assessment ----

async function handlePostAssessment(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  if (!event.body) {
    return respond(400, { error: 'Bad Request', message: 'Request body is required' });
  }

  let payload: MetricPayload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return respond(400, { error: 'Bad Request', message: 'Invalid JSON body' });
  }

  if (!payload.detail?.team_id || !payload.detail?.repo) {
    return respond(400, { error: 'Bad Request', message: 'team_id and repo are required' });
  }

  // Store assessment directly in DynamoDB for fast lookups
  const item: Record<string, { S?: string; N?: string }> = {
    team_id: { S: payload.detail.team_id },
    repo: { S: payload.detail.repo },
    last_updated: { S: payload.detail.timestamp ?? new Date().toISOString() },
    prism_level: { N: payload.detail.prism_level ?? '1' },
    last_event_type: { S: 'prism.d1.assessment' },
  };

  if (payload.detail.metric) {
    item.assessment_metric = { S: payload.detail.metric.name };
    item.assessment_value = { N: payload.detail.metric.value.toString() };
  }

  await dynamoClient.send(
    new PutItemCommand({
      TableName: METADATA_TABLE,
      Item: item,
    }),
  );

  // Also publish to EventBridge for pipeline processing
  await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'prism.d1.velocity',
          DetailType: 'prism.d1.assessment',
          Detail: JSON.stringify(payload.detail),
          EventBusName: EVENT_BUS_NAME,
        },
      ],
    }),
  );

  return respond(202, {
    message: 'Assessment accepted',
    team_id: payload.detail.team_id,
    repo: payload.detail.repo,
    prism_level: payload.detail.prism_level,
  });
}

// ---- GET /metrics/{team_id} ----

async function handleGetMetrics(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  const teamId = event.pathParameters?.team_id ?? extractTeamIdFromPath(event.path);

  if (!teamId) {
    return respond(400, { error: 'Bad Request', message: 'team_id path parameter is required' });
  }

  const repo = event.queryStringParameters?.repo;
  const hours = parseInt(event.queryStringParameters?.hours ?? '168', 10); // default 7 days
  const detailType = event.queryStringParameters?.detail_type;

  const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const endTime = new Date().toISOString();

  try {
    let rows: Record<string, string | null>[];

    if (detailType && !repo) {
      // Query by detail_type using GSI, then filter by team_id client-side
      const result = await dynamoClient.send(
        new QueryCommand({
          TableName: EVENTS_TABLE,
          IndexName: 'by-detail-type',
          KeyConditionExpression: 'detail_type = :dt AND sk BETWEEN :start AND :end',
          FilterExpression: 'begins_with(pk, :teamPrefix)',
          ExpressionAttributeValues: {
            ':dt': { S: detailType },
            ':start': { S: startTime },
            ':end': { S: endTime },
            ':teamPrefix': { S: `${teamId}#` },
          },
          Limit: 1000,
          ScanIndexForward: false,
        }),
      );

      rows = (result.Items ?? []).map(mapDynamoItem);
    } else {
      // Query by pk (team_id#repo) using main table
      const pk = repo ? `${teamId}#${repo}` : undefined;

      if (pk) {
        const result = await dynamoClient.send(
          new QueryCommand({
            TableName: EVENTS_TABLE,
            KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
            ExpressionAttributeValues: {
              ':pk': { S: pk },
              ':start': { S: startTime },
              ':end': { S: endTime },
              ...(detailType ? { ':dt': { S: detailType } } : {}),
            },
            ...(detailType ? { FilterExpression: 'detail_type = :dt' } : {}),
            Limit: 1000,
            ScanIndexForward: false,
          }),
        );

        rows = (result.Items ?? []).map(mapDynamoItem);
      } else {
        // No repo specified — query GSI by detail_type if provided, otherwise
        // we need to scan with team prefix filter. For efficiency, use a
        // begins_with filter on the main table by doing a query per common
        // detail type or just filter. Here we use the GSI with a broad approach.
        // Since we don't have a pk, query all detail types for this team.
        const result = await dynamoClient.send(
          new QueryCommand({
            TableName: EVENTS_TABLE,
            IndexName: 'by-detail-type',
            KeyConditionExpression: 'detail_type = :dt AND sk BETWEEN :start AND :end',
            FilterExpression: 'begins_with(pk, :teamPrefix)',
            ExpressionAttributeValues: {
              ':dt': { S: 'prism.d1.commit' },
              ':start': { S: startTime },
              ':end': { S: endTime },
              ':teamPrefix': { S: `${teamId}#` },
            },
            Limit: 1000,
            ScanIndexForward: false,
          }),
        );

        // Query all detail types in parallel
        const detailTypes = [
          'prism.d1.pr',
          'prism.d1.deploy',
          'prism.d1.eval',
          'prism.d1.incident',
          'prism.d1.assessment',
        ];

        const additionalResults = await Promise.all(
          detailTypes.map((dt) =>
            dynamoClient.send(
              new QueryCommand({
                TableName: EVENTS_TABLE,
                IndexName: 'by-detail-type',
                KeyConditionExpression: 'detail_type = :dt AND sk BETWEEN :start AND :end',
                FilterExpression: 'begins_with(pk, :teamPrefix)',
                ExpressionAttributeValues: {
                  ':dt': { S: dt },
                  ':start': { S: startTime },
                  ':end': { S: endTime },
                  ':teamPrefix': { S: `${teamId}#` },
                },
                Limit: 1000,
                ScanIndexForward: false,
              }),
            ),
          ),
        );

        const allItems = [
          ...(result.Items ?? []),
          ...additionalResults.flatMap((r) => r.Items ?? []),
        ];

        // Sort by sk descending and limit to 1000
        allItems.sort((a, b) => (b.sk?.S ?? '').localeCompare(a.sk?.S ?? ''));
        rows = allItems.slice(0, 1000).map(mapDynamoItem);
      }
    }

    return respond(200, {
      team_id: teamId,
      query_hours: hours,
      count: rows.length,
      records: rows,
    });
  } catch (err) {
    console.error('DynamoDB query error:', err);
    return respond(500, { error: 'Query Failed', message: (err as Error).message });
  }
}

function mapDynamoItem(item: Record<string, { S?: string; N?: string }>): Record<string, string | null> {
  const record: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(item)) {
    record[key] = value.S ?? value.N ?? null;
  }
  return record;
}

// ---- Helpers ----

function extractTeamIdFromPath(path: string): string | undefined {
  const match = path.match(/^\/metrics\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function validateMetricPayload(payload: MetricPayload): string | null {
  const validDetailTypes = [
    'prism.d1.commit',
    'prism.d1.pr',
    'prism.d1.deploy',
    'prism.d1.eval',
    'prism.d1.incident',
    'prism.d1.assessment',
    'prism.d1.agent',
    'prism.d1.agent.eval',
  ];

  if (!payload['detail-type']) {
    return 'detail-type is required';
  }
  if (!validDetailTypes.includes(payload['detail-type'])) {
    return `Invalid detail-type. Must be one of: ${validDetailTypes.join(', ')}`;
  }
  if (!payload.detail) {
    return 'detail object is required';
  }
  if (!payload.detail.team_id) {
    return 'detail.team_id is required';
  }
  if (!payload.detail.repo) {
    return 'detail.repo is required';
  }
  if (!payload.detail.timestamp) {
    return 'detail.timestamp is required';
  }
  return null;
}

// ---- POST /security-findings ----

async function handlePostSecurityFindings(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  const body = JSON.parse(event.body ?? '{}');
  const findings = body.findings ?? [body];

  if (!Array.isArray(findings) || findings.length === 0) {
    return respond(400, { error: 'findings array is required' });
  }

  const entries = findings.map((finding: any) => ({
    Source: 'prism.d1.velocity',
    DetailType: `prism.d1.security.${finding.type ?? finding.phase ?? 'code_review'}`,
    EventBusName: EVENT_BUS_NAME,
    Detail: JSON.stringify({
      team_id: finding.team_id ?? 'unknown',
      repo: finding.repository ?? finding.repo ?? 'unknown',
      timestamp: finding.found_at ?? new Date().toISOString(),
      prism_level: 3,
      metric: { name: 'security_finding', value: 1, unit: 'count' },
      security_agent_finding: finding,
    }),
  }));

  // Emit in batches of 10
  for (let i = 0; i < entries.length; i += 10) {
    await eventBridgeClient.send(new PutEventsCommand({ Entries: entries.slice(i, i + 10) }));
  }

  return respond(200, { message: 'OK', findingsProcessed: entries.length });
}

// ---- GET /security-findings/{team_id} ----

async function handleGetSecurityFindings(event: ApiGatewayEvent): Promise<ApiGatewayResponse> {
  const teamId = event.pathParameters?.team_id;
  if (!teamId) {
    return respond(400, { error: 'team_id path parameter is required' });
  }

  const hours = parseInt(event.queryStringParameters?.hours ?? '168', 10); // Default 7 days
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const securityTypes = [
    'prism.d1.security.design_review',
    'prism.d1.security.code_review',
    'prism.d1.security.pen_test',
  ];

  const allFindings: any[] = [];

  for (const detailType of securityTypes) {
    const result = await dynamoClient.send(
      new QueryCommand({
        TableName: EVENTS_TABLE,
        IndexName: 'by-detail-type',
        KeyConditionExpression: 'detail_type = :dt AND sk >= :since',
        ExpressionAttributeValues: {
          ':dt': { S: detailType },
          ':since': { S: since },
        },
        ScanIndexForward: false,
        Limit: 100,
      }),
    );

    if (result.Items) {
      for (const item of result.Items) {
        const data = JSON.parse(item.data?.S ?? '{}');
        if (data.team_id === teamId) {
          allFindings.push({
            detail_type: detailType,
            timestamp: item.sk?.S,
            finding_id: item.finding_id?.S,
            ...data,
          });
        }
      }
    }
  }

  return respond(200, { team_id: teamId, findings: allFindings, count: allFindings.length });
}

function respond(statusCode: number, body: Record<string, unknown>): ApiGatewayResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}
