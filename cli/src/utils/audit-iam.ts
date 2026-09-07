import { aws, AwsTarget, daysSince } from './aws.js';
import { Finding, Severity } from './audit.js';

/**
 * Audit IAM credential hygiene -- the way in.
 *
 * Not Bedrock-specific by nature. Credential theft aimed at model inference
 * (LLMjacking) is the most expensive consequence of a leaked long-lived key
 * rather than a different attack: the stolen credential is an ordinary IAM key,
 * and the same hygiene failures expose every other service too. These checks are
 * therefore the "way in" half of `bedrock-protection scan-account`; the
 * blast-radius half lives in audit-bedrock.ts.
 *
 * Audit-only, with one documented exception at `credentialReport()`.
 */

interface CredRow {
  user: string;
  passwordEnabled: boolean;
  mfaActive: boolean;
  passwordLastUsed: string;
  keys: Array<{ n: number; active: boolean; lastRotated: string; lastUsed: string }>;
}

/**
 * GetCredentialReport fails with ReportNotPresent until GenerateCredentialReport
 * has been called -- measured, not assumed. Generation is asynchronous, so this
 * kicks it off and re-reads a bounded number of times.
 *
 * This is the only non-read AWS call in the command. It produces a report
 * artifact and modifies no resource.
 */
function credentialReport(target?: AwsTarget): CredRow[] | { error: string } {
  let got = aws(['iam', 'get-credential-report'], target);

  if (!got.ok && got.errorCode === 'ReportNotPresent') {
    const gen = aws(['iam', 'generate-credential-report'], target);
    if (!gen.ok) return { error: gen.errorCode || 'generate-credential-report failed' };
    for (let i = 0; i < 10 && !got.ok; i++) {
      got = aws(['iam', 'get-credential-report'], target);
      if (!got.ok && got.errorCode !== 'ReportNotPresent') break;
    }
  }
  if (!got.ok) return { error: got.errorCode || 'get-credential-report failed' };

  const b64 = got.json?.Content;
  if (!b64) return { error: 'credential report had no Content' };

  const csv = Buffer.from(b64, 'base64').toString('utf8');
  const lines = csv.trim().split('\n');
  const header = lines[0].split(',');
  const col = (name: string) => header.indexOf(name);

  const rows: CredRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const at = (name: string) => (col(name) >= 0 ? c[col(name)] : '');
    rows.push({
      user: at('user'),
      passwordEnabled: at('password_enabled') === 'true',
      mfaActive: at('mfa_active') === 'true',
      passwordLastUsed: at('password_last_used'),
      keys: [1, 2].map((n) => ({
        n,
        active: at(`access_key_${n}_active`) === 'true',
        lastRotated: at(`access_key_${n}_last_rotated`),
        lastUsed: at(`access_key_${n}_last_used_date`),
      })),
    });
  }
  return rows;
}

export function auditRoot(target?: AwsTarget): Finding[] {
  const out: Finding[] = [];

  // GetAccountSummary answers the two most severe questions in one call and
  // needs no credential report. AccountMFAEnabled and AccountAccessKeysPresent
  // both describe the ROOT user specifically.
  const summary = aws(['iam', 'get-account-summary'], target);
  const map = summary.ok ? (summary.json?.SummaryMap ?? null) : null;

  if (!map) {
    out.push({
      id: 'root-mfa', category: 'root', title: 'Root account MFA',
      status: 'INDETERMINATE', severity: 'CRITICAL',
      detail: `Could not read the account summary (${summary.errorCode || 'unknown error'}).`,
      remediation: 'Grant iam:GetAccountSummary and re-run.',
    });
    out.push({
      id: 'root-access-keys', category: 'root', title: 'Root access keys',
      status: 'INDETERMINATE', severity: 'CRITICAL',
      detail: `Could not read the account summary (${summary.errorCode || 'unknown error'}).`,
    });
    return out;
  }

  const rootMfa = map.AccountMFAEnabled === 1;
  out.push({
    id: 'root-mfa', category: 'root', title: 'Root account MFA',
    status: rootMfa ? 'PASS' : 'FAIL', severity: 'CRITICAL',
    detail: rootMfa
      ? 'Root user has an MFA device.'
      : 'Root user has NO MFA device. Root cannot be constrained by SCPs or permission boundaries, so a compromised root is unbounded.',
    remediation: 'Attach a FIDO2 security key to root — phishing resistant, unlike TOTP. In Amazon-internal Isengard accounts root is managed for you and this may not be actionable; confirm before escalating.',
  });

  const rootKeys = map.AccountAccessKeysPresent === 1;
  out.push({
    id: 'root-access-keys', category: 'root', title: 'Root access keys',
    status: rootKeys ? 'FAIL' : 'PASS', severity: 'CRITICAL',
    detail: rootKeys
      ? 'Root has active access keys — unconstrainable long-lived credentials, the single worst credential to leak.'
      : 'No root access keys.',
    remediation: 'Delete root access keys. Nothing legitimate requires them.',
  });

  return out;
}

