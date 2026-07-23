import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { platform, homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function run(cmd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return { ok: true, stdout, stderr: '' };
  } catch (err: any) {
    return { ok: false, stdout: '', stderr: (err.stderr || err.message || '').trim() };
  }
}

// ---- Constants ----

const CRON_MARKER = '# prism-otel-sync';
const PLIST_LABEL = 'com.prism.otel-sync';
const SCHTASK_NAME = 'PrismOtelSync';
const LOG_DIR = join(homedir(), '.prism', 'logs');

// ---- Scheduler helpers per OS ----

function getCodeburnPath(): string | null {
  const which = platform() === 'win32' ? 'where codeburn' : 'which codeburn';
  const result = run(which);
  return result.ok ? result.stdout.split('\n')[0] : null;
}

function buildSyncCommand(codeburnPath: string, since: string): string {
  return `${codeburnPath} sync push --since ${since}`;
}

// ---- Linux: user crontab ----

function linuxScheduleExists(): boolean {
  const result = run('crontab -l');
  return result.ok && result.stdout.includes(CRON_MARKER);
}

function linuxInstallSchedule(codeburnPath: string, intervalHours: number): void {
  const existing = run('crontab -l');
  const lines = existing.ok ? existing.stdout.split('\n').filter(l => !l.includes(CRON_MARKER)) : [];
  const logFile = join(LOG_DIR, 'otel-sync.log');
  const cronExpr = `0 */${intervalHours} * * *`;
  lines.push(`${CRON_MARKER}`);
  lines.push(`${cronExpr} ${buildSyncCommand(codeburnPath, '7d')} >> ${logFile} 2>&1`);
  const tmpFile = '/tmp/prism-crontab.tmp';
  writeFileSync(tmpFile, lines.join('\n') + '\n');
  const result = run(`crontab ${tmpFile}`);
  if (!result.ok) throw new Error(`Failed to install crontab: ${result.stderr}`);
}

function linuxRemoveSchedule(): void {
  const existing = run('crontab -l');
  if (!existing.ok) return;
  const lines = existing.stdout.split('\n').filter(l => !l.includes(CRON_MARKER) && !l.includes('codeburn sync push'));
  const tmpFile = '/tmp/prism-crontab.tmp';
  writeFileSync(tmpFile, lines.join('\n') + '\n');
  run(`crontab ${tmpFile}`);
}

// ---- macOS: LaunchAgent ----

function darwinPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

function darwinScheduleExists(): boolean {
  return existsSync(darwinPlistPath());
}

function darwinInstallSchedule(codeburnPath: string, intervalHours: number): void {
  const logFile = join(LOG_DIR, 'otel-sync.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${codeburnPath}</string>
    <string>sync</string>
    <string>push</string>
    <string>--since</string>
    <string>7d</string>
  </array>
  <key>StartInterval</key>
  <integer>${intervalHours * 3600}</integer>
  <key>StandardOutPath</key>
  <string>${logFile}</string>
  <key>StandardErrorPath</key>
  <string>${logFile}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
  const plistPath = darwinPlistPath();
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath, plist);
  run(`launchctl unload ${plistPath} 2>/dev/null`);
  const result = run(`launchctl load ${plistPath}`);
  if (!result.ok) throw new Error(`Failed to load LaunchAgent: ${result.stderr}`);
}

function darwinRemoveSchedule(): void {
  const plistPath = darwinPlistPath();
  if (existsSync(plistPath)) {
    run(`launchctl unload ${plistPath}`);
    run(`rm ${plistPath}`);
  }
}

// ---- Windows: schtasks ----

function windowsScheduleExists(): boolean {
  const result = run(`schtasks /query /tn ${SCHTASK_NAME} /fo CSV`);
  return result.ok;
}

function windowsInstallSchedule(codeburnPath: string, intervalHours: number): void {
  const logFile = join(LOG_DIR, 'otel-sync.log');
  const cmd = `${codeburnPath} sync push --since 7d >> "${logFile}" 2>&1`;
  const result = run(
    `schtasks /create /tn ${SCHTASK_NAME} /sc hourly /mo ${intervalHours} ` +
    `/tr "cmd /c ${cmd.replace(/"/g, '\\"')}" /f`
  );
  if (!result.ok) throw new Error(`Failed to create scheduled task: ${result.stderr}`);
}

