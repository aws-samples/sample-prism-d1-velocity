#!/usr/bin/env npx tsx
/**
 * Tool-usage wire-contract guard.
 *
 * codeburn sends the tools a model invoked as `ai.tools`, an OTLP arrayValue of
 * stringValues (codeburn src/sync/otlp.ts). The receiver ignored it until the
 * OTEL#TOOLDAY rollup was added. These cases pin the parse, the MCP split and
 * the report fold so a change on either side fails here instead of rendering
 * an empty tool panel.
 *
 * Run: npx tsx scripts/check-tool-usage.ts
 */
import { parseOtlpSpans, parseToolNames, mcpServerOf, aggregateToolUsage } from '../lib/lambda/otel-receiver.js';

const NANOS = String(BigInt(Date.parse('2026-10-16T12:00:00.000Z')) * 1_000_000n);

type Attr = { key: string; value: Record<string, unknown> };
const s = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const tools = (...names: unknown[]): Attr => ({
  key: 'ai.tools',
  value: { arrayValue: { values: names.map(n => ({ stringValue: n })) } },
});

function usagePayload(attrs: Attr[]) {
  return {
    resourceSpans: [{
      resource: { attributes: [s('codeburn.device_id', '87c5988219a81930')] },
      scopeSpans: [{
        spans: [{
          name: 'codeburn.usage',
          spanId: 'a1b2c3d4e5f60718',
          traceId: 'd04625d0b0f640b97eafbe2ec9a32a33',
          startTimeUnixNano: NANOS,
          endTimeUnixNano: NANOS,
          attributes: [
            s('ai.provider', 'claude'),
            s('ai.model', 'claude-sonnet-4-5'),
            { key: 'ai.input_tokens', value: { intValue: '10' } },
            { key: 'ai.output_tokens', value: { intValue: '5' } },
            { key: 'ai.cost_usd', value: { doubleValue: 0.01 } },
            ...attrs,
          ],
        }],
      }],
    }],
  };
}

let failures = 0;
function check(name: string, condition: boolean, detail: string): void {
  if (condition) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name}\n      ${detail}`); failures++; }
}

console.log('\nTool-usage wire-contract guard\n');

// --- Parse: codeburn's shape reaches ParsedSpan.toolNames ---
{
  const r = parseOtlpSpans(usagePayload([tools('Edit', 'Bash', 'mcp__awsknowledge__search')]));
  const got = r.spans[0]?.toolNames ?? [];
  check('ai.tools arrayValue parsed onto the usage span',
    r.spans.length === 1 && got.join(',') === 'Edit,Bash,mcp__awsknowledge__search',
    `got spans=${r.spans.length} toolNames=${JSON.stringify(got)}`);
}

// --- Absent attribute: old codeburn / providers without tool data ---
{
  const r = parseOtlpSpans(usagePayload([]));
  check('missing ai.tools yields [] and the span is still accepted',
    r.spans.length === 1 && r.spans[0]!.toolNames.length === 0,
    `got ${JSON.stringify(r.spans[0]?.toolNames)} rejected=${r.rejected}`);
}

// --- Claude Code repeats a name per tool_use block; counts are per call ---
{
  const got = parseToolNames({ arrayValue: { values: [{ stringValue: 'Bash' }, { stringValue: 'Bash' }, { stringValue: 'Read' }] } });
  check('duplicate names collapse to one per call', got.join(',') === 'Bash,Read', `got ${JSON.stringify(got)}`);
}

// --- Untrusted input: key delimiter, control chars, oversize, non-strings ---
{
  const got = parseToolNames({ arrayValue: { values: [
    { stringValue: 'a#b' }, { stringValue: 'x\u0000y' }, { stringValue: 'z'.repeat(129) },
    { intValue: 3 }, { stringValue: '   ' },
  ] } });
  check('# and control chars stripped, oversize/non-string/blank dropped',
    got.join(',') === 'ab,xy', `got ${JSON.stringify(got)}`);
  const many = parseToolNames({ arrayValue: { values: Array.from({ length: 100 }, (_, i) => ({ stringValue: `t${i}` })) } });
  check('capped at 64 names', many.length === 64, `got ${many.length}`);
  check('scalar value instead of array yields []', parseToolNames({ stringValue: 'Bash' }).length === 0, 'expected []');
}

// --- MCP split ---
check('mcp__server__tool -> server', mcpServerOf('mcp__awsknowledge__search') === 'awsknowledge', mcpServerOf('mcp__awsknowledge__search'));
check('server name with underscores keeps the first __ split',
  mcpServerOf('mcp__builder_mcp__InternalSearch') === 'builder_mcp', mcpServerOf('mcp__builder_mcp__InternalSearch'));
check('non-MCP tool -> empty server', mcpServerOf('Bash') === '' && mcpServerOf('mcp__only') === '', 'expected ""');

// --- Report fold ---
{
  const item = (day: string, tool: string, name: string, calls: number, server = '') => ({
    day: { S: day }, tool: { S: tool }, tool_name: { S: name }, call_count: { N: String(calls) }, mcp_server: { S: server },
  });
  const r = aggregateToolUsage([
    item('2026-10-15', 'claude-code', 'Bash', 4),
    item('2026-10-16', 'kiro', 'Bash', 2),
    item('2026-10-16', 'claude-code', 'mcp__awsknowledge__search', 3, 'awsknowledge'),
    item('2026-10-16', 'claude-code', 'mcp__awsknowledge__read', 1, 'awsknowledge'),
    { day: { S: '2026-10-16' }, tool_name: { S: 'Bad' }, call_count: { N: 'NaN' } },
  ], '2026-10-01', '2026-10-16', 'all');
  check('totals sum per-tool counts', r.totalToolCalls === 10, `got ${r.totalToolCalls}`);
  check('tools sorted by calls, AI tools split',
    r.tools[0]?.name === 'Bash' && r.tools[0]?.calls === 6 && r.tools[0]?.byAiTool['kiro'] === 2,
    JSON.stringify(r.tools[0]));
  check('MCP server rollup counts calls and distinct tools',
    r.mcpServers.length === 1 && r.mcpServers[0]!.calls === 4 && r.mcpServers[0]!.tools === 2,
    JSON.stringify(r.mcpServers));
  check('days ascending with per-day sums',
    JSON.stringify(r.days) === JSON.stringify([{ date: '2026-10-15', calls: 4 }, { date: '2026-10-16', calls: 6 }]),
    JSON.stringify(r.days));
}

console.log(failures === 0 ? '\nAll tool-usage checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
