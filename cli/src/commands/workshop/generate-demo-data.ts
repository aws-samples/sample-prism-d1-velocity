/**
 * PRISM D1 — workshop demo data generator.
 *
 * The dashboards read TWO stores, and a generator that fills only one leaves
 * roughly half of every view blank:
 *
 *   EventBridge → metrics-processor → events table + CloudWatch
 *     Delivery KPIs, eval gates, governance, agent ops, security, most of CISO.
 *
 *   AI-usage table (attribution) → otel-receiver GET routes
 *     AI share, merge rate, defect rate, $/shipped commit, Attribution
 *     Coverage, Repository Breakdown, the observed PRISM level, and the whole
 *     Developer Productivity dashboard.
 *
 * Attribution is written directly to DynamoDB rather than POSTed to
 * /v1/traces because the receiver derives the owning developer from the
 * caller's JWT claim. Every seeded commit would land under the single
 * participant running this command, and a one-developer fleet cannot
 * demonstrate the per-developer view or a coverage shortfall. Direct writes
 * are the only way to seed a multi-developer fleet.
 *
 * The cost of that choice is schema coupling. Item shapes below must match
 * infra/lib/lambda/otel-receiver.ts — specifically writeCommitAttribution,
 * writeSpanIfNew and bumpDailyAggregate. If those change, this changes too.
 *
 * Guardrails, because this writes fabricated facts into a metrics store:
 *   - every seeded item carries demo_seed=true and a seed_run_id
 *   - seeding refuses to run when the table already holds real attribution,
 *     unless --force is passed
 *   - --purge-demo removes seeded items and leaves real ones alone
 */

import { randomBytes } from 'node:crypto';
import { run } from '../../utils/exec.js';
import { withPrivateTemp } from '../../utils/tempfile.js';

// ---- Shell-free AWS CLI helpers ----

/**
 * EventBridge put-events with the entry array passed as a file.
 *
 * The previous form interpolated JSON.stringify output into a single-quoted
 * shell string (`--entries '${json}'`). A team, bus or repo name containing an
 * apostrophe terminated that quoted region and the remainder became shell
 * source. Passing a file path removes both the quoting and the shell.
 */
function putEvents(region: string, entries: object[]): boolean {
  return withPrivateTemp('entries.json', JSON.stringify(entries), (file) =>
    run('aws', ['events', 'put-events', '--region', region, '--entries', `file://${file}`]).ok,
  );
}

type DdbRequest = { PutRequest: { Item: Record<string, unknown> } } | { DeleteRequest: { Key: Record<string, unknown> } };

/** Write one request with the single-item APIs (PutItem / DeleteItem). */
function ddbWriteOne(region: string, table: string, req: DdbRequest): { ok: boolean; stderr: string } {
  if ('PutRequest' in req) {
    const r = withPrivateTemp('item.json', JSON.stringify(req.PutRequest.Item), (file) =>
      run('aws', ['dynamodb', 'put-item', '--region', region, '--table-name', table, '--item', `file://${file}`]),
    );
    return { ok: r.ok, stderr: r.stderr };
  }
  const r = withPrivateTemp('key.json', JSON.stringify(req.DeleteRequest.Key), (file) =>
    run('aws', ['dynamodb', 'delete-item', '--region', region, '--table-name', table, '--key', `file://${file}`]),
  );
  return { ok: r.ok, stderr: r.stderr };
}

/**
 * Whether this caller may use BatchWriteItem. null until the first attempt.
 *
 * Module-scoped so the discovery is made once. When it lives inside
 * ddbBatchWrite it resets per call, and a role without the action pays for a
 * doomed batch request on every invocation — the preflight probe alone
 * re-discovered it three times.
 */
let batchWriteSupported: boolean | null = null;

/**
 * Write requests to DynamoDB, preferring BatchWriteItem and falling back to the
 * single-item APIs.
 *
 * The fallback exists because IAM policies routinely enumerate DynamoDB actions
 * individually. A live workshop role held dynamodb:PutItem — a single put-item
 * succeeded against the real table, KMS included — while every BatchWriteItem
 * call failed. Rather than require an IAM change to a role this repo does not
 * define, fall back to the API that is demonstrably permitted.
 *
 * Per-item writes are slower but bounded: a full seed is roughly 150 items.
 */
