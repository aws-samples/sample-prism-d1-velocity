import { createHmac, timingSafeEqual } from 'crypto';
import {
  EventBridgeClient,
  PutEventsCommand,
  PutEventsRequestEntry,
} from '@aws-sdk/client-eventbridge';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AITrailers,
  AIOrigin,
  DORAMetrics,
  AIDORAMetrics,
  PrismMetricDetail,
  PrismDetailType,
  PrismEvent,
  GitHubPushEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewEvent,
  GitHubDeploymentEvent,
  GitHubDeploymentStatusEvent,
  GitHubCheckRunEvent,
  GitHubCommit,
} from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME ?? 'prism-d1-metrics';
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const TEAM_ID = process.env.TEAM_ID ?? 'default';
const AWS_REGION = process.env.AWS_REGION ?? 'us-west-2';

const ebClient = new EventBridgeClient({ region: AWS_REGION });

// ---------------------------------------------------------------------------
// Signature Verification
// ---------------------------------------------------------------------------

function verifySignature(payload: string, signatureHeader: string | undefined): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn('GITHUB_WEBHOOK_SECRET not set — skipping signature verification');
    return true;
  }

  if (!signatureHeader) {
    return false;
  }

  const [algorithm, signature] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !signature) {
    return false;
  }

  const expected = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AI Trailer Parsing
// ---------------------------------------------------------------------------

const TRAILER_REGEX = /^([\w-]+):\s*(.+)$/;

