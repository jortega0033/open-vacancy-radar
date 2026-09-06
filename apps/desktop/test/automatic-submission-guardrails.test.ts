import { describe, expect, it } from 'vitest';
import { checkAutomaticEligibility, checkRateLimits, type RateLimits } from '../electron/automatic-submission-guardrails.js';

const RATE_LIMITS: RateLimits = { perDay: 3, perEmployerPerDay: 1, minIntervalMs: 60_000 };
const NOW = '2026-01-02T12:00:00.000Z';

describe('checkRateLimits', () => {
  it('allows a submission when no history exists yet', () => {
    expect(checkRateLimits({ rateLimits: RATE_LIMITS, company: 'Acme', now: NOW, recentAutomaticSubmissions: [] })).toEqual({ ok: true });
  });

  it('refuses once the daily cap is reached, counting only the last 24 hours', () => {
    const recentAutomaticSubmissions = [
      { company: 'Acme', submittedAt: '2026-01-02T09:00:00.000Z' },
      { company: 'Beta', submittedAt: '2026-01-02T10:00:00.000Z' },
      { company: 'Gamma', submittedAt: '2026-01-02T11:00:00.000Z' },
      // Outside the 24h window -- must not count toward the cap.
      { company: 'Old Co', submittedAt: '2025-12-30T09:00:00.000Z' },
    ];
    const result = checkRateLimits({ rateLimits: RATE_LIMITS, company: 'Delta', now: NOW, recentAutomaticSubmissions });
    expect(result).toMatchObject({ ok: false, reason: 'daily_cap_reached' });
  });

  it('refuses a second same-day submission to the same employer even under the daily cap', () => {
    const recentAutomaticSubmissions = [{ company: 'Acme', submittedAt: '2026-01-02T09:00:00.000Z' }];
    const result = checkRateLimits({ rateLimits: RATE_LIMITS, company: 'Acme', now: NOW, recentAutomaticSubmissions });
    expect(result).toMatchObject({ ok: false, reason: 'per_employer_daily_cap_reached' });
  });

  it('allows a same-day submission to a different employer', () => {
    const recentAutomaticSubmissions = [{ company: 'Acme', submittedAt: '2026-01-02T09:00:00.000Z' }];
    const result = checkRateLimits({ rateLimits: RATE_LIMITS, company: 'Beta', now: NOW, recentAutomaticSubmissions });
    expect(result).toEqual({ ok: true });
  });

  it('refuses when the minimum interval since the most recent automatic submission has not elapsed', () => {
    const recentAutomaticSubmissions = [{ company: 'Zeta', submittedAt: '2026-01-02T11:59:30.000Z' }]; // 30s ago
    const result = checkRateLimits({ rateLimits: RATE_LIMITS, company: 'Eta', now: NOW, recentAutomaticSubmissions });
    expect(result).toMatchObject({ ok: false, reason: 'min_interval_not_elapsed' });
  });

  it('allows once the minimum interval has elapsed', () => {
    const recentAutomaticSubmissions = [{ company: 'Zeta', submittedAt: '2026-01-02T11:58:00.000Z' }]; // 120s ago
    const result = checkRateLimits({ rateLimits: RATE_LIMITS, company: 'Eta', now: NOW, recentAutomaticSubmissions });
    expect(result).toEqual({ ok: true });
  });

  it('allows even when the most recent submission is timestamped fractionally after `now` -- real clock skew between two calls, never read as "wait even longer"', () => {
    // A real, if narrow, possibility: `now` is captured once for a whole batch, but a submission
    // fired moments later gets stamped with the actual wall-clock time at that later instant. That
    // must never make the elapsed time negative and demand more than minIntervalMs itself asks for.
    const recentAutomaticSubmissions = [{ company: 'Zeta', submittedAt: '2026-01-02T12:00:00.500Z' }]; // 500ms "after" now
    const zeroInterval: RateLimits = { ...RATE_LIMITS, minIntervalMs: 0 };
    const result = checkRateLimits({ rateLimits: zeroInterval, company: 'Eta', now: NOW, recentAutomaticSubmissions });
    expect(result).toEqual({ ok: true });
  });

  it('checks the daily cap before the min-interval check, reporting the more fundamental refusal first', () => {
    const recentAutomaticSubmissions = [
      { company: 'Acme', submittedAt: '2026-01-02T11:59:50.000Z' },
      { company: 'Beta', submittedAt: '2026-01-02T11:00:00.000Z' },
      { company: 'Gamma', submittedAt: '2026-01-02T10:00:00.000Z' },
    ];
    const result = checkRateLimits({ rateLimits: RATE_LIMITS, company: 'Delta', now: NOW, recentAutomaticSubmissions });
    expect(result.reason).toBe('daily_cap_reached');
  });
});

describe('checkAutomaticEligibility', () => {
  it('refuses when no prior submitted attempt exists for this employer -- first attempt is always manual', () => {
    const result = checkAutomaticEligibility({ company: 'Acme', currentFormStructureHash: 'hash-a', priorSubmittedAttempts: [] });
    expect(result).toMatchObject({ ok: false, reason: 'no_prior_manual_submission_for_employer' });
  });

  it('refuses when the current form structure does not match the most recent submission for this employer', () => {
    const result = checkAutomaticEligibility({
      company: 'Acme',
      currentFormStructureHash: 'hash-new',
      priorSubmittedAttempts: [{ company: 'Acme', formStructureHash: 'hash-old', submittedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(result).toMatchObject({ ok: false, reason: 'form_structure_changed_since_last_review' });
  });

  it('refuses when the most recent prior submission has no recorded structure hash at all', () => {
    const result = checkAutomaticEligibility({
      company: 'Acme',
      currentFormStructureHash: 'hash-a',
      priorSubmittedAttempts: [{ company: 'Acme', formStructureHash: null, submittedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(result).toMatchObject({ ok: false, reason: 'form_structure_changed_since_last_review' });
  });

  it('allows when the current structure matches the most recent prior submission for this employer', () => {
    const result = checkAutomaticEligibility({
      company: 'Acme',
      currentFormStructureHash: 'hash-a',
      priorSubmittedAttempts: [{ company: 'Acme', formStructureHash: 'hash-a', submittedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(result).toEqual({ ok: true });
  });

  it('compares against the most recent submission for the employer, not an earlier stale one', () => {
    const result = checkAutomaticEligibility({
      company: 'Acme',
      currentFormStructureHash: 'hash-b',
      priorSubmittedAttempts: [
        { company: 'Acme', formStructureHash: 'hash-a', submittedAt: '2026-01-01T00:00:00.000Z' }, // older, stale template
        { company: 'Acme', formStructureHash: 'hash-b', submittedAt: '2026-01-05T00:00:00.000Z' }, // most recent
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it('never lets one employer\'s submission history authorize automatic mode for a different employer', () => {
    const result = checkAutomaticEligibility({
      company: 'Acme',
      currentFormStructureHash: 'hash-a',
      priorSubmittedAttempts: [{ company: 'Beta', formStructureHash: 'hash-a', submittedAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(result).toMatchObject({ ok: false, reason: 'no_prior_manual_submission_for_employer' });
  });
});
