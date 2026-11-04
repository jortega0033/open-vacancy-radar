import type { ApplicationTargetPolicy } from '@agent-dock/application-executor';
import type {
  BlindApplyGateEvidence,
  BlindApplySkipReason,
} from './workspace/blind-apply-schema.js';

/**
 * Blind Apply's eligibility gates (#722): pure, ordered, and all of them before any tailoring.
 *
 * The point of this module is what it makes impossible. `evaluateBlindApplyCandidate` is the only way
 * a vacancy becomes work, and it returns a decision *before* anything expensive or irreversible has
 * been reached: a closed posting, a duplicate, a role outside the confirmed family, an unverified
 * link and a target no compiled policy covers all stop here, and the caller has not yet called
 * tailoring, the field mapper or the executor. Every external fact it needs arrives through a port the
 * caller supplies, and a test can count that no later port was touched.
 *
 * Gate order (cheapest and most decisive first, the network check last):
 *
 *   B0  an active authorization, and the CV/profile it was confirmed against are unchanged
 *   B1  the role family is one the person confirmed (v1: frontend only)
 *   B2  the person's hard filters pass -- `unknown` does NOT pass
 *   B3  the apply link is verified, not a careers page or an aggregator listing
 *   B4  not a duplicate of anything already started, sent or tracked
 *   B3' a compiled policy permits unattended submission here; otherwise "Apply yourself" and no work
 *   B5  the posting is confirmed open right now
 *
 * B4 deliberately runs before the policy lookup: a duplicate of an application the person already
 * sent is a duplicate whether or not this app could have submitted it, and showing it as "Apply
 * yourself" would invite a second real application. B6 (pacing) is not a gate; it only delays and is
 * applied by the runner, never here.
 */

export type BlindApplyPauseReason = 'inactive' | 'cv_changed' | 'profile_changed';

export type BlindApplyGateDecision =
  | { kind: 'eligible'; policyId: string; evidence: BlindApplyGateEvidence }
  | { kind: 'skip'; reason: BlindApplySkipReason; detail: string; evidence: BlindApplyGateEvidence }
  | { kind: 'apply_yourself'; detail: string; evidence: BlindApplyGateEvidence }
  /** Nothing about this vacancy is wrong; Blind Apply as a whole must stop until it is confirmed again. */
  | { kind: 'paused'; reason: BlindApplyPauseReason; detail: string };

export interface BlindApplyCandidate {
  vacancyKey: string;
  company: string;
  role: string;
  applyUrl: string;
  /** The deterministic role family from the relevance assessment, or null when it could not be told. */
  family: string | null;
  /** The person's hard filters and the official eligibility state, folded to one answer. */
  filters: 'eligible' | 'not_eligible' | 'unknown';
  linkStatus: 'verified' | 'unverified' | 'unknown';
}

export interface BlindApplyAuthorizationFacts {
  active: boolean;
  roleFamilies: readonly string[];
  sourceCvContentHash: string;
  profileVersion: string;
}

export interface BlindApplyCurrentFacts {
  /** `sha256(default CV text)` right now, or null when no CV is available. */
  cvContentHash: string | null;
  profileVersion: string;
}

export type BlindApplyLiveness =
  | { status: 'open'; verificationId: string | null }
  | { status: 'closed' | 'unverifiable'; verificationId: string | null };

export interface BlindApplyGatePorts {
  authorization: BlindApplyAuthorizationFacts;
  current: BlindApplyCurrentFacts;
  /** The compiled policy covering this URL, if any. Must be the same lookup the executor uses. */
  resolvePolicy(url: string): ApplicationTargetPolicy | undefined;
  /** Whether this employer-and-role was already started, sent, tracked by hand or is in progress. */
  isDuplicate(candidate: BlindApplyCandidate): boolean;
  /** One bounded posting check. Only called when every earlier gate has passed. */
  checkLiveness(candidate: BlindApplyCandidate): Promise<BlindApplyLiveness>;
}