function ddbBatchWrite(region: string, table: string, requests: DdbRequest[]): { written: number; error: string | null } {
  let written = 0;
  let batchError = '';

  for (let i = 0; i < requests.length; i += 25) {
    const chunk = requests.slice(i, i + 25);

    if (batchWriteSupported !== false) {
      const payload = JSON.stringify({ [table]: chunk });
      const result = withPrivateTemp('batch.json', payload, (file) =>
        run('aws', ['dynamodb', 'batch-write-item', '--region', region, '--request-items', `file://${file}`]),
      );
      if (result.ok) {
        batchWriteSupported = true;
        written += chunk.length;
        process.stdout.write('.');
        continue;
      }
      // Remember why, then write everything item by item from here on.
      batchError = result.stderr || 'batch-write-item failed with no stderr';
      batchWriteSupported = false;
      process.stdout.write('!');
    }

    for (const req of chunk) {
      const one = ddbWriteOne(region, table, req);
      if (!one.ok) {
        return {
          written,
          error:
            `batch-write-item failed and the single-item fallback also failed.\n` +
            `  batch-write-item: ${batchError || '(not attempted this call)'}\n` +
            `  put-item/delete-item: ${one.stderr}`,
        };
      }
      written++;
      if (written % 25 === 0) process.stdout.write('.');
    }
  }

  return { written, error: null };
}

/**
 * Confirm the attribution table is writable *by the API seeding actually uses*
 * before generating anything. Runs regardless of --force, because --force is
 * about overwriting real data, not about reachability.
 *
 * The probe deliberately uses BatchWriteItem rather than PutItem. IAM policies
 * routinely enumerate DynamoDB actions individually, so a role can hold
 * dynamodb:PutItem and not dynamodb:BatchWriteItem — which is exactly the
 * failure this function was added for. Probing PutItem would have passed and
 * left the real failure to surface 150 items later.
 *
 * describe-table alone is also insufficient: read access does not imply write
 * access, and the table is KMS-encrypted, so a role can hold the DynamoDB
 * actions and still fail on kms:GenerateDataKey.
 */
function preflightAttributionTable(region: string, table: string): string | null {
  const describe = run('aws', ['dynamodb', 'describe-table', '--region', region, '--table-name', table, '--output', 'json']);
  if (!describe.ok) {
    return `cannot describe ${table}: ${describe.stderr}`;
  }
  const probeKey = { pk: { S: 'REPO#__prism_preflight__' }, sk: { S: 'COMMIT#__prism_preflight__' } };
  const probeItem = { ...probeKey, record_type: { S: 'PREFLIGHT' }, demo_seed: { BOOL: true } };

  const put = ddbBatchWrite(region, table, [{ PutRequest: { Item: probeItem } }]);
  if (put.error) {
    return `cannot batch-write to ${table}: ${put.error}`;
  }
  ddbBatchWrite(region, table, [{ DeleteRequest: { Key: probeKey } }]);
  return null;
}

/** True when the table holds attribution commits that this generator did not create. */
function hasRealAttribution(region: string, table: string): boolean {
  const values = JSON.stringify({ ':rt': { S: 'OTEL_ATTR_COMMIT' } });
  const result = withPrivateTemp('values.json', values, (file) =>
    run('aws', [
      'dynamodb', 'scan',
      '--region', region,
      '--table-name', table,
      '--select', 'COUNT',
      '--filter-expression', 'record_type = :rt AND attribute_not_exists(demo_seed)',
      '--expression-attribute-values', `file://${file}`,
      '--output', 'json',
    ]),
  );
  if (!result.ok) return false; // table missing or no access — surfaced by the caller's first write
  try {
    return (JSON.parse(result.stdout).Count ?? 0) > 0;
  } catch {
    return false;
  }
}

function purgeDemoAttribution(region: string, table: string): number {
  const values = JSON.stringify({ ':t': { BOOL: true } });
  const result = withPrivateTemp('values.json', values, (file) =>
    run('aws', [
      'dynamodb', 'scan',
      '--region', region,
      '--table-name', table,
      '--filter-expression', 'demo_seed = :t',
      '--projection-expression', 'pk,sk',
      '--expression-attribute-values', `file://${file}`,
      '--output', 'json',
    ]),
  );
  if (!result.ok) {
    console.error(`Error: could not scan ${table}: ${result.stderr}`);
    return 0;
  }
  let items: Array<Record<string, unknown>>;
  try {
    items = JSON.parse(result.stdout).Items ?? [];
  } catch {
    console.error('Error: could not parse scan output');
    return 0;
  }
  if (items.length === 0) return 0;
  return ddbBatchWrite(region, table, items.map(key => ({ DeleteRequest: { Key: key } }))).written;
}

