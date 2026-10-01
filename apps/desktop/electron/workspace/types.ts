/**
 * The wire contract for the `workspace:*` IPC channels: the single source of truth shared by
 * `electron/main.ts` (which produces these records), `electron/preload.ts` (which types the
 * bridge) and `src/window.d.ts` (which re-exports them to the renderer). Type-only: nothing here
 * is emitted, so the renderer never gains a runtime import from the Electron side.
 *
 * Two deliberate differences from `schema.ts`:
 *  - Timestamps cross the boundary as ISO-8601 strings, not `Date` objects. Structured clone
 *    would carry a `Date` fine, but a string is what React state, JSON export and test fixtures
 *    all want anyway, and it removes an entire class of "which side owns the timezone" bug.
 *  - Every record is listed field by field rather than inferred from the Drizzle table, so a
 *    column added to the database is not automatically published to the renderer. Widening this
 *    surface has to be a deliberate edit here.
 */

import type { CvSourceDocument } from './cv-source-schema.js';
import type {
  CvApprovedResumeSnapshot,
  CvApprovedWording,
  CvArtifactRecord,
  CvEvidenceFact,
  CvEvidenceOverlayOrigin,
  CvEvidenceOverlayState,
  CvJdIncompleteReason,
  CvJdOrigin,
  CvJdRevision,
  CvListingStatus,
  CvProjectSelection,
  CvRequirementCoverage,
  CvRequirementMapping,
  CvSourceBaseline,
} from './cv-evidence-schema.js';
import type { CvRebasePlan } from './cv-case-rebase.js';
import type { McpAuditOutcome, McpGrantScopeType } from './mcp-grant-schema.js';
import type { CvProposalPayload, CvProposalStatus } from './cv-proposal-schema.js';

export type SavedJobStatus = 'considering' | 'preparing' | 'applied';

export type ApplicationStatus =
  | 'preparing'
  | 'applied'
  | 'recruiter_screen'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'withdrawn';

export type CvKind = 'uploaded' | 'manual';

/** Provenance of a `CvDocumentRecord`'s `text` (issue #396). See `schema.ts`'s `textSource` column
 * doc comment for why this is never inferred after the fact. */
export type CvTextSource = 'text_layer' | 'ai_transcription';

export type LetterType = 'motivation_letter' | 'cover_letter' | 'recruiter_message' | 'short_application_message';
export type LetterTone = 'formal' | 'natural' | 'confident' | 'concise';
export type LetterLength = 'short' | 'standard' | 'detailed';
export type LetterStatus = 'draft' | 'final' | 'sent';

export type StartPage = 'search' | 'saved' | 'applications' | 'last_opened';
export type ThemePreference = 'light' | 'dark' | 'system';
export type DensityPreference = 'comfortable' | 'compact';
export type SidebarStartPreference = 'expanded' | 'collapsed' | 'remember_last';

/** Which installed CLI AI features (gap analysis, letters) run through. Matches `ProviderId` in
 * `@agent-dock/shared`, spelled out locally for the same reason every other enum here is. */
export type DefaultAiProvider = 'claude' | 'codex';

export interface CvProfile {
  title: string;
  years: string;
  location: string;
  languages: string;
  skills: string[];
  summary: string;
  auth: string;
}

/** #274's structured source CV, re-exported here so the renderer reaches it through the same
 * module every other workspace record type comes from. Defined in `cv-source-schema.ts` for the
 * same reason `CvProfile`'s field list lives in `cv-profile-schema.ts`: validation, prompting and
 * response coercion all need it, and one definition is what keeps those three from drifting. */
export type {
  CvEngagementType,
  CvSourceContact,
  CvSourceDocument,
  CvSourceEducationEntry,
  CvSourceExperienceEntry,
  CvSourceProjectEntry,
} from './cv-source-schema.js';

/** #419's evidence/approved-wording overlay, re-exported for the same reason the source-CV types
 * above are: the renderer reaches every workspace record type through this one module. */
export type {
  CvApprovedResumeSnapshot,
  CvApprovedWording,
  CvClaimField,
  CvEvidenceClass,
  CvEvidenceFact,
  CvEvidenceOverlayOrigin,
  CvEvidenceOverlayState,
  CvFactApproval,
  CvFactConflict,
  CvFactOwnership,
  CvFactSourceKind,
  CvFactVerification,
  CvJdIncompleteReason,
  CvJdOrigin,
  CvJdRevision,
  CvListingStatus,
  CvProjectSelection,
  CvRequirementClassification,
  CvRequirementCoverage,
  CvRequirementMapping,
  CvSourceBaseline,
  CvWordingApprovalStatus,
} from './cv-evidence-schema.js';
export type { CvCurrentInputs, CvDroppedWording, CvInputChange, CvRebasePlan } from './cv-case-rebase.js';

/** #421's MCP client grants and audit trail, re-exported for the same reason the CV-tailoring
 * types above are. */
export type { McpAuditOutcome, McpGrantScopeType } from './mcp-grant-schema.js';

/** #421's proposal staging layer, re-exported for the same reason. */
export type {
  CvClarificationQuestionProposalPayload,
  CvEvidenceLinkProposalPayload,
  CvFactProposalPayload,
  CvProposalKind,
  CvProposalPayload,
  CvProposalStatus,
  CvRequirementProposalPayload,
  CvSelectionProposalPayload,
  CvWordingProposalPayload,
} from './cv-proposal-schema.js';

export interface SavedJobRecord {
  id: string;
  vacancyKey: string | null;
  role: string;
  company: string;
  location: string;
  salary: string | null;
  arrangement: string | null;
  verification: string | null;
  matchPercent: number | null;
  sourceUrl: string | null;
  notes: string;
  status: SavedJobStatus;
  /** ISO-8601 */
  savedAt: string;
  /**
   * The kept gap-analysis result for this job, or null when the user has never saved one. Plain
   * text, exactly as the AI CLI produced it. See `schema.ts` for why it lives on this row.
   */
  gapAnalysis: string | null;
  /** ISO-8601, or null. Non-null exactly when `gapAnalysis` is. */
  gapAnalysisAt: string | null;
}

