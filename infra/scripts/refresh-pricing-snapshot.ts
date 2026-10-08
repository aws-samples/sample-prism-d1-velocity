#!/usr/bin/env npx tsx
/**
 * Regenerate the bundled LiteLLM price snapshot.
 *
 * The deployed refresh Lambda keeps each account's table current in S3; this
 * snapshot is only what a fresh deploy prices with before the first refresh
 * runs (or if S3 is unreachable). Refreshing it occasionally keeps that window
 * accurate; it never needs to be current.
 *
 * Run: npx tsx scripts/refresh-pricing-snapshot.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import {
  LITELLM_PRICES_URL, slimLiteLLM, validateTable, toDocument, parseDocument,
} from '../lib/lambda/pricing/price-table.js';

const SNAPSHOT = path.join(__dirname, '..', 'lib', 'lambda', 'pricing', 'litellm-snapshot.json');

async function main(): Promise<void> {
  const res = await fetch(LITELLM_PRICES_URL);
  if (!res.ok) throw new Error(`fetch ${LITELLM_PRICES_URL}: HTTP ${res.status}`);
  const next = slimLiteLLM(await res.json());

  const prev = existsSync(SNAPSHOT) ? parseDocument(JSON.parse(readFileSync(SNAPSHOT, 'utf-8'))) : null;
  const v = validateTable(next, prev?.entries);
  if (!v.ok) {
    console.error(`refused: ${v.reasons.join('; ')}`);
    process.exit(1);
  }
  // One entry per line keeps the git diff of a refresh readable.
  const doc = toDocument(next, new Date().toISOString());
  const lines = Object.entries(doc.entries).map(([k, e]) => `    ${JSON.stringify(k)}: ${JSON.stringify(e)}`);
  const body =
    `{\n  "version": 1,\n  "source": ${JSON.stringify(doc.source)},\n  "fetchedAt": ${JSON.stringify(doc.fetchedAt)},\n` +
    `  "entryCount": ${doc.entryCount},\n  "entries": {\n${lines.join(',\n')}\n  }\n}\n`;
  writeFileSync(SNAPSHOT, body);
  console.log(
    `wrote ${doc.entryCount} entries to ${path.relative(process.cwd(), SNAPSHOT)}` +
    (prev ? ` (was ${prev.entryCount}; ${v.jumps.length} rate jumps >10x)` : ''),
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