function windowsRemoveSchedule(): void {
  run(`schtasks /delete /tn ${SCHTASK_NAME} /f`);
}

// ---- Unified scheduler interface ----

function scheduleExists(): boolean {
  switch (platform()) {
    case 'darwin': return darwinScheduleExists();
    case 'win32': return windowsScheduleExists();
    default: return linuxScheduleExists();
  }
}

function installSchedule(codeburnPath: string, intervalHours: number): void {
  mkdirSync(LOG_DIR, { recursive: true });
  switch (platform()) {
    case 'darwin': return darwinInstallSchedule(codeburnPath, intervalHours);
    case 'win32': return windowsInstallSchedule(codeburnPath, intervalHours);
    default: return linuxInstallSchedule(codeburnPath, intervalHours);
  }
}

function removeSchedule(): void {
  switch (platform()) {
    case 'darwin': return darwinRemoveSchedule();
    case 'win32': return windowsRemoveSchedule();
    default: return linuxRemoveSchedule();
  }
}

function schedulerName(): string {
  switch (platform()) {
    case 'darwin': return 'LaunchAgent';
    case 'win32': return 'Scheduled Task';
    default: return 'crontab';
  }
}

// ---- Status ----

function showStatus(codeburnPath: string | null): void {
  console.log('\n📊 OTEL Sync Status\n');

  // Codeburn installed?
  if (codeburnPath) {
    console.log(`  ✓ codeburn found: ${codeburnPath}`);
    const ver = run(`${codeburnPath} --version`);
    if (ver.ok) console.log(`    version: ${ver.stdout}`);
  } else {
    console.log('  ✗ codeburn not found in PATH');
  }

  // Sync configured?
  const configPath = join(homedir(), '.config', 'codeburn', 'sync.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(`  ✓ sync configured: ${cfg.baseUrl || cfg.endpoint || cfg.url || '(configured)'}`);
    } catch {
      console.log(`  ✓ sync config exists: ${configPath}`);
    }
  } else {
    console.log('  ✗ sync not configured (run setup first)');
  }

  // Schedule exists?
  if (scheduleExists()) {
    console.log(`  ✓ ${schedulerName()} schedule active`);
  } else {
    console.log(`  ✗ no ${schedulerName()} schedule found`);
  }

  // Last log?
  const logFile = join(LOG_DIR, 'otel-sync.log');
  if (existsSync(logFile)) {
    const lastLines = run(`tail -5 "${logFile}"`);
    if (lastLines.ok && lastLines.stdout) {
      console.log(`  Last sync output (${logFile}):`);
      for (const line of lastLines.stdout.split('\n')) {
        console.log(`    ${line}`);
      }
    }
  }
  console.log('');
}

// ---- Main ----

