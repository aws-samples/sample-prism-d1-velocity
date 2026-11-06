/**
 * The local record that `prism-cli enable security` finished in this repo:
 * `.prism/config.json` -> `security`. Ids and placement only, never a secret.
 * The dashboard's Security Agent row reads it, so the dashboard stays
 * credential-free.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONFIG_PATH, readPrismConfig } from '../codewatch/config.js';

export interface SecurityMarker {
  agentSpaceId: string;
  applicationId: string;
  codeReviewId: string;
  region: string;
  account: string;
  setupAt: string;
}

const REQUIRED: (keyof SecurityMarker)[] = ['agentSpaceId', 'codeReviewId', 'region', 'account'];

/** The marker, or null when it is absent or incomplete. */
export function readSecurityMarker(repoRoot: string): SecurityMarker | null {
  const s = readPrismConfig(repoRoot).security;
  if (!s || typeof s !== 'object') return null;
  for (const k of REQUIRED) if (typeof s[k] !== 'string' || !s[k]) return null;
  return {
    agentSpaceId: s.agentSpaceId, applicationId: typeof s.applicationId === 'string' ? s.applicationId : '',
    codeReviewId: s.codeReviewId, region: s.region, account: s.account,
    setupAt: typeof s.setupAt === 'string' ? s.setupAt : '',
  };
}

/**
 * Writes the marker, keeping every other key in the file. setupAt is kept when
 * nothing else changed, so a re-run that changes nothing leaves the file as it
 * was. Returns true when the file was written.
 */
export function writeSecurityMarker(repoRoot: string, m: Omit<SecurityMarker, 'setupAt'>, now: Date): boolean {
  const p = resolve(repoRoot, CONFIG_PATH);
  const cfg = readPrismConfig(repoRoot);
  const prev = readSecurityMarker(repoRoot);
  const same = prev && prev.agentSpaceId === m.agentSpaceId && prev.applicationId === m.applicationId
    && prev.codeReviewId === m.codeReviewId && prev.region === m.region && prev.account === m.account && prev.setupAt;
  if (same && existsSync(p)) return false;
  cfg.security = { ...m, setupAt: now.toISOString() };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  return true;
}

