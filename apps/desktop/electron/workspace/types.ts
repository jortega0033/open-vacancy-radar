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
  /** When true (or when this is the first CV in the library) the new row becomes the default. */
  isDefault?: boolean;
}

export type CvDocumentPatch = Partial<Omit<CvDocumentInput, 'kind'>>;

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
  autoScanEnabled: boolean;
  defaultLocation: string;
  defaultCvId: string | null;
  defaultLetterType: LetterType;
  defaultLetterTone: LetterTone;
  defaultLetterLength: LetterLength;
  defaultApplicationStatus: ApplicationStatus;
  confirmApplicationDelete: boolean;
  autoArchiveRejected: boolean;
  defaultProvider: DefaultAiProvider;
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

/** Sidebar badge counts. `activeApplications` excludes archived rows, matching the nav badge. */
export interface WorkspaceCounts {
  savedJobs: number;
  activeApplications: number;
  letters: number;
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
  listApplicationArtifacts(attemptId: string): Promise<ApplicationArtifactRecord[]>;

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
}