export interface SavedJobInput {
  role: string;
  company: string;
  location?: string;
  vacancyKey?: string | null;
  salary?: string | null;
  arrangement?: string | null;
  verification?: string | null;
  matchPercent?: number | null;
  sourceUrl?: string | null;
  notes?: string;
  status?: SavedJobStatus;
  /**
   * The kept gap-analysis result. Writable (this is what "Save analysis" sends) and clearable by
   * sending an explicit `null`.
   *
   * There is deliberately no `gapAnalysisAt` here: the timestamp is derived by the main process
   * from its own clock whenever this field is written, the way `letters.updatedAt` already is. A
   * renderer that could set it could claim an analysis was kept at a time it was not.
   */
  gapAnalysis?: string | null;
}

export type SavedJobPatch = Partial<SavedJobInput>;

export interface ApplicationRecord {
  id: string;
  savedJobId: string | null;
  role: string;
  company: string;
  location: string;
  verification: string | null;
  status: ApplicationStatus;
  /** ISO-8601, or null while the application has not been sent yet. */
  appliedAt: string | null;
  nextStep: string;
  contact: string;
  cvId: string | null;
  letterId: string | null;
  notes: string;
  archived: boolean;
}

export interface ApplicationInput {
  role: string;
  company: string;
  location?: string;
  savedJobId?: string | null;
  verification?: string | null;
  status?: ApplicationStatus;
  appliedAt?: string | null;
  nextStep?: string;
  contact?: string;
  cvId?: string | null;
  letterId?: string | null;
  notes?: string;
  archived?: boolean;
}

export type ApplicationPatch = Partial<ApplicationInput>;

/** `list` filter for applications. 'active' is the pipeline view; 'archived' the history view. */
export type ApplicationFilter = 'all' | 'active' | 'archived';

export interface CvDocumentRecord {
  id: string;
  name: string;
  kind: CvKind;
  targetRole: string;
  text: string;
  profile: CvProfile;
  /**
   * #274: the reviewed full structured source CV (employers, dates, engagement types, education,
   * contact details, links, projects). Null for every record created before this existed and for
   * every one whose source has not been extracted and reviewed yet -- which is a real, honest
   * state, not a defect: export falls back to the thin `profile` mapping rather than fabricating
   * the sections this record genuinely does not have.
   */
  source: CvSourceDocument | null;
  /** See `CvTextSource`. `'text_layer'` for every record that predates this column. */
  textSource: CvTextSource;
  isDefault: boolean;
  /** ISO-8601 */
  uploadedAt: string;
  /** ISO-8601 */
  updatedAt: string;
}

export interface CvDocumentInput {
  name: string;
  kind: CvKind;
  targetRole?: string;
  text?: string;
  profile?: Partial<CvProfile>;
  /**
   * The reviewed structured source CV. Sending it is what marks it reviewed: `reviewedAt` is
   * stamped by the main process from its own clock, never taken from here, for the same reason
   * `SavedJobInput` has no `gapAnalysisAt` -- a renderer that could set it could claim a record
   * was confirmed at a time nobody confirmed it. Sending an explicit `null` clears it.
   */
  source?: CvSourceDocument | null;
  /**
   * See `CvTextSource`. Defaults to `'text_layer'` (the column default) when omitted, which is
   * every existing call site: only the AI-transcription review step (`useCvPicker.ts`) ever sends
   * `'ai_transcription'`, and only once the user has confirmed the transcribed text is correct.
   */
  textSource?: CvTextSource;
  /** When true (or when this is the first CV in the library) the new row becomes the default. */
  isDefault?: boolean;
}

export type CvDocumentPatch = Partial<Omit<CvDocumentInput, 'kind'>>;

/**
 * #419: one (CV, vacancy) tailoring session's reviewable overlay -- see `cv-evidence-schema.ts`'s
 * header for what this is and is not. `cvId` and `vacancyKey` together are this record's real
 * identity; `id` exists only because every other workspace record has one and the update/delete
 * verbs below are shaped like every other entity's.
 */
export interface CvEvidenceOverlayRecord {
  id: string;
  cvId: string;
  vacancyKey: string;
  sourceCvContentHash: string;
  jdSnapshot: string;
  jdSnapshotHash: string;
  jdComplete: boolean;
  /** #419: what the completeness heuristic found in the current JD, and its own warning text.
   * Kept apart from `jdComplete` and from `jdConfirmedComplete`. */
  jdIncompleteReasons: CvJdIncompleteReason[];
  jdWarning: string;
  /** #419: the candidate's own "I read it and it is complete" confirmation for a short JD. */
  jdConfirmedComplete: boolean;
  /** #421's case contract: see `CvJdRevision`. */
  jdRevisions: CvJdRevision[];
  listingStatus: CvListingStatus;
  state: CvEvidenceOverlayState;
  requirements: CvRequirementMapping[];
  /** #419: extraction progress for the current JD revision. See `CvRequirementCoverage`. */
  requirementCoverage: CvRequirementCoverage;
  facts: CvEvidenceFact[];
  wordingVariants: CvApprovedWording[];
  /** #421's case contract: see `CvEvidenceOverlayOrigin`. */
  origin: CvEvidenceOverlayOrigin;
  /** #421's case contract: an opaque token bumped by the repository layer on every write, never
   * accepted from a caller (see `updateCvEvidenceOverlay`'s patch type below, which has no field
   * for it). `approveCvEvidenceOverlay` takes the caller's last-known value back as
   * `expectedCaseRevision`, purely to detect a conflicting write in between; it is never itself
   * writable. */
  caseRevision: string;
  /** #421's case contract: `null` until the first approval. See `CvApprovedResumeSnapshot`. */
  approvedResumeSnapshot: CvApprovedResumeSnapshot | null;
  /** #419 step 8: the projects the candidate approved for this case's CV, `null` until approved. */
  projectSelection: CvProjectSelection | null;
  /** #419: the CV inputs this case was started or last rebased from, used to show what changed. */
  sourceBaseline: CvSourceBaseline | null;
  /** #419 step 9: files rendered from the approved snapshot, oldest first. See `CvArtifactRecord`. */
  artifacts: CvArtifactRecord[];
  /** #419: an earlier version marked this case exported without recording a hash or checks. */
  legacyUnverifiedExport: boolean;
  /** ISO-8601 */
  capturedAt: string;
  /** ISO-8601 */
  updatedAt: string;
}

export interface CvEvidenceOverlayInput {
  cvId: string;
  vacancyKey: string;
  sourceCvContentHash: string;
  jdSnapshot?: string;
  jdSnapshotHash: string;
  jdComplete?: boolean;
  /** #419: how this JD text reached the case. Defaults to `'manual'` for a `'manual'` origin and
   * `'found'` otherwise. */
  jdOrigin?: CvJdOrigin;
  /** Optional posting URL and requisition number, stored on the JD revision. Never fetched. */
  jdUrl?: string;
  jdRequisition?: string;
  listingStatus?: CvListingStatus;
  /** Defaults to `'vacancy'` -- the only origin every existing caller creates today. #421's future
   * MCP `start_tailoring_case` tool is what will pass `'manual'`. */
  origin?: CvEvidenceOverlayOrigin;
}

