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
import type { CvSourceDocument } from './cv-source-schema.js';

/**
 * The version of the resume render contract: the shape `TailoredResume` is rendered from and the
 * template/validation rules that turn it into a PDF or DOCX. It is stored with every approved
 * snapshot so that a later renderer change can mark a saved artifact's verification as outdated
 * without touching the candidate's factual approval (#419: "a renderer change invalidates artifact
 * verification, not factual approval"). Raise it whenever a change alters what a render of the same
 * snapshot would contain. A snapshot approved before this field existed reads as version `0`.
 */
export const CV_RENDER_CONTRACT_VERSION = 1;

/** Whether a candidate's testimony has been independently corroborated. `unreviewed` is what an
 * accepted MCP proposal carries until the candidate approves it: nobody has said yet that the claim
 * is true, so it is not testimony of any kind. `self_reported` is the
 * default and the common case; upgrading it is a deliberate, separate action, never implicit in
 * giving an answer. `candidate_confirmed_gap` is not a lesser verification state -- it is the
 * candidate explicitly saying "I did not do this", which is itself a fact worth recording so the
 * same question is never asked again as if unanswered. */
export type CvFactVerification = 'unreviewed' | 'self_reported' | 'candidate_confirmed_gap' | 'corroborated';

export const CV_FACT_VERIFICATIONS: readonly CvFactVerification[] = [
  'unreviewed',
  'self_reported',
  'candidate_confirmed_gap',
  'corroborated',
];

/** Whether the candidate did this alone or as part of a team. Distinct from `verification`: a
 * corroborated fact can still have been shared work, and ownership never upgrades or downgrades
 * how well-evidenced a fact is. */
export type CvFactOwnership = 'sole' | 'shared' | 'unknown';

export const CV_FACT_OWNERSHIPS: readonly CvFactOwnership[] = ['sole', 'shared', 'unknown'];

/** Where a fact's content came from. `mcp_proposal` is a claim an MCP client proposed that the
 * candidate accepted into the case but has not reviewed; approving it re-stamps it as
 * `candidate_testimony`. `repository_inspection` can corroborate implementation
 * details given a pinned revision and a relevant call path -- it cannot by itself establish
 * authorship or that the code ran in production, which is why `verification` and `sourceKind`
 * are separate fields rather than one implying the other. */
export type CvFactSourceKind = 'mcp_proposal' | 'candidate_testimony' | 'repository_inspection';

export const CV_FACT_SOURCE_KINDS: readonly CvFactSourceKind[] = [
  'mcp_proposal',
  'candidate_testimony',
  'repository_inspection',
];

/** Where a fact stands in the candidate's own review (#419 step 7). Only `approved` facts may back
 * wording that reaches a CV. `proposed` is the starting state of anything the candidate has not yet
 * looked at (an accepted MCP proposal included); `superseded` means a later correction replaced
 * it, and the record is kept rather than deleted. */
export type CvFactApproval = 'proposed' | 'approved' | 'rejected' | 'superseded';

export const CV_FACT_APPROVALS: readonly CvFactApproval[] = ['proposed', 'approved', 'rejected', 'superseded'];

/** The reviewed source field a fact is anchored to: a role's bullets or a project's description. */
export type CvFactAnchorField = 'experience_bullets' | 'project_description';

export const CV_FACT_ANCHOR_FIELDS: readonly CvFactAnchorField[] = ['experience_bullets', 'project_description'];

/** One profile skill a fact backs (through a `skill` wording that cites it), as it stood in the
 * reviewed `CvProfile.skills` list when the fact was anchored. */
export interface CvFactSkillAnchor {
  skill: string;
  /** SHA-256 hex of the skill's normalized name. */
  digest: string;
}

/**
 * Which part of the reviewed source a fact was reviewed against (#436). Stamped and compared only in
 * the main process, never accepted from a caller: a renderer or MCP client cannot supply an anchor,
 * and the digest is always computed from `text`. Editing or removing an anchored role bullet, changing
 * an anchored project description, or removing an anchored profile skill marks the fact stale, so it
 * goes back to the candidate for review instead of the whole case being treated as changed. A fact
 * with no anchor (one stored before this existed) is simply not checked this way, and is never given
 * an invented one.
 */
export interface CvFactAnchor {
  /** The role or project id, equal to the fact's own `parentId` when stamped. */
  parentId: string;
  field: CvFactAnchorField;
  /** The exact reviewed source text of `field` at the time it was anchored. */
  text: string;
  /** SHA-256 hex of `field` and `text`. */
  digest: string;
  /** Profile skills the fact backs (the profile field is `CvProfile.skills`). Empty for most facts. */
  profileSkills: CvFactSkillAnchor[];
}

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
  /** The candidate's review state. A fact is usable only while `approved` and not part of an
   * unresolved contradiction (see `isCvFactUsable`). */
  approval: CvFactApproval;
  /** When in the role or project this happened, in the candidate's own words ("2021 to 2022", "first
   * year", "current"). Empty means the candidate has not said. Two facts about one role only
   * contradict each other when they describe the same phase, so contradiction detection reads this. */
  timePhase: string;
  /** See `CvFactAnchor`. Absent on a fact stored before anchors existed, and on a fact whose
   * role or project is not in the reviewed source. */
  anchor?: CvFactAnchor | null;
}

