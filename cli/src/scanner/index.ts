export { scanners } from './categories.js';
export { buildScanResult } from './scoring.js';
export { formatReport } from './reporter.js';
export type { ScanResult, ScanConfig, CategoryScore, Evidence, OutputFormat, PRISMLevelInfo } from './types.js';

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanners } from './categories.js';
import { buildScanResult } from './scoring.js';
import { formatReport } from './reporter.js';
import type { ScanConfig, CategoryScore, OutputFormat, ScanResult } from './types.js';

/**
 * Run the full PRISM scanner against a repository.
 * Returns the structured ScanResult.
 */
export async function runScan(
  repoPath: string,
  options: { output?: OutputFormat; outputFile?: string; verbose?: boolean; commitDepth?: number } = {},
): Promise<ScanResult> {
  const resolvedPath = resolve(repoPath);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
    throw new Error(`Repository path does not exist or is not a directory: ${resolvedPath}`);
  }

  const config: ScanConfig = {
    repoPath: resolvedPath,
    verbose: options.verbose ?? false,
    commitDepth: options.commitDepth ?? 200,
  };

  const format = options.output ?? 'console';
  const categories: CategoryScore[] = [];

  if (format === 'console') {
    console.log(`\n  PRISM D1 Velocity Scanner`);
    console.log(`  Scanning: ${resolvedPath}\n`);
  }

  for (const scanner of scanners) {
    const start = Date.now();
    try {
      if (config.verbose && format === 'console') process.stdout.write(`  Scanning ${scanner.name}...`);
      const cat = await scanner.scan(resolvedPath, config);
      categories.push(cat);
      if (config.verbose && format === 'console') console.log(` ${cat.earnedPoints}/${cat.maxPoints} (${Date.now() - start}ms)`);
    } catch (err) {
      if (config.verbose && format === 'console') console.log(` ERROR: ${(err as Error).message}`);
      categories.push({ category: scanner.name, maxPoints: 0, earnedPoints: 0, evidence: [{ signal: 'Scanner error', found: false, points: 0, detail: `${(err as Error).message}` }] });
    }
  }

  const scanResult = buildScanResult(resolvedPath, categories);
  const report = formatReport(scanResult, format);

  if (options.outputFile) {
    writeFileSync(resolve(options.outputFile), report, 'utf-8');
    if (format === 'console') {
      console.log(report);
      console.log(`\n  Report written to: ${resolve(options.outputFile)}`);
    }
  } else {
    console.log(report);
  }

  return scanResult;
}
