import {
  EMPTY_CV_EVIDENCE_OVERLAY,
  type CvApprovedWording,
  type CvEvidenceFact,
  type CvEvidenceOverlay,
  type CvJdRevision,
  type CvRequirementMapping,
} from '../../electron/workspace/cv-evidence-schema.js';

/**
 * Synthetic builders for the #419 evidence records, so a test states only the fields it is about.
 * The defaults describe a well-formed, already-reviewed record: a requirement with a verified quote
 * in the fixture JD, an approved fact, an approved wording variant, and complete requirement
 * coverage for the fixture's one JD revision.
 */

export const FIXTURE_HASH = 'a'.repeat(64);
export const FIXTURE_REVISION_ID = 'rev-1';
/** The text `makeRequirement`'s default quote is found in, at offset 0. */
export const FIXTURE_JD = 'Experience with React is required. The team also values Angular.';

export function makeRevision(partial: Partial<CvJdRevision> = {}): CvJdRevision {
  return {
    revisionId: FIXTURE_REVISION_ID,
    text: FIXTURE_JD,
    textHash: 'b'.repeat(64),
    complete: true,
    capturedAt: '2026-09-30T00:00:00.000Z',
    origin: 'found',
    url: '',
    requisition: '',
    incompleteReasons: [],
    warning: '',
    ...partial,
  };
}

export function makeRequirement(partial: Partial<CvRequirementMapping> = {}): CvRequirementMapping {
  return {
    requirementId: 'r-1',
    text: 'Experience with React',
    jdAnchor: 'Experience with React',
    classification: 'required',
    evidenceClass: 'direct',
    anchorParentId: 'experience-1',
    candidateAdded: false,
    reviewed: true,
    quoteStart: 0,
    quoteEnd: 'Experience with React'.length,
    jdRevisionId: FIXTURE_REVISION_ID,
    excluded: false,
    exclusionReason: '',
    sourceIds: [],
    factIds: [],
    ...partial,
  };
}

export function makeFact(partial: Partial<CvEvidenceFact> = {}): CvEvidenceFact {
  return {
    factId: 'fact-1',
    parentId: 'experience-1',
    parentType: 'experience',
    client: '',
    activity: 'Built the booking screens',
    mechanism: 'Angular and RxJS',
    result: '',
    ownership: 'sole',
    sourceKind: 'candidate_testimony',
    sourceReference: '',
    verification: 'self_reported',
    metricValue: '',
    metricUnit: '',
    metricBasis: '',
    supersedes: '',
    createdAt: '2026-09-30T00:00:00.000Z',
    approval: 'approved',
    timePhase: '',
    ...partial,
  };
}

export function makeVariant(partial: Partial<CvApprovedWording> = {}): CvApprovedWording {
  return {
    variantId: 'v-1',
    targetField: 'summary',
    parentId: '',
    text: 'Approved wording.',
    factIds: ['fact-1'],
    status: 'candidate_approved',
    approvedAt: '2026-09-30T00:00:00.000Z',
    sourceRevision: FIXTURE_HASH,
    supersedes: '',
    rejectedAt: '',
    ...partial,
  };
}

/** A complete, approvable overlay: one JD revision, coverage confirmed for it, no records yet. */
export function makeOverlay(partial: Partial<CvEvidenceOverlay> = {}): CvEvidenceOverlay {
  return {
    ...EMPTY_CV_EVIDENCE_OVERLAY,
    sourceCvContentHash: FIXTURE_HASH,
    jdSnapshot: FIXTURE_JD,
    jdRevisions: [makeRevision()],
    requirementCoverage: { status: 'complete', revisionId: FIXTURE_REVISION_ID, batches: 1 },
    ...partial,
  };
}
