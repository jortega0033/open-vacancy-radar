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
  /** When true (or when this is the first CV in the library) the new row becomes the default. */
  isDefault?: boolean;
}

export type CvDocumentPatch = Partial<Omit<CvDocumentInput, 'kind'>>;

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
  | 'submission_unknown';

/** Checkpoints for which a dedup check refuses a second concurrent attempt at the same vacancy.
 * `submission_unknown` is deliberately included even though it is not really "still in progress":
 * it means a real submit action may or may not have gone through, and starting a fresh unforced
 * attempt at that exact vacancy risks a second real submission on top of one that already
 * succeeded. Per #198's own framing, the realistic way to resolve that is asking the user --
 * which here means the user has to pass `force: true`, the same escape hatch as any other
 * deliberate re-attempt, not that this checkpoint is silently treated as safely closed out. */
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

export interface ApplicationAttemptRecord {
  id: string;
  applicationId: string | null;
  vacancyKey: string | null;
  canonicalUrl: string;
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
}

export interface ApplicationAttemptInput {
  applicationId?: string | null;
  vacancyKey?: string | null;
  canonicalUrl?: string;
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
   */
  force?: boolean;
}

/** Every field patchable except the identity/provenance fields (`vacancyKey`, `canonicalUrl`,
 * `company`, `role`, `sourceCvId`, `sourceCvContentHash`, `jdSnapshot`, `jdSnapshotHash`,
 * `workflowVersion`) -- an attempt's own record of what it was generated from must not silently
 * change after creation; only its progress (checkpoint, detail, linkage, completeness, submit
 * time) does. */
export type ApplicationAttemptPatch = Partial<
  Pick<
    ApplicationAttemptInput,
    'applicationId' | 'jdComplete' | 'checkpoint' | 'checkpointDetail'
  >
> & { submittedAt?: string | null };

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
}