export default {
  description: 'Set up automated codeburn OTEL sync (pushes AI usage telemetry every 12h)',
  options: [
    { flags: '--url <url>', description: 'OTEL collector URL (from CDK deploy output OtelCollectorUrl)' },
    { flags: '--interval <hours>', description: 'Sync interval in hours (default: 12)' },
    { flags: '--status', description: 'Show current sync schedule status' },
    { flags: '--remove', description: 'Remove the sync schedule' },
  ],
  async action(opts: { url?: string; interval?: string; status?: boolean; remove?: boolean }) {
    const codeburnPath = getCodeburnPath();

    // --status
    if (opts.status) {
      showStatus(codeburnPath);
      return;
    }

    // --remove
    if (opts.remove) {
      if (scheduleExists()) {
        removeSchedule();
        console.log(`\n  ✓ ${schedulerName()} schedule removed.\n`);
      } else {
        console.log(`\n  No ${schedulerName()} schedule found — nothing to remove.\n`);
      }
      return;
    }

    // ---- Setup flow ----
    console.log('\n🔄 OTEL Sync Setup\n');
    console.log('This will configure automated codeburn telemetry sync to your PRISM');
    console.log('OTEL collector. Runs every 12 hours to keep dashboards fresh.\n');

    // 1. Check codeburn version
    if (!codeburnPath) {
      console.error('Error: codeburn not found. Install with: npm install -g codeburn');
      process.exit(1);
    }
    const verResult = run(`${codeburnPath} --version`);
    if (verResult.ok) {
      const ver = verResult.stdout.replace(/[^0-9.]/g, '');
      const parts = ver.split('.').map(Number);
      if (parts[0] === 0 && parts[1] < 9 || (parts[1] === 9 && parts[2] < 16)) {
        console.error(`Error: codeburn >= 0.9.16 required (found ${ver}). Run: npm update -g codeburn`);
        process.exit(1);
      }
      console.log(`  ✓ codeburn ${ver}`);
    }

    // 2. Get the OTEL collector URL
    const otelUrl = opts.url || await prompt('OTEL collector URL (from CDK deploy output OtelCollectorUrl)');
    if (!otelUrl) {
      console.error('Error: OTEL collector URL is required.');
      process.exit(1);
    }

    // 3. Check if codeburn sync is already configured for this URL
    const configPath = join(homedir(), '.config', 'codeburn', 'sync.json');
    let needsSetup = true;
    if (existsSync(configPath)) {
      try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
        const existingUrl = cfg.baseUrl || cfg.endpoint || cfg.url || '';
        if (existingUrl === otelUrl || existingUrl.startsWith(otelUrl)) {
          console.log(`  ✓ codeburn sync already configured for this endpoint.`);
          needsSetup = false;
        } else {
          console.log(`  ⚠ codeburn sync configured for different endpoint: ${existingUrl}`);
          const override = await prompt('Reconfigure for the new URL? (y/N)', 'N');
          if (override.toLowerCase() !== 'y') {
            console.log('  Keeping existing configuration.');
            needsSetup = false;
          }
        }
      } catch {
        // Corrupt config — re-setup
      }
    }

    // 4. Run codeburn sync setup (opens browser for OIDC)
    if (needsSetup) {
      console.log('\n  Running: codeburn sync setup ' + otelUrl);
      console.log('  (This will open a browser for OIDC authentication)\n');
      try {
        execSync(`${codeburnPath} sync setup ${otelUrl}`, { stdio: 'inherit' });
        console.log('\n  ✓ codeburn sync configured.');
      } catch (err: any) {
        console.error(`\n  ✗ codeburn sync setup failed. Ensure Cognito user exists and try again.`);
        process.exit(1);
      }
    }

    // 5. Initial backfill push (30d — server drops >14d from CloudWatch, keeps in DDB/S3)
    console.log('\n  Pushing initial backfill (last 30 days of telemetry)...');
    const backfill = run(`${codeburnPath} sync push --since 30d`);
    if (backfill.ok) {
      console.log('  ✓ Backfill push complete.');
      if (backfill.stdout) console.log(`    ${backfill.stdout.split('\n').slice(-1)[0]}`);
    } else {
      console.log(`  ⚠ Backfill push failed (non-fatal): ${backfill.stderr.split('\n')[0]}`);
      console.log('    The schedule will retry. Check ~/.prism/logs/otel-sync.log');
    }

    // 6. Install OS schedule
    const intervalHours = opts.interval ? parseInt(opts.interval, 10) : 12;
    if (isNaN(intervalHours) || intervalHours < 1) {
      console.error('Error: --interval must be a positive integer (hours).');
      process.exit(1);
    }

    if (scheduleExists()) {
      console.log(`\n  ✓ ${schedulerName()} schedule already exists — updating.`);
      removeSchedule();
    }

    installSchedule(codeburnPath, intervalHours);
    console.log(`  ✓ ${schedulerName()} schedule installed (every ${intervalHours}h).`);

    // Summary
    console.log('\n════════════════════════════════════════════════');
    console.log('  ✅ OTEL sync setup complete!');
    console.log('════════════════════════════════════════════════');
    console.log(`\n  Endpoint:  ${otelUrl}`);
    console.log(`  Schedule:  every ${intervalHours}h via ${schedulerName()}`);
    console.log(`  Backfill:  last 30d pushed (dashboard shows last 14d)`);
    console.log(`  Logs:      ${join(LOG_DIR, 'otel-sync.log')}`);
    console.log(`\n  Run \`prism-cli bootstrapper setup-otel-sync --status\` to check health.`);
    console.log(`  Run \`prism-cli bootstrapper setup-otel-sync --remove\` to uninstall.\n`);
  },
};
