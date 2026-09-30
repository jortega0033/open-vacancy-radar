/**
 * The reviewable requirement -> evidence -> clarification -> approved-wording overlay for one
 * (CV, vacancy) tailoring session (#419).
 *
 * `CvSourceDocument` (`cv-source-schema.ts`) is the candidate's own reviewed document: real
 * employers, real projects, real dates, in the candidate's own words. Nothing in this module ever
 * edits that document. What lives here instead is *evidence about* it -- a clarification the
 * candidate gave when asked what they personally did on a role or project, and the exact wording
 * a person explicitly approved for a CV field, both scoped back to one `CvSourceExperienceEntry`
 * or `CvSourceProjectEntry` id. A tailored CV field can only ever be unchanged reviewed source
 * text, or text a candidate approved here; nothing else may reach a claim-bearing field. This
 * module carries no opinion on how that enforcement runs (that belongs to the composition gate
 * slice 3 builds) -- it only defines the shape that gate reads.
 *
 * Three properties this shape exists to guarantee, mirroring `cv-source-schema.ts`'s own header:
 *
 * 1. **A JD may steer emphasis, never author a claim.** Nothing here lets a requirement's own
 *    wording become a fact. A fact's `activity`/`mechanism`/`result` are always the candidate's
 *    own words, given in answer to a question the JD prompted, never copied from the JD itself.
 * 2. **Self-reported and independently corroborated are different states, always labelled.** A
 *    fact's `verification` says which one it is; nothing here ever upgrades one to the other on
 *    its own.
 * 3. **A correction supersedes, it never silently erases.** `CvEvidenceFact.supersedes` and
 *    `CvApprovedWording.status` exist so a stale answer can be replaced without deleting the
 *    record of what it replaced.
 *
 * Deliberately no runtime imports, the same discipline `cv-source-schema.ts` and
 * `cv-profile-schema.ts` follow: this file is bundled into both the renderer and the Electron
 * main process, and that is only safe while it never touches an Electron- or Node-only API.
 */

/** Whether a candidate's testimony has been independently corroborated. `self_reported` is the
 * default and the common case; upgrading it is a deliberate, separate action, never implicit in
 * giving an answer. `candidate_confirmed_gap` is not a lesser verification state -- it is the
 * candidate explicitly saying "I did not do this", which is itself a fact worth recording so the
 * same question is never asked again as if unanswered. */
export type CvFactVerification = 'self_reported' | 'candidate_confirmed_gap' | 'corroborated';

export const CV_FACT_VERIFICATIONS: readonly CvFactVerification[] = [
  'self_reported',
  'candidate_confirmed_gap',
  'corroborated',
];

/** Whether the candidate did this alone or as part of a team. Distinct from `verification`: a
 * corroborated fact can still have been shared work, and ownership never upgrades or downgrades
 * how well-evidenced a fact is. */
export type CvFactOwnership = 'sole' | 'shared' | 'unknown';

export const CV_FACT_OWNERSHIPS: readonly CvFactOwnership[] = ['sole', 'shared', 'unknown'];

/** Where a fact's content came from. `repository_inspection` can corroborate implementation
 * details given a pinned revision and a relevant call path -- it cannot by itself establish
 * authorship or that the code ran in production, which is why `verification` and `sourceKind`
 * are separate fields rather than one implying the other. */
export type CvFactSourceKind = 'candidate_testimony' | 'repository_inspection';

export const CV_FACT_SOURCE_KINDS: readonly CvFactSourceKind[] = [
  'candidate_testimony',
  'repository_inspection',
];

export interface CvEvidenceFact {
  /** Stable across edits, the same guarantee every other id in this module makes. Assigned by the
   * app, never by the model. */
  factId: string;
  /** A `CvSourceExperienceEntry.id` or `CvSourceProjectEntry.id`: which role or project this fact
   * is evidence for. */
  parentId: string;
  parentType: 'experience' | 'project';
  /** The end client this fact concerns, when `parentId` is a client engagement. Empty otherwise --
   * mirrors `CvSourceExperienceEntry.client`'s own reasoning: never folded into another field. */
  client: string;
  /** What the candidate personally did, in their own words. */
  activity: string;
  /** How, including the actual tools/mechanics and scope. Empty when not yet answered -- an
   * unknown mechanism stays unstated rather than inferred. */
  mechanism: string;
  /** The result, or why it mattered. Empty when not known; never a number inferred from test
   * counts, repository activity, or a deployed URL (see `metricBasis`). */
  result: string;
  ownership: CvFactOwnership;
  sourceKind: CvFactSourceKind;
  /** A pinned commit/revision and call path for `repository_inspection`; free text describing the
   * answer's context for `candidate_testimony`. */
  sourceReference: string;
  verification: CvFactVerification;
  /** Empty unless a number is actually part of this fact. When set, `metricBasis` must say where
   * it came from -- a metric with no stated basis is not permitted to reach a wording variant. */
  metricValue: string;
  metricUnit: string;
  /** What grounds `metricValue`: a candidate-confirmed figure, or a primary measurement, never a
   * proxy the app inferred on its own. */
  metricBasis: string;
  /** The `factId` this fact replaces. Empty for a fresh fact. The superseded fact is kept, not
   * deleted -- this field is what turns "replace" into an auditable action instead of data loss. */
  supersedes: string;
  createdAt: string;
}

