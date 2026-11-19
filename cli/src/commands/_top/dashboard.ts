import { homedir } from 'node:os';
import { buildPayload } from '../../dashboard/payload.js';
import { startServer, BIND_HOST } from '../../dashboard/server.js';
import { buildDashboardApi } from '../../dashboard/api-core.js';
import { serveStdio } from '../../dashboard/stdio.js';
import type { PayloadTiming } from '../../dashboard/payload.js';
import { collectHistory, collectUsage } from '../../dashboard/usage.js';
import { UsageCache, usageCachePath } from '../../dashboard/usage-cache.js';
import { binaryStampOnPath } from '../../utils/tool-check.js';
import { buildSnapshotHtml, canOpen, openBrowser, writeSnapshot } from '../../dashboard/snapshot.js';
import { ownVersion } from './version.js';
import { UpdateCheck, updateCachePath } from '../../dashboard/update-check.js';
import { resolve } from 'node:path';

export function parsePort(v: string | undefined): number {
  if (v === undefined) return 0;
  if (!/^\d+$/.test(v)) throw new Error(`--port must be a number, got "${v}"`);
  const n = Number(v);
  if (n !== 0 && (n < 1024 || n > 65535)) throw new Error('--port must be 0 or between 1024 and 65535');
  return n;
}

export function formatTiming(t: PayloadTiming): string {
  return `prism dashboard timing: scan ${t.scan} ms, setup ${t.setup} ms, usage ${t.usage} ms (${t.cacheHit ? 'cache hit' : 'codeburn export'}), total ${t.total} ms`;
}