/**
 * Every field a later step writes is patchable, `cvId`/`vacancyKey` are not: those are the row's
 * identity, and changing them would silently reassign an overlay to a different tailoring session
 * rather than update this one. `state` is patchable directly for every value except
 * `'candidate_approved'` (unlike, say, `CvDocumentInput`'s `isDefault`) because the composition/QA
 * gate slices need to set most transitions as a plain consequence of their own checks, not through
 * a separate verb per transition -- `'candidate_approved'` is the one exception, gated instead
 * behind `approveCvEvidenceOverlay` below, because #421 requires that specific transition to
 * re-derive wording from facts and freeze an approved-resume snapshot atomically, not merely accept
 * whatever the caller already computed (see that method's own doc comment). `caseRevision`,
 * `jdRevisions`, and `approvedResumeSnapshot` have no field here at all: they are write-layer-owned
 * derived state, never directly settable by any caller, MCP or otherwise.
 */
export interface CvEvidenceOverlayPatch {
  sourceCvContentHash?: string;
  jdSnapshot?: string;
  jdSnapshotHash?: string;
  jdComplete?: boolean;
  /** #419: metadata for the JD revision a text change creates. Ignored when the text is unchanged. */
  jdOrigin?: CvJdOrigin;
  jdUrl?: string;
  jdRequisition?: string;
  /** #419: the candidate's confirmation that a short JD is complete. Rejected for an empty or
   * known-truncated JD, and reset to `false` by any text change that does not also set it. */
  jdConfirmedComplete?: boolean;
  listingStatus?: CvListingStatus;
  state?: Exclude<CvEvidenceOverlayState, 'candidate_approved' | 'qa_failed' | 'artifact_approved'>;
  requirements?: CvRequirementMapping[];
  /** #419: record that extraction is partial (more batches owed) or that the candidate confirms the
   * list is complete. The repository stamps it with the current JD revision. */
  requirementCoverage?: { status: 'partial' | 'complete'; batches: number };
  facts?: CvEvidenceFact[];
  wordingVariants?: CvApprovedWording[];
}

/** #421: a named local client's authorization to act on the local MCP endpoint. See
 * `mcp-grant-schema.ts`'s `McpClientGrant` for the full shape this mirrors -- this record never
 * carries the credential itself, only that a verifier exists, since the credential crosses into
 * the renderer at no point (see `createMcpClientGrant` below). */
export interface McpClientGrantRecord {
  id: string;
  name: string;
  scopeType: McpGrantScopeType;
  sourceCvId: string;
  caseIds: string[];
  canReadFinalSnapshot: boolean;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 */
  expiresAt: string;
  /** ISO-8601, or `''` while active. */
  revokedAt: string;
}

export interface McpClientGrantInput {
  name: string;
  scopeType: McpGrantScopeType;
  /** Required when `scopeType === 'source_cv'`, ignored otherwise. */
  sourceCvId?: string;
  /** Required when `scopeType === 'case_ids'`, ignored otherwise -- the candidate names the exact
   * existing cases this grant may work on. */
  caseIds?: string[];
  canReadFinalSnapshot?: boolean;
  /** ISO-8601 */
  expiresAt: string;
}

/** #421's audit trail entry. See `mcp-grant-schema.ts`'s own doc comment on why every field here
 * is structurally incapable of carrying raw CV/JD text or a credential. */
export interface McpAuditLogEntry {
  id: string;
  /** `''` when no grant matched at all. */
  grantId: string;
  toolName: string;
  /** `''` when no case was involved. */
  caseId: string;
  outcome: McpAuditOutcome;
  /** `''` when not applicable. */
  revision: string;
  /** ISO-8601 */
  createdAt: string;
}

export interface McpAuditLogEntryInput {
  /** `''` when no grant matched at all. */
  grantId: string;
  toolName: string;
  caseId?: string;
  outcome: McpAuditOutcome;
  revision?: string;
}

/** #421's staging layer: what an MCP client proposed, before any of it reaches a real
 * `CvRequirementMapping`/`CvEvidenceFact`/`CvApprovedWording`. See `cv-proposal-schema.ts`'s own
 * header for why a proposal is never the same type as what it promotes into. There is no
 * `CvTailoringProposalInput` here: a proposal is created only by an MCP tool handler calling
 * `createCvTailoringProposal` directly (same process, no IPC channel), never by the renderer --
 * the renderer only ever lists, accepts, or rejects one that already exists.
 */
export interface CvTailoringProposalRecord {
  id: string;
  caseId: string;
  /** `''` if the grant that proposed this no longer exists. */
  grantId: string;
  status: CvProposalStatus;
  payload: CvProposalPayload;
  caseRevisionAtProposal: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601, or `''` while `status === 'pending'`. */
  decidedAt: string;
}


/** #156: the two formats the manual CV Library export action offers, matching what the existing
 * Letters export already supports (`letters/export.ts`'s `exportDocx`/`exportPdf`) minus markdown,
 * which the ticket's own scope narrows to PDF/DOCX for a resume. */
export type CvExportFormat = 'pdf' | 'docx';

/** Mirrors `SaveFileResult` (`window.d.ts`/`preload.ts`'s `system.saveFile`): `{ saved: false }`
 * means the user cancelled the native save dialog, not a failure -- the caller must not treat it
 * as an error. Named separately (not reused) because this bridge's own key-set test
 * (`preload.test.ts`) pins `workspace` and `system` as independent namespaces with no shared type
 * import between them. */
export interface CvExportResult {
  saved: boolean;
  path?: string;
}

/** The result of exporting a tailoring case's approved snapshot (#419 step 9). `artifact` is the record
 * written by this call: a saved file, or a file that failed its checks (`saved: false` with
 * `validation.ok` false). It is `null` when the save dialog was cancelled, which writes nothing. */
export interface CvCaseExportResult {
  saved: boolean;
  path?: string;
  artifact: CvArtifactRecord | null;
  overlay: CvEvidenceOverlayRecord;
}

