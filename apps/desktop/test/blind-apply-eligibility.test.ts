import { describe, expect, it, vi } from 'vitest';
import type { ApplicationTargetPolicy } from '@agent-dock/application-executor';
import {
  evaluateBlindApplyCandidate,
  policyPermitsBlindSubmission,
  type BlindApplyCandidate,
  type BlindApplyGatePorts,
  type BlindApplyLiveness,
} from '../electron/blind-apply-eligibility.js';
import { FIXTURE_REVIEW_POLICY } from '../electron/application-target-policies.js';

const CANDIDATE: BlindApplyCandidate = {
  vacancyKey: 'vac-1',
  company: 'Northwind',
  role: 'Senior Frontend Engineer',
  applyUrl: 'https://jobs.example.invalid/apply/1',
  family: 'frontend',
  filters: 'eligible',
  linkStatus: 'verified',
};

const POLICY: ApplicationTargetPolicy = { ...FIXTURE_REVIEW_POLICY, id: 'synthetic-policy' };

function ports(overrides: Partial<BlindApplyGatePorts> = {}): BlindApplyGatePorts & {
  calls: { resolvePolicy: ReturnType<typeof vi.fn>; isDuplicate: ReturnType<typeof vi.fn>; checkLiveness: ReturnType<typeof vi.fn> };
} {
  const resolvePolicy = vi.fn(() => POLICY as ApplicationTargetPolicy | undefined);
  const isDuplicate = vi.fn(() => false);
  const checkLiveness = vi.fn(async (): Promise<BlindApplyLiveness> => ({ status: 'open', verificationId: 'ver-1' }));
  return {
    authorization: { active: true, roleFamilies: ['frontend'], sourceCvContentHash: 'cv-1', profileVersion: 'p1' },
    current: { cvContentHash: 'cv-1', profileVersion: 'p1' },
    resolvePolicy,
    isDuplicate,
    checkLiveness,
    ...overrides,
    calls: { resolvePolicy, isDuplicate, checkLiveness },
  } as never;
}