export function parseAITrailers(commitMessage: string): AITrailers {
  const lines = commitMessage.split('\n');
  const trailers: Record<string, string> = {};

  // Trailers appear at the end of the message after a blank line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') break;
    const match = TRAILER_REGEX.exec(line);
    if (match) {
      trailers[match[1].toLowerCase()] = match[2].trim();
    }
  }

  let origin: AIOrigin = 'human';
  const rawOrigin = trailers['ai-origin'];
  if (rawOrigin === 'ai-assisted' || rawOrigin === 'ai-generated' || rawOrigin === 'human') {
    origin = rawOrigin;
  } else if (rawOrigin) {
    // Any non-standard ai-origin value is treated as ai-assisted
    origin = 'ai-assisted';
  }

  return {
    origin,
    model: trailers['ai-model'] ?? null,
    tool: trailers['ai-tool'] ?? null,
    specRef: trailers['spec-ref'] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Metric Helpers
// ---------------------------------------------------------------------------

function emptyDORA(): DORAMetrics {
  return {
    deployment_frequency: null,
    lead_time_seconds: null,
    change_failure_rate: null,
    mttr_seconds: null,
  };
}

function emptyAIDORA(): AIDORAMetrics {
  return {
    ai_acceptance_rate: null,
    ai_to_merge_ratio: null,
    spec_to_code_hours: null,
    post_merge_defect_rate: null,
    eval_gate_pass_rate: null,
    ai_test_coverage_delta: null,
  };
}

function buildMetricDetail(
  repo: string,
  timestamp: string,
  metricName: string,
  metricValue: number,
  metricUnit: string,
  aiTrailers: AITrailers,
  doraOverrides: Partial<DORAMetrics> = {},
  aiDoraOverrides: Partial<AIDORAMetrics> = {},
): PrismMetricDetail {
  return {
    team_id: TEAM_ID,
    repo,
    timestamp,
    prism_level: null,
    metric: {
      name: metricName,
      value: metricValue,
      unit: metricUnit,
    },
    ai_context: {
      tool: aiTrailers.tool ?? 'claude-code',
      model: aiTrailers.model,
      origin: aiTrailers.origin,
    },
    dora: { ...emptyDORA(), ...doraOverrides },
    ai_dora: { ...emptyAIDORA(), ...aiDoraOverrides },
  };
}

// ---------------------------------------------------------------------------
// Event Processors
// ---------------------------------------------------------------------------

function processPushEvent(payload: GitHubPushEvent): PrismEvent[] {
  const repo = payload.repository.full_name;
  const events: PrismEvent[] = [];

  // Analyze AI-origin ratio across all commits in the push
  let aiCommitCount = 0;
  const totalCommits = payload.commits.length;

  for (const commit of payload.commits) {
    const trailers = parseAITrailers(commit.message);

    if (trailers.origin !== 'human') {
      aiCommitCount++;
    }

    const filesChanged = commit.added.length + commit.removed.length + commit.modified.length;

    events.push({
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.commit',
      detail: buildMetricDetail(
        repo,
        commit.timestamp,
        'commit.files_changed',
        filesChanged,
        'files',
        trailers,
      ),
    });
  }

  // Emit AI-to-merge ratio for the push
  if (totalCommits > 0) {
    const ratio = aiCommitCount / totalCommits;
    const aggregateTrailers: AITrailers = {
      origin: aiCommitCount > 0 ? 'ai-assisted' : 'human',
      model: null,
      tool: null,
      specRef: null,
    };

    events.push({
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.commit',
      detail: buildMetricDetail(
        repo,
        new Date().toISOString(),
        'push.ai_to_merge_ratio',
        ratio,
        'ratio',
        aggregateTrailers,
        {},
        { ai_to_merge_ratio: ratio },
      ),
    });
  }

  return events;
}

function processPullRequestEvent(payload: GitHubPullRequestEvent): PrismEvent[] {
  const repo = payload.repository.full_name;
  const pr = payload.pull_request;
  const events: PrismEvent[] = [];

  // Extract AI trailers from PR body if present
  const trailers = parseAITrailers(pr.body ?? '');

  if (payload.action === 'opened') {
    events.push({
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.pr',
      detail: buildMetricDetail(
        repo,
        pr.created_at,
        'pr.opened',
        1,
        'count',
        trailers,
      ),
    });
  }

  if (payload.action === 'closed' && pr.merged && pr.merged_at) {
    // Calculate lead time: time from PR creation to merge
    const createdMs = new Date(pr.created_at).getTime();
    const mergedMs = new Date(pr.merged_at).getTime();
    const leadTimeSeconds = Math.max(0, Math.round((mergedMs - createdMs) / 1000));

    events.push({
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.pr',
      detail: buildMetricDetail(
        repo,
        pr.merged_at,
        'pr.merged',
        1,
        'count',
        trailers,
        { lead_time_seconds: leadTimeSeconds },
      ),
    });

    // Emit lines-changed metric
    events.push({
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.pr',
      detail: buildMetricDetail(
        repo,
        pr.merged_at,
        'pr.lines_changed',
        pr.additions + pr.deletions,
        'lines',
        trailers,
      ),
    });
  }

  if (payload.action === 'closed' && !pr.merged) {
    events.push({
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.pr',
      detail: buildMetricDetail(
        repo,
        pr.closed_at ?? new Date().toISOString(),
        'pr.closed_without_merge',
        1,
        'count',
        trailers,
      ),
    });
  }

  return events;
}

function processDeploymentEvent(payload: GitHubDeploymentEvent): PrismEvent[] {
  const repo = payload.repository.full_name;
  const trailers: AITrailers = { origin: 'human', model: null, tool: null, specRef: null };

  return [
    {
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.deploy',
      detail: buildMetricDetail(
        repo,
        payload.deployment.created_at,
        'deployment.created',
        1,
        'count',
        trailers,
        { deployment_frequency: 1 },
      ),
    },
  ];
}

function processDeploymentStatusEvent(payload: GitHubDeploymentStatusEvent): PrismEvent[] {
  const repo = payload.repository.full_name;
  const trailers: AITrailers = { origin: 'human', model: null, tool: null, specRef: null };
  const status = payload.deployment_status;

  const isFailure = status.state === 'failure' || status.state === 'error';

  return [
    {
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.deploy',
      detail: buildMetricDetail(
        repo,
        status.created_at,
        `deployment.status.${status.state}`,
        1,
        'count',
        trailers,
        {
          change_failure_rate: isFailure ? 1 : 0,
        },
      ),
    },
  ];
}

function processCheckRunEvent(payload: GitHubCheckRunEvent): PrismEvent[] {
  if (payload.action !== 'completed') {
    return [];
  }

  const repo = payload.repository.full_name;
  const checkRun = payload.check_run;
  const trailers: AITrailers = { origin: 'human', model: null, tool: null, specRef: null };

  // Determine if this is an eval gate (convention: check run name starts with "eval-" or "prism-eval")
  const isEvalGate =
    checkRun.name.startsWith('eval-') || checkRun.name.startsWith('prism-eval');

  const passed = checkRun.conclusion === 'success' ? 1 : 0;
  const metricName = isEvalGate ? 'eval_gate.result' : 'check_run.result';

  const aiDoraOverrides: Partial<AIDORAMetrics> = {};
  if (isEvalGate) {
    aiDoraOverrides.eval_gate_pass_rate = passed;
  }

  const durationMs =
    checkRun.completed_at && checkRun.started_at
      ? new Date(checkRun.completed_at).getTime() - new Date(checkRun.started_at).getTime()
      : 0;

  return [
    {
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.eval',
      detail: buildMetricDetail(
        repo,
        checkRun.completed_at ?? new Date().toISOString(),
        metricName,
        passed,
        'boolean',
        trailers,
        {},
        aiDoraOverrides,
      ),
    },
    {
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.eval',
      detail: buildMetricDetail(
        repo,
        checkRun.completed_at ?? new Date().toISOString(),
        `${metricName}.duration_ms`,
        durationMs,
        'milliseconds',
        trailers,
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Pull Request Review (AI Acceptance Rate)
// ---------------------------------------------------------------------------

function processPullRequestReviewEvent(event: GitHubPullRequestReviewEvent): PrismEvent[] {
  if (event.action !== 'submitted') return [];

  const review = event.review;
  const pr = event.pull_request;
  const repo = event.repository.full_name;

  // Only track approval/rejection reviews (not comments)
  if (review.state !== 'approved' && review.state !== 'changes_requested') {
    return [];
  }

  // Check if this PR has AI trailers
  const trailers = parseAITrailers(pr.body ?? '');
  if (trailers.origin === 'human') {
    // Also check PR title for AI indicators
    const titleTrailers = parseAITrailers(pr.title ?? '');
    if (titleTrailers.origin === 'human') {
      return []; // Not an AI-assisted PR
    }
  }

  const accepted = review.state === 'approved' ? 1 : 0;

  return [
    {
      source: 'prism.d1.velocity',
      detailType: 'prism.d1.pr',
      detail: buildMetricDetail(
        repo,
        review.submitted_at,
        'pr.ai_review',
        accepted,
        'boolean',
        trailers,
        {},
        {
          ai_acceptance_rate: accepted * 100,
        },
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// EventBridge Emitter
// ---------------------------------------------------------------------------

async function emitEvents(events: PrismEvent[]): Promise<void> {
  if (events.length === 0) return;

  // EventBridge PutEvents supports max 10 entries per call
  const batches: PrismEvent[][] = [];
  for (let i = 0; i < events.length; i += 10) {
    batches.push(events.slice(i, i + 10));
  }

  for (const batch of batches) {
    const entries: PutEventsRequestEntry[] = batch.map((event) => ({
      Source: event.source,
      DetailType: event.detailType,
      Detail: JSON.stringify(event.detail),
      EventBusName: EVENT_BUS_NAME,
    }));

    const command = new PutEventsCommand({ Entries: entries });
    const result = await ebClient.send(command);

    if (result.FailedEntryCount && result.FailedEntryCount > 0) {
      console.error(
        'EventBridge PutEvents partial failure:',
        JSON.stringify(result.Entries?.filter((e) => e.ErrorCode)),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lambda Handler
// ---------------------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const body = event.body ?? '';
  const signature = event.headers['x-hub-signature-256'] ?? event.headers['X-Hub-Signature-256'];
  const eventType = event.headers['x-github-event'] ?? event.headers['X-GitHub-Event'];

  // Verify webhook signature
  if (!verifySignature(body, signature)) {
    console.error('Webhook signature verification failed');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }

  if (!eventType) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing X-GitHub-Event header' }),
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    console.error('Failed to parse webhook body:', err);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  let prismEvents: PrismEvent[] = [];

  try {
    switch (eventType) {
      case 'push':
        prismEvents = processPushEvent(payload as GitHubPushEvent);
        break;
      case 'pull_request':
        prismEvents = processPullRequestEvent(payload as GitHubPullRequestEvent);
        break;
      case 'deployment':
        prismEvents = processDeploymentEvent(payload as GitHubDeploymentEvent);
        break;
      case 'deployment_status':
        prismEvents = processDeploymentStatusEvent(payload as GitHubDeploymentStatusEvent);
        break;
      case 'check_run':
        prismEvents = processCheckRunEvent(payload as GitHubCheckRunEvent);
        break;
      case 'pull_request_review':
        prismEvents = processPullRequestReviewEvent(payload as GitHubPullRequestReviewEvent);
        break;
      default:
        console.log(`Ignoring unhandled event type: ${eventType}`);
    }

    await emitEvents(prismEvents);

    console.log(`Processed ${eventType} event — emitted ${prismEvents.length} metric(s)`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'OK',
        eventsEmitted: prismEvents.length,
      }),
    };
  } catch (err) {
    console.error('Error processing webhook:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal processing error' }),
    };
  }
}