export interface LetterRecord {
  id: string;
  title: string;
  company: string;
  role: string;
  type: LetterType;
  tone: LetterTone;
  length: LetterLength;
  status: LetterStatus;
  vacancyKey: string | null;
  cvId: string | null;
  body: string;
  /** ISO-8601 */
  updatedAt: string;
}

export interface LetterInput {
  title: string;
  company?: string;
  role?: string;
  type?: LetterType;
  tone?: LetterTone;
  length?: LetterLength;
  status?: LetterStatus;
  vacancyKey?: string | null;
  cvId?: string | null;
  body?: string;
}

export type LetterPatch = Partial<LetterInput>;

export type ApplicationAttemptCheckpoint =
  | 'queued'
  | 'reading_jd'
  | 'tailoring'
  | 'rendering'
  | 'filling'
  | 'ready'
  | 'submitting'
  | 'submitted'
  | 'needs_user'
  | 'skipped'
  | 'failed'
  | 'submission_unknown'
  /**
   * A person told the app they completed this application themselves (#271). Kept strictly
   * distinct from `submitted`, which since #271 means "this app observed a real receipt": folding
   * a person's own statement into the evidence-backed value would make that value unfalsifiable.
   * Never downgraded to `failed` by the absence of a confirmation email -- silence is not evidence.
   */
  | 'user_reported';

/** Checkpoints for which a dedup check refuses a second concurrent attempt at the same vacancy.
 * `submission_unknown` is deliberately included even though it is not really "still in progress":
 * it means a real submit action may or may not have gone through, and starting a fresh unforced
 * attempt at that exact vacancy risks a second real submission on top of one that already
 * succeeded. Per #198's own framing, the realistic way to resolve that is asking the user --
 * which here means the user has to pass `force: true`, the same escape hatch as any other
 * deliberate re-attempt, not that this checkpoint is silently treated as safely closed out.
 *
 * `user_reported` is deliberately absent, exactly like `submitted`: both mean this vacancy has
 * been applied to and nothing is still in flight, so a genuinely later re-application is allowed
 * without `force` -- unlike `submission_unknown`, where a second attempt risks doubling up on one
 * that already succeeded. */
export const NON_TERMINAL_ATTEMPT_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = [
  'queued',
  'reading_jd',
  'tailoring',
  'rendering',
  'filling',
  'ready',
  'submitting',
  'needs_user',
  'submission_unknown',
];

/**
 * Checkpoints that mean an application to this requisition is already done, for #275's
 * completed-application lookup. Deliberately a *separate* set from the concurrency guard above,
 * and deliberately overlapping it on `submission_unknown`, because the two answer different
 * questions:
 *
 *  - The concurrency guard asks "is something already running for this vacancy?", and `force: true`
 *    is the documented way for a user to say "yes, and start another anyway".
 *  - This set asks "did an application already reach the employer?". `force` must NOT answer that
 *    one: #198's escape hatch exists for re-attempting work that did not land, and letting it also
 *    wave through a posting that already got a real submission is precisely the hole #275 closes.
 *    The only way past this set is the explicit, recorded reapply path.
 *
 * `submission_unknown` is in both. It stays protected here so that clearing the concurrency guard
 * with `force` cannot silently re-queue a posting that may already have been submitted; resolving
 * it takes either reconciliation (patching the checkpoint to what actually happened, with a
 * recorded reason) or a recorded reapply -- never a bare retry.
 *
 * `user_reported` is in this set and deliberately absent from the concurrency guard above, and the
 * two facts are not in tension. #271 made `submitted` mean "this app observed a receipt", which
 * moved a person's own "I applied to this by hand" onto its own checkpoint. That statement is
 * still a completed application to this requisition -- #275's third acceptance case requires
 * user-reported and receipt-confirmed completion to suppress a duplicate *equally* -- so leaving
 * it out here would have reopened the exact hole #275 closes, for the one completion path a person
 * is most likely to use. It stays out of the concurrency set for #271's reason: nothing is in
 * flight, so it is not a concurrent attempt; it is a finished one, which is what this set is for.
 */
export const COMPLETED_ATTEMPT_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = [
  'submitted',
  'user_reported',
  'submission_unknown',
];

/** What backs a completion claim. See `schema.ts`'s comment on `completion_evidence`: both values
 * suppress duplicates identically, and the distinction is preserved rather than collapsed. */
export type ApplicationCompletionEvidence = 'user_reported' | 'receipt_confirmed';

export interface ApplicationAttemptRecord {
  id: string;
  applicationId: string | null;
  vacancyKey: string | null;
  canonicalUrl: string;
  /** #275's derived requisition identity. Never supplied by a caller: `createApplicationAttempt`
   * derives all three from `company`/`canonicalUrl` so two rows cannot disagree about what the
   * same URL means. */
  employerKey: string;
  requisitionId: string | null;
  canonicalUrlKey: string;
  company: string;
  role: string;
  sourceCvId: string | null;
  sourceCvContentHash: string;
  jdSnapshot: string;
  jdSnapshotHash: string;
  jdComplete: boolean;
  workflowVersion: string;
  tailoringMode: 'ai' | 'original';
  checkpoint: ApplicationAttemptCheckpoint;
  checkpointDetail: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 */
  updatedAt: string;
  /** ISO-8601, or null before a submit was ever attempted. */
  submittedAt: string | null;
  /** Set once this attempt reaches `submitted` (#203) -- see `schema.ts`'s own comment on the
   * column for what it fingerprints and why. Null for every attempt that hasn't submitted yet. */
  formStructureHash: string | null;
  /** ISO-8601. Set only while an automatic-mode submit (#203) is queued for this attempt's
   * cancel/undo window; null otherwise, including for every manually-reviewed attempt. */
  scheduledAutomaticSubmitAt: string | null;
  /** Which path actually sent this attempt, set alongside `submittedAt`. Null until submitted. */
  submissionMode: 'manual' | 'automatic' | null;
  /** What backs this attempt's completion claim (#275), or null when it was never recorded --
   * which, on a `submitted` row, means "completed, evidence unrecorded", not "not completed". */
  completionEvidence: ApplicationCompletionEvidence | null;
  /** Set only on the explicit reapply path (#275): the completed attempt this one supersedes,
   * why, and the document version that attempt carried. Null/empty on an ordinary attempt. */
  supersedesAttemptId: string | null;
  reapplyReason: string;
  reapplyPreviousCvContentHash: string | null;
  /**
   * What the preparation pipeline (#272) committed to this attempt's form, or null for an attempt
   * no pipeline run has prepared. Read-only across the bridge: there is no patch field for it, so
   * only the main-process pipeline can ever write one (see `recordPreparedApplicationFields`).
   */
  preparedFields: PreparedApplicationFields | null;
}

