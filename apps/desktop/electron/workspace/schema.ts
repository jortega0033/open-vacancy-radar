import { randomUUID } from 'node:crypto';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Personal workspace data (saved jobs, applications, CV library, generated letters, settings),
 * deliberately a separate small schema/database from `@open-vacancy-radar/vacancy-engine`'s.
 * The engine's database is scan/discovery state with its own lifecycle (migrations, advisory
 * locks, content-hash reuse); this is plain per-user CRUD the desktop app owns outright. Keeping
 * them apart means neither schema's migration history constrains the other.
 *
 */

export const savedJobs = sqliteTable('saved_jobs', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /** Links back to a DiscoveryVacancyAudit/report row's `key`, when saved from a live search
   * result. Null for a manually-entered saved job (the prototype's "add saved job" flow). */
  vacancyKey: text('vacancy_key'),
  role: text('role').notNull(),
  company: text('company').notNull(),
  location: text('location').notNull(),
  salary: text('salary'),
  arrangement: text('arrangement'),
  verification: text('verification'),
  matchPercent: integer('match_percent'),
  sourceUrl: text('source_url'),
  notes: text('notes').notNull().default(''),
  status: text('status', { enum: ['considering', 'preparing', 'applied'] }).notNull().default('considering'),
  savedAt: integer('saved_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  /**
   * The gap-analysis answer the user explicitly chose to keep for this job, exactly as the AI CLI
   * returned it (plain text). Nullable, and null is the normal state: analysis is on-demand, most
   * saved jobs never have one, and nothing writes here except the "Save analysis" action.
   *
   * It is a column on `saved_jobs` rather than its own table because there is exactly one kept
   * analysis per job -- clicking "Save analysis" again replaces it -- so a table would be a
   * one-row-per-job join with no query anyone would ever write against it. This mirrors
   * `letters.body`, the app's other stored AI output.
   *
   * Storing it is disclosed in docs/privacy.md's retention section: the *prompt* already left the
   * machine before this column existed, but the *output* now stays on disk until the job is
   * deleted, and that is a separate fact a user is entitled to be told.
   */
  gapAnalysis: text('gap_analysis'),
  /** When `gapAnalysis` was last written. Null exactly when `gapAnalysis` is null. */
  gapAnalysisAt: integer('gap_analysis_at', { mode: 'timestamp_ms' }),
});