export function auditPasswordPolicy(target?: AwsTarget): Finding {
  const pol = aws(['iam', 'get-account-password-policy'], target);

  // NoSuchEntity is the API saying "no policy set", which means AWS defaults
  // apply. That is a finding, not an error -- treating it as an error hides it.
  if (!pol.ok && pol.errorCode === 'NoSuchEntity') {
    return {
      id: 'password-policy', category: 'policy', title: 'Account password policy',
      status: 'FAIL', severity: 'MEDIUM',
      detail: 'No password policy is set, so only AWS defaults apply (minimum length 8, no complexity or reuse rules).',
      remediation: 'Set MinimumPasswordLength >= 14 with complexity and reuse prevention — or remove console passwords entirely in favour of Identity Center.',
    };
  }
  if (!pol.ok) {
    return {
      id: 'password-policy', category: 'policy', title: 'Account password policy',
      status: 'INDETERMINATE', severity: 'MEDIUM',
      detail: `Could not read the password policy (${pol.errorCode || 'unknown error'}).`,
    };
  }

  const p = pol.json?.PasswordPolicy ?? {};
  const weak: string[] = [];
  if ((p.MinimumPasswordLength ?? 0) < 14) weak.push(`MinimumPasswordLength=${p.MinimumPasswordLength ?? 'unset'} (< 14)`);
  if (!p.RequireSymbols) weak.push('RequireSymbols=false');
  if (!p.RequireNumbers) weak.push('RequireNumbers=false');
  if (!p.RequireUppercaseCharacters || !p.RequireLowercaseCharacters) weak.push('mixed case not required');
  if (!p.PasswordReusePrevention) weak.push('PasswordReusePrevention unset');

  return {
    id: 'password-policy', category: 'policy', title: 'Account password policy',
    status: weak.length ? 'FAIL' : 'PASS', severity: 'MEDIUM',
    detail: weak.length ? `Weaker than baseline: ${weak.join(', ')}.` : 'Policy meets the baseline.',
    remediation: weak.length ? 'Raise minimum length to 14+, require complexity, enable reuse prevention.' : undefined,
  };
}