export type CvClaimField = 'summary' | 'skill' | 'experience_bullet' | 'project_description';

export const CV_CLAIM_FIELDS: readonly CvClaimField[] = [
  'summary',
  'skill',
  'experience_bullet',
  'project_description',
];

export type CvWordingApprovalStatus = 'draft' | 'candidate_approved' | 'rejected';

export const CV_WORDING_APPROVAL_STATUSES: readonly CvWordingApprovalStatus[] = [
  'draft',
  'candidate_approved',
  'rejected',
];

export interface CvApprovedWording {
  variantId: string;
  targetField: CvClaimField;
  /** The `CvSourceExperienceEntry.id`/`CvSourceProjectEntry.id` this wording is scoped to, or
   * empty for a summary/skill variant that is not tied to one entry. A composed CV field may only
   * use a variant whose scope matches (or is empty for) the field it is filling -- this is what
   * "approved variants stay linked to their original role/project" (#419) means in data terms. */
  parentId: string;
  /** The exact text a person approved. What the composition gate is permitted to place in a
   * claim-bearing CV field verbatim -- never a paraphrase of it. */
  text: string;
  /** Every `CvEvidenceFact.factId` this wording is grounded in. A variant with an empty list is
   * never approvable (see `describeCvApprovedWordingGaps`): every claim-bearing sentence must
   * trace to at least one fact. */
  factIds: string[];
  status: CvWordingApprovalStatus;
  /** ISO-8601, stamped by the main process from its own clock on approval, never renderer-supplied
   * -- the same rule `CvSourceDocument.reviewedAt` already follows and for the same reason: "a
   * person approved this exact text" is the one claim the export gate relies on. Empty until
   * `status` is `'candidate_approved'`. */
  approvedAt: string;
  /** The `CvSourceDocument.reviewedAt` this variant was approved against. A later re-review of the
   * source (a new `reviewedAt`) means this variant's grounding has not been re-confirmed against
   * the current source, and `describeCvEvidenceOverlayGaps` treats it as stale. */
  sourceRevision: string;
}

export type CvRequirementClassification = 'required' | 'preferred' | 'unclear';

export const CV_REQUIREMENT_CLASSIFICATIONS: readonly CvRequirementClassification[] = [
  'required',
  'preferred',
  'unclear',
];

/** Kept distinct from #361's advisory ATS-fit wording on purpose (#419's own instruction): that
 * feature explains a fit percentage after the fact, this classifies what is *permitted to be
 * claimed* before anything is written. `unsupported` means no CV claim is permitted on current
 * evidence -- it says nothing about whether the candidate actually has the ability, which is why
 * it is a distinct state from `needs_verification` (not yet asked) rather than one bucket. */
export type CvEvidenceClass = 'direct' | 'transferable' | 'unsupported' | 'needs_verification';

export const CV_EVIDENCE_CLASSES: readonly CvEvidenceClass[] = [
  'direct',
  'transferable',
  'unsupported',
  'needs_verification',
];

export interface CvRequirementMapping {
  requirementId: string;
  /** The requirement's own wording, exactly as read from the JD. */
  text: string;
  /** Where in the JD this requirement came from -- a quoted phrase or section label, so a person
   * reviewing the mapping can find it in the source posting. */
  jdAnchor: string;
  classification: CvRequirementClassification;
  evidenceClass: CvEvidenceClass;
  /** A `CvSourceExperienceEntry.id`/`CvSourceProjectEntry.id` the mapping points to, or empty for
   * `evidenceClass: 'unsupported'` (`none`, in #419's own words). */
  anchorParentId: string;
  /** True when the candidate added or corrected this requirement rather than the model having
   * extracted it -- #419 requires the candidate be able to add a requirement the model missed, and
   * this is how a reviewer can tell which requirements that happened for. */
  candidateAdded: boolean;
  /** Whether the candidate has looked at this specific mapping. A requirement can exist (extracted
   * or candidate-added) and still be unreviewed; #419's "no complete-coverage language while any
   * material requirement remains unreviewed" reads this flag, not just array membership. */
  reviewed: boolean;
}

export type CvEvidenceOverlayState =
  | 'needs_input'
  | 'conflict'
  | 'draft'
  | 'candidate_approved'
  | 'qa_failed'
  | 'artifact_approved';

export const CV_EVIDENCE_OVERLAY_STATES: readonly CvEvidenceOverlayState[] = [
  'needs_input',
  'conflict',
  'draft',
  'candidate_approved',
  'qa_failed',
  'artifact_approved',
];

export type CvListingStatus = 'open' | 'closed' | 'unknown';

export const CV_LISTING_STATUSES: readonly CvListingStatus[] = ['open', 'closed', 'unknown'];