/** Where a committed value came from. Mirrors `ValueProvenance` in
 * `@agent-dock/application-executor`, spelled out locally for the same reason every other enum in
 * this file is: the renderer must not gain a runtime import from the executor package. */
export type PreparedFieldProvenance = 'cv' | 'profile' | 'user_answer' | 'jd';

export type PreparedFieldStatus =
  /** This app filled the field, and the executor reported the fill succeeded. */
  | 'committed'
  /** Deliberately left for the person: a consent or credential field, which this app never fills
   * on someone's behalf regardless of what a generation session proposes. */
  | 'awaiting_you'
  /** Optional, and no source value existed for it. Left empty rather than invented. */
  | 'left_blank'
  /** A document upload this attempt could not complete. Stays a blocker, never a silent skip. */
  | 'pending_upload';

export interface PreparedApplicationField {
  /** The field's own label, exactly as the live page presented it when the fill ran. */
  label: string;
  controlType: 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file' | 'unknown';
  required: boolean;
  status: PreparedFieldStatus;
  /** The exact value committed. Present only for `committed`. */
  value?: string;
  /** Which source that value came from. Present only for `committed`. */
  provenance?: PreparedFieldProvenance;
  /** Why nothing was committed. Present for every status other than `committed`. */
  detail?: string;
}

/**
 * The durable record of one attempt's prepared form (#272), stored as JSON on the attempt row.
 *
 * `company`/`role` are recorded alongside the fields on purpose: a review renders these only when
 * they still match the attempt it is showing, so a record left over from any other employer or
 * role can never be presented as this application's answers.
 */
export interface PreparedApplicationFields {
  version: 1;
  /** ISO-8601, main-process clock, at the moment the fill ran. */
  preparedAt: string;
  company: string;
  role: string;
  /**
   * How the values below were established. `applied` means this app applied them and the executor
   * reported each fill succeeded -- it is explicitly NOT a read-back of the live page confirming
   * the value is committed there, which is #277 (R06)'s work. A later verification level is added
   * as a new value here rather than by widening what `applied` is taken to mean.
   */
  verification: 'applied';
  fields: PreparedApplicationField[];
}

/**
 * The one way past #275's completed-application guard: a deliberate, recorded decision to apply
 * again to a requisition an earlier attempt already reached -- a corrected document, an updated
 * CV, an employer who asked for a resubmission.
 *
 * Every field is required because the point is the record. `supersedesAttemptId` must name an
 * attempt that is genuinely one of the completed matches for this identity, so naming an unrelated
 * attempt cannot be used as a generic bypass, and `reason` must be non-empty so the row says why.
 */
export interface ApplicationReapplyRequest {
  supersedesAttemptId: string;
  reason: string;
}

/**
 * One already-completed application found by #275's lookup. `matchedOn` says which identity
 * actually matched, so a caller (and a human reading a refusal) can tell a confident ATS
 * requisition match from the weaker URL fallback rather than being told only that something
 * matched.
 */
export interface CompletedApplicationMatch {
  attemptId: string;
  /** `submitted`, or `submission_unknown` for an attempt whose outcome was never reconciled. */
  checkpoint: ApplicationAttemptCheckpoint;
  completionEvidence: ApplicationCompletionEvidence | null;
  matchedOn: 'requisition' | 'canonical_url' | 'vacancy_key';
  /** ISO-8601, or null for a `submission_unknown` attempt that never recorded a submit time. */
  submittedAt: string | null;
}

export interface ApplicationAttemptInput {
  applicationId?: string | null;
  vacancyKey?: string | null;
  canonicalUrl?: string;
  /**
   * An employer/ATS requisition id the caller already has from a structured source. Only consulted
   * when `canonicalUrl` is not a recognised ATS job URL, which is the case that can derive a better
   * one on its own. Never trusted over the URL.
   */
  requisitionId?: string | null;
  company: string;
  role: string;
  sourceCvId?: string | null;
  sourceCvContentHash: string;
  jdSnapshot?: string;
  jdSnapshotHash: string;
  jdComplete?: boolean;
  workflowVersion?: string;
  checkpoint?: ApplicationAttemptCheckpoint;
  checkpointDetail?: string;
  /**
   * Bypasses the dedup refusal (an existing non-terminal attempt for the same `vacancyKey`) for
   * the one case #198 calls out explicitly: the user asking for a genuinely new attempt at a
   * vacancy they already tried. Defaults to false; a caller has to opt in.
   *
   * Scoped to the *concurrency* guard only. It has never meant "send a second application to a
   * posting that already got one", and since #275 it cannot: a completed (or possibly-completed)
   * application is refused regardless of this flag, and only `reapply` gets past that.
   */
  force?: boolean;
  /**
   * The explicit corrected-document/reapply path (#275). Present only when the user has decided to
   * apply again to a requisition an earlier attempt already reached; the resulting row records the
   * predecessor, the reason, and both document versions.
   */
  reapply?: ApplicationReapplyRequest;
}

/** Every field patchable except the identity/provenance fields (`vacancyKey`, `canonicalUrl`,
 * `employerKey`, `requisitionId`, `canonicalUrlKey`, `company`, `role`, `sourceCvId`,
 * `sourceCvContentHash`, `jdSnapshot`, `jdSnapshotHash`, `workflowVersion`) and the reapply record
 * (`supersedesAttemptId`, `reapplyReason`, `reapplyPreviousCvContentHash`) -- an attempt's own
 * record of what it was generated from, and of the decision that authorized it, must not silently
 * change after creation; only its progress (checkpoint, detail, linkage, completeness, submit time,
 * completion evidence) does. */
export type ApplicationAttemptPatch = Partial<
  Pick<
    ApplicationAttemptInput,
    'applicationId' | 'jdComplete' | 'checkpoint' | 'checkpointDetail'
  >
> & {
  submittedAt?: string | null;
  formStructureHash?: string | null;
  scheduledAutomaticSubmitAt?: string | null;
  submissionMode?: 'manual' | 'automatic' | null;
  completionEvidence?: ApplicationCompletionEvidence | null;
};

export type ApplicationArtifactKind = 'cv_pdf' | 'cover_letter_pdf' | 'combined_pdf' | 'other';

