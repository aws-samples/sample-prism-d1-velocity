import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from '../../utils/exec.js';
import { readResultEntries } from '../../codewatch/results.js';
import { readLog } from '../../dashboard/commits.js';
import {
  buildReport, findResultById, renderReportHtml, renderReportJson, renderReportMarkdown, reviewEntries, reviewForCommit,
} from '../../dashboard/report.js';

const FORMATS = ['md', 'html', 'json'] as const;

/** Writes a scan report without the dashboard server. Same content as GET /report/<id>. */
export default {
  description: 'Write a codewatch scan report (one pre-push review and its secret scans) as Markdown, HTML or JSON',
  options: [
    { flags: '--repo <path>', description: 'Repository (default: the current one)' },
    { flags: '--id <result-id>', description: 'Result id (file name in .prism/results/ without .json)' },
    { flags: '--commit <sha>', description: 'Report on the newest review whose pushed range includes this commit' },
    { flags: '--format <fmt>', description: `Output format: ${FORMATS.join(' | ')}`, default: 'md' },
    { flags: '--output <file>', description: 'Write to a file instead of stdout' },
  ],
  action(opts: { repo?: string; id?: string; commit?: string; format?: string; output?: string }) {
    const fail = (msg: string): never => { console.error(`Error: ${msg}`); process.exit(1); };
    const format = (opts.format || 'md') as typeof FORMATS[number];
    if (!FORMATS.includes(format)) fail(`--format must be one of: ${FORMATS.join(', ')}`);
    if (opts.id && opts.commit) fail('pass --id or --commit, not both');

    const top = run('git', ['-C', resolve(opts.repo || '.'), 'rev-parse', '--show-toplevel']);
    if (!top.ok) fail(`not a git repository: ${resolve(opts.repo || '.')}`);
    const repo = top.stdout;
    const entries = readResultEntries(repo);
    const log = readLog(repo);

    let entry;
    if (opts.id) {
      entry = findResultById(repo, opts.id, entries);
      if (!entry) fail(`no result "${opts.id}" in ${repo}/.prism/results/`);
    } else if (opts.commit) {
      entry = reviewForCommit(entries, opts.commit, log);
      if (!entry) fail(`no recorded pre-push review covers commit ${opts.commit}`);
    } else {
      entry = reviewEntries(entries)[0];
      if (!entry) fail(`no pre-push reviews recorded in ${repo}/.prism/results/ yet`);
    }
    let report;
    try {
      report = buildReport(repo, entry!, entries, { log });
    } catch (e: any) {
      return fail(`${opts.id} is not a pre-push review (${e.message})`);
    }
    const out = format === 'json' ? renderReportJson(report) : format === 'html' ? renderReportHtml(report) : renderReportMarkdown(report);
    if (opts.output) {
      writeFileSync(opts.output, out);
      console.error(`Wrote ${format} report ${report.id} to ${opts.output}`);
    } else {
      process.stdout.write(out);
    }
  },
};