export type CvClaimField = 'summary' | 'skill' | 'experience_bullet' | 'project_description';

export const CV_CLAIM_FIELDS: readonly CvClaimField[] = [
  'summary',
  'skill',
  'experience_bullet',
  'project_description',
];

export type CvWordingApprovalStatus = 'draft' | 'candidate_approved' | 'rejected' | 'superseded';

export const CV_WORDING_APPROVAL_STATUSES: readonly CvWordingApprovalStatus[] = [
  'draft',
  'candidate_approved',
  'rejected',
  'superseded',
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
  /** The `variantId` this wording replaced when the candidate edited it. Empty for a first
   * proposal. The replaced variant stays in the list as `superseded` (#419: editing creates a new
   * variant; rejection and supersession remain recorded). */
  supersedes: string;
  /** ISO-8601, stamped when the candidate rejected this exact wording. Empty otherwise. */
  rejectedAt: string;
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
export type CvEvidenceClass =
  | 'direct'
  | 'transferable'
  | 'unsupported'
  | 'needs_verification'
  | 'candidate_confirmed_gap';

export const CV_EVIDENCE_CLASSES: readonly CvEvidenceClass[] = [
  'direct',
  'transferable',
  'unsupported',
  'needs_verification',
  'candidate_confirmed_gap',
];

/** What a model may propose. `candidate_confirmed_gap` is only ever the candidate's own statement,
 * so no extraction or proposal path accepts it. */
export const CV_MODEL_EVIDENCE_CLASSES: readonly CvEvidenceClass[] = [
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
  /** Where `jdAnchor` sits in the text of the JD revision `jdRevisionId` names, as a half-open span
   * `[quoteStart, quoteEnd)`. Computed by the main process, never accepted from a caller. `-1` for
   * both means the quote was not found in that text, which blocks approval. */
  quoteStart: number;
  quoteEnd: number;
  /** The `CvJdRevision.revisionId` this requirement's quote was verified against. A requirement
   * whose revision is not the current one is stale: it was reviewed against older text. */
  jdRevisionId: string;
  /** The candidate marked this "not a requirement". It stays in the list with its reason and is
   * left out of review, coverage and evidence gating. */
  excluded: boolean;
  exclusionReason: string;
  /** Further `CvSourceExperienceEntry.id`/`CvSourceProjectEntry.id` values that evidence this
   * requirement, beyond the single `anchorParentId`. */
  sourceIds: string[];
  /** `CvEvidenceFact.factId` values that evidence this requirement. Each must exist on the case. */
  factIds: string[];
}

/** How far requirement extraction has got for one JD revision (#419 step 5). A model output cap
 * means one pass can return only part of a long posting, so `partial` records that more batches
 * are still owed, and nothing may claim complete coverage until the status is `complete` for the
 * current revision. */
export type CvRequirementCoverageStatus = 'not_run' | 'partial' | 'complete';

export const CV_REQUIREMENT_COVERAGE_STATUSES: readonly CvRequirementCoverageStatus[] = ['not_run', 'partial', 'complete'];

export interface CvRequirementCoverage {
  status: CvRequirementCoverageStatus;
  /** The JD revision this status describes. Any other current revision reads as `not_run`. */
  revisionId: string;
  batches: number;
}

export const EMPTY_CV_REQUIREMENT_COVERAGE: CvRequirementCoverage = { status: 'not_run', revisionId: '', batches: 0 };

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
  /** The `CV_RENDER_CONTRACT_VERSION` this snapshot was approved under. `0` for a snapshot approved
   * before the field existed. Artifact verification (a later slice) compares it with the current
   * constant; factual approval never depends on it. */
  renderContractVersion: number;
  resume: TailoredResume;
  /** SHA-256 hex of the resume's own serialization, supplied by the caller. */
  digest: string;
  /** ISO-8601 */
  approvedAt: string;
  /** The `caseRevision` this snapshot was approved against. */
  caseRevision: string;
}

/** The two file formats a case can be exported to. Spelled out here (not imported from `types.ts`)
 * so this module stays dependency-free. */
export type CvArtifactFormat = 'pdf' | 'docx';

export const CV_ARTIFACT_FORMATS: readonly CvArtifactFormat[] = ['pdf', 'docx'];

/**
 * One rendered file made from a case's approved snapshot (#419 step 9). The record attests to the
 * bytes produced at export, nothing else: a file edited or replaced afterwards on disk is not
 * re-verified, and a record never becomes "current" again once the snapshot it was made from is no
 * longer the case's approved one. History is kept: an old record stays with its hash.
 */
