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
 * main process, and that is only safe while it never touches an Electron- or Node-only API. The
 * one `import type` below (`TailoredResume`) is erased entirely at compile time and carries no
 * runtime dependency, so it does not break that discipline.
 */

import type { TailoredResume } from '../resume-schema.js';

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
  /** ISO-8601, stamped at the moment of approval. Unlike `CvSourceDocument.reviewedAt` (main-
   * process-stamped, since that value is the export gate's *only* signal that a person reviewed a
   * source at all), this overlay's `state` field is the actual gate here (`updateCvEvidenceOverlay`
   * still accepts a renderer-supplied `state`, the same trust boundary `ComposedCvReview.tsx`'s own
   * approve action already operates inside), so `approvedAt` is a record of when, not a security
   * boundary of its own. Empty until `status` is `'candidate_approved'`. */
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

/** Which of the two ways a case can start: read from an existing OVR-discovered vacancy, or begun
 * from a job description a client pasted in directly with no vacancy behind it (#421's MCP case
 * contract -- an external client may propose a case from JD text alone). Distinct from how
 * `vacancyKey` itself is built (`vacancy-key.ts`'s `vacancyKeyFor`/`mintManualCaseKey`) so a
 * reader never has to parse the key's own string shape to answer "did a real vacancy back this". */
export type CvEvidenceOverlayOrigin = 'vacancy' | 'manual';

export const CV_EVIDENCE_OVERLAY_ORIGINS: readonly CvEvidenceOverlayOrigin[] = ['vacancy', 'manual'];

/** How a JD revision's text reached the case. */
export type CvJdOrigin = 'found' | 'pasted' | 'manual';

export const CV_JD_ORIGINS: readonly CvJdOrigin[] = ['found', 'pasted', 'manual'];

/** Why a JD was flagged incomplete. Mirrors `generation-input.ts`'s `JdIncompleteReason`, restated
 * here because this file carries no runtime imports. `no_posting_text` and `truncated_at_source`
 * can never be waived by the candidate; the other two are the "genuinely short" cases a candidate
 * may confirm complete after reading. */
export type CvJdIncompleteReason =
  | 'no_posting_text'
  | 'posting_text_too_thin'
  | 'no_requirements_captured'
  | 'truncated_at_source';

export const CV_JD_INCOMPLETE_REASONS: readonly CvJdIncompleteReason[] = [
  'no_posting_text',
  'posting_text_too_thin',
  'no_requirements_captured',
  'truncated_at_source',
];

/** Reasons the candidate cannot waive: there is nothing to confirm, or the text is known to stop
 * before the posting does. */
export const CV_JD_UNWAIVABLE_REASONS: readonly CvJdIncompleteReason[] = ['no_posting_text', 'truncated_at_source'];

/** One immutable capture of the JD text this overlay read, at some point in its life. Appended,
 * never edited or removed, whenever the JD text actually changes -- the same "a correction
 * supersedes, it never silently erases" discipline this module's header already states for facts
 * and wording. The last entry always mirrors the overlay's current `jdSnapshot`/`jdSnapshotHash`/
 * `jdComplete`; earlier entries exist so a requirement or fact captured against an older posting
 * can still be read against the exact wording it was captured from (#421: "retain immutable JD
 * revisions"), not just against whatever the JD currently says. */
export interface CvJdRevision {
  /** App-assigned, never derived from content -- the same discipline every other id in this module
   * follows. */
  revisionId: string;
  text: string;
  /** SHA-256 hex of `text`, supplied by the caller -- this file has no runtime crypto import. */
  textHash: string;
  complete: boolean;
  /** ISO-8601, when this revision was captured. */
  capturedAt: string;
  /** Where this text came from: read from a found vacancy, pasted or replaced by the candidate on a
   * found vacancy, or entered by hand for a manual case. Absent on a revision stored before this
   * field existed; `toCvEvidenceOverlay` fills it in on read. */
  origin: CvJdOrigin;
  /** The posting URL the candidate or the discovery result supplied, if any. Never fetched. */
  url: string;
  /** The employer's requisition or reference number, if the candidate supplied one. */
  requisition: string;
  /** Why the completeness heuristic flagged this text (`JdIncompleteReason` values plus
   * `'truncated_at_source'` when a caller reported a source-side cut). Empty when nothing was
   * flagged. */
  incompleteReasons: CvJdIncompleteReason[];
  /** The heuristic's own sentence(s), kept apart from `complete` and from the candidate's
   * confirmation. Empty when nothing was flagged. */
  warning: string;
}

