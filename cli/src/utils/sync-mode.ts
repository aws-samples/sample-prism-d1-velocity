/**
 * Where a developer's codeburn usage goes, saved once per user:
 *   local  usage stays on this machine (no sync endpoint, no schedule)
 *   team   codeburn syncs to the team's PRISM collector
 *   admin  this user is the platform team setting up PRISM
 *
 * File: ~/.prism/codeburn.json  { "mode": "...", "updatedAt": "..." }
 *
 * No mode saved: a configured sync endpoint means team (machines set up
 * before modes existed keep syncing), else local.
 *
 * Also the one place for the hint texts and doc links that `enable codeburn`,
 * the dashboard and its --json share.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configuredSyncUrl, ENABLE_CODEBURN_CMD } from './otel-sync-schedule.js';

export const SYNC_MODES = ['local', 'team', 'admin'] as const;
export type SyncMode = typeof SYNC_MODES[number];
/** saved: from the mode file. migrated: no file, but a sync endpoint is configured. default: neither. */
export type SyncModeSource = 'saved' | 'migrated' | 'default';

export const SYNC_MODE_PATH = '~/.prism/codeburn.json';
export const syncModePath = (home: string): string => join(home, '.prism', 'codeburn.json');

/** The saved mode, or null when there is no valid mode file. */
export function readSavedMode(home: string): SyncMode | null {
  try {
    const m = JSON.parse(readFileSync(syncModePath(home), 'utf8'))?.mode;
    return (SYNC_MODES as readonly string[]).includes(m) ? m : null;
  } catch {
    return null;
  }
}

/** Atomic write, owner-only, like ~/.prism/aws.json. */
export function writeSyncMode(home: string, mode: SyncMode, now = new Date()): void {
  const path = syncModePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mode, updatedAt: now.toISOString() }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function effectiveMode(home: string, url: string | null = configuredSyncUrl(home)): { mode: SyncMode; source: SyncModeSource } {
  const saved = readSavedMode(home);
  if (saved) return { mode: saved, source: 'saved' };
  return url !== null ? { mode: 'team', source: 'migrated' } : { mode: 'local', source: 'default' };
}

export const MODE_SOURCE_TEXT: Record<SyncModeSource, string> = {
  saved: `saved in ${SYNC_MODE_PATH}`,
  migrated: 'no mode saved; a codeburn sync endpoint is configured, so team',
  default: 'no mode saved and no sync endpoint, so local',
};

// ---------------------------------------------------------------- help texts and links

export interface HelpLink { label: string; url: string }
export interface CheckHelp {
  text: string;
  links: HelpLink[];
  /** Ordered steps, when the help is a procedure (admin mode). */
  steps?: string[];
  /** Commands that carry out the steps. */
  commands?: string[];
}

/** Public setup docs. The one place these URLs live. */
export const SETUP_DOCS = {
  telemetryAccount: 'https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/README.md#2-give-each-developer-a-telemetry-account',
  platformTeamGuide: 'https://github.com/aws-samples/sample-prism-d1-velocity/blob/main/USER_GUIDE.md#administrator-setup',
} as const;

const SETUP_LINK: HelpLink = { label: 'Setup instructions', url: SETUP_DOCS.telemetryAccount };
const GUIDE_LINK: HelpLink = { label: 'Platform team guide', url: SETUP_DOCS.platformTeamGuide };
export const TEAM_URL_CMD = `${ENABLE_CODEBURN_CMD} --url <collector URL>`;

/** team mode, no sync endpoint: only the platform team can supply the collector URL and account. */
export const TEAM_NO_URL_HELP: CheckHelp = {
  text: 'codeburn sync is not set up on this machine. Ask your platform team for the collector URL and a telemetry account for your email, '
    + `then run ${TEAM_URL_CMD}.`,
  links: [SETUP_LINK, GUIDE_LINK],
};

/** local mode: nothing to fix; how to join a team later. */
export const LOCAL_MODE_HELP: CheckHelp = {
  text: `If your team uses PRISM, ask your platform team for the collector URL and a telemetry account, then run ${TEAM_URL_CMD}.`,
  links: [SETUP_LINK],
};

export const TEAM_INFO_CMD = 'prism-cli team info';
export const TEAM_ADD_CMD = 'prism-cli team add-developer <email>';

export const PLATFORM_TEAM_STEPS = [
  'Deploy the PRISM stack (infra/: npx cdk deploy --all).',
  `Note the stack outputs OtelCollectorUrl and OtelUserPoolId (${TEAM_INFO_CMD} prints both).`,
  `Add each developer: a telemetry account named by their email (${TEAM_ADD_CMD}).`,
  `Share the collector URL; each developer runs ${TEAM_URL_CMD}.`,
];

/** admin mode: the platform-team procedure and the helper commands. */
export const PLATFORM_TEAM_HELP: CheckHelp = {
  text: 'You are the platform team: set up PRISM so developers can sync.',
  steps: PLATFORM_TEAM_STEPS,
  commands: [TEAM_INFO_CMD, TEAM_ADD_CMD],
  links: [GUIDE_LINK],
};