/** Whether a compiled policy permits unattended submission. Requires the terms register's clearance AND
 * the submit action itself; either one missing makes the target "Apply yourself". */
export function policyPermitsBlindSubmission(policy: ApplicationTargetPolicy): boolean {
  return policy.termsEligibleForAutomation === true && policy.allowedActions.includes('submit') && !policy.killSwitches.submit;
}

function evidenceOf(
  candidate: BlindApplyCandidate,
  extra: Partial<BlindApplyGateEvidence> = {},
): BlindApplyGateEvidence {
  return {
    family: candidate.family,
    filters: candidate.filters,
    linkStatus: candidate.linkStatus,
    policyId: null,
    livenessStatus: null,
    livenessVerificationId: null,
    duplicateCheck: 'clear',
    ...extra,
  };
}

export async function evaluateBlindApplyCandidate(
  candidate: BlindApplyCandidate,
  ports: BlindApplyGatePorts,
): Promise<BlindApplyGateDecision> {
  // B0: the whole feature, not this vacancy.
  const { authorization, current } = ports;
  if (!authorization.active) {
    return { kind: 'paused', reason: 'inactive', detail: 'Blind Apply is not turned on' };
  }
  if (current.cvContentHash === null || current.cvContentHash !== authorization.sourceCvContentHash) {
    return { kind: 'paused', reason: 'cv_changed', detail: 'Your CV changed after you turned Blind Apply on. Confirm it again to continue.' };
  }
  if (current.profileVersion !== authorization.profileVersion) {
    return { kind: 'paused', reason: 'profile_changed', detail: 'Your profile changed after you turned Blind Apply on. Confirm it again to continue.' };
  }

  // B1
  if (candidate.family === null || !authorization.roleFamilies.includes(candidate.family)) {
    return { kind: 'skip', reason: 'not_frontend', detail: 'Not a frontend role', evidence: evidenceOf(candidate) };
  }

  // B2: unknown is not a pass.
  if (candidate.filters !== 'eligible') {
    return {
      kind: 'skip',
      reason: 'filters',
      detail: candidate.filters === 'unknown' ? 'Your filters could not be confirmed for this role' : 'Outside your filters',
      evidence: evidenceOf(candidate),
    };
  }

  // B3 (link): a careers page or aggregator listing is not a place to apply.
  if (candidate.linkStatus !== 'verified') {
    return { kind: 'skip', reason: 'unverified_link', detail: 'The apply link is not confirmed', evidence: evidenceOf(candidate) };
  }

  // B4
  if (ports.isDuplicate(candidate)) {
    return {
      kind: 'skip',
      reason: 'duplicate',
      detail: 'You already applied or started this one',
      evidence: evidenceOf(candidate, { duplicateCheck: 'duplicate' }),
    };
  }

  // B3 (policy): no compiled policy that permits unattended submission means no work at all.
  const policy = ports.resolvePolicy(candidate.applyUrl);
  if (!policy || !policyPermitsBlindSubmission(policy)) {
    return {
      kind: 'apply_yourself',
      detail: 'This site is not set up for Blind Apply. Apply yourself.',
      evidence: evidenceOf(candidate, { policyId: policy?.id ?? null }),
    };
  }

  // B5: the only network call, last.
  const liveness = await ports.checkLiveness(candidate);
  const evidence = evidenceOf(candidate, {
    policyId: policy.id,
    livenessStatus: liveness.status,
    livenessVerificationId: liveness.verificationId,
  });
  if (liveness.status === 'closed') {
    return { kind: 'skip', reason: 'closed', detail: 'This posting is closed', evidence };
  }
  if (liveness.status !== 'open') {
    return { kind: 'skip', reason: 'unverifiable_posting', detail: 'This posting could not be confirmed open', evidence };
  }
  return { kind: 'eligible', policyId: policy.id, evidence };
}