export interface CvArtifactRecord {
  artifactId: string;
  format: CvArtifactFormat;
  /** SHA-256 hex of the rendered bytes (of the bytes written to `savedPath` when `savedPath` is set). */
  contentHash: string;
  /** ISO-8601 */
  exportedAt: string;
  /** `CvApprovedResumeSnapshot.digest` this file was rendered from. */
  snapshotDigest: string;
  /** `CvApprovedResumeSnapshot.approvedAt` of that snapshot. A later approval of identical content
   * still makes this file historical. */
  snapshotApprovedAt: string;
  renderContractVersion: number;
  /** `pageCount` is set for a PDF only. */
  validation: { ok: boolean; reasons: string[]; pageCount?: number };
  /** Where the candidate saved it. `''` when the file failed its checks and was never offered for saving. */
  savedPath: string;
  /** ISO-8601 or `''`: the candidate opened the saved file to read it (PDF review needs this). */
  reviewOpenedAt: string;
  /** ISO-8601 or `''`: the candidate's explicit visual confirmation of this file. */
  confirmedAt: string;
}

/** Per-format status shown in the CV workspace. `legacy_unverified` is a case marked exported by an
 * earlier version that recorded no hash or checks. */
export type CvArtifactStatus =
  | 'not_exported'
  | 'awaiting_review'
  | 'qa_failed'
  | 'accepted'
  | 'stale'
  | 'legacy_unverified';

/** Most artifact records kept per case; the oldest are dropped past this. */
export const CV_ARTIFACT_HISTORY_LIMIT = 40;

/**
 * The projects the candidate approved for this case's CV (#419 step 8), in the order they appear.
 * It records the ids of `selectSourceProjects(source)` at the moment of approval, so changing a
 * pin or the project limit, or removing a project, makes it differ from the current selection and
 * blocks whole-CV approval until the candidate approves the new selection.
 */
export interface CvProjectSelection {
  projectIds: string[];
  /** The source's `maxProjects` at approval, shown back to the candidate. `0` means no limit. */
  maxProjects: number;
  /** ISO-8601, stamped by the write layer. */
  approvedAt: string;
}

/**
 * What the case was started from, kept so a later change to the CV can be shown as a diff (#419:
 * "a source CV/profile/text change invalidates the case's approval until the candidate reviews a
 * diff and explicitly rebases it"). `null` on a case created before this existed: such a case still
 * blocks on its stored source hash, but has no earlier copy to list changes against.
 */
export interface CvSourceBaseline {
  source: CvSourceDocument | null;
  /** The reviewed `CvProfile.skills` at capture time. */
  skills: string[];
  profileSummary: string;
  /** SHA-256 hex of the CV's extracted text; the text itself is not duplicated here. */
  textDigest: string;
  /** SHA-256 hex over all of the above, compared against the CV's current inputs on approval. */
  inputsDigest: string;
  /** ISO-8601 */
  capturedAt: string;
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
  /** How much of the JD's requirement list has been extracted and confirmed. See
   * `CvRequirementCoverage`. */
  requirementCoverage: CvRequirementCoverage;
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
  /** The candidate's approved project selection, `null` until approved. Persisted with the case. */
  projectSelection: CvProjectSelection | null;
  /** The CV inputs this case was last started or rebased from. See `CvSourceBaseline`. */
  sourceBaseline: CvSourceBaseline | null;
  /** Files rendered from the approved snapshot, oldest first. See `CvArtifactRecord`. */
  artifacts: CvArtifactRecord[];
  /** True for a case an earlier version marked `artifact_approved`: it was exported, but no hash or
   * checks were recorded, so nothing about that file is verified. Cleared once a real artifact is recorded. */
  legacyUnverifiedExport: boolean;
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
  requirementCoverage: EMPTY_CV_REQUIREMENT_COVERAGE,
  facts: [],
  wordingVariants: [],
  origin: 'vacancy',
  caseRevision: '0',
  approvedResumeSnapshot: null,
  projectSelection: null,
  sourceBaseline: null,
  artifacts: [],
  legacyUnverifiedExport: false,
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
  linksPerRequirement: 20,
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
  reasons.push(...describeCvRequirementGaps(overlay));
  const approvedVariants = overlay.wordingVariants.filter((variant) => variant.status === 'candidate_approved');
  const staleVariants = approvedVariants.filter((variant) => variant.sourceRevision !== overlay.sourceCvContentHash);
  if (staleVariants.length > 0) {
    reasons.push(`${staleVariants.length} approved wording variant(s) were approved against a different source revision`);
  }
  const ungroundedVariants = approvedVariants.filter((variant) => variant.factIds.length === 0);
  if (ungroundedVariants.length > 0) {
    reasons.push(`${ungroundedVariants.length} approved wording variant(s) cite no supporting fact`);
  }
  const conflictedFactIds = conflictedFactIdSet(overlay.facts);
  const unusableBacking = approvedVariants.filter(
    (variant) =>
      variant.factIds.length > 0 &&
      !variant.factIds.every((factId) => {
        const fact = overlay.facts.find((candidate) => candidate.factId === factId);
        return fact !== undefined && isCvFactUsable(fact, conflictedFactIds);
      }),
  );
  if (unusableBacking.length > 0) {
    reasons.push(`${unusableBacking.length} approved wording variant(s) rest on a fact that is not approved or is in conflict`);
  }
  if (conflictedFactIds.size > 0) {
    reasons.push('your facts contradict each other: resolve or omit one of each conflicting pair');
  } else if (overlay.state === 'conflict') {
    reasons.push('unresolved conflicting corrections remain');
  }
  return reasons;
}