export const cvDocuments = sqliteTable('cv_documents', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['uploaded', 'manual'] }).notNull(),
  targetRole: text('target_role').notNull().default(''),
  /** Full extracted text for an uploaded CV (PDF/txt/md): what the AI features actually read.
   * Empty for a manual profile, which instead relies entirely on `profile`. */
  text: text('text').notNull().default(''),
  /** Structured profile fields, editable regardless of kind: { title, years, location,
   * languages, skills: string[], summary, auth }. */
  profile: text('profile', { mode: 'json' }).notNull().$type<{
    title: string;
    years: string;
    location: string;
    languages: string;
    skills: string[];
    summary: string;
    auth: string;
  }>(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const letters = sqliteTable('letters', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  title: text('title').notNull(),
  company: text('company').notNull(),
  role: text('role').notNull(),
  type: text('type', { enum: ['motivation_letter', 'cover_letter', 'recruiter_message', 'short_application_message'] }).notNull(),
  tone: text('tone', { enum: ['formal', 'natural', 'confident', 'concise'] }).notNull(),
  length: text('length', { enum: ['short', 'standard', 'detailed'] }).notNull(),
  status: text('status', { enum: ['draft', 'final', 'sent'] }).notNull().default('draft'),
  vacancyKey: text('vacancy_key'),
  cvId: text('cv_id').references(() => cvDocuments.id, { onDelete: 'set null' }),
  /** The generated letter body, as returned by the AI session: plain text, user-editable. */
  body: text('body').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const applications = sqliteTable('applications', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  savedJobId: text('saved_job_id').references(() => savedJobs.id, { onDelete: 'set null' }),
  role: text('role').notNull(),
  company: text('company').notNull(),
  location: text('location').notNull().default(''),
  verification: text('verification'),
  status: text('status', {
    enum: ['preparing', 'applied', 'recruiter_screen', 'interview', 'offer', 'rejected', 'withdrawn'],
  }).notNull().default('preparing'),
  appliedAt: integer('applied_at', { mode: 'timestamp_ms' }),
  nextStep: text('next_step').notNull().default(''),
  contact: text('contact').notNull().default(''),
  cvId: text('cv_id').references(() => cvDocuments.id, { onDelete: 'set null' }),
  letterId: text('letter_id').references(() => letters.id, { onDelete: 'set null' }),
  notes: text('notes').notNull().default(''),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
});

/**
 * A single attempt at applying to one vacancy (#198, part of the #193 auto-apply split). This
 * table is deliberately inert on its own: nothing in this slice fills a form, renders a PDF, or
 * submits anything -- it exists to give the later slices (#199 artifact staging, #200 the daemon
 * queue runner, #201 the browser executor) a durable, resumable place to record what stage an
 * attempt has reached, so a crash or a closed window never loses or duplicates work.
 *
 * `sourceCvContentHash` and `jdSnapshotHash` exist for the same reason #196's pre-submit gate
 * needs them later: a value is only ever trusted if it can be shown to still match what the user
 * actually reviewed, and a hash is how that gets checked without re-reading the full text.
 */
export const applicationAttempts = sqliteTable('application_attempts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /** Set once an `applications` row exists to track this attempt's outcome (status, next step,
   * notes) the way every other application does. Null while the attempt is still in progress and
   * has not yet reached a state worth surfacing on the Applications page. */
  applicationId: text('application_id').references(() => applications.id, { onDelete: 'set null' }),
  /** Links back to a DiscoveryVacancyAudit/report row's `key`, matching `savedJobs.vacancyKey`'s
   * existing convention -- this attempt's "posting ID". Null for a manually-entered target. */
  vacancyKey: text('vacancy_key'),
  /** The actual URL this attempt applies through -- the "canonical job URL" #193 specified,
   * kept separate from `vacancyKey` because a posting can be re-listed at a new URL. */
  canonicalUrl: text('canonical_url').notNull().default(''),
  company: text('company').notNull(),
  role: text('role').notNull(),
  /** The CV this attempt was generated from. `on delete set null`, not cascade: deleting the
   * source CV later must not erase the historical record of what was actually submitted. */
  sourceCvId: text('source_cv_id').references(() => cvDocuments.id, { onDelete: 'set null' }),
  /** SHA-256 hex of the source CV's text + profile at the moment this attempt was created. This
   * is the attempt's only durable "CV version" -- `cvDocuments` has no version history of its
   * own, and the CV can be edited or deleted after an attempt exists. */
  sourceCvContentHash: text('source_cv_content_hash').notNull(),
  /** The full job-description text this attempt read, exactly as captured -- not the 6,000
   * character `formatVacancy` excerpt #193 flagged as insufficient for full-JD coverage. */
  jdSnapshot: text('jd_snapshot').notNull().default(''),
  /** SHA-256 hex of `jdSnapshot`, so a later stage can detect the JD changed underneath it
   * without re-reading and re-comparing the full text every time. */
  jdSnapshotHash: text('jd_snapshot_hash').notNull(),
  /** Whether `jdSnapshot` is believed complete, or was truncated by a source-side limit. #193's
   * own gap: silently dropping requirements past a character limit must never happen unlabeled. */
  jdComplete: integer('jd_complete', { mode: 'boolean' }).notNull().default(true),
  /** Identifies which version of the generation task contract/prompt produced this attempt, so a
   * later change to that contract cannot silently reinterpret an already-recorded attempt. */
  workflowVersion: text('workflow_version').notNull().default(''),
  checkpoint: text('checkpoint', {
    enum: [
      'queued',
      'reading_jd',
      'tailoring',
      'rendering',
      'filling',
      'ready',
      'submitting',
      'submitted',
      'needs_user',
      'skipped',
      'failed',
      'submission_unknown',
    ],
  })
    .notNull()
    .default('queued'),
  /** Free-text detail for the current checkpoint -- why it's `needs_user`, what `failed`, or a
   * short human-readable reason. Never used for control flow; the checkpoint enum alone is. */
  checkpointDetail: text('checkpoint_detail').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  /** Set only on a transition into `submitted` or `submission_unknown` -- the two checkpoints
   * that mean a real, possibly-irreversible submit action was actually attempted. */
  submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }),
});

/**
 * A generated file belonging to one attempt (#198): a tailored CV PDF, a cover letter PDF, or
 * anything else a later stage stages for upload. Schema only in this slice -- nothing here writes
 * a real file to disk yet; that mechanism is #199's. `onDelete: 'cascade'` because an artifact has
 * no meaning independent of the attempt it belongs to.
 */