/**
 * An immutable copy of the exact `TailoredResume` a candidate approved, taken at the moment
 * `state` moved to `'candidate_approved'` -- #421's `read_approved_resume` MCP tool reads this
 * rather than recomposing on every call, so a client with final-snapshot permission sees a fixed
 * artifact rather than one that could shift under it between reads. `caseRevision` records which
 * case revision this snapshot belongs to, stamped by the write layer at approval time, never by
 * the caller (the same "app assigns ids, never the caller" discipline generalized to a revision
 * number). A later case mutation invalidates `state` the same way it always has
 * (`invalidatedOverlayState`); nothing here re-reads this snapshot once stale, it is left in place
 * as the historical record of what was approved.
 */
export interface CvApprovedResumeSnapshot {
  resume: TailoredResume;
  /** SHA-256 hex of the resume's own serialization, supplied by the caller. */
  digest: string;
  /** ISO-8601 */
  approvedAt: string;
  /** The `caseRevision` this snapshot was approved against. */
  caseRevision: string;
}

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
  /** The full JD text this overlay read, exactly as captured -- not a truncated excerpt. Always
   * equal to `jdRevisions.at(-1).text`; kept as its own field rather than derived on every read
   * because nearly every existing reader (`RequirementMapping.tsx`, `describeCvEvidenceOverlayGaps`)
   * only ever needs the current text, not the history. */
  jdSnapshot: string;
  /** SHA-256 hex of `jdSnapshot`. */
  jdSnapshotHash: string;
  /** Whether `jdSnapshot` is believed complete, or was truncated by a source-side limit. */
  jdComplete: boolean;
  /** The completeness heuristic's findings for the current `jdSnapshot`, kept apart from
   * `jdComplete` and from `jdConfirmedComplete`. See `CvJdRevision.incompleteReasons`. */
  jdIncompleteReasons: CvJdIncompleteReason[];
  /** The heuristic's own sentence(s) for the current `jdSnapshot`; empty when nothing was flagged. */
  jdWarning: string;
  /** The candidate read the whole JD and says a short one is complete. Reset to `false` whenever
   * the JD text changes. It never overrides an empty or known-truncated JD. */
  jdConfirmedComplete: boolean;
  /** #421's case contract: every past version of `jdSnapshot`, oldest first, the last entry always
   * mirroring the three fields above. See `CvJdRevision`. */
  jdRevisions: CvJdRevision[];
  listingStatus: CvListingStatus;
  state: CvEvidenceOverlayState;
  requirements: CvRequirementMapping[];
  facts: CvEvidenceFact[];
  wordingVariants: CvApprovedWording[];
  /** #421's case contract: how this case began. See `CvEvidenceOverlayOrigin`. */
  origin: CvEvidenceOverlayOrigin;
  /** #421's case contract: a value that changes whenever any field on this overlay changes,
   * stamped by the write layer (never the caller) on every write. Distinct from
   * `sourceCvContentHash`, which is an *input* digest (of the reviewed source CV only) rather than
   * a record of this case's own write history -- an MCP tool's revision check is against this
   * field, not that one. Monotonically increasing, but callers should treat it as an opaque token
   * to compare for equality, not as an arithmetic value. */
  caseRevision: string;
  /** #421's case contract: the exact resume a candidate approved, frozen at the moment `state`
   * moved to `'candidate_approved'`. `null` until the first approval. See
   * `CvApprovedResumeSnapshot`. */
  approvedResumeSnapshot: CvApprovedResumeSnapshot | null;
}