/**
 * Why the requirement list cannot back an approved CV (#419 step 5): extraction not finished or
 * not confirmed for the current JD revision, requirements reviewed against older text, a quote that
 * is not in the JD, an item still unreviewed, a required item still needing verification, a
 * confirmed gap that also links a fact, and a fact link that does not resolve to an approved fact.
 * Excluded requirements ("not a requirement", with a reason) take no part in any of it.
 */
export function describeCvRequirementGaps(
  overlay: Pick<CvEvidenceOverlay, 'requirements' | 'requirementCoverage' | 'jdRevisions' | 'facts'>,
): string[] {
  const reasons: string[] = [];
  const currentRevisionId = currentCvJdRevisionId(overlay);
  const coverage = overlay.requirementCoverage;
  if (coverage.revisionId !== currentRevisionId || coverage.status === 'not_run') {
    reasons.push('the requirements of the current job description have not been extracted and confirmed as a full list');
  } else if (coverage.status === 'partial') {
    reasons.push('the requirement list is partial: more of the job description has not been read yet');
  }
  const active = overlay.requirements.filter((requirement) => !requirement.excluded);
  const stale = active.filter((requirement) => requirement.jdRevisionId !== currentRevisionId);
  if (stale.length > 0) {
    reasons.push(`${stale.length} requirement(s) were reviewed against an older job description and need review again`);
  }
  const unquoted = active.filter((requirement) => requirement.quoteStart < 0);
  if (unquoted.length > 0) {
    reasons.push(`${unquoted.length} requirement(s) have no exact quote from the job description`);
  }
  const unreviewed = active.filter((requirement) => !requirement.reviewed);
  if (unreviewed.length > 0) {
    reasons.push(`${unreviewed.length} requirement(s) have not been reviewed`);
  }
  const unresolvedRequired = active.filter(
    (requirement) =>
      requirement.classification === 'required' && requirement.reviewed && requirement.evidenceClass === 'needs_verification',
  );
  if (unresolvedRequired.length > 0) {
    reasons.push(`${unresolvedRequired.length} required item(s) still need verification`);
  }
  const approvedFactIds = new Set(overlay.facts.filter((fact) => fact.approval === 'approved').map((fact) => fact.factId));
  const badLinks = active.filter((requirement) => requirement.factIds.some((factId) => !approvedFactIds.has(factId)));
  if (badLinks.length > 0) {
    reasons.push(`${badLinks.length} requirement(s) link to a fact that is not approved`);
  }
  const contradictory = active.filter((requirement) => requirement.evidenceClass === 'candidate_confirmed_gap' && requirement.factIds.length > 0);
  if (contradictory.length > 0) {
    reasons.push(`${contradictory.length} requirement(s) are marked as a gap you confirmed but also link a fact`);
  }
  return reasons;
}

/**
 * Checks a requirement list a caller wants to save against the stored JD text, in the main process
 * (#419 step 5). A requirement whose quote is new or changed must be an exact substring of the
 * current JD, and a requirement the candidate marks reviewed again after a JD edit is re-verified
 * against the new text; both throw rather than saving a quote that is not there. A requirement left
 * as it was keeps the span and revision already stored, whatever the caller sent back: a caller
 * cannot vouch for its own quote. Excluded requirements are never refused for a missing quote.
 */
export function verifyCvRequirementQuotes(
  next: readonly CvRequirementMapping[],
  previous: readonly CvRequirementMapping[],
  jdText: string,
  currentRevisionId: string,
): CvRequirementMapping[] {
  const previousById = new Map(previous.map((requirement) => [requirement.requirementId, requirement]));
  const taken = new Set<number>();
  return next.map((requirement) => {
    const before = previousById.get(requirement.requirementId);
    const quoteChanged = !before || before.jdAnchor !== requirement.jdAnchor;
    const reReviewed = requirement.reviewed && (!before || !before.reviewed || before.jdRevisionId !== currentRevisionId);
    if (before && !quoteChanged && !reReviewed) {
      if (before.quoteStart >= 0) taken.add(before.quoteStart);
      return { ...requirement, quoteStart: before.quoteStart, quoteEnd: before.quoteEnd, jdRevisionId: before.jdRevisionId };
    }
    const span = locateJdQuote(jdText, requirement.jdAnchor, taken);
    if (!span) {
      if (requirement.excluded) {
        return {
          ...requirement,
          quoteStart: before?.quoteStart ?? -1,
          quoteEnd: before?.quoteEnd ?? -1,
          jdRevisionId: before?.jdRevisionId ?? currentRevisionId,
        };
      }
      throw new Error(
        quoteChanged
          ? `"${requirement.jdAnchor.slice(0, 80)}" is not an exact quote from the job description, so this requirement cannot be saved`
          : `the quote for "${requirement.text.slice(0, 80)}" is no longer in the job description: correct the quote or mark it as not a requirement`,
      );
    }
    taken.add(span.start);
    return { ...requirement, jdAnchor: requirement.jdAnchor.trim(), quoteStart: span.start, quoteEnd: span.end, jdRevisionId: currentRevisionId };
  });
}

