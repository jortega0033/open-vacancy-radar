/**
 * The deterministic guardrails issue #203 requires before an automatic (unattended) submit is
 * allowed to fire, kept Electron-free and pure the same way `application-submit-gate.ts` is: every
 * input is resolved by the caller from real, current state (never cached, never trusted from an
 * earlier check), and this module only ever answers "does this specific attempt, right now, pass
 * every guardrail" -- it does not read a database, a clock, or a policy table itself.
 *
 * Two independent checks live here, both required before `application-review-session.ts`'s
 * automatic-submit path may call `executor.submit()`:
 *
 * 1. `checkRateLimits` -- the policy's own `rateLimits` (perDay/perEmployerPerDay/minIntervalMs),
 *    enforced against real submission history, not just configured and left unchecked (#202's own
 *    scope explicitly deferred this: "rate limits become load-bearing once automatic mode exists").
 * 2. `checkAutomaticEligibility` -- #203 scope item 1's rule: the first attempt against any given
 *    employer is always manually reviewed, and a later one may only proceed unattended when its
 *    filled form has the identical structure (same fields, same control types, same required-ness)
 *    as the most recent attempt that employer actually had manually submitted. A grant authorizes
 *    a *platform*; this is what stops that authorization from silently covering an employer whose
 *    application form the user has never actually looked at, or one that changed since they did.
 */

export interface RateLimits {
  perDay: number;
  perEmployerPerDay: number;
  minIntervalMs: number;
}

export interface RecentAutomaticSubmission {
  company: string;
  /** ISO-8601 */
  submittedAt: string;
}

export interface RateLimitCheckInput {
  rateLimits: RateLimits;
  company: string;
  /** ISO-8601, injected rather than read from `Date.now()` here so this stays a pure function a
   * test can pin to an exact instant. */
  now: string;
  /** Every automatic submission recorded for this policy (any employer) -- callers should not
   * pre-filter by company; the per-employer cap is computed here from the full list. */
  recentAutomaticSubmissions: readonly RecentAutomaticSubmission[];
}

export type RateLimitRefusalReason = 'daily_cap_reached' | 'per_employer_daily_cap_reached' | 'min_interval_not_elapsed';

export interface RateLimitCheckResult {
  ok: boolean;
  reason?: RateLimitRefusalReason;
  detail?: string;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function checkRateLimits(input: RateLimitCheckInput): RateLimitCheckResult {
  const nowMs = Date.parse(input.now);
  const windowStart = nowMs - ONE_DAY_MS;
  const withinWindow = input.recentAutomaticSubmissions.filter((entry) => Date.parse(entry.submittedAt) > windowStart);

  if (withinWindow.length >= input.rateLimits.perDay) {
    return {
      ok: false,
      reason: 'daily_cap_reached',
      detail: `${withinWindow.length} automatic submissions already sent in the last 24 hours (cap: ${input.rateLimits.perDay})`,
    };
  }

  const withinWindowForEmployer = withinWindow.filter((entry) => entry.company === input.company);
  if (withinWindowForEmployer.length >= input.rateLimits.perEmployerPerDay) {
    return {
      ok: false,
      reason: 'per_employer_daily_cap_reached',
      detail: `${withinWindowForEmployer.length} automatic submissions already sent to "${input.company}" in the last 24 hours (cap: ${input.rateLimits.perEmployerPerDay})`,
    };
  }

  const mostRecent = input.recentAutomaticSubmissions.reduce<number | undefined>((latest, entry) => {
    const at = Date.parse(entry.submittedAt);
    return latest === undefined || at > latest ? at : latest;
  }, undefined);
  if (mostRecent !== undefined) {
    // Floored at zero: a submission timestamped fractionally after `now` (real clock skew between
    // when a caller captured `now` and when a just-fired submission actually got stamped, or a
    // clock that simply isn't perfectly monotonic across two calls) must never read as "even more
    // time must still elapse" -- elapsed time cannot be negative, so treat it as effectively zero,
    // not as a reason to demand an even longer wait than minIntervalMs itself asks for.
    const elapsedMs = Math.max(0, nowMs - mostRecent);
    if (elapsedMs < input.rateLimits.minIntervalMs) {
      const remainingMs = input.rateLimits.minIntervalMs - elapsedMs;
      return {
        ok: false,
        reason: 'min_interval_not_elapsed',
        detail: `the minimum interval between automatic submissions hasn't elapsed yet (${Math.ceil(remainingMs / 1000)}s remaining)`,
      };
    }
  }

  return { ok: true };
}

export interface PriorSubmittedAttempt {
  company: string;
  /** Null for an attempt that predates #203 recording this, or one that was never submitted. */
  formStructureHash: string | null;
  /** ISO-8601. Used to find the *most recent* prior submission for this employer -- the one the
   * user actually reviewed last, not an arbitrary earlier one that might no longer be representative. */
  submittedAt: string;
}

export interface AutomaticEligibilityInput {
  company: string;
  /** The current attempt's own live form-structure fingerprint, computed fresh from its current
   * snapshot -- never a stored value, since the whole point is detecting drift since the last
   * manual review. */
  currentFormStructureHash: string;
  /** Every attempt this policy has ever recorded reaching `submitted`, across all employers --
   * this function does its own filtering to the most recent one for `company`. */
  priorSubmittedAttempts: readonly PriorSubmittedAttempt[];
}

export type AutomaticEligibilityRefusalReason = 'no_prior_manual_submission_for_employer' | 'form_structure_changed_since_last_review';

export interface AutomaticEligibilityResult {
  ok: boolean;
  reason?: AutomaticEligibilityRefusalReason;
  detail?: string;
}

export function checkAutomaticEligibility(input: AutomaticEligibilityInput): AutomaticEligibilityResult {
  const priorForEmployer = input.priorSubmittedAttempts
    .filter((attempt) => attempt.company === input.company)
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
  const mostRecent = priorForEmployer[0];

  if (!mostRecent) {
    return {
      ok: false,
      reason: 'no_prior_manual_submission_for_employer',
      detail: `no prior submission for "${input.company}" exists yet -- the first attempt at any employer is always manually reviewed`,
    };
  }

  if (mostRecent.formStructureHash === null || mostRecent.formStructureHash !== input.currentFormStructureHash) {
    return {
      ok: false,
      reason: 'form_structure_changed_since_last_review',
      detail: `this attempt's form does not match the structure of the last application a human reviewed for "${input.company}"`,
    };
  }

  return { ok: true };
}