export interface ApplicationArtifactRecord {
  id: string;
  attemptId: string;
  kind: ApplicationArtifactKind;
  fileName: string;
  mimeType: string;
  byteSize: number;
  contentHash: string;
  storagePath: string;
  /** ISO-8601 */
  createdAt: string;
}

/** Renderer-safe artifact metadata. The app-owned absolute storage path never crosses contextBridge. */
export type ApplicationArtifactSummary = Omit<ApplicationArtifactRecord, 'storagePath'>;

export interface ApplicationArtifactInput {
  attemptId: string;
  kind: ApplicationArtifactKind;
  fileName?: string;
  mimeType: string;
  byteSize: number;
  contentHash: string;
  storagePath?: string;
}

/** #271. `user_reported` exists here as well as on the checkpoint enum because a receipt row
 * records *one observation*, and "a person said they did this by hand" is one of the observations
 * worth keeping -- recorded as its own outcome so it is never counted as observed delivery. */
export type SubmissionReceiptOutcome = 'submitted' | 'rejected' | 'unknown' | 'user_reported';

export type SubmissionReceiptSource = 'page_observation' | 'delayed_receipt' | 'user_reported';

export type SubmissionReceiptEvidenceKind =
  | 'confirmation_page'
  | 'receipt_reference'
  | 'delivery_receipt'
  | 'user_statement'
  | 'none';

/**
 * One durable record of what was actually observed about an attempt's delivery (#271). See
 * `schema.ts`'s own comment on the table for why this is separate from the attempt's checkpoint.
 * `evidenceReference` is untrusted third-party page text: display it, never act on it.
 */
export interface ApplicationSubmissionReceiptRecord {
  id: string;
  attemptId: string;
  outcome: SubmissionReceiptOutcome;
  source: SubmissionReceiptSource;
  destination: string;
  evidenceKind: SubmissionReceiptEvidenceKind;
  evidenceReference: string;
  detail: string;
  /** ISO-8601 */
  observedAt: string;
  /** ISO-8601 */
  createdAt: string;
}

export interface ApplicationSubmissionReceiptInput {
  attemptId: string;
  outcome: SubmissionReceiptOutcome;
  source: SubmissionReceiptSource;
  destination?: string;
  evidenceKind: SubmissionReceiptEvidenceKind;
  evidenceReference?: string;
  detail?: string;
  /** ISO-8601. Defaults to now, but the observer passes its own observation timestamp so the
   * record carries when the evidence was seen, not when the row happened to be written. */
  observedAt?: string;
}

/**
 * One saved answer in the reusable application-answer library (#372). See `schema.ts`'s comment
 * on `applicationAnswers` for the full reasoning: candidate-authored only, exact-key lookup only,
 * pure storage -- the confirm/fill step lives in `application-review-session.ts`.
 */
export interface ApplicationAnswerRecord {
  id: string;
  /** `applicationAnswerKey(label, controlType)` (`application-answer-key.ts`); the exact-match
   * lookup key, not shown to the user. */
  normalizedKey: string;
  /** The original, unnormalized field label -- what the management UI displays. */
  label: string;
  controlType: 'text' | 'textarea';
  answer: string;
  originCompany: string;
  originRole: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601. Bumped on every edit to `answer`. */
  updatedAt: string;
  /** ISO-8601. Bumped every time this saved answer is actually used elsewhere, not on an edit. */
  lastConfirmedAt: string;
}

export interface ApplicationAnswerInput {
  label: string;
  controlType: 'text' | 'textarea';
  answer: string;
  originCompany: string;
  originRole: string;
}

/**
 * Editing an existing saved answer from the management UI. Deliberately only `answer` is
 * patchable: `label`/`controlType` together derive `normalizedKey`, so editing either after
 * creation would silently break the match to the application this answer was originally saved
 * from, and `originCompany`/`originRole` are provenance of that original save, not user-editable
 * fields -- #372 does not ask for either, and both would be surprising to allow.
 */
export type ApplicationAnswerPatch = Partial<{ answer: string }>;

/** An explicit grant of automatic-submission authority for one compiled target policy (#203). See
 * `schema.ts`'s own comment on `automationGrants` for why this is scoped per-policy, not per-posting,
 * and why `expiresAt`/`revokedAt` are re-checked at every use rather than only at creation. */
export interface AutomationGrantRecord {
  id: string;
  policyId: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 */
  expiresAt: string;
  /** ISO-8601, or null while active. */
  revokedAt: string | null;
}

export interface AutomationGrantInput {
  policyId: string;
  /** ISO-8601. The caller (main-process code behind a native confirmation dialog -- #203 scope
   * item 5) decides how far out this is; there is no default here to accidentally inherit. */
  expiresAt: string;
}

export interface AppSettingsRecord {
  launchAtLogin: boolean;
  startPage: StartPage;
  theme: ThemePreference;
  density: DensityPreference;
  sidebarStart: SidebarStartPreference;
  sidebarCollapsed: boolean;
  lastOpenedPage: string;
  minimizeToTrayOnClose: boolean;
  welcomeSeen: boolean;
  autoScanEnabled: boolean;
  /** The auto-apply kill switch (off for this MVP release). Read by main.ts at startup and handed
   * to `application-target-policies.ts`; never writable from the renderer -- `parseSettingsPatch`
   * does not accept it. See `schema.ts`'s comment on the column for the full reasoning. */
  autoApplyEnabled: boolean;
  defaultLocation: string;
  defaultCvId: string | null;
  defaultLetterType: LetterType;
  defaultLetterTone: LetterTone;
  defaultLetterLength: LetterLength;
  defaultApplicationStatus: ApplicationStatus;
  confirmApplicationDelete: boolean;
  autoArchiveRejected: boolean;
  defaultProvider: DefaultAiProvider;
  /** #421: whether the local MCP endpoint listens at all. See `schema.ts`'s comment on the column
   * for the full reasoning; unlike `autoApplyEnabled` above, `parseSettingsPatch` does accept this
   * one -- it is the literal on/off switch the candidate flips in Settings. */
  mcpEndpointEnabled: boolean;
  /**
   * ADI-07: the AI Workspace's renderer-local view state, persisted here rather than in
   * `localStorage` so it travels with the workspace database like every other preference. See
   * `schema.ts`'s comment on these three columns for the full reasoning.
   */
  agentSelectedSessionId: string | null;
  agentArchivedSessionIds: string[];
  agentUnreadCounts: Record<string, number>;
}

export type AppSettingsPatch = Partial<AppSettingsRecord>;