/** The id of the newest JD revision, or `''` before any JD text exists. */
export function currentCvJdRevisionId(overlay: Pick<CvEvidenceOverlay, 'jdRevisions'>): string {
  return overlay.jdRevisions.at(-1)?.revisionId ?? '';
}

/**
 * Finds `quote` in `text` as an exact substring (#419 step 5: a model-supplied quote is never
 * trusted until it is found). Returns the half-open span of an occurrence, preferring one whose
 * start is not in `takenStarts` so two requirements that quote the same words land on different
 * occurrences when the text has more than one. A quote is trimmed at its edges only; nothing inside
 * it is normalised, so a paraphrase or a re-spaced quote does not match.
 */
export function locateJdQuote(
  text: string,
  quote: string,
  takenStarts: ReadonlySet<number> = new Set(),
): { start: number; end: number } | null {
  const needle = quote.trim();
  if (needle.length === 0) return null;
  let first: { start: number; end: number } | null = null;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    const span = { start: at, end: at + needle.length };
    if (!takenStarts.has(at)) return span;
    first ??= span;
    from = at + 1;
  }
  return first;
}

function normalizeWords(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

/** A key two proposals for the same requirement share: the same quote, or the same wording. Used
 * to dedupe a model's list against itself and against what is already saved. */
export function requirementDedupeKeys(requirement: Pick<CvRequirementMapping, 'text' | 'jdAnchor'>): string[] {
  const keys = [`text:${normalizeWords(requirement.text)}`];
  if (requirement.jdAnchor.trim()) keys.push(`quote:${normalizeWords(requirement.jdAnchor)}`);
  return keys;
}

// ------------------------------------------------------------------------ facts (#419 step 7)

const SOLE_VS_SHARED: readonly CvFactOwnership[] = ['sole', 'shared'];

function wordSet(value: string): Set<string> {
  return new Set(
    normalizeWords(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
}

/** True when two activity descriptions plainly talk about the same piece of work: identical once
 * normalised, or sharing most of their words. Deliberately conservative, so two different things
 * done in one role are never reported as contradicting each other. */
function sameSubject(a: string, b: string): boolean {
  if (normalizeWords(a) === normalizeWords(b)) return true;
  const left = wordSet(a);
  const right = wordSet(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.7;
}

export interface CvFactConflict {
  factIds: [string, string];
  reason: string;
}

/**
 * Contradictions among facts that are still in play (proposed or approved). Two facts about the
 * same role or project and the same time phase, describing the same work, conflict when one says
 * `sole` and the other `shared`, or when they give different numbers. Detection never picks a
 * winner: the candidate resolves it by rejecting or superseding one fact, and every fact in an
 * unresolved pair is unusable until then.
 */
export function findCvFactConflicts(facts: readonly CvEvidenceFact[]): CvFactConflict[] {
  const live = facts.filter((fact) => fact.approval === 'proposed' || fact.approval === 'approved');
  const conflicts: CvFactConflict[] = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.parentId !== b.parentId) continue;
      if (a.verification === 'candidate_confirmed_gap' || b.verification === 'candidate_confirmed_gap') continue;
      if (normalizeWords(a.timePhase) !== normalizeWords(b.timePhase)) continue;
      if (!sameSubject(a.activity, b.activity)) continue;
      if (SOLE_VS_SHARED.includes(a.ownership) && SOLE_VS_SHARED.includes(b.ownership) && a.ownership !== b.ownership) {
        conflicts.push({ factIds: [a.factId, b.factId], reason: 'one says you did this alone and the other says it was shared work' });
        continue;
      }
      if (a.metricValue.trim() && b.metricValue.trim() && normalizeWords(a.metricValue) !== normalizeWords(b.metricValue)) {
        conflicts.push({ factIds: [a.factId, b.factId], reason: 'the two facts give different numbers for the same work' });
      }
    }
  }
  return conflicts;
}

function conflictedFactIdSet(facts: readonly CvEvidenceFact[]): Set<string> {
  return new Set(findCvFactConflicts(facts).flatMap((conflict) => conflict.factIds));
}

/** A fact may back wording only while the candidate has approved it and no unresolved
 * contradiction involves it. */
export function isCvFactUsable(fact: CvEvidenceFact, conflictedFactIds: ReadonlySet<string>): boolean {
  return fact.approval === 'approved' && fact.verification !== 'unreviewed' && !conflictedFactIds.has(fact.factId);
}

/** The parts of a fact a candidate's approval was about. Changing any of them makes the old
 * approval, and every wording built on it, no longer apply. */
function factSignature(fact: CvEvidenceFact): string {
  return JSON.stringify([
    fact.parentId,
    fact.parentType,
    fact.client,
    fact.activity,
    fact.mechanism,
    fact.result,
    fact.ownership,
    fact.timePhase,
    fact.metricValue,
    fact.metricUnit,
    fact.metricBasis,
    fact.verification,
  ]);
}

/**
 * Applies the supersession flow for one fact: the old fact becomes `superseded` (kept, never
 * deleted), a corrected copy is added with `supersedes` pointing back at it and starts `proposed`
 * so the candidate reviews the correction itself, and every wording variant that cited the old
 * fact is revoked. Returns the new lists; the caller persists them.
 */
export function supersedeCvFact(
  overlay: Pick<CvEvidenceOverlay, 'facts' | 'wordingVariants'>,
  factId: string,
  corrections: Partial<
    Pick<CvEvidenceFact, 'activity' | 'mechanism' | 'result' | 'ownership' | 'timePhase' | 'client' | 'metricValue' | 'metricUnit' | 'metricBasis'>
  >,
  now: string,
): { facts: CvEvidenceFact[]; wordingVariants: CvApprovedWording[]; replacement: CvEvidenceFact } {
  const old = overlay.facts.find((fact) => fact.factId === factId);
  if (!old) throw new Error('that fact does not exist on this case');
  if (old.approval === 'superseded' || old.approval === 'rejected') {
    throw new Error('that fact was already replaced or rejected');
  }
  const replacement: CvEvidenceFact = {
    ...old,
    ...corrections,
    factId: crypto.randomUUID(),
    supersedes: old.factId,
    createdAt: now,
    approval: 'proposed',
  };
  const facts = overlay.facts.map((fact) => (fact.factId === factId ? { ...fact, approval: 'superseded' as const } : fact));
  return {
    facts: [...facts, replacement],
    wordingVariants: revokeVariantsCiting(overlay.wordingVariants, new Set([factId])),
    replacement,
  };
}

/** Marks every approved variant that cites one of `factIds` as superseded. Drafts are left alone:
 * they were never approved, and `reconcileCvEvidence` stops a draft built on a dead fact from ever
 * being approved. */
export function revokeVariantsCiting(variants: readonly CvApprovedWording[], factIds: ReadonlySet<string>): CvApprovedWording[] {
  return variants.map((variant) =>
    variant.status === 'candidate_approved' && variant.factIds.some((factId) => factIds.has(factId))
      ? { ...variant, status: 'superseded' as const }
      : variant,
  );
}

/**
 * Edits one wording variant the way #419 step 7 requires: the edit never changes an approved text
 * in place. The old variant becomes `superseded` and stays in the list, and the new text is a new
 * variant, still a `draft` until the candidate approves exactly what is now displayed.
 */
export function editCvWordingVariant(
  variants: readonly CvApprovedWording[],
  variantId: string,
  text: string,
): { wordingVariants: CvApprovedWording[]; replacement: CvApprovedWording } {
  const old = variants.find((variant) => variant.variantId === variantId);
  if (!old) throw new Error('that wording does not exist on this case');
  if (old.status === 'rejected' || old.status === 'superseded') throw new Error('that wording was already rejected or replaced');
  const replacement: CvApprovedWording = {
    ...old,
    variantId: crypto.randomUUID(),
    text: text.trim(),
    status: 'draft',
    approvedAt: '',
    rejectedAt: '',
    supersedes: old.variantId,
  };
  return {
    wordingVariants: [...variants.map((variant) => (variant.variantId === variantId ? { ...variant, status: 'superseded' as const } : variant)), replacement],
    replacement,
  };
}

/**
 * Fills the fields a row stored before #419 step 2 does not have, without inventing review state.
 * A legacy requirement keeps its text and review flag, gets its quote located in the current JD
 * (or `-1` when it is not there), and is treated as read against the current revision, as it was
 * the only one then. A legacy fact becomes `approved` only when the candidate already approved
 * wording built on it, or when it records the candidate's own "not my work"; every other legacy
 * fact is `proposed`, so nothing the candidate never reviewed gains approval from the upgrade.
 */
export function upgradeStoredRequirements(
  rows: readonly Partial<CvRequirementMapping>[],
  jdText: string,
  currentRevisionId: string,
): CvRequirementMapping[] {
  return rows.map((row) => {
    const jdAnchor = row.jdAnchor ?? '';
    const span = row.quoteStart === undefined ? locateJdQuote(jdText, jdAnchor) : null;
    return {
      requirementId: row.requirementId ?? '',
      text: row.text ?? '',
      jdAnchor,
      classification: row.classification ?? 'unclear',
      evidenceClass: row.evidenceClass ?? 'needs_verification',
      anchorParentId: row.anchorParentId ?? '',
      candidateAdded: row.candidateAdded ?? false,
      reviewed: row.reviewed ?? false,
      quoteStart: row.quoteStart ?? span?.start ?? -1,
      quoteEnd: row.quoteEnd ?? span?.end ?? -1,
      jdRevisionId: row.jdRevisionId ?? currentRevisionId,
      excluded: row.excluded ?? false,
      exclusionReason: row.exclusionReason ?? '',
      sourceIds: row.sourceIds ?? [],
      factIds: row.factIds ?? [],
    };
  });
}

export function upgradeStoredFacts(
  rows: readonly (Omit<CvEvidenceFact, 'approval' | 'timePhase'> & Partial<Pick<CvEvidenceFact, 'approval' | 'timePhase'>>)[],
  variants: readonly Pick<CvApprovedWording, 'status' | 'factIds'>[],
): CvEvidenceFact[] {
  const backing = new Set(variants.filter((variant) => variant.status === 'candidate_approved').flatMap((variant) => variant.factIds));
  return rows.map((row) => {
    const { anchor: storedAnchor, ...rest } = row;
    const anchor = readStoredFactAnchor(storedAnchor);
    return {
      ...rest,
      timePhase: row.timePhase ?? '',
      approval: row.approval ?? (row.verification === 'candidate_confirmed_gap' || backing.has(row.factId) ? 'approved' : 'proposed'),
      // A fact stored before anchors existed (or with a malformed one) stays unanchored, never given
      // an invented anchor.
      ...(anchor ? { anchor } : {}),
    };
  });
}

/** Reads a stored anchor defensively: anything that is not a complete anchor reads as none. */
export function readStoredFactAnchor(value: unknown): CvFactAnchor | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.parentId !== 'string' || typeof raw.text !== 'string' || typeof raw.digest !== 'string') return null;
  if (!CV_FACT_ANCHOR_FIELDS.includes(raw.field as CvFactAnchorField)) return null;
  const skills = Array.isArray(raw.profileSkills) ? (raw.profileSkills as unknown[]) : [];
  return {
    parentId: raw.parentId,
    field: raw.field as CvFactAnchorField,
    text: raw.text,
    digest: raw.digest,
    profileSkills: skills
      .filter((entry): entry is CvFactSkillAnchor => !!entry && typeof (entry as CvFactSkillAnchor).skill === 'string' && typeof (entry as CvFactSkillAnchor).digest === 'string')
      .map((entry) => ({ skill: entry.skill, digest: entry.digest })),
  };
}