export const applicationArtifacts = sqliteTable('application_artifacts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  attemptId: text('attempt_id')
    .notNull()
    .references(() => applicationAttempts.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['cv_pdf', 'cover_letter_pdf', 'combined_pdf', 'other'] }).notNull(),
  fileName: text('file_name').notNull().default(''),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  /** SHA-256 hex of the file's bytes -- what #196 §2.4's validator checks an `artifactId` against
   * before trusting it, and what #196 §5's pre-submit gate re-checks hasn't drifted since review. */
  contentHash: text('content_hash').notNull(),
  /** Where the file actually lives on disk once #199 exists. Empty in this slice, since nothing
   * writes one yet; never a path the renderer supplies (see #196 §6.2's "nothing renderer-supplied"
   * rule) -- only ever written by the main-process code that staged the file. */
  storagePath: text('storage_path').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

/** Single fixed row (id fixed at 1). This is app-wide preference state, not a multi-row table. */
export const appSettings = sqliteTable('app_settings', {
  id: integer('id').primaryKey().default(1),
  launchAtLogin: integer('launch_at_login', { mode: 'boolean' }).notNull().default(false),
  startPage: text('start_page', {
    enum: ['search', 'saved', 'applications', 'last_opened'],
  }).notNull().default('search'),
  theme: text('theme', { enum: ['light', 'dark', 'system'] }).notNull().default('system'),
  density: text('density', { enum: ['comfortable', 'compact'] }).notNull().default('comfortable'),
  sidebarStart: text('sidebar_start', { enum: ['expanded', 'collapsed', 'remember_last'] }).notNull().default('remember_last'),
  sidebarCollapsed: integer('sidebar_collapsed', { mode: 'boolean' }).notNull().default(false),
  lastOpenedPage: text('last_opened_page').notNull().default('search'),
  /** Whether closing the main window hides it to the system tray instead of quitting the app.
   * Off by default: silently changing "closing the window quits" to "stays running invisibly"
   * without explicit opt-in would be a surprising, dark-pattern-adjacent change for a local-first
   * tool. */
  minimizeToTrayOnClose: integer('minimize_to_tray_on_close', { mode: 'boolean' }).notNull().default(false),
  /** Whether the app periodically re-scans for vacancies on its own while minimized to the tray
   * (#195). Off by default -- and a no-op in practice unless `minimizeToTrayOnClose` is also on,
   * since nothing else keeps the process alive to run the timer. */
  autoScanEnabled: integer('auto_scan_enabled', { mode: 'boolean' }).notNull().default(false),
  defaultLocation: text('default_location').notNull().default(''),
  defaultCvId: text('default_cv_id').references(() => cvDocuments.id, { onDelete: 'set null' }),
  defaultLetterType: text('default_letter_type', {
    enum: ['motivation_letter', 'cover_letter', 'recruiter_message', 'short_application_message'],
  }).notNull().default('motivation_letter'),
  defaultLetterTone: text('default_letter_tone', { enum: ['formal', 'natural', 'confident', 'concise'] }).notNull().default('natural'),
  defaultLetterLength: text('default_letter_length', { enum: ['short', 'standard', 'detailed'] }).notNull().default('standard'),
  defaultApplicationStatus: text('default_application_status', {
    enum: ['preparing', 'applied', 'recruiter_screen', 'interview', 'offer', 'rejected', 'withdrawn'],
  }).notNull().default('preparing'),
  confirmApplicationDelete: integer('confirm_application_delete', { mode: 'boolean' }).notNull().default(true),
  autoArchiveRejected: integer('auto_archive_rejected', { mode: 'boolean' }).notNull().default(false),
  defaultProvider: text('default_provider', { enum: ['claude', 'codex'] }).notNull().default('claude'),
  /*
   * ADI-07: the AI Workspace's renderer-local view state.
   *
   * These are preferences, not data, and they live here for exactly one reason: every other
   * preference in this app lives here. The alternative considered was `localStorage`, which is
   * where a browser app would put "which row was selected". This is not a browser app -- a user
   * who backs up, exports, or resets their workspace database reasonably expects that to carry
   * their app state, and a second store inside Chromium's profile directory would silently not be
   * part of any of those operations.
   *
   * The two collection-shaped fields are JSON columns, following `cv_documents.profile`'s existing
   * precedent for a small structured value, rather than join tables: neither is ever queried,
   * ordered, or joined by SQL, so a table would buy nothing and cost two migrations.
   */
  /** The session the AI Workspace reopens on. Nullable: "nothing selected" is a real state. */
  agentSelectedSessionId: text('agent_selected_session_id'),
  /** Session ids the user has archived out of the live list. Bounded in validate.ts. */
  agentArchivedSessionIds: text('agent_archived_session_ids', { mode: 'json' })
    .notNull()
    .$type<string[]>()
    .default([]),
  /** `sessionId -> unread activity count`, for the list's badges. Bounded in validate.ts. */
  agentUnreadCounts: text('agent_unread_counts', { mode: 'json' })
    .notNull()
    .$type<Record<string, number>>()
    .default({}),
});