/** Uniform result for the delete verbs: `false` means "no such row", not "an error occurred". */
export interface DeleteResult {
  deleted: boolean;
}

/** Sidebar badge counts. `activeApplications` excludes archived rows, matching the nav badge.
 * `cvDocuments` also doubles as the cheap "is the CV library empty" check the Welcome modal's
 * first-launch gate needs -- an id-only count, not a fetch of every CV's full extracted text. */
export interface WorkspaceCounts {
  savedJobs: number;
  activeApplications: number;
  letters: number;
  cvDocuments: number;
}

/** Result of the main-process-owned destructive reset. */
export interface ApplicationDataResetResult {
  settings: AppSettingsRecord;
  deleted: {
    savedJobs: number;
    applications: number;
    cvDocuments: number;
    letters: number;
    applicationAttempts: number;
    applicationArtifacts: number;
    submissionReceipts: number;
    automationGrants: number;
    applicationAnswers: number;
    cvEvidenceOverlays: number;
    mcpClientGrants: number;
    mcpAuditLogEntries: number;
    cvTailoringProposals: number;
  };
}

/**
 * The `window.workspace` capability list, declared here (not in preload.ts) so the renderer can
 * refer to it without a type reference into the preload module itself. preload.ts implements this
 * interface; `src/window.d.ts` re-exports it.
 *
 * Flat and explicit on purpose: twenty named capabilities rather than a nested
 * `workspace.savedJobs.create(...)` object or (worse) a `workspace.query(table, verb, payload)`
 * dispatcher. A flat list is the shape a test can assert exhaustively ("exactly these functions
 * and nothing else"), and it makes adding a capability a visible diff in four files rather than a
 * new string threaded through one generic channel.
 */
export interface WorkspaceBridge {
  getSettings(): Promise<AppSettingsRecord>;
  updateSettings(patch: AppSettingsPatch): Promise<AppSettingsRecord>;
  getCounts(): Promise<WorkspaceCounts>;
  resetApplicationData(): Promise<ApplicationDataResetResult>;

  listSavedJobs(): Promise<SavedJobRecord[]>;
  createSavedJob(input: SavedJobInput): Promise<SavedJobRecord>;
  updateSavedJob(id: string, patch: SavedJobPatch): Promise<SavedJobRecord>;
  deleteSavedJob(id: string): Promise<DeleteResult>;

  listApplications(filter?: ApplicationFilter): Promise<ApplicationRecord[]>;
  createApplication(input: ApplicationInput): Promise<ApplicationRecord>;
  updateApplication(id: string, patch: ApplicationPatch): Promise<ApplicationRecord>;
  deleteApplication(id: string): Promise<DeleteResult>;

  listCvDocuments(): Promise<CvDocumentRecord[]>;
  createCvDocument(input: CvDocumentInput): Promise<CvDocumentRecord>;
  updateCvDocument(id: string, patch: CvDocumentPatch): Promise<CvDocumentRecord>;
  deleteCvDocument(id: string): Promise<DeleteResult>;
  /** Returns the whole library, so the caller sees the demotion of the previous default too. */
  setDefaultCvDocument(id: string): Promise<CvDocumentRecord[]>;

  listLetters(): Promise<LetterRecord[]>;
  createLetter(input: LetterInput): Promise<LetterRecord>;
  updateLetter(id: string, patch: LetterPatch): Promise<LetterRecord>;
  deleteLetter(id: string): Promise<DeleteResult>;
  duplicateLetter(id: string): Promise<LetterRecord>;

  /**
   * Read/patch-only (issue #202): the renderer can list, inspect, and update the checkpoint/detail
   * of an application attempt for review, but never creates or deletes one directly -- an attempt's
   * existence and its identity fields (company, role, source CV, JD snapshot) are owned entirely by
   * the main-process generation pipeline (#198-#201), not by anything the renderer initiates.
   */
  listApplicationAttempts(): Promise<ApplicationAttemptRecord[]>;
  getApplicationAttempt(id: string): Promise<ApplicationAttemptRecord>;
  updateApplicationAttempt(id: string, patch: ApplicationAttemptPatch): Promise<ApplicationAttemptRecord>;
  listApplicationArtifacts(attemptId: string): Promise<ApplicationArtifactSummary[]>;

  /**
   * Read/revoke-only (issue #203): the renderer can see which policies currently have an active
   * automatic-submission grant and turn one off, but can never CREATE one through this bridge --
   * granting requires a real native OS confirmation dialog, which lives behind
   * `window.applicationExecutor.requestAutomationGrant` instead, precisely so that a plain IPC
   * call (the same boundary that is adequate for read/patch access here) is never the sole gate on
   * authorizing unattended submission. Revoking carries no such risk in the other direction --
   * turning automation off is always safe to do immediately -- so it stays a plain bridge method.
   */
  listAutomationGrants(): Promise<AutomationGrantRecord[]>;
  revokeAutomationGrant(id: string): Promise<AutomationGrantRecord>;

  /**
   * #156: renders one CV Library entry into the app's default resume template and writes it to a
   * user-chosen path via the native save dialog, exactly the "manual export with a default
   * app-authored template" action the ticket asks for. Unlike `system.saveFile` (which only ever
   * writes bytes the renderer already built), the actual document content is produced entirely in
   * the main process -- PDF rendering needs a real `BrowserWindow` -- so this one capability both
   * renders and saves, rather than being split across two calls the way Letters' export is.
   * `{ saved: false }` means the user cancelled the dialog, not a failure.
   */
  exportCvDocument(id: string, format: CvExportFormat): Promise<CvExportResult>;

