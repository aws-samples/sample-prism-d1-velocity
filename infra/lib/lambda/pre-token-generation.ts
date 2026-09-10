/**
 * Pre token generation trigger (V2_0) — copies `email` into the ACCESS token.
 *
 * WHY THIS EXISTS
 *
 * Every per-developer number on these dashboards keys on the identity the
 * otel-receiver derives from the caller's JWT, and the commit side of the
 * pipeline keys on the git author email (`metrics-processor.ts` writes
 * `gsi_user: USER#<author email>` from the CI census). For the two to join,
 * the receiver's identity must also be an email.
 *
 * Cognito ID tokens carry `email`. Cognito ACCESS tokens do not — and API
 * Gateway's HttpJwtAuthorizer validates the access token. So with a federated
 * IdP the receiver falls back to `username`, which Cognito prefixes with the
 * provider name (`corpidp_alice`). The same person then appears as two
 * developers: one holding all the token spend and no commits, the other the
 * reverse. On a pool with months of accumulated telemetry, effectively all of
 * the AI-usage history lands on the prefixed identity while commit attribution
 * lands on the email one.
 *
 * Mapping `email` on the identity provider is necessary but NOT sufficient: it
 * populates the user ATTRIBUTE, which never reaches the access token on its
 * own. This trigger is the piece that moves it there.
 *
 * PAIRED WITH `otelIdentityClaim=email`
 *
 * This function is inert by itself. The receiver resolves identity as
 * `[IDENTITY_CLAIM, 'username', 'email', 'sub']`, and IDENTITY_CLAIM defaults
 * to `username` — which is always present, so `email` is unreachable no matter
 * what this trigger adds. Deploy this WITH `-c otelIdentityClaim=email`, or it
 * adds a claim nothing reads.
 *
 * FAIL-OPEN, DELIBERATELY
 *
 * A federated user's `email` is populated by the IdP attribute mapping on
 * sign-in, so a user who has not signed in since the mapping was added has no
 * email yet. Returning the event unmodified in that case lets the receiver's
 * chain fall through to `username` — the pre-existing behaviour — so those users
 * keep writing to their old key until they next sign in, and the migration is
 * self-completing. Throwing here would instead block token issuance and lock
 * them out of sync entirely, turning a cosmetic split into an outage.
 *
 * Requires the Essentials or Plus feature plan; access token customization is
 * unavailable on Lite. Deployed against a pool already on Plus.
 */

interface PreTokenGenerationV2Event {
  request?: {
    userAttributes?: Record<string, string>;
  };
  response?: unknown;
}

export async function handler(event: PreTokenGenerationV2Event): Promise<PreTokenGenerationV2Event> {
  const email = event.request?.userAttributes?.email;

  // Trim before testing: a whitespace-only attribute would satisfy a bare
  // truthiness check here and then be rejected by the receiver's own
  // `v.trim()` guard, silently reverting to `username` with no signal.
  if (typeof email !== 'string' || email.trim() === '') {
    return event;
  }

  // Lowercased to match the receiver, which lowercases every resolved identity
  // before building `USER#<identity>`. Emitting mixed case here would create a
  // second partition key for the same person the first time an IdP returned a
  // capitalized address.
  const normalized = email.trim().toLowerCase();

  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: {
        claimsToAddOrOverride: { email: normalized },
      },
    },
  };

  return event;
}
