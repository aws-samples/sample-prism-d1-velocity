import { homedir } from 'node:os';
import { buildPayload } from '../../dashboard/payload.js';
import { cachedPayload, startServer, BIND_HOST } from '../../dashboard/server.js';
import { reportFromRepos } from '../../dashboard/report.js';
import { ActionRunner, cliEntry, repoId } from '../../dashboard/actions.js';
import { setupApi } from '../../dashboard/setup-api.js';
import { repoRootOf } from '../../aws/connection.js';
import { systemdUserAvailable } from '../../utils/otel-sync-schedule.js';
import type { DashboardPayload, PayloadTiming } from '../../dashboard/payload.js';
import { collectUsage, emptyUsage } from '../../dashboard/usage.js';
import { UsageCache, usageCachePath } from '../../dashboard/usage-cache.js';
import { buildSnapshotHtml, canOpen, openBrowser, writeSnapshot } from '../../dashboard/snapshot.js';
import { ownVersion } from './version.js';
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
  description: 'Local web dashboard (127.0.0.1 only): codewatch results, codeburn usage, and a Setup page that runs local setup steps. Read-only in AWS.',
  options: [
    { flags: '--json', description: 'Print the dashboard data as JSON and exit (no server)' },
    { flags: '--root <dir>', description: 'Where to look for git repos, 3 levels deep (default: your home directory)' },
    { flags: '--all', description: '[deprecated, no effect] every repo under --root is now shown by default' },
    { flags: '--port <n>', description: 'Port on 127.0.0.1 (default: a random free port)' },
    { flags: '--no-open', description: 'Do not open a browser' },
    { flags: '--snapshot <file>', description: 'Write the dashboard as one static HTML file (data embedded, no server, no token, mode 0600) and exit' },
    { flags: '--open', description: 'With --snapshot: open the file in a browser when a display is available' },
    { flags: '--fresh', description: 'With --json: run the codeburn exports now instead of using the usage cache (~/.prism/cache, 5 minutes)' },
    { flags: '--timing', description: 'With --json: print how long each stage took to stderr' },
  ],
  async action(opts: { json?: boolean; all?: boolean; root?: string; port?: string; open?: boolean; fresh?: boolean; timing?: boolean; snapshot?: string }) {
    // stderr, so --json output stays parseable.
    if (opts.all) console.error('prism: --all is deprecated and has no effect; the dashboard now scans your home directory (or --root) by default.');
    const usageCache = new UsageCache({ file: usageCachePath(homedir()), collect: () => collectUsage() });

    if (opts.snapshot !== undefined) {
      if (opts.json) { console.error('Error: --snapshot and --json are separate outputs; pick one.'); process.exit(1); }
      let refresh: Promise<unknown> | null = null;
      const file = resolve(opts.snapshot);
      let bytes: number;
      try {
        const html = await buildSnapshotHtml({
          cwd: process.cwd(), home: homedir(), root: opts.root, version: ownVersion(),
          usage: async () => { const r = await usageCache.get({ fresh: opts.fresh }); refresh = r.refresh; return r; },
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
      return;
    }
    if (opts.json) {
      let refresh: Promise<unknown> | null = null;
      const payload = await buildPayload({
        cwd: process.cwd(), root: opts.root,
        usage: async () => { const r = await usageCache.get({ fresh: opts.fresh }); refresh = r.refresh; return r; },
      });
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      if (opts.timing) console.error(formatTiming(payload.timing));
      // A stale cache was printed; finish its background refresh so the next run gets new data.
      if (refresh) await refresh;
      return;
    }
    // The page's first paint never waits for codeburn: it shows the cached usage, or "loading" until /api/usage answers.
    const build = () => buildPayload({
      cwd: process.cwd(), root: opts.root,
      usage: async () => {
        const u = usageCache.current();
        return u ? { usage: u, cacheHit: true } : { usage: emptyUsage('loading', 'Loading usage from codeburn...'), cacheHit: false };
      },
    });

    let port: number;
    try { port = parsePort(opts.port); } catch (e: any) { console.error(`Error: ${e.message}`); process.exit(1); }

    let srv;
    try {
      const payload = cachedPayload(build);
      const repos = async () => ((await payload()) as DashboardPayload).repos;
      // Reports are looked up only in the repos the dashboard itself discovered.
      const getReport = async (id: string) => reportFromRepos((await repos()).map((r) => r.path), id);
      let systemd: boolean | undefined;
      const runner = new ActionRunner({
        execPath: process.execPath, entry: cliEntry(), cwd: process.cwd(), home: homedir(), platform: process.platform,
        repos: async () => (await repos()).map((r) => ({ id: repoId(r.path), name: r.name, path: r.path })),
        systemdAvailable: () => (systemd ??= systemdUserAvailable()),
        onDone: () => payload.invalidate(),
      });
      const api = setupApi({
        runner, cwd: process.cwd(),
        repoPaths: async () => (await repos()).map((r) => r.path),
        identity: { env: process.env, home: homedir(), repoRoot: repoRootOf(process.cwd()) },
        refresh: () => { payload.invalidate(); return payload(); },
      });
      // fresh=1 (the Refresh button) waits for new exports; otherwise the cache, refreshed in the background when stale.
      const getUsage = async (url: URL) => {
        const r = await usageCache.get({ fresh: url.searchParams.get('fresh') === '1' });
        if (!r.cacheHit) payload.invalidate();
        r.refresh?.then(() => payload.invalidate(), () => {});
        return { usage: r.usage, cacheHit: r.cacheHit };
      };
      srv = await startServer({ port, getPayload: payload, getReport, getApi: { ...api.getApi, '/api/usage': getUsage }, postApi: api.postApi });
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
  },
};