  /**
   * #419, slice 1: plain CRUD over one CV's tailoring overlays, no approval/composition logic --
   * that arrives with the slices that read `state`/`requirements`/`wordingVariants` for a reason.
   * `getCvEvidenceOverlay` returns `null` rather than throwing when no overlay exists yet for a
   * (cvId, vacancyKey) pair: "never started this vacancy's draft" is the normal first-visit state,
   * not an error, the same distinction `WorkspaceNotFoundError` already draws for every id lookup
   * that *should* exist.
   */
  listCvEvidenceOverlays(cvId: string): Promise<CvEvidenceOverlayRecord[]>;
  getCvEvidenceOverlay(cvId: string, vacancyKey: string): Promise<CvEvidenceOverlayRecord | null>;
  createCvEvidenceOverlay(input: CvEvidenceOverlayInput): Promise<CvEvidenceOverlayRecord>;
  updateCvEvidenceOverlay(id: string, patch: CvEvidenceOverlayPatch): Promise<CvEvidenceOverlayRecord>;
  /**
   * #421's case contract: the *only* path that may move `state` to `'candidate_approved'`. Unlike
   * `updateCvEvidenceOverlay` (which accepts and stores whatever `wordingVariants` the caller sends
   * as a plain patch), this re-derives wording from the overlay's own facts server-side
   * (`proposeWordingFromFacts`) rather than trusting a caller-computed value, re-checks every gap
   * (`describeCvEvidenceOverlayGaps`) before applying anything, and freezes an
   * `approvedResumeSnapshot` in the same write -- so an MCP tool (or a compromised renderer) cannot
   * approve arbitrary text merely by getting it validated and stored through the generic patch
   * verb. `expectedCaseRevision` must match the overlay's current `caseRevision` or the call
   * rejects with a conflict naming the actual current revision, never a partial apply.
   */
  approveCvEvidenceOverlay(id: string, expectedCaseRevision: string): Promise<CvEvidenceOverlayRecord>;
  /**
   * #419 step 8: records the candidate's approval of the projects the CV will show (the source's
   * pinned projects plus the unpinned ones its limit allows, computed in the main process, never
   * taken from the caller). Required before whole-CV approval when the source has projects. Any
   * change to that selection later makes the stored one stale.
   */
  approveCvProjectSelection(id: string, expectedCaseRevision: string): Promise<CvEvidenceOverlayRecord>;
  /** #419: what changed in the CV since this case was started, and what a rebase would keep and
   * drop. Read only. */
  previewCvEvidenceRebase(id: string): Promise<CvRebasePlan>;
  /**
   * #419: the candidate's explicit "use my current CV" action. Keeps facts and wording that still
   * fit the current CV, drops wording whose role, project or source text changed, clears the project
   * selection approval and leaves the case a draft that must be approved again.
   */
  rebaseCvEvidenceOverlay(id: string, expectedCaseRevision: string): Promise<CvEvidenceOverlayRecord>;
  deleteCvEvidenceOverlay(id: string): Promise<DeleteResult>;
  /**
   * #419, slice 4: renders the *candidate-approved* composition (`composeApprovedTailoredResume`,
   * built fresh against the current reviewed source, never a cached one) to a real file via the
   * native save dialog -- the same rendering/validation machinery `exportCvDocument` already uses,
   * pointed at a different resume source. Refuses with the composition's own blockers when the
   * overlay is not actually approvable, the same way `exportCvDocument` refuses on
   * `describeCvExportBlockers`. On a successful, validated export, the overlay's `state` becomes
   * `'artifact_approved'` -- the terminal state, distinct from `'candidate_approved'` (#419: "CV
   * approval and application/submission readiness are separate states").
   */
  exportCvEvidenceOverlay(overlayId: string, format: CvExportFormat): Promise<CvCaseExportResult>;
  /**
   * #419 step 9: opens the saved file for the candidate to read, after checking that its bytes still
   * match the hash recorded at export, and records that it was opened. A PDF cannot be accepted
   * before this has happened.
   */
  openCvArtifact(overlayId: string, artifactId: string): Promise<CvEvidenceOverlayRecord>;
  /** #419 step 9: the candidate's explicit visual confirmation of one saved file. Refused for a file
   * that failed its checks or belongs to an earlier version of the CV. */
  confirmCvArtifact(overlayId: string, artifactId: string): Promise<CvEvidenceOverlayRecord>;

  /**
   * #421: named local-client grants for the local MCP endpoint. Deliberately never returns a
   * credential value -- `createMcpClientGrant`'s one-time secret is delivered to the candidate
   * through a main-process-owned native dialog or clipboard action and never crosses into the
   * renderer at all (the same "the daemon's bearer token never crosses into the renderer" rule
   * SECURITY.md already states, generalized to a per-client credential). This resolved value is
   * only ever the grant record itself.
   */
  listMcpClientGrants(): Promise<McpClientGrantRecord[]>;
  createMcpClientGrant(input: McpClientGrantInput): Promise<McpClientGrantRecord>;
  revokeMcpClientGrant(id: string): Promise<McpClientGrantRecord>;
  /** `port` is `null` whenever `running` is `false`. Not itself a secret -- see `main.ts`'s own
   * comment on this channel for why this is a plain read, unlike the daemon's base URL/token. */
  getMcpServerStatus(): Promise<{ running: boolean; port: number | null }>;

  /**
   * #421's proposal review surface. `acceptCvTailoringProposal` promotes the proposal's payload
   * into the case's real `CvEvidenceOverlay` (the exact promotion depends on `payload.kind`, see
   * `acceptCvTailoringProposal`'s own doc comment in `repository.ts`) and returns both the decided
   * proposal and the overlay it just updated, since the caller's screen is watching the overlay,
   * not the proposal list. `rejectCvTailoringProposal` has no promotion step: the overlay is
   * unchanged, only the proposal's own `status` moves to `'rejected'`.
   */
  listCvTailoringProposals(caseId: string): Promise<CvTailoringProposalRecord[]>;
  acceptCvTailoringProposal(id: string): Promise<{ proposal: CvTailoringProposalRecord; overlay: CvEvidenceOverlayRecord }>;
  rejectCvTailoringProposal(id: string): Promise<CvTailoringProposalRecord>;

  /**
   * The reusable application-answer library (#372). See `schema.ts`'s comment on
   * `applicationAnswers` for what this stores and why it is never auto-filled from here.
   */
  listApplicationAnswers(): Promise<ApplicationAnswerRecord[]>;
  /** Upsert on the normalized label+controlType key: an existing answer for the same key is
   * updated in place (`answer`, `originCompany`, `originRole`, `updatedAt`, `lastConfirmedAt`)
   * rather than duplicated. */
  saveApplicationAnswer(input: ApplicationAnswerInput): Promise<ApplicationAnswerRecord>;
  updateApplicationAnswer(id: string, patch: ApplicationAnswerPatch): Promise<ApplicationAnswerRecord>;
  /** Bumps only `lastConfirmedAt`, for the moment a saved answer is actually reused on a live field
   * ("Use this answer"). Separate from `updateApplicationAnswer`: this is a pure use-confirmation
   * signal, never a way to edit the answer's own text. */
  recordApplicationAnswerUsed(id: string): Promise<ApplicationAnswerRecord>;
  deleteApplicationAnswer(id: string): Promise<DeleteResult>;
}