export const EMPTY_CV_EVIDENCE_OVERLAY: CvEvidenceOverlay = {
  sourceCvContentHash: '',
  jdSnapshot: '',
  jdSnapshotHash: '',
  jdComplete: true,
  jdIncompleteReasons: [],
  jdWarning: '',
  jdConfirmedComplete: false,
  jdRevisions: [],
  listingStatus: 'unknown',
  state: 'needs_input',
  requirements: [],
  facts: [],
  wordingVariants: [],
  origin: 'vacancy',
  caseRevision: '0',
  approvedResumeSnapshot: null,
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
  reasons.push(...describeCvJdGaps(overlay));
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

/**
 * Why the current JD cannot back an approved CV (#419 step 4). An empty JD and a JD known to stop
 * before the posting does can never be approved against. A JD the heuristic flagged as thin or
 * requirement-free needs the candidate's own confirmation after reading it; the heuristic's
 * warning stays on record either way. A row stored before completeness was assessed has no
 * reasons and falls through to the legacy `jdComplete` flag.
 */
export function describeCvJdGaps(
  overlay: Pick<CvEvidenceOverlay, 'jdSnapshot' | 'jdComplete' | 'jdIncompleteReasons' | 'jdConfirmedComplete'>,
): string[] {
  if (overlay.jdSnapshot.trim().length === 0) {
    return ['there is no job description text yet, so nothing can be approved against it'];
  }
  if (overlay.jdIncompleteReasons.includes('truncated_at_source')) {
    return ['the job description is cut off, so paste the full text before approving'];
  }
  if (overlay.jdIncompleteReasons.length > 0) {
    return overlay.jdConfirmedComplete
      ? []
      : ['the job description looks incomplete and you have not confirmed it is complete after reading it'];
  }
  return overlay.jdComplete ? [] : ['the job description was not read in full'];
}

export function isCvEvidenceOverlayApprovable(overlay: CvEvidenceOverlay, currentSourceCvContentHash: string): boolean {
  return describeCvEvidenceOverlayGaps(overlay, currentSourceCvContentHash).length === 0;
}

/**
 * Composes one fact's own words into one candidate CV sentence -- mechanically, never by an AI
 * paraphrase: every word here already came from the candidate's own clarification answer
 * (`activity`/`mechanism`/`result`), just joined into a sentence shape a CV bullet reads as. This
 * is what step 4 of #419 calls "proposed claim-bearing text": the thing a person reviews and
 * explicitly approves before it can reach a claim-bearing field, never text that reaches one on
 * its own.
 */
export function deriveWordingFromFact(fact: CvEvidenceFact): string {
  const parts = [fact.activity.trim()];
  if (fact.mechanism.trim()) parts.push(`using ${fact.mechanism.trim()}`);
  let sentence = parts.join(', ');
  if (fact.result.trim()) sentence = `${sentence}, ${fact.result.trim()}`;
  return sentence;
}

/**
 * Proposes one approved-wording variant per self-reported fact that has none yet (#419, step 4).
 * Only `self_reported` facts propose wording: `candidate_confirmed_gap` is the candidate saying
 * they did *not* do the thing, and `corroborated` facts (independently verified, not from a
 * clarification answer) are not yet wired to this path. A fact that already backs an existing
 * `wordingVariant` (by `factIds`) is never proposed a second time, so re-running this after an
 * earlier approval does not offer to re-approve the same ground twice.
 *
 * Each proposal is emitted already `status: 'candidate_approved'`, scoped to
 * `currentSourceCvContentHash`: the caller (the composition/approval review screen) shows the
 * candidate exactly this text, composed into the full CV preview, and only persists it at the
 * moment the candidate approves *that* preview -- so "propose" and "approve" are the same action
 * here by construction, not two separate steps that could drift apart. See
 * `ComposedCvReview.tsx`'s own doc comment for how the preview and the persisted approval stay the
 * same text.
 */
export function proposeWordingFromFacts(
  overlay: CvEvidenceOverlay,
  currentSourceCvContentHash: string,
): CvApprovedWording[] {
  const alreadyGrounded = new Set(overlay.wordingVariants.flatMap((variant) => variant.factIds));
  const now = new Date().toISOString();
  return overlay.facts
    .filter((fact) => fact.verification === 'self_reported' && !alreadyGrounded.has(fact.factId))
    .map((fact) => ({
      variantId: crypto.randomUUID(),
      targetField: fact.parentType === 'project' ? 'project_description' : 'experience_bullet',
      parentId: fact.parentId,
      text: deriveWordingFromFact(fact),
      factIds: [fact.factId],
      status: 'candidate_approved',
      approvedAt: now,
      sourceRevision: currentSourceCvContentHash,
    }));
}

/**
 * A stable identity string for one vacancy lead, so per-vacancy state (#419's evidence overlay)
 * has something to key on. Takes a minimal structural shape rather than importing the renderer's
 * own `VacancyLead` type, so this file's "no runtime imports" discipline extends to type imports
 * too -- every real `VacancyLead` already has these four fields, so passing one here needs no cast.
 *
 * The source URL wins whenever one exists: it is exactly what a real posting resolves to, and two
 * leads with the same URL are the same vacancy by construction. Only a hand-entered vacancy with no
 * URL falls back to a normalized role/company/location composite, normalized case- and
 * whitespace-insensitively so two spellings of the same vacancy still key together.
 *
 * Moved here from the renderer's own `vacancy-key.ts` (#421) so Electron main (the MCP tool
 * handlers starting a case from a vacancy reference) can call it too, without main importing from
 * `src/` -- the same "dependency-free shared module lives under `electron/workspace`, the renderer
 * imports from there" direction `resume-source.ts`/`cv-source-schema.ts` already establish.
 * `src/components/cv/vacancy-key.ts` re-exports this unchanged.
 */
export function vacancyKeyFor(vacancy: { title: string; company: string; location: string; url: string }): string {
  const url = vacancy.url.trim();
  if (url.length > 0) return `url:${url}`;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/gu, ' ');
  return `fields:${normalize(vacancy.title)}|${normalize(vacancy.company)}|${normalize(vacancy.location)}`;
}

