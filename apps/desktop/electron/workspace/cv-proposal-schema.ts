/**
 * #421: the staging layer for anything an MCP client proposes -- a requirement, a link from a
 * requirement to existing source evidence, a fact (claimed candidate testimony), a piece of CV
 * wording. There is deliberately no "selection" kind: which projects a CV shows comes from the
 * source's pins and project limit and is approved by the candidate (`approveCvProjectSelection`),
 * so a client-proposed scope had nothing to attach to (#436).
 *
 * Deliberately never the same structures #419's `cv-evidence-schema.ts` owns. #421's own words:
 * "every submitted item remains 'proposed' until the candidate reviews it" and "a model-supplied
 * id is never proof" -- nothing an external client sends reaches a real
 * `CvRequirementMapping`/`CvEvidenceFact`/`CvApprovedWording` until a person explicitly accepts it
 * here, through this module's own review path, never automatically. `acceptCvTailoringProposal`
 * (`repository.ts`) is the only place a proposal's content crosses into the real overlay.
 *
 * Every payload shape below is deliberately *not* the same type as the real record it promotes
 * into: a proposal is missing exactly the fields only a person or the app itself may set
 * (`requirementId`/`factId`/`variantId`, `candidateAdded`, `reviewed`, `verification`, wording
 * `status`/`approvedAt`). A client cannot propose those because the type has no field for them,
 * the same discipline every other "app assigns this, never the caller" id in this codebase follows.
 *
 * Same "no runtime imports" discipline as `cv-evidence-schema.ts`/`mcp-grant-schema.ts`: read by
 * the renderer (the proposal review panel) and by Electron main (the MCP tool handlers that create
 * these, and the acceptance logic that promotes one).
 */

import type { CvClaimField, CvEvidenceClass, CvFactOwnership, CvRequirementClassification } from './cv-evidence-schema.js';

export type CvProposalKind = 'requirement' | 'evidence_link' | 'clarification_question' | 'fact' | 'wording';

export const CV_PROPOSAL_KINDS: readonly CvProposalKind[] = [
  'requirement',
  'evidence_link',
  'clarification_question',
  'fact',
  'wording',
];

export type CvProposalStatus = 'pending' | 'accepted' | 'rejected';

export const CV_PROPOSAL_STATUSES: readonly CvProposalStatus[] = ['pending', 'accepted', 'rejected'];

export const CV_PROPOSAL_LIMITS = {
  question: 2_000,
  factIdsPerProposal: 20,
} as const;

/** Promotes into a `CvRequirementMapping` on acceptance; the app assigns `requirementId`, sets
 * `candidateAdded: true` (a person chose to accept it, the same signal a hand-typed addition
 * gives), and `reviewed: false` (acceptance is not the same act as reviewing its evidence class). */
export interface CvRequirementProposalPayload {
  text: string;
  jdAnchor: string;
  classification: CvRequirementClassification;
  evidenceClass: CvEvidenceClass;
  anchorParentId: string;
}

/** Promotes by patching an *existing* requirement's `anchorParentId`/`evidenceClass` in place --
 * `requirementId` must already exist in the case, checked at proposal-creation time, not only at
 * acceptance (#421: "invented fact IDs... fail without changing approved state", generalized here
 * to any referenced id this module accepts). */
export interface CvEvidenceLinkProposalPayload {
  requirementId: string;
  anchorParentId: string;
  evidenceClass: CvEvidenceClass;
}

/** Has no structural effect of its own on acceptance beyond flagging the named requirement as
 * needing the candidate's attention (`evidenceClass: 'needs_verification'`) -- answering the
 * question itself still goes through the existing clarification flow in the app, never through
 * this proposal's own acceptance. */
export interface CvClarificationQuestionProposalPayload {
  requirementId: string;
  question: string;
}

/** Promotes into a `CvEvidenceFact` only once a person reviews and accepts it here, and arrives
 * `approval: 'proposed'`, `verification: 'unreviewed'`, `sourceKind: 'mcp_proposal'` (#436). Only
 * the candidate approving the fact in the evidence review makes it `self_reported` testimony, never
 * the client's own claim about what the candidate said (#421: "new self-reported facts require the
 * candidate to answer in OVR"). A client cannot propose a `repository_inspection` fact, which has
 * no client-facing proposal shape at all. */
export interface CvFactProposalPayload {
  parentId: string;
  parentType: 'experience' | 'project';
  client: string;
  activity: string;
  mechanism: string;
  result: string;
  ownership: CvFactOwnership;
  sourceReference: string;
  metricValue: string;
  metricUnit: string;
  metricBasis: string;
}

/** Promotes into a `CvApprovedWording` with `status: 'draft'` on acceptance: accepting puts the
 * wording in front of the candidate, and approving its exact text is a separate per-variant step
 * (#419 step 7). The whole case's own `state` still only moves to `'candidate_approved'` through
 * `approveCvEvidenceOverlay`. Every `factIds` entry must already exist on the case at
 * proposal-creation time. */
export interface CvWordingProposalPayload {
  targetField: CvClaimField;
  parentId: string;
  text: string;
  factIds: string[];
}

export type CvProposalPayload =
  | { kind: 'requirement'; data: CvRequirementProposalPayload }
  | { kind: 'evidence_link'; data: CvEvidenceLinkProposalPayload }
  | { kind: 'clarification_question'; data: CvClarificationQuestionProposalPayload }
  | { kind: 'fact'; data: CvFactProposalPayload }
  | { kind: 'wording'; data: CvWordingProposalPayload };

export interface CvTailoringProposal {
  id: string;
  caseId: string;
  /** Which grant proposed this -- shown back to the candidate in the review panel, never a value
   * the client itself supplied. */
  grantId: string;
  status: CvProposalStatus;
  payload: CvProposalPayload;
  /** The case's `caseRevision` at the moment this was proposed -- lets the review panel flag a
   * proposal made against a since-changed case, the same staleness concern `CvApprovedWording
   * .sourceRevision` already tracks for approved wording. */
  caseRevisionAtProposal: string;
  createdAt: string;
  /** ISO-8601, or `''` while `status === 'pending'`. */
  decidedAt: string;
}