export function upgradeStoredVariants(
  rows: readonly (Omit<CvApprovedWording, 'supersedes' | 'rejectedAt'> & Partial<Pick<CvApprovedWording, 'supersedes' | 'rejectedAt'>>)[],
): CvApprovedWording[] {
  return rows.map((row) => ({ ...row, supersedes: row.supersedes ?? '', rejectedAt: row.rejectedAt ?? '' }));
}

const NUMBER_PATTERN = /\d[\d.,]*/gu;

/** Numbers in `text` that none of the cited facts' own words contain. A figure in a wording must
 * come from a fact whose `metricBasis` the candidate gave, never be introduced by the wording. */
export function unbackedNumbers(text: string, facts: readonly CvEvidenceFact[]): string[] {
  const haystack = facts
    .flatMap((fact) => [fact.activity, fact.mechanism, fact.result, fact.metricValue, fact.metricUnit])
    .join(' ');
  const backed = new Set((haystack.match(NUMBER_PATTERN) ?? []).map((value) => value.replace(/[.,]+$/u, '')));
  return (text.match(NUMBER_PATTERN) ?? []).map((value) => value.replace(/[.,]+$/u, '')).filter((value) => !backed.has(value));
}

/**
 * The invariants the evidence lists must keep across any write, enforced in the main process so a
 * renderer bug (or a model-influenced renderer) cannot bypass them:
 *  - a rejected or superseded fact or wording never comes back to life;
 *  - changing an approved fact's content drops it to `proposed`, and wording built on it is revoked;
 *  - a variant can only be newly approved when every fact it cites exists, is approved and is not
 *    in a contradiction, and its numbers come from those facts;
 *  - an approved variant's text is immutable (an edit is a new variant);
 *  - approval timestamps and the source revision are stamped here, never taken from the caller.
 * Throws on a forbidden transition. Wording approved earlier whose facts were since revoked is
 * revoked silently, since that is a consequence rather than a mistake.
 */