export default {
  description: 'Local web dashboard (127.0.0.1 only): codewatch results, codeburn usage, and a Settings page that runs local setup steps. Read-only in AWS.',
  options: [
    { flags: '--json', description: 'Print the dashboard data as JSON and exit (no server)' },
    { flags: '--root <dir>', description: 'Where to look for git repos, 3 levels deep (default: your home directory)' },
    { flags: '--all', description: '[deprecated, no effect] every repo under --root is now shown by default' },
    { flags: '--port <n>', description: 'Port on 127.0.0.1 (default: a random free port)' },
    { flags: '--no-open', description: 'Do not open a browser' },
    { flags: '--snapshot <file>', description: 'Write the dashboard as one static HTML file (data embedded, no server, no token, mode 0600) and exit' },
    { flags: '--serve-stdio', description: 'No server: answer the dashboard API as JSON lines on stdin/stdout (for the VS Code extension and the Kiro Crew app)' },
    { flags: '--exit-on-stdin-close', description: 'Stop the server when stdin closes (prism-cli mcp uses this so the dashboard ends with the session)' },
    { flags: '--open', description: 'With --snapshot: open the file in a browser when a display is available' },
    { flags: '--fresh', description: 'With --json: run the codeburn exports now instead of using the usage cache (~/.prism/cache, 5 minutes)' },
    { flags: '--timing', description: 'With --json: print how long each stage took to stderr' },
  ],
  async action(opts: { json?: boolean; all?: boolean; root?: string; port?: string; open?: boolean; fresh?: boolean; timing?: boolean; snapshot?: string; exitOnStdinClose?: boolean; serveStdio?: boolean }) {
    // stderr, so --json output stays parseable.
    if (opts.all) console.error('prism: --all is deprecated and has no effect; the dashboard now scans your home directory (or --root) by default.');
    // The month paints first; the earlier weeks of the heatmap (one more export: about 30 s on codeburn's first run, about 9 s after) follow in the background.
    // A cached panel is used only with the codeburn binary that produced it: an install or upgrade runs new exports.
    const usageCache = new UsageCache({ file: usageCachePath(homedir()), collect: (prior) => collectUsage({ prior, history: 'defer' }), collectHistory: () => collectHistory(), binary: () => binaryStampOnPath('codeburn') });
    /** One-shot outputs wait for the earlier weeks, so a file never says "loading" forever. */
    const settledUsage = async () => {
      const r = await usageCache.get({ fresh: opts.fresh });
      const u = r.usage.history?.status === 'pending' ? (await usageCache.settled()) ?? r.usage : r.usage;
      return { usage: u, cacheHit: r.cacheHit, refresh: r.refresh };
    };
    // At most one npm registry request a day (3 s timeout, silent offline); PRISM_NO_UPDATE_CHECK=1 turns it off.
    const updates = new UpdateCheck({ installed: ownVersion(), file: updateCachePath(homedir()) });

    if (opts.snapshot !== undefined) {
      if (opts.json) { console.error('Error: --snapshot and --json are separate outputs; pick one.'); process.exit(1); }
      let refresh: Promise<unknown> | null = null;
      const file = resolve(opts.snapshot);
      let bytes: number;
      try {
        const html = await buildSnapshotHtml({
          cwd: process.cwd(), home: homedir(), root: opts.root, version: ownVersion(),
          usage: async () => { const r = await settledUsage(); refresh = r.refresh; return r; },
          versionInfo: () => updates.get(),
        });
        bytes = writeSnapshot(file, html);
      } catch (e: any) {
        console.error(`Error: could not write the snapshot to ${file}: ${e?.message || e}`);
        process.exit(1);
      }
      process.stdout.write(file + '\n');
      console.error(`prism dashboard: snapshot written (${Math.round(bytes / 1024)} KB, mode 0600). It shows local paths; share it with care.`);
      // --open shares opts.open with --no-open, whose default is true, so ask argv whether it was given.
      if (process.argv.includes('--open')) {
        if (canOpen(process.env, process.platform)) openBrowser(file);
        else console.error('prism dashboard: no display here (SSH session?), so it was not opened. Copy the file to your machine and open it there.');
      }
      if (refresh) await refresh;
      await usageCache.historyRun();
      return;
    }
    if (opts.json) {
      let refresh: Promise<unknown> | null = null;
      const payload = await buildPayload({
        cwd: process.cwd(), root: opts.root,
        usage: async () => { const r = await settledUsage(); refresh = r.refresh; return r; },
        version: () => updates.get(),
      });
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      if (opts.timing) console.error(formatTiming(payload.timing));
      // A stale cache was printed; finish its background refresh so the next run gets new data.
      if (refresh) await refresh;
      await usageCache.historyRun();
      return;
    }
    if (opts.serveStdio) {
      // No listener: the same route table over stdin/stdout, for a host process that owns this child (stdio.ts).
      // stdout carries the protocol only: anything a library logs goes to stderr instead.
      console.log = console.info = (...a: unknown[]) => console.error(...a);
      const api = buildDashboardApi({ cwd: process.cwd(), root: opts.root, usageCache, updates });
      // The host went away (stdin closed, or a signal): stop a running action so nothing outlives this process.
      const quit = (code: number) => { api.shutdown(); process.exit(code); };
      process.on('SIGTERM', () => quit(0));
      process.on('SIGINT', () => quit(0));
      process.on('SIGHUP', () => quit(0));
      await serveStdio(api, process.stdin, process.stdout, { version: ownVersion() });
      quit(0);
    }

    let port: number;
    try { port = parsePort(opts.port); } catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }

    let srv;
    try {
      const api = buildDashboardApi({ cwd: process.cwd(), root: opts.root, usageCache, updates });
      srv = await startServer({ port, getPayload: api.getPayload, getReport: api.getReport, getApi: api.getApi, postApi: api.postApi });
    } catch (e: any) {
      console.error(`Error: could not start the dashboard on ${BIND_HOST}${port ? `:${port}` : ''}: ${e.message}`);
      process.exit(1);
    }
    console.log(`PRISM dashboard (local only, ${BIND_HOST}:${srv.port})`);
    console.log(`  ${srv.url}`);
    console.log('  The token in this URL is the only key to the page; do not share it. Ctrl-C to stop.');
    if (opts.open !== false) openBrowser(srv.url);

    const stop = () => { srv!.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (opts.exitOnStdinClose) {
      process.stdin.on('end', stop);
      process.stdin.on('close', stop);
      process.stdin.resume();
    }
  },
};