describe('Blind Apply gates', () => {
  it('lets a supported, open, frontend, non-duplicate, verified-link posting through, with its evidence', async () => {
    const p = ports();
    const decision = await evaluateBlindApplyCandidate(CANDIDATE, p);
    expect(decision).toMatchObject({
      kind: 'eligible',
      policyId: 'synthetic-policy',
      evidence: { family: 'frontend', filters: 'eligible', linkStatus: 'verified', livenessStatus: 'open', livenessVerificationId: 'ver-1', duplicateCheck: 'clear' },
    });
  });

  it('B0: pauses everything when Blind Apply is off, the CV changed, or the profile changed', async () => {
    expect(await evaluateBlindApplyCandidate(CANDIDATE, ports({ authorization: { active: false, roleFamilies: ['frontend'], sourceCvContentHash: 'cv-1', profileVersion: 'p1' } })))
      .toMatchObject({ kind: 'paused', reason: 'inactive' });
    const cvChanged = ports({ current: { cvContentHash: 'cv-2', profileVersion: 'p1' } });
    expect(await evaluateBlindApplyCandidate(CANDIDATE, cvChanged)).toMatchObject({ kind: 'paused', reason: 'cv_changed' });
    const noCv = ports({ current: { cvContentHash: null, profileVersion: 'p1' } });
    expect(await evaluateBlindApplyCandidate(CANDIDATE, noCv)).toMatchObject({ kind: 'paused', reason: 'cv_changed' });
    const profileChanged = ports({ current: { cvContentHash: 'cv-1', profileVersion: 'p2' } });
    expect(await evaluateBlindApplyCandidate(CANDIDATE, profileChanged)).toMatchObject({ kind: 'paused', reason: 'profile_changed' });
    // None of those reached a downstream port.
    for (const p of [cvChanged, noCv, profileChanged]) {
      expect(p.calls.isDuplicate).not.toHaveBeenCalled();
      expect(p.calls.checkLiveness).not.toHaveBeenCalled();
    }
  });

  it('B1: a role outside the confirmed family is skipped', async () => {
    const p = ports();
    for (const family of ['backend', null]) {
      expect(await evaluateBlindApplyCandidate({ ...CANDIDATE, family }, p)).toMatchObject({ kind: 'skip', reason: 'not_frontend' });
    }
    expect(p.calls.checkLiveness).not.toHaveBeenCalled();
  });

  it('B2: filters that are not eligible, or merely unknown, are skipped -- unknown is not a pass', async () => {
    const p = ports();
    expect(await evaluateBlindApplyCandidate({ ...CANDIDATE, filters: 'not_eligible' }, p)).toMatchObject({ kind: 'skip', reason: 'filters' });
    expect(await evaluateBlindApplyCandidate({ ...CANDIDATE, filters: 'unknown' }, p)).toMatchObject({ kind: 'skip', reason: 'filters' });
    expect(p.calls.checkLiveness).not.toHaveBeenCalled();
  });

  it('B3: an unverified apply link is skipped before duplicates, policy or liveness are consulted', async () => {
    const p = ports();
    expect(await evaluateBlindApplyCandidate({ ...CANDIDATE, linkStatus: 'unverified' }, p)).toMatchObject({ kind: 'skip', reason: 'unverified_link' });
    expect(p.calls.isDuplicate).not.toHaveBeenCalled();
    expect(p.calls.resolvePolicy).not.toHaveBeenCalled();
    expect(p.calls.checkLiveness).not.toHaveBeenCalled();
  });

  it('B4: a duplicate is skipped with zero policy lookups and zero liveness calls', async () => {
    const p = ports({ isDuplicate: vi.fn(() => true) });
    const decision = await evaluateBlindApplyCandidate(CANDIDATE, p);
    expect(decision).toMatchObject({ kind: 'skip', reason: 'duplicate', evidence: { duplicateCheck: 'duplicate' } });
    expect(p.resolvePolicy).not.toHaveBeenCalled();
    expect(p.checkLiveness).not.toHaveBeenCalled();
  });

  it('a duplicate on an unsupported site is still a duplicate, never "Apply yourself"', async () => {
    const p = ports({ isDuplicate: vi.fn(() => true), resolvePolicy: vi.fn(() => undefined) });
    expect(await evaluateBlindApplyCandidate(CANDIDATE, p)).toMatchObject({ kind: 'skip', reason: 'duplicate' });
  });

  it('an unsupported target is "Apply yourself" and never asks whether it is open', async () => {
    const p = ports({ resolvePolicy: vi.fn(() => undefined) });
    expect(await evaluateBlindApplyCandidate(CANDIDATE, p)).toMatchObject({ kind: 'apply_yourself' });
    expect(p.checkLiveness).not.toHaveBeenCalled();
  });

  it('a policy that is not cleared for unattended submission is "Apply yourself" too', async () => {
    const notCleared = { ...POLICY, termsEligibleForAutomation: false };
    const noSubmit = { ...POLICY, allowedActions: POLICY.allowedActions.filter((action) => action !== 'submit') };
    const killed = { ...POLICY, killSwitches: { ...POLICY.killSwitches, submit: true } };
    for (const policy of [notCleared, noSubmit, killed]) {
      expect(policyPermitsBlindSubmission(policy)).toBe(false);
      const p = ports({ resolvePolicy: vi.fn(() => policy) });
      expect(await evaluateBlindApplyCandidate(CANDIDATE, p)).toMatchObject({ kind: 'apply_yourself', evidence: { policyId: policy.id } });
      expect(p.checkLiveness).not.toHaveBeenCalled();
    }
  });

  it('B5: a closed posting is skipped; one that cannot be confirmed open is skipped too', async () => {
    const closed = ports({ checkLiveness: vi.fn(async () => ({ status: 'closed', verificationId: 'v' }) as BlindApplyLiveness) });
    expect(await evaluateBlindApplyCandidate(CANDIDATE, closed)).toMatchObject({ kind: 'skip', reason: 'closed', evidence: { livenessStatus: 'closed' } });
    const unverifiable = ports({ checkLiveness: vi.fn(async () => ({ status: 'unverifiable', verificationId: null }) as BlindApplyLiveness) });
    expect(await evaluateBlindApplyCandidate(CANDIDATE, unverifiable)).toMatchObject({ kind: 'skip', reason: 'unverifiable_posting' });
  });

  it('the liveness check is the very last gate and runs exactly once for an eligible posting', async () => {
    const order: string[] = [];
    const p = ports({
      isDuplicate: vi.fn(() => (order.push('duplicate'), false)),
      resolvePolicy: vi.fn(() => (order.push('policy'), POLICY)),
      checkLiveness: vi.fn(async () => (order.push('liveness'), { status: 'open', verificationId: null }) as BlindApplyLiveness),
    });
    await evaluateBlindApplyCandidate(CANDIDATE, p);
    expect(order).toEqual(['duplicate', 'policy', 'liveness']);
  });

  it('the fixture policy is the only compiled policy that permits Blind submission today (no real target)', async () => {
    const { resolveApplicationTargetPolicy } = await import('../electron/application-target-policies.js');
    expect(policyPermitsBlindSubmission(FIXTURE_REVIEW_POLICY)).toBe(true);
    expect(FIXTURE_REVIEW_POLICY.origins).toEqual([]);
    expect(resolveApplicationTargetPolicy('workable-apply')).toBeUndefined();
  });
});