/**
 * One (CV, vacancy) tailoring session's full reviewable state. Not a replacement for
 * `CvSourceDocument`: this is the vacancy-specific overlay on top of it, the way an
 * `applicationAttempts` row is a vacancy-specific snapshot on top of `cvDocuments` (#198's own
 * precedent for freezing a JD snapshot and hashing a source CV against drift).
 */
export interface CvEvidenceOverlay {
  /** SHA-256 hex of the `CvSourceDocument` this overlay was built from (the same content-hash
   * discipline `applicationAttempts.sourceCvContentHash` already uses). A source edited after this
   * overlay was built no longer matches, and every fact/wording variant scoped to the changed
   * entry needs re-confirming before the overlay can be approved again. */
  sourceCvContentHash: string;
  /** The full JD text this overlay read, exactly as captured -- not a truncated excerpt. */
  jdSnapshot: string;
  /** SHA-256 hex of `jdSnapshot`. */
  jdSnapshotHash: string;
  /** Whether `jdSnapshot` is believed complete, or was truncated by a source-side limit. */
  jdComplete: boolean;
  listingStatus: CvListingStatus;
  state: CvEvidenceOverlayState;
  requirements: CvRequirementMapping[];
  facts: CvEvidenceFact[];
  wordingVariants: CvApprovedWording[];
}

export const EMPTY_CV_EVIDENCE_OVERLAY: CvEvidenceOverlay = {
  sourceCvContentHash: '',
  jdSnapshot: '',
  jdSnapshotHash: '',
  jdComplete: true,
  listingStatus: 'unknown',
  state: 'needs_input',
  requirements: [],
  facts: [],
  wordingVariants: [],
};

/** Field size budgets, the same two-tier discipline (generous for real content, finite against a
 * hostile caller) `CV_SOURCE_LIMITS` already uses. */
export const CV_EVIDENCE_LIMITS = {
  /** factId / parentId / client / sourceReference / metricValue / metricUnit / metricBasis /
   * variantId / requirementId / jdAnchor */
  shortField: 512,
  activity: 2_000,
  mechanism: 2_000,
  result: 2_000,
  wordingText: 4_000,
  requirementText: 2_000,
  facts: 300,
  wordingVariants: 300,
  requirements: 200,
  factIdsPerVariant: 20,
} as const;

/**
 * Every reason this overlay must not back a final artifact, in the user's terms. Mirrors
 * `describeCvSourceGaps`'s own contract: reasons, not a boolean, because the whole point of
 * blocking is that the caller must be able to say what would fix it.
 *
 * `currentSourceCvContentHash` is the *current* source's hash, supplied by the caller rather than
 * recomputed here (this file has no runtime crypto import, by design) -- see this module's header.
 */
export function describeCvEvidenceOverlayGaps(
  overlay: CvEvidenceOverlay,
  currentSourceCvContentHash: string,
): string[] {
  const reasons: string[] = [];
  if (overlay.sourceCvContentHash !== currentSourceCvContentHash) {
    reasons.push('the reviewed source CV has changed since this draft was built');
  }
  if (!overlay.jdComplete) {
    reasons.push('the job description was not read in full');
  }
  const unreviewed = overlay.requirements.filter((requirement) => !requirement.reviewed);
  if (unreviewed.length > 0) {
    reasons.push(`${unreviewed.length} requirement(s) have not been reviewed`);
  }
  const unresolvedRequired = overlay.requirements.filter(
    (requirement) =>
      requirement.classification === 'required' &&
      requirement.reviewed &&
      requirement.evidenceClass === 'needs_verification',
  );
  if (unresolvedRequired.length > 0) {
    reasons.push(`${unresolvedRequired.length} required item(s) still need verification`);
  }
  const approvedVariants = overlay.wordingVariants.filter((variant) => variant.status === 'candidate_approved');
  const staleVariants = approvedVariants.filter((variant) => variant.sourceRevision !== overlay.sourceCvContentHash);
  if (staleVariants.length > 0) {
    reasons.push(`${staleVariants.length} approved wording variant(s) were approved against a different source revision`);
  }
  const ungroundedVariants = approvedVariants.filter((variant) => variant.factIds.length === 0);
  if (ungroundedVariants.length > 0) {
    reasons.push(`${ungroundedVariants.length} approved wording variant(s) cite no supporting fact`);
  }
  if (overlay.state === 'conflict') {
    reasons.push('unresolved conflicting corrections remain');
  }
  return reasons;
}

export function isCvEvidenceOverlayApprovable(overlay: CvEvidenceOverlay, currentSourceCvContentHash: string): boolean {
  return describeCvEvidenceOverlayGaps(overlay, currentSourceCvContentHash).length === 0;
}

/**
 * The state a fresh read/refresh should carry, given whatever change was detected. #419: "a
 * refresh must show what changed and allow review; do not silently carry forward an approval" --
 * so any drift from `'candidate_approved'`/`'artifact_approved'` drops back to `'draft'` rather
 * than staying approved against inputs that moved.
 */
export function invalidatedOverlayState(current: CvEvidenceOverlayState): CvEvidenceOverlayState {
  return current === 'candidate_approved' || current === 'artifact_approved' || current === 'qa_failed'
    ? 'draft'
    : current;
}
