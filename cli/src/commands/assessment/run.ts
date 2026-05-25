import { runScan } from '../../scanner/index.js';
import type { OutputFormat } from '../../scanner/types.js';

export default {
  description: 'Run the PRISM D1 Velocity scanner against a repository',
  options: [
    { flags: '-r, --repo <path>', description: 'Path to the git repository to scan', default: '.' },
    { flags: '-o, --output <format>', description: 'Output format: console, json, markdown', default: 'console' },
    { flags: '-f, --output-file <path>', description: 'Write report to file' },
    { flags: '-v, --verbose', description: 'Verbose output with timing' },
  ],
  async action(options: { repo: string; output: string; outputFile?: string; verbose?: boolean }) {
    const format = options.output as OutputFormat;
    if (!['console', 'json', 'markdown'].includes(format)) {
      console.error(`Invalid output format: ${format}. Use console, json, or markdown.`);
      process.exit(1);
    }
    await runScan(options.repo, {
      output: format,
      outputFile: options.outputFile,
      verbose: !!options.verbose,
    });
  },
};