/**
 * A stable key for a case with no vacancy behind it at all -- #421's MCP case contract, where an
 * external client may start a case from pasted JD text alone. Freshly minted per call, never
 * derived from the JD text itself: two cases started from identical JD text are still two distinct
 * cases the candidate may want to track separately, the same "app assigns ids, never derives them
 * from content" discipline this module already follows for `factId`/`variantId`. The `manual:`
 * prefix can never collide with `vacancyKeyFor`'s own `url:`/`fields:` prefixes.
 */
export function mintManualCaseKey(): string {
  return `manual:${crypto.randomUUID()}`;
}

/**
 * The new `jdRevisions` history after a JD-text write, appending a fresh immutable revision only
 * when the text actually changed -- a write that merely re-sends today's own JD text (an
 * idempotent retry, or a caller that always includes it) must not pad the history with an
 * identical entry. `capturedAt` is supplied by the caller, the same "no runtime clock" discipline
 * `createdAt`/`approvedAt` already follow elsewhere in this module (`new Date()` itself is a plain
 * JS global, not an Electron/Node-only API, so calling it here does not break the file's "no
 * runtime imports" discipline the way reading a clock through `node:` would).
 */
export interface CvJdRevisionMeta {
  origin: CvJdOrigin;
  url: string;
  requisition: string;
  incompleteReasons: CvJdIncompleteReason[];
  warning: string;
}

export function withJdRevision(
  overlay: CvEvidenceOverlay,
  text: string,
  textHash: string,
  complete: boolean,
  capturedAt: string,
  meta: Partial<CvJdRevisionMeta> = {},
): CvJdRevision[] {
  if (text === overlay.jdSnapshot && textHash === overlay.jdSnapshotHash && complete === overlay.jdComplete) {
    return overlay.jdRevisions;
  }
  return [
    ...overlay.jdRevisions,
    {
      revisionId: crypto.randomUUID(),
      text,
      textHash,
      complete,
      capturedAt,
      origin: meta.origin ?? 'found',
      url: meta.url ?? '',
      requisition: meta.requisition ?? '',
      incompleteReasons: meta.incompleteReasons ?? [],
      warning: meta.warning ?? '',
    },
  ];
}

/** The JSON shape the requirement-mapping extraction prompt asks for, and the shape the response
 * coercion reads back (`requirement-mapping-response.ts`) -- the same one-dependency-free-file
 * discipline `CV_SOURCE_JSON_SHAPE` follows. `requirementId`/`candidateAdded`/`reviewed` are absent
 * on purpose: the app assigns the id and owns the review/candidate-added flags, so a model is
 * never asked for any of them. */
export const CV_REQUIREMENT_MAPPING_JSON_SHAPE =
  '{"requirements": [{"text": string, "jdAnchor": string, ' +
  '"classification": "required" | "preferred" | "unclear", ' +
  '"evidenceClass": "direct" | "transferable" | "unsupported" | "needs_verification", ' +
  '"anchorParentId": string}]}';

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