// ---- Synthetic fleet ----

const SONNET = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * `onboarded: false` is deliberate and load-bearing. That developer authors
 * PRs, so their commits appear in the CI census that forms the Attribution
 * Coverage denominator, but they produce no attribution items. Coverage
 * therefore lands below 100% for the honest reason — someone has not run
 * setup-otel-sync — which is exactly what the KPI exists to reveal. Seeding
 * everyone would render a permanent 100% and teach the opposite lesson.
 */
const DEVELOPERS = [
  { email: 'alex.rivera@example.com', tool: 'claude-code', model: SONNET, aiRate: 0.74, onboarded: true },
  { email: 'priya.natarajan@example.com', tool: 'kiro', model: HAIKU, aiRate: 0.61, onboarded: true },
  { email: 'sam.okafor@example.com', tool: 'claude-code', model: SONNET, aiRate: 0.83, onboarded: true },
  { email: 'wei.zhang@example.com', tool: 'cursor', model: HAIKU, aiRate: 0.42, onboarded: true },
  { email: 'jordan.blake@example.com', tool: 'none', model: '', aiRate: 0, onboarded: false },
] as const;

type Developer = (typeof DEVELOPERS)[number];

const SPAN_TTL_DAYS = 90;
const COMMIT_TTL_DAYS = 365;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export default {
  description: 'Generate sample data for the PRISM dashboards (8 days of events + attribution)',
  options: [
    { flags: '--region <region>', description: 'AWS region', default: 'us-west-2' },
    { flags: '--bus <name>', description: 'EventBridge bus name', default: 'prism-d1-metrics' },
    { flags: '--team <id>', description: 'Team identifier', default: 'demo-team' },
    { flags: '--repo <name>', description: 'Primary repository name', default: 'prism-d1-sample-app' },
    { flags: '--table <name>', description: 'Attribution (AI usage) table name', default: 'prism-d1-ai-usage' },
    { flags: '--no-attribution', description: 'Emit events only; leave the attribution store untouched' },
    { flags: '--purge-demo', description: 'Delete previously seeded attribution items and exit' },
    { flags: '--force', description: 'Seed attribution even when the table already holds real data' },
  ],
  action(options: {
    region: string;
    bus: string;
    team: string;
    repo: string;
    table: string;
    attribution: boolean;
    purgeDemo?: boolean;
    force?: boolean;
  }) {
    const { region, bus, team, repo, table } = options;
    const seedAttribution = options.attribution !== false;

    // No shell here, so `command -v aws` is not available — `command` is a
    // shell builtin, not a binary. Probe the binary directly instead.
    if (!run('aws', ['--version']).ok) {
      console.error('Error: AWS CLI not found. Install from https://aws.amazon.com/cli/');
      process.exit(1);
    }

    if (options.purgeDemo) {
      console.log(`Purging seeded attribution items from ${table} (${region})...`);
      const removed = purgeDemoAttribution(region, table);
      console.log(`\nRemoved ${removed} seeded item(s). Real attribution data was left untouched.`);
      return;
    }

    console.log('=== PRISM Demo Data Generator ===');
    console.log(`Region: ${region} | Bus: ${bus} | Team: ${team}`);
    console.log(`Attribution: ${seedAttribution ? `${table}` : 'skipped (--no-attribution)'}`);
    console.log('');

    if (seedAttribution) {
      const problem = preflightAttributionTable(region, table);
      if (problem) {
        console.error(`Error: ${problem}`);
        console.error('');
        console.error('Attribution seeding writes directly to DynamoDB, which needs permissions the');
        console.error('rest of this command does not: dynamodb:PutItem, BatchWriteItem and DeleteItem');
        console.error(`on ${table}, plus kms:GenerateDataKey and kms:Decrypt on the table's key.`);
        console.error('Only the otel-receiver and attribution-metrics-publisher Lambdas are granted');
        console.error('these by the CDK stack, so a workshop or devbox role will not have them by');
        console.error('default.');
        console.error('');
        console.error('  --no-attribution   emit events only; the event-driven widgets still populate');
        console.error('');
        console.error('Attribution-sourced widgets (AI share, coverage, Repository Breakdown, the');
        console.error('observed PRISM level, Developer Productivity) need either those permissions or');
        console.error('a real codeburn sync from Module 04.');
        process.exit(1);
      }
    }

    if (seedAttribution && !options.force && hasRealAttribution(region, table)) {
      console.error(`Error: ${table} already contains real attribution data.`);
      console.error('');
      console.error('Seeding fabricated commits alongside real developer activity corrupts the');
      console.error('very KPIs this dashboard exists to report — AI share, coverage, $/shipped.');
      console.error('');
      console.error('  --no-attribution   emit events only, leave attribution alone');
      console.error('  --force            seed anyway (marked demo_seed=true, removable)');
      process.exit(1);
    }

    // A repo set, so the Repository Breakdown view has more than one row. The
    // per-day PR count is distributed across these rather than multiplied by
    // them, so total event volume is unchanged.
    const REPOS = [repo, `${repo}-api`, `${repo}-web`];
    const seedRunId = hex(8);

    let batch: object[] = [];
    let total = 0;

    function flush() {
      if (batch.length > 0) {
        if (putEvents(region, batch)) {
          total += batch.length;
        } else {
          console.error(`Warning: Failed to emit batch of ${batch.length} events`);
        }
        batch = [];
      }
    }

    function addEvent(detailType: string, detail: object) {
      batch.push({
        Source: 'prism.d1.velocity',
        DetailType: detailType,
        EventBusName: bus,
        Detail: JSON.stringify(detail),
      });
      if (batch.length >= 10) {
        flush();
        process.stdout.write('.');
      }
    }

    // ---- Attribution accumulators ----
    //
    // Spans and commits are collected SEPARATELY because write order matters.
    // Each COMMIT# put fires a DynamoDB stream event into
    // attribution-metrics-publisher, which resolves origin by querying the
    // user's SPAN# items for a matching trace_id — it ignores the stored
    // ai_origin verdict. If a commit's stream event is processed before its
    // span exists, the join misses and an AI commit publishes as HumanCommits.
    // The receiver avoids this by running processSpans before
    // processAttributionSpans; this mirrors that ordering.
    const spanRequests: DdbRequest[] = [];
    const commitRequests: DdbRequest[] = [];
    /** (user, day, tool, model) → running totals for the OTEL#DAY rollup. */
    const dayRollups = new Map<string, {
      user: string; day: string; tool: string; model: string;
      inputTokens: number; outputTokens: number; costUsd: number; calls: number;
    }>();

    const commitTtl = Math.floor(Date.now() / 1000) + COMMIT_TTL_DAYS * 86400;
    const spanTtl = Math.floor(Date.now() / 1000) + SPAN_TTL_DAYS * 86400;

    /**
     * Seed one commit's attribution facts.
     *
     * `ai_origin` is written explicitly here because the receiver freezes it at
     * ingest and every read path prefers the stored verdict. The SPAN# item is
     * NOT optional for AI commits: attribution-metrics-publisher ignores the
     * stored verdict and re-derives origin by joining traceId against spans, so
     * an AI commit with no matching span publishes as HumanCommits. Omitting
     * spans would make the native CloudWatch graphs contradict the custom
     * widgets on the same dashboard.
     */
    function seedCommit(dev: Developer, repoName: string, sha: string, timestamp: string, isAi: boolean, inMain: boolean, wasReverted: boolean) {
      const traceId = hex(16);
      const sessionId = `sess-${seedRunId}-${hex(4)}`;

      commitRequests.push({
        PutRequest: {
          Item: {
            pk: { S: `REPO#${repoName}` },
            sk: { S: `COMMIT#${sha}` },
            record_type: { S: 'OTEL_ATTR_COMMIT' },
            session_id: { S: sessionId },
            trace_id: { S: traceId },
            project: { S: repoName },
            user: { S: dev.email },
            device_id: { S: `demo-${seedRunId}` },
            in_main: { BOOL: inMain },
            was_reverted: { BOOL: wasReverted },
            timestamp: { S: timestamp },
            updated_at: { S: new Date().toISOString() },
            ttl: { N: String(commitTtl) },
            ai_origin: { S: isAi ? 'ai-generated' : 'human' },
            ai_tool: { S: isAi ? dev.tool : 'none' },
            ai_model: { S: isAi ? dev.model : '' },
            origin_source: { S: 'write-time-join' },
            // Sparse by-user GSI keys — the per-developer productivity query
            // reads gsi_user / gsi_user_sk rather than scanning.
            gsi_user: { S: `USER#${dev.email}` },
            gsi_user_sk: { S: `COMMIT#${timestamp}` },
            demo_seed: { BOOL: true },
            seed_run_id: { S: seedRunId },
          },
        },
      });

      if (!isAi) return;

      const inputTokens = randomInt(3000, 18000);
      const outputTokens = randomInt(800, 6000);
      const costUsd = Math.round((inputTokens / 1000 * 0.003 + outputTokens / 1000 * 0.015) * 10000) / 10000;

      spanRequests.push({
        PutRequest: {
          Item: {
            pk: { S: `USER#${dev.email}` },
            sk: { S: `SPAN#${timestamp}#${hex(8)}` },
            record_type: { S: 'OTEL_SPAN' },
            trace_id: { S: traceId },
            tool: { S: dev.tool },
            model: { S: dev.model },
            input_tokens: { N: String(inputTokens) },
            output_tokens: { N: String(outputTokens) },
            cost_usd: { N: String(costUsd) },
            project: { S: repoName },
            device_id: { S: `demo-${seedRunId}` },
            cost_estimated: { BOOL: false },
            timestamp: { S: timestamp },
            ttl: { N: String(spanTtl) },
            demo_seed: { BOOL: true },
            seed_run_id: { S: seedRunId },
          },
        },
      });

      const day = timestamp.slice(0, 10);
      const key = `${dev.email}|${day}|${dev.tool}|${dev.model}`;
      const roll = dayRollups.get(key) ?? {
        user: dev.email, day, tool: dev.tool, model: dev.model,
        inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0,
      };
      roll.inputTokens += inputTokens;
      roll.outputTokens += outputTokens;
      roll.costUsd = Math.round((roll.costUsd + costUsd) * 10000) / 10000;
      roll.calls += 1;
      dayRollups.set(key, roll);
    }

    for (let day = 7; day >= 0; day--) {
      const date = new Date();
      date.setDate(date.getDate() - day);
      const dateStr = formatDate(date);
      const maxH = day === 0 ? Math.max(0, new Date().getUTCHours() - 1) : 17;
      const minH = Math.min(8, maxH);
      const at = (h: number, m: number) => `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

      // ---- Merged PRs: the census half of Attribution Coverage ----
      const prs = randomInt(2, 4);
      for (let i = 0; i < prs; i++) {
        const prRepo = REPOS[randomInt(0, REPOS.length - 1)];
        const dev = DEVELOPERS[randomInt(0, DEVELOPERS.length - 1)];
        const tc = randomInt(2, 6);
        const shas = Array.from({ length: tc }, () => hex(20));
        const isFailureFix = randomInt(0, 7) === 0;
        const lt = 3600 * (day + 1) + randomInt(0, 3599);
        const ts = at(randomInt(minH, maxH), 30);
        const prNumber = 100 + day * 10 + i;

        // Shape mirrors bootstrapper/github-workflows/prism-ai-metrics.yml.
        // Three fields were previously missing or misplaced, each with a
        // visible consequence: pr.total_commits (coverage read "no CI commit
        // census"), pr.commit_shas (security findings had nothing to join for
        // origin), and dora.is_failure_fix (Revert Rate read 0% and Revert
        // Turnaround read "—"). dora.deployment_frequency is deliberately NOT
        // here: it lives only on the deploy event, and carrying it on both
        // double-counted DeploymentFrequency, inflating Merge Frequency 2x.
        addEvent('prism.d1.pr', {
          team_id: team, repo: prRepo, timestamp: ts, prism_level: 2,
          metric: { name: 'pr_merged', value: 1, unit: 'count' },
          dora: { lead_time_seconds: lt, is_failure_fix: isFailureFix },
          pr: {
            number: prNumber,
            author: dev.email.split('@')[0],
            reviews_approved: randomInt(1, 2),
            reviews_changes_requested: randomInt(0, 1),
            total_commits: tc,
            commit_shas: shas,
          },
        });

        addEvent('prism.d1.deploy', {
          team_id: team, repo: prRepo, timestamp: ts, prism_level: 2,
          metric: { name: 'deployment', value: 1, unit: 'count' },
          dora: { deployment_frequency: 1 },
        });

        // Commit events and attribution facts describe the SAME commits, so the
        // two stores agree. Emitting them independently is how the previous
        // version drifted.
        for (const sha of shas) {
          const cts = at(randomInt(minH, maxH), randomInt(0, 59));
          const isAi = dev.onboarded && Math.random() < dev.aiRate;
          const inMain = randomInt(0, 19) !== 0;          // ~95% merged
          const wasReverted = inMain && randomInt(0, 24) === 0; // ~4% of merged

          addEvent('prism.d1.commit', {
            team_id: team, repo: prRepo, timestamp: cts, prism_level: 2,
            metric: { name: 'commit', value: 1, unit: 'count' },
            ai_context: {
              tool: isAi ? dev.tool : 'n/a',
              model: isAi ? dev.model : 'n/a',
              origin: isAi ? 'ai-generated' : 'human',
            },
          });

          if (seedAttribution && dev.onboarded) {
            seedCommit(dev, prRepo, sha, cts, isAi, inMain, wasReverted);
          }
        }
      }

      // ---- Eval gate results ----
      for (let i = 0; i < prs; i++) {
        let score = 0.88;
        let res = 'PASS';
        if (day === 4 && randomInt(0, 1) === 0) { score = 0.62; res = 'FAIL'; }
        if (randomInt(0, 7) === 0) { score = 0.71; res = 'FAIL'; }

        addEvent('prism.d1.eval', {
          team_id: team, repo, timestamp: at(randomInt(minH, maxH), 45), prism_level: 2,
          metric: { name: 'eval_score', value: score, unit: 'score' },
          ai_context: { tool: 'bedrock-eval', model: HAIKU, origin: 'ai-generated' },
          ai_dora: { eval_gate_pass_rate: res === 'PASS' ? 1 : 0 },
          eval: { result: res, pr_number: 100 + day * 10 + i },
        });
      }

      const ts = at(9, 0);

      // Change failure rate and MTTR still have live CloudWatch metrics and an
      // alarm. The other assessment metrics this loop used to emit —
      // ai_acceptance_rate, ai_test_coverage_delta, spec_to_code_hours,
      // post_merge_defect_rate, PRISMLevel, BedrockCostUSD, TokenEfficiency —
      // have no consumer left: their metrics were deleted, their producing
      // Lambdas were removed, or the exec view now computes the value rather
      // than reading a published one.
      const cfr = parseFloat((randomInt(1, 8) / 100).toFixed(4));
      const mttrSeconds = randomInt(600, 4199);

      addEvent('prism.d1.assessment', {
        team_id: team, repo, timestamp: ts, prism_level: 2,
        metric: { name: 'change_failure_rate', value: cfr, unit: 'percent' },
        dora: { change_failure_rate: cfr },
      });

      addEvent('prism.d1.assessment', {
        team_id: team, repo, timestamp: ts, prism_level: 2,
        metric: { name: 'mttr', value: mttrSeconds, unit: 'seconds' },
        dora: { mttr_seconds: mttrSeconds },
      });

      // ---- Agent invocations ----
      const agentCount = randomInt(3, 10);
      for (let a = 0; a < agentCount; a++) {
        const steps = randomInt(2, 9);
        addEvent('prism.d1.agent', {
          team_id: team, repo, timestamp: at(randomInt(minH, maxH), randomInt(0, 59)), prism_level: 3,
          metric: { name: 'agent_invocation', value: 1, unit: 'count' },
          ai_context: { tool: 'strands-agent', model: HAIKU, origin: 'ai-generated' },
          agent: {
            agent_name: 'task-assistant', steps_taken: steps, tools_invoked: steps - 1,
            duration_ms: randomInt(1000, 5999), tokens_used: randomInt(2000, 9999),
            status: randomInt(0, 5) === 0 ? 'failure' : 'success', guardrails_triggered: 0,
          },
        });
      }

      // ---- Guardrail triggers ----
      const GUARDRAIL_CATEGORIES = ['CONTENT_FILTER', 'DENIED_TOPIC', 'SENSITIVE_INFO', 'WORD_FILTER'] as const;
      const GUARDRAIL_ACTIONS = ['BLOCK', 'ANONYMIZE', 'WARN'] as const;
      for (let g = 0; g < randomInt(1, 5); g++) {
        addEvent('prism.d1.guardrail', {
          team_id: team, repo, timestamp: at(randomInt(minH, maxH), randomInt(0, 59)), prism_level: 2,
          metric: { name: 'guardrail_trigger', value: 1, unit: 'count' },
          guardrail: {
            guardrail_id: 'gr-demo-001', guardrail_name: 'prism-safety',
            trigger_category: GUARDRAIL_CATEGORIES[randomInt(0, 3)], trigger_type: 'automated',
            action_taken: GUARDRAIL_ACTIONS[randomInt(0, 2)], agent_name: 'task-assistant',
            invocation_id: `inv-${day}-${g}`,
          },
        });
      }

      // ---- MCP tool calls ----
      const MCP_TOOLS = ['file_read', 'file_write', 'shell_exec', 'web_fetch', 'db_query'];
      for (let m = 0; m < randomInt(5, 15); m++) {
        const authorized = randomInt(0, 19) !== 0; // 5% denied
        addEvent('prism.d1.mcp.tool_call', {
          team_id: team, repo, timestamp: at(randomInt(minH, maxH), randomInt(0, 59)), prism_level: 2,
          metric: { name: 'mcp_tool_call', value: 1, unit: 'count' },
          mcp_tool_call: {
            session_id: `sess-${day}-${m}`, client_id: 'claude-code',
            tool_name: MCP_TOOLS[randomInt(0, 4)], scopes_used: ['read'], authorized,
            risk_level: authorized ? 'low' : 'high',
            duration_ms: randomInt(50, 2000),
            result_status: authorized ? 'success' : 'denied',
          },
        });
      }

      // ---- Quality: AI vs human defect rates ----
      addEvent('prism.d1.quality', {
        team_id: team, repo, timestamp: ts, prism_level: 2,
        metric: { name: 'quality_comparison', value: 1, unit: 'count' },
        quality: {
          deployment_id: `deploy-${day}`,
          ai_defect_rate: parseFloat((randomInt(1, 4) / 100).toFixed(4)),
          human_defect_rate: parseFloat((randomInt(2, 7) / 100).toFixed(4)),
          total_ai_commits: randomInt(5, 12), total_human_commits: randomInt(3, 8),
        },
      });

      // ---- Security findings ----
      const PHASES = ['design_review', 'code_review', 'pen_test'] as const;
      const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
      for (let f = 0; f < randomInt(1, 4); f++) {
        const fts = at(randomInt(minH, maxH), randomInt(0, 59));
        const severity = SEVERITIES[randomInt(0, 3)];
        const phase = PHASES[randomInt(0, 2)];
        addEvent('prism.d1.security.code_review', {
          team_id: team, repo, timestamp: fts, prism_level: 2,
          metric: { name: 'security_finding', value: 1, unit: 'count' },
          security_agent_finding: {
            finding_id: `finding-${day}-${f}`, phase, severity,
            cvss_score: severity === 'CRITICAL' ? 9.1 : severity === 'HIGH' ? 7.5 : severity === 'MEDIUM' ? 5.2 : 2.8,
            title: 'Demo finding', category: 'injection',
            cwe_id: 'CWE-79', exploit_validated: phase === 'pen_test',
            compliance_mappings: ['OWASP-A03'],
            ai_origin: randomInt(0, 1) === 0 ? 'ai-assisted' : 'human',
            spec_ref: null, found_at: fts, remediated_at: null,
          },
        });
      }

      // ---- Security remediation ----
      if (day > 0 && randomInt(0, 2) === 0) {
        addEvent('prism.d1.security.remediation', {
          team_id: team, repo, timestamp: at(randomInt(minH, maxH), randomInt(0, 59)), prism_level: 2,
          metric: { name: 'security_remediation', value: 1, unit: 'count' },
          security_remediation: {
            finding_id: `finding-${day + 1}-0`,
            severity: SEVERITIES[randomInt(0, 2)],
            remediation_time_hours: randomInt(2, 48),
            remediated_by_origin: randomInt(0, 1) === 0 ? 'ai-assisted' : 'human',
            finding_phase: 'code_review',
          },
        });
      }

      // ---- Exfiltration alert (rare) ----
      if (randomInt(0, 6) === 0) {
        const ets = at(randomInt(minH, maxH), randomInt(0, 59));
        addEvent('prism.d1.security', {
          team_id: team, repo, timestamp: ets, prism_level: 2,
          metric: { name: 'exfiltration_alert', value: 1, unit: 'count' },
          security: {
            alert_type: 'anomalous_read', table_name: 'prism-d1-events',
            principal_arn: 'arn:aws:iam::123456789012:role/demo-role',
            read_count: randomInt(500, 2000), window_start: ets, window_end: ets,
          },
        });
      }

      // ---- Per-rubric eval scores ----
      const RUBRICS = ['code-quality', 'api-response-quality', 'agent-quality', 'security-compliance', 'spec-compliance'];
      for (const rubric of RUBRICS) {
        const rScore = parseFloat((randomInt(65, 98) / 100).toFixed(2));
        addEvent('prism.d1.eval', {
          team_id: team, repo, timestamp: at(randomInt(minH, maxH), 50), prism_level: 2,
          metric: { name: 'eval_score', value: rScore, unit: 'score' },
          ai_context: { tool: 'bedrock-eval', model: HAIKU, origin: 'ai-generated' },
          ai_dora: { eval_gate_pass_rate: rScore >= 0.7 ? 1 : 0 },
          eval: { result: rScore >= 0.7 ? 'PASS' : 'FAIL', rubric, score: rScore, pr_number: 100 + day * 10 },
        });
      }
    }

    flush();
    console.log('');

    // ---- Attribution store ----
    let attrWritten = 0;
    if (seedAttribution) {
      for (const roll of dayRollups.values()) {
        spanRequests.push({
          PutRequest: {
            Item: {
              pk: { S: `USER#${roll.user}` },
              // '#' is the key delimiter, so it must not appear in the model.
              sk: { S: `OTEL#DAY#${roll.day}#${roll.tool}#${roll.model.replace(/#/g, '')}` },
              record_type: { S: 'OTEL_DAY' },
              tool: { S: roll.tool },
              model: { S: roll.model.replace(/#/g, '') },
              day: { S: roll.day },
              input_tokens: { N: String(roll.inputTokens) },
              output_tokens: { N: String(roll.outputTokens) },
              cost_usd: { N: String(roll.costUsd) },
              call_count: { N: String(roll.calls) },
              updated_at: { S: new Date().toISOString() },
              demo_seed: { BOOL: true },
              seed_run_id: { S: seedRunId },
            },
          },
        });
      }

      const totalItems = spanRequests.length + commitRequests.length;
      if (totalItems > 0) {
        console.log(`Seeding ${totalItems} attribution items into ${table}...`);
        // Spans and rollups first — see the note on the accumulators above.
        const spans = ddbBatchWrite(region, table, spanRequests);
        attrWritten += spans.written;
        let failure = spans.error;
        if (!failure) {
          const commits = ddbBatchWrite(region, table, commitRequests);
          attrWritten += commits.written;
          failure = commits.error;
        }
        console.log('');
        if (failure) {
          console.error(`Error: attribution seeding stopped after ${attrWritten} of ${totalItems} items.`);
          console.error(failure);
          console.error('');
          console.error('Events were emitted successfully, so the event-driven widgets will populate.');
          console.error(`Clean up the partial seed with: prism-cli workshop generate-demo-data --purge-demo --region ${region}`);
          process.exit(1);
        }
      }
    }

    console.log(`=== Done! ${total} events emitted, ${attrWritten} attribution items seeded ===`);
    if (seedAttribution) {
      const onboarded = DEVELOPERS.filter(d => d.onboarded).length;
      console.log(`Fleet: ${onboarded} of ${DEVELOPERS.length} developers onboarded — Attribution Coverage`);
      console.log('will read below 100% by design, which is what the KPI is for.');
      console.log(`Seed run ${seedRunId} · remove with: prism-cli workshop generate-demo-data --purge-demo`);
    }
    console.log('');
    console.log(`Open CloudWatch → Dashboards → PRISM-D1-Team-Velocity (${region})`);
    console.log("Set the time range to 'Last 1 week'.");
  },
};