export function auditUsers(target: AwsTarget | undefined, maxKeyAge: number, unusedDays: number): Finding[] {
  const out: Finding[] = [];
  const report = credentialReport(target);

  if ('error' in report) {
    for (const [id, title, sev] of [
      ['access-key-age', 'Long-lived access keys', 'HIGH'],
      ['console-user-no-mfa', 'Console users without MFA', 'HIGH'],
      ['unused-credentials', 'Unused credentials', 'MEDIUM'],
    ] as Array<[string, string, Severity]>) {
      out.push({
        id, category: 'users', title,
        status: 'INDETERMINATE', severity: sev,
        detail: `Credential report unavailable (${report.error}).`,
        remediation: 'Grant iam:GenerateCredentialReport and iam:GetCredentialReport, then re-run.',
      });
    }
    return out;
  }

  // <root_account> is covered by the summary checks and reported with a
  // different shape, so exclude it here rather than double-reporting.
  const users = report.filter((r) => r.user !== '<root_account>');

  const stale: string[] = [];
  for (const u of users) {
    for (const k of u.keys) {
      if (!k.active) continue;
      const age = daysSince(k.lastRotated);
      if (age !== null && age > maxKeyAge) stale.push(`${u.user} key ${k.n} (${age}d)`);
    }
  }
  out.push({
    id: 'access-key-age', category: 'users', title: 'Long-lived access keys',
    status: stale.length ? 'FAIL' : 'PASS', severity: 'HIGH',
    detail: stale.length
      ? `${stale.length} active key(s) older than ${maxKeyAge}d: ${stale.slice(0, 8).join(', ')}${stale.length > 8 ? ', …' : ''}. Key age is the strongest single predictor of credential-theft exposure — an old key has had more opportunities to leak and is rarely missed when it does.`
      : `No active access key is older than ${maxKeyAge}d.`,
    remediation: stale.length ? 'Rotate, or delete the key and move the workload onto an IAM role. A role issues short-lived credentials that cannot be exfiltrated as a static string.' : undefined,
  });

  const noMfa = users.filter((u) => u.passwordEnabled && !u.mfaActive).map((u) => u.user);
  out.push({
    id: 'console-user-no-mfa', category: 'users', title: 'Console users without MFA',
    status: noMfa.length ? 'FAIL' : 'PASS', severity: 'HIGH',
    detail: noMfa.length
      ? `${noMfa.length} user(s) have console passwords and no MFA: ${noMfa.slice(0, 8).join(', ')}${noMfa.length > 8 ? ', …' : ''}.`
      : 'Every console-enabled user has MFA.',
    remediation: noMfa.length ? 'Enforce MFA with a deny policy conditioned on aws:MultiFactorAuthPresent rather than relying on voluntary enrolment.' : undefined,
  });

  const unused: string[] = [];
  for (const u of users) {
    if (u.passwordEnabled) {
      const d = daysSince(u.passwordLastUsed);
      if (d !== null && d > unusedDays) unused.push(`${u.user} password (${d}d)`);
    }
    for (const k of u.keys) {
      if (!k.active) continue;
      // 'N/A' means active but never used; fall back to key age so a
      // never-used key is not silently skipped.
      const d = daysSince(k.lastUsed) ?? daysSince(k.lastRotated);
      if (d !== null && d > unusedDays) unused.push(`${u.user} key ${k.n} (${d}d)`);
    }
  }
  out.push({
    id: 'unused-credentials', category: 'users', title: 'Unused credentials',
    status: unused.length ? 'FAIL' : 'PASS', severity: 'MEDIUM',
    detail: unused.length
      ? `${unused.length} credential(s) idle for over ${unusedDays}d: ${unused.slice(0, 8).join(', ')}${unused.length > 8 ? ', …' : ''}. An idle credential is pure attack surface — its first malicious use looks identical to its first legitimate use.`
      : `No credential has been idle longer than ${unusedDays}d.`,
    remediation: unused.length ? 'Delete them. Idle credentials are the ones whose misuse goes unnoticed longest.' : undefined,
  });

  return out;
}

export function auditUserPolicies(target?: AwsTarget): Finding {
  const list = aws(['iam', 'list-users', '--query', 'Users[].UserName'], target);
  if (!list.ok) {
    return {
      id: 'user-admin-policy', category: 'users', title: 'AdministratorAccess on IAM users',
      status: 'INDETERMINATE', severity: 'HIGH',
      detail: `Could not list users (${list.errorCode || 'unknown error'}).`,
    };
  }

  const names: string[] = Array.isArray(list.json) ? list.json : [];
  const admins: string[] = [];
  let unchecked = 0;
  for (const name of names) {
    const att = aws(['iam', 'list-attached-user-policies', '--user-name', name], target);
    if (!att.ok) { unchecked++; continue; }
    const policies = att.json?.AttachedPolicies ?? [];
    if (policies.some((p: any) => p.PolicyName === 'AdministratorAccess')) admins.push(name);
  }

  return {
    id: 'user-admin-policy', category: 'users', title: 'AdministratorAccess on IAM users',
    // A partial read cannot clear the check: unchecked users may be the admins.
    status: admins.length ? 'FAIL' : unchecked > 0 ? 'INDETERMINATE' : 'PASS',
    severity: 'HIGH',
    detail: admins.length
      ? `AdministratorAccess is attached directly to: ${admins.join(', ')}. Any access key belonging to these users is an unbounded credential.`
      : unchecked > 0
        ? `Checked ${names.length - unchecked}/${names.length} users; ${unchecked} could not be read, so this result is incomplete.`
        : `None of ${names.length} user(s) has AdministratorAccess attached directly.`,
    remediation: admins.length ? 'Move admin access behind an assumable role gated on MFA, so no static key carries it.' : undefined,
  };
}