export function reconcileCvEvidence(
  previous: Pick<CvEvidenceOverlay, 'facts' | 'wordingVariants'>,
  next: Pick<CvEvidenceOverlay, 'facts' | 'wordingVariants'>,
  context: { sourceCvContentHash: string; now: string },
): { facts: CvEvidenceFact[]; wordingVariants: CvApprovedWording[] } {
  const previousFacts = new Map(previous.facts.map((fact) => [fact.factId, fact]));
  const previousVariants = new Map(previous.wordingVariants.map((variant) => [variant.variantId, variant]));

  const facts = next.facts.map((incoming) => {
    const before = previousFacts.get(incoming.factId);
    // The candidate approving a fact an MCP client proposed is the act that makes it their
    // testimony (#436). Stamped here, never taken from the caller.
    const fact =
      incoming.approval === 'approved' && before?.approval !== 'approved' && incoming.verification === 'unreviewed'
        ? { ...incoming, verification: 'self_reported' as const, sourceKind: incoming.sourceKind === 'mcp_proposal' ? ('candidate_testimony' as const) : incoming.sourceKind }
        : incoming;
    if (!before) return fact;
    if ((before.approval === 'rejected' || before.approval === 'superseded') && fact.approval !== before.approval) {
      throw new Error('a rejected or replaced fact cannot be reused: add a corrected fact instead');
    }
    if (before.approval === 'approved' && fact.approval === 'approved' && factSignature(before) !== factSignature(fact)) {
      return { ...fact, approval: 'proposed' as const };
    }
    return fact;
  });
  // Facts that left the approved state this write, by any route (edit, rejection, supersession).
  const droppedFactIds = new Set(
    facts.filter((fact) => previousFacts.get(fact.factId)?.approval === 'approved' && fact.approval !== 'approved').map((fact) => fact.factId),
  );
  const conflicted = conflictedFactIdSet(facts);
  const factById = new Map(facts.map((fact) => [fact.factId, fact]));

  const wordingVariants = next.wordingVariants.map((variant) => {
    const before = previousVariants.get(variant.variantId);
    if (before && (before.status === 'rejected' || before.status === 'superseded') && variant.status !== before.status) {
      throw new Error('a rejected or replaced wording cannot be reused: edit it into a new variant instead');
    }
    let status = variant.status;
    let approvedAt = variant.approvedAt;
    let rejectedAt = variant.rejectedAt;
    let sourceRevision = variant.sourceRevision;
    if (status === 'candidate_approved') {
      if (before?.status === 'candidate_approved') {
        if (before.text !== variant.text || JSON.stringify(before.factIds) !== JSON.stringify(variant.factIds)) {
          throw new Error('an approved wording cannot be edited in place: editing creates a new variant');
        }
        // Keep the original stamps; revoke if a fact it stands on was dropped or contradicts.
        approvedAt = before.approvedAt;
        sourceRevision = before.sourceRevision;
        const backingBroken = variant.factIds.some((factId) => {
          const fact = factById.get(factId);
          return !fact || droppedFactIds.has(factId) || !isCvFactUsable(fact, conflicted);
        });
        if (backingBroken) status = 'superseded';
      } else {
        const cited = variant.factIds.map((factId) => factById.get(factId));
        if (variant.factIds.length === 0 || cited.some((fact) => !fact)) {
          throw new Error('this wording cites a fact that does not exist on this case, so it cannot be approved');
        }
        const usableFacts = cited as CvEvidenceFact[];
        if (usableFacts.some((fact) => !isCvFactUsable(fact, conflicted))) {
          throw new Error('this wording cites a fact that is not approved or is in a contradiction, so it cannot be approved');
        }
        const numbers = unbackedNumbers(variant.text, usableFacts);
        if (numbers.length > 0) {
          throw new Error(`this wording contains a number (${numbers.join(', ')}) that none of its facts state`);
        }
        approvedAt = context.now;
        sourceRevision = context.sourceCvContentHash;
      }
    }
    if (status === 'rejected' && !rejectedAt) rejectedAt = context.now;
    if (status !== 'candidate_approved') approvedAt = status === 'superseded' ? approvedAt : '';
    return { ...variant, status, approvedAt, rejectedAt, sourceRevision };
  });

  return { facts, wordingVariants };
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
 * Proposes one wording variant per approved, self-reported fact that has none yet (#419, steps 4
 * and 7). Only `self_reported` facts propose wording: `candidate_confirmed_gap` is the candidate
 * saying they did *not* do the thing, and `corroborated` facts are not yet wired to this path. A
 * fact the candidate has not approved, or that sits in a contradiction, proposes nothing. A fact
 * that already backs any existing variant, including a rejected or superseded one, is never
 * proposed a second time, so a rejection is not undone by re-running this.
 *
 * Every proposal is a `draft`. It reaches a CV only after the candidate approves that exact text,
 * one variant at a time; nothing here, and nothing in the approve-whole-CV path, approves wording.
 */
export function proposeWordingFromFacts(overlay: Pick<CvEvidenceOverlay, 'facts' | 'wordingVariants'>): CvApprovedWording[] {
  const alreadyGrounded = new Set(overlay.wordingVariants.flatMap((variant) => variant.factIds));
  const conflicted = conflictedFactIdSet(overlay.facts);
  return overlay.facts
    .filter((fact) => fact.verification === 'self_reported' && isCvFactUsable(fact, conflicted) && !alreadyGrounded.has(fact.factId))
    .map((fact) => ({
      variantId: crypto.randomUUID(),
      targetField: fact.parentType === 'project' ? ('project_description' as const) : ('experience_bullet' as const),
      parentId: fact.parentId,
      text: deriveWordingFromFact(fact),
      factIds: [fact.factId],
      status: 'draft' as const,
      approvedAt: '',
      sourceRevision: '',
      supersedes: '',
      rejectedAt: '',
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
  '"anchorParentId": string}], "hasMore": boolean}';

/** How many requirements one extraction batch may return. A response that fills the batch is read
 * as possibly cut off, however `hasMore` is set, and another batch is requested. */
export const CV_REQUIREMENT_BATCH_SIZE = 25;
/** Upper bound on follow-up batches for one posting, so a model that always says `hasMore` cannot
 * loop forever. Reaching it leaves coverage `partial`. */
export const CV_REQUIREMENT_MAX_BATCHES = 8;

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
