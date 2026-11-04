import { randomUUID } from 'node:crypto';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { CvSourceDocument } from './cv-source-schema.js';
import {
  CV_EVIDENCE_OVERLAY_ORIGINS,
  CV_EVIDENCE_OVERLAY_STATES,
  CV_LISTING_STATUSES,
  EMPTY_CV_REQUIREMENT_COVERAGE,
  type CvApprovedResumeSnapshot,
  type CvApprovedWording,
  type CvArtifactRecord,
  type CvEvidenceFact,
  type CvJdIncompleteReason,
  type CvJdRevision,
  type CvProjectSelection,
  type CvRequirementCoverage,
  type CvRequirementMapping,
  type CvSourceBaseline,
} from './cv-evidence-schema.js';
import { MCP_AUDIT_OUTCOMES, MCP_GRANT_SCOPE_TYPES } from './mcp-grant-schema.js';
import { CV_PROPOSAL_KINDS, CV_PROPOSAL_STATUSES } from './cv-proposal-schema.js';
import type { SupportPromptState } from './support-prompt.js';
import type { CompanyResearchDiagnostics } from '../company-evidence.js';
import type { PreparedApplicationFields } from './types.js';
import type { BriefNotice, BriefSourceFacts, FrozenBrief, StoredAssessment } from '../application-brief.js';
import type { DraftContent, InputFence, RefusedFinding, StoredFinding, StoredProposal } from '../application-critique.js';
import type { PackageManifestContent } from '../submitted-package.js';
import type { FollowUpDraftBasis } from '../application-actions-core.js';

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
  /** Full extracted text for an uploaded CV (PDF/txt/md/docx): what the AI features actually read.
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
  /**
   * #274: the reviewed full structured source CV -- real employers with their own dates and
   * engagement type, education, the candidate's corrected contact details and links, and project
   * records with the candidate's pins and configured count limit. See `cv-source-schema.ts` for
   * the shape and for why each of those is a separate field rather than prose.
   *
   * Nullable, and null is the normal state for every row that predates this column: a CV whose
   * source has never been extracted and reviewed has no structured source, and saying so is the
   * point. Export falls back to the flat `profile` mapping for those rather than inventing the
   * sections they do not have.
   *
   * A JSON column rather than four join tables (experience/education/projects/links), following
   * `profile`'s existing precedent: this value is only ever read and written whole, for one CV at a
   * time, and nothing queries, orders or joins across it in SQL.
   */
  sourceCv: text('source_cv', { mode: 'json' }).$type<CvSourceDocument>(),
  /**
   * Provenance of `text` (issue #396): `'text_layer'` for pdf.js/mammoth local extraction (every
   * row before this column existed, via the column default, and every ordinary upload since), or
   * `'ai_transcription'` for a scanned/image-only PDF whose text came from an AI provider instead.
   * A vision-capable model can misread dates, employers or technologies, so this is never inferred
   * after the fact -- `createCvDocument`'s caller states it explicitly, and the renderer can only
   * ever request `'ai_transcription'` after the user has reviewed and confirmed the transcribed
   * text (see `useCvPicker.ts`'s transcription-review step): the row simply would not exist yet
   * otherwise. `text_layer` needs no separate review gate the way transcription does -- pdf.js and
   * mammoth extract the document's own text characters rather than inferring them, so there is
   * nothing equivalent to a vision model's misread to confirm.
   */
  textSource: text('text_source', { enum: ['text_layer', 'ai_transcription'] }).notNull().default('text_layer'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

/**
 * #419: one row per (CV, vacancy) tailoring session -- the reviewable requirement/evidence/
 * approved-wording overlay `cv-evidence-schema.ts` describes. A separate table from `cvDocuments`
 * rather than another JSON column on it, unlike `sourceCv`: `sourceCv` is 1:1 with its CV, this is
 * 1:many (the same CV tailored for several vacancies, each with its own JD and its own set of
 * approved wording), so it needs its own lookup key (`cvId` + `vacancyKey`) a JSON column cannot
 * offer. `facts`/`requirements`/`wordingVariants` are still JSON columns within this table, for
 * the same reason `sourceCv` is one: each is only ever read and written whole, for one overlay at
 * a time, and nothing queries, orders or joins across it in SQL.
 */
export const cvEvidenceOverlays = sqliteTable('cv_evidence_overlays', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  cvId: text('cv_id').notNull().references(() => cvDocuments.id, { onDelete: 'cascade' }),
  /** Matches `savedJobs.vacancyKey`/`applicationAttempts`' own vacancy reference: the discovery
   * report's `key`, not a URL, so the same vacancy is always the same row regardless of how it was
   * reached. */
  vacancyKey: text('vacancy_key').notNull(),
  /** The role and company the case was opened for, so a case can be listed and reopened with its
   * own label (#419). A manual case's key carries neither. Empty on a case that predates them. */
  caseTitle: text('case_title').notNull().default(''),
  caseCompany: text('case_company').notNull().default(''),
  /** SHA-256 hex of the `CvSourceDocument` this overlay was built from -- see this module's own
   * doc comment on `CvEvidenceOverlay.sourceCvContentHash` in `cv-evidence-schema.ts`. */
  sourceCvContentHash: text('source_cv_content_hash').notNull(),
  jdSnapshot: text('jd_snapshot').notNull().default(''),
  jdSnapshotHash: text('jd_snapshot_hash').notNull(),
  jdComplete: integer('jd_complete', { mode: 'boolean' }).notNull().default(true),
  /** The completeness heuristic's findings for the current `jdSnapshot` (#419). Separate from
   * `jdComplete` and from the candidate's confirmation below. */
  jdIncompleteReasons: text('jd_incomplete_reasons', { mode: 'json' }).notNull().$type<CvJdIncompleteReason[]>().default([]),
  jdWarning: text('jd_warning').notNull().default(''),
  /** The candidate read the whole JD and confirmed a short one is complete. Reset on a text change. */
  jdConfirmedComplete: integer('jd_confirmed_complete', { mode: 'boolean' }).notNull().default(false),
  /** #421's case contract: every past `jdSnapshot`, oldest first -- see `CvJdRevision`. */
  jdRevisions: text('jd_revisions', { mode: 'json' }).notNull().$type<CvJdRevision[]>().default([]),
  listingStatus: text('listing_status', { enum: CV_LISTING_STATUSES as unknown as [string, ...string[]] })
    .notNull()
    .default('unknown'),
  state: text('state', { enum: CV_EVIDENCE_OVERLAY_STATES as unknown as [string, ...string[]] })
    .notNull()
    .default('needs_input'),
  requirements: text('requirements', { mode: 'json' }).notNull().$type<CvRequirementMapping[]>().default([]),
  /** #419: how far requirement extraction has got for the current JD revision. See
   * `CvRequirementCoverage`. */
  requirementCoverage: text('requirement_coverage', { mode: 'json' })
    .notNull()
    .$type<CvRequirementCoverage>()
    .default(EMPTY_CV_REQUIREMENT_COVERAGE),
  facts: text('facts', { mode: 'json' }).notNull().$type<CvEvidenceFact[]>().default([]),
  wordingVariants: text('wording_variants', { mode: 'json' }).notNull().$type<CvApprovedWording[]>().default([]),
  /** #421's case contract: how this case began -- see `CvEvidenceOverlayOrigin`. */
  origin: text('origin', { enum: CV_EVIDENCE_OVERLAY_ORIGINS as unknown as [string, ...string[]] })
    .notNull()
    .default('vacancy'),
  /** #421's case contract: bumped by the repository layer on every write, never caller-supplied.
   * A plain `text` column (not `integer`), since every reader treats it as an opaque token to
   * compare for equality -- see `CvEvidenceOverlay.caseRevision`. */
  caseRevision: text('case_revision').notNull().default('0'),
  /** #421's case contract: `null` until the first approval -- see `CvApprovedResumeSnapshot`. */
  approvedResumeSnapshot: text('approved_resume_snapshot', { mode: 'json' })
    .$type<CvApprovedResumeSnapshot | null>()
    .default(null),
  /** #419 step 8: the projects the candidate approved for this case's CV. `null` until approved,
   * and for every case that predates the column. */
  projectSelection: text('project_selection', { mode: 'json' }).$type<CvProjectSelection | null>().default(null),
  /** #419: the CV inputs this case was started or last rebased from, so a later change can be shown
   * as a diff. `null` for a case that predates the column. */
  sourceBaseline: text('source_baseline', { mode: 'json' }).$type<CvSourceBaseline | null>().default(null),
  /** #419 step 9: one record per rendered file, oldest first -- see `CvArtifactRecord`. */
  artifacts: text('artifacts', { mode: 'json' }).$type<CvArtifactRecord[]>().default([]),
  capturedAt: integer('captured_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

/** #421: a named local client's authorization to act on the local MCP endpoint. See
 * `mcp-grant-schema.ts`'s own header for why this lives in its own module rather than beside
 * `cvEvidenceOverlays` above. */
export const mcpClientGrants = sqliteTable('mcp_client_grants', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  scopeType: text('scope_type', { enum: MCP_GRANT_SCOPE_TYPES as unknown as [string, ...string[]] }).notNull(),
  /** Set only when `scopeType === 'source_cv'`; `''` otherwise. */
  sourceCvId: text('source_cv_id').notNull().default(''),
  /** Set only when `scopeType === 'case_ids'` at creation, or appended to over time for a
   * `source_cv` grant -- a JSON column rather than a join table, since nothing ever queries across
   * it in SQL, the same reasoning `cvEvidenceOverlays.requirements` above already documents. */
  caseIds: text('case_ids', { mode: 'json' }).notNull().$type<string[]>().default([]),
  canReadFinalSnapshot: integer('can_read_final_snapshot', { mode: 'boolean' }).notNull().default(false),
  /** SHA-256 hex of the one-time credential value shown to the candidate at creation and never
   * itself stored -- this column can verify a presented credential but can never reproduce it, the
   * same discipline a password hash follows. */
  credentialVerifierHash: text('credential_verifier_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  /** Null while active. Never deleted once revoked -- the same `automationGrants.revokedAt`
   * reasoning: a revoked grant is itself part of the record #421's audit trail exists to keep. */
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
});

/** #421's audit trail. Every call attempt through the local MCP endpoint writes exactly one row
 * here, successful or not -- see `mcp-grant-schema.ts`'s own doc comment on why every column here
 * is structurally incapable of carrying raw CV/JD text or a credential. Append-only: nothing in
 * this module ever updates or deletes a row here once written. */
export const mcpAuditLogEntries = sqliteTable('mcp_audit_log_entries', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /** `null` when no grant could be matched at all. `onDelete: 'set null'`, not `'cascade'`: deleting
   * a grant record is not a thing this app does (grants are revoked, never deleted -- see above),
   * but if it ever happened, the audit history of what that client did must outlive the grant row
   * it once pointed to, not vanish with it. */
  grantId: text('grant_id').references(() => mcpClientGrants.id, { onDelete: 'set null' }),
  toolName: text('tool_name').notNull(),
  caseId: text('case_id'),
  outcome: text('outcome', { enum: MCP_AUDIT_OUTCOMES as unknown as [string, ...string[]] }).notNull(),
  revision: text('revision'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

/** #421's proposal staging layer. See `cv-proposal-schema.ts`'s own header for why nothing an MCP
 * client sends reaches `cvEvidenceOverlays.requirements`/`facts`/`wordingVariants` directly. */
export const cvTailoringProposals = sqliteTable('cv_tailoring_proposals', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  caseId: text('case_id').notNull().references(() => cvEvidenceOverlays.id, { onDelete: 'cascade' }),
  /** `onDelete: 'set null'`, matching `mcpAuditLogEntries.grantId`'s own reasoning: a proposal
   * already decided stays a record of what was decided even if its grant row somehow stopped
   * existing (grants are revoked, never deleted, in the app's own flows). */
  grantId: text('grant_id').references(() => mcpClientGrants.id, { onDelete: 'set null' }),
  kind: text('kind', { enum: CV_PROPOSAL_KINDS as unknown as [string, ...string[]] }).notNull(),
  status: text('status', { enum: CV_PROPOSAL_STATUSES as unknown as [string, ...string[]] }).notNull().default('pending'),
  /** The kind-specific payload (`CvProposalPayload`'s `data`, not the `{kind, data}` wrapper --
   * `kind` above is this same value, already its own column so a query can filter by it in SQL). */
  payload: text('payload', { mode: 'json' }).notNull(),
  caseRevisionAtProposal: text('case_revision_at_proposal').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
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
  /**
   * `role`, `company`, `location` and `verification` are a frozen snapshot of the vacancy as it
   * stood when this application was created, copied once from the source `saved_jobs` row and
   * deliberately never re-read from it afterward -- a later edit in `SavedJobDrawer` does not
   * propagate here. This is the same "record of what was applied to" semantic `applicationAttempts`
   * already commits to for `sourceCvContentHash`/`jdSnapshotHash` below: an application is evidence
   * of what someone actually applied to, not a live view of the saved job.
   *
   * The alternative -- re-deriving these from `saved_jobs` whenever `savedJobId` is set -- was
   * considered and rejected: a saved job's role/company/location/verification can legitimately be
   * corrected later (a typo fix, a location update) without that correction needing to rewrite
   * history for an application already created from it. See `deleteSavedJob` in `repository.ts` for
   * the matching note on the delete side of this relationship.
   */
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
  /**
   * Set when the person deletes the Applications row this attempt is linked to (#444). The tracker
   * sync creates a row for an attempt that has none; without this marker the next event, or the
   * next start-up reconcile, would recreate the row the person just removed. Never set by anything
   * else, and never cleared: a deleted tracker row stays deleted.
   */
  applicationDetached: integer('application_detached', { mode: 'boolean' }).notNull().default(false),
  /** Links back to a DiscoveryVacancyAudit/report row's `key`, matching `savedJobs.vacancyKey`'s
   * existing convention -- this attempt's "posting ID". Null for a manually-entered target. */
  vacancyKey: text('vacancy_key'),
  /** The actual URL this attempt applies through -- the "canonical job URL" #193 specified,
   * kept separate from `vacancyKey` because a posting can be re-listed at a new URL. */
  canonicalUrl: text('canonical_url').notNull().default(''),
  /**
   * #275's requisition identity, derived once at creation by `application-identity.ts` and stored
   * rather than recomputed, so the completed-application lookup is a plain column comparison.
   *
   * `employerKey` is `<ats-provider>:<board>` when the apply URL is a recognised ATS job URL, and
   * a normalized company name otherwise. It is never matched on alone: two different openings at
   * one employer share an `employerKey` and must both stay eligible, which is why every completed
   * lookup requires a non-null `requisitionId` alongside it before it will call two attempts the
   * same application. Empty on every row written before migration 0012.
   */
  employerKey: text('employer_key').notNull().default(''),
  /** The opening's id as the receiving ATS names it, or null when nothing reliable was derivable
   * -- in which case `canonicalUrlKey` is the only identity the lookup has to work with. */
  requisitionId: text('requisition_id'),
  /** `canonicalUrl` reduced to the parts that identify the posting (no scheme, no `www.`, no
   * fragment, no tracking parameters, remaining query sorted). The fallback identity, and the
   * reason the same posting arriving with different `utm_*` tags is still the same posting. */
  canonicalUrlKey: text('canonical_url_key').notNull().default(''),
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
  /** Which document path this attempt records. `original` is set only after the person explicitly
   * chooses the visible fallback after AI tailoring fails; it is never a silent fallback. */
  tailoringMode: text('tailoring_mode', { enum: ['ai', 'original'] }).notNull().default('ai'),
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
      /**
       * A person told the app they completed this application themselves (#271). Deliberately NOT
       * `submitted`: that checkpoint now means "this app observed a real receipt", and collapsing
       * the two would make the evidence-backed state unfalsifiable. Equally deliberately not
       * `failed` -- #271's fourth acceptance case is that the *absence* of a confirmation email is
       * not evidence of anything, so nothing may ever downgrade this on silence alone.
       */
      'user_reported',
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
  /** A deterministic fingerprint of the filled form's own structure (each field's control type,
   * label, and required-ness -- never a value), recorded only once this attempt reaches
   * `submitted`. Issue #203's "an automatic attempt against an already-reviewed employer must use
   * the same template, same structured fields, no new free-text the user hasn't seen" rule compares
   * a new attempt's live structure hash against the most recent submitted attempt's stored one for
   * the same employer -- a mismatch means the page changed since a human last looked at it, which
   * forces that attempt back to manual review regardless of any active automation grant. Null until
   * a first submission exists for this attempt (and stays null forever for one that never submits). */
  formStructureHash: text('form_structure_hash'),
  /**
   * Set only while an automatic-mode submit (#203) is queued for this attempt: the real, timed
   * cancel/undo window between scheduling and the submit action actually firing. A person can
   * cancel by clearing this (see `ApplicationAttemptPatch`); once real time passes this timestamp
   * with it still set, the daemon/main-process scheduler is clear to submit. Never set by manual
   * review (#202) at all -- that path has no window because the human's own click *is* the
   * confirmation, with nothing further to wait out.
   */
  scheduledAutomaticSubmitAt: integer('scheduled_automatic_submit_at', { mode: 'timestamp_ms' }),
  /** Set alongside `submittedAt`, recording which path actually sent it: #203's rate limits are
   * scoped to automatic submissions specifically ("a minimum delay between automatic submissions"),
   * so counting a manually-reviewed submission against that cap would be wrong -- a person's own
   * review pace is already the rate limit #202 relies on for the manual path. Null until submitted. */
  submissionMode: text('submission_mode', { enum: ['manual', 'automatic'] }),
  /**
   * What backs the claim that this attempt was actually completed (#275). Both values suppress a
   * duplicate equally -- the column exists to preserve *which* one did it, not to rank them:
   *
   *  - `user_reported`: a person told the app this application is done. That is the only kind of
   *    completion a renderer-originated patch can ever assert (see `validate.ts`), because the
   *    renderer is the user and cannot observe a receipt.
   *  - `receipt_confirmed`: the submission itself was observed to land -- a confirmation page or an
   *    unambiguous receipt. Only main-process submission code may record this, and only #271's
   *    receipt observer can honestly produce it; until that lands nothing writes this value, and a
   *    `submitted` attempt with a null evidence type means "completed, evidence not recorded".
   *
   * Null is not "not completed": the checkpoint alone decides that. Null means the evidence was
   * never recorded, which is the state every row written before migration 0012 is in.
   */
  completionEvidence: text('completion_evidence', { enum: ['user_reported', 'receipt_confirmed'] }),
  /**
   * #275's explicit reapply path: the completed attempt this one deliberately supersedes.
   *
   * A plain column, not a foreign key. The point of these three fields is to be a durable record
   * of a decision, and a `set null` on delete (or worse, a cascade) would erase exactly the
   * provenance an audit of "why was a second application sent to this requisition?" needs. The
   * predecessor's own document version is snapshotted here for the same reason the attempt
   * snapshots `sourceCvContentHash` rather than trusting `cvDocuments` to still hold it.
   */
  supersedesAttemptId: text('supersedes_attempt_id'),
  /** Why the user reapplied (a corrected document, an updated CV, an employer asking again).
   * Required and non-empty on the reapply path; empty on every ordinary attempt. */
  reapplyReason: text('reapply_reason').notNull().default(''),
  /** The superseded attempt's `sourceCvContentHash` as it stood when this reapply was created.
   * With this row's own `sourceCvContentHash` that is both document versions, before and after,
   * readable without depending on the predecessor row still existing. */
  reapplyPreviousCvContentHash: text('reapply_previous_cv_content_hash'),
  /**
   * What the preparation pipeline (#272) actually committed to this attempt's form, as JSON --
   * one entry per field the live snapshot carried, each recording the field's own label, control
   * type, whether it was committed/left to the person/left blank, and where a committed value came
   * from (`cv`/`profile`/`user_answer`). Empty string for every attempt no pipeline run has
   * prepared, which is every attempt created before this column existed.
   *
   * Stored on the attempt rather than derived at review time on purpose: it is the record of what
   * *this* attempt committed, so a review can never show a previous attempt's answers for the same
   * vacancy, and it survives an app restart exactly as the checkpoint does. It records only what
   * this app itself applied -- reading the page back to confirm each value is genuinely committed
   * is #277 (R06)'s work, which is why each entry carries its own `verification` field rather than
   * this column implying a read-back that has not happened.
   */
  preparedFields: text('prepared_fields', { mode: 'json' }).$type<PreparedApplicationFields | null>(),
});

/**
 * An explicit grant of automatic-submission authority for one compiled target policy (#203).
 * Deliberately scoped per-policy, not per-posting: automation's whole point is covering postings
 * the user hasn't individually looked at yet, so "which postings" cannot be the grant's own scope
 * the way it would be for a one-off manual authorization. `expiresAt` and `revokedAt` are both
 * re-checked immediately before every automatic send (issue #203 scope item 2), not only at grant
 * creation -- a grant that has quietly expired or been revoked since its last use must never let an
 * automatic submit through on the strength of having once been valid.
 */
export const automationGrants = sqliteTable('automation_grants', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /** `ApplicationTargetPolicy.id` this grant authorizes -- never an origin, selector, or anything
   * else renderer-suppliable; validated against the compiled policy table at creation time. */
  policyId: text('policy_id').notNull(),
  /** ISO-8601, main-process clock, at creation -- when the native confirmation dialog (#203 scope
   * item 5's auth-boundary hardening) was actually accepted. */
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  /** Null while active. Grants are never deleted -- a revoked grant stays as a durable record of
   * "automation was authorized for this policy, then explicitly turned off," which the reconciler
   * and any future audit need to be able to see. */
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
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

/**
 * What one bounded, authoritative check of an attempt's live posting found (#687). One row per
 * distinct state: a repeat observation with the same outcome/content/reason refreshes `observedAt`
 * rather than inserting, so overlapping prepare/resume requests cannot duplicate it.
 *
 * Deliberately NOT columns on `applicationAttempts`: `jdSnapshot` / `jdSnapshotHash` are what the
 * documents were prepared against and what the pre-submit gate trusts, so a live posting changing
 * (or closing) must never rewrite them. Only an explicit, guarded `adoptPostingChange` on an attempt
 * that has not been submitted replaces the snapshot. A submitted attempt keeps its package forever;
 * its rows here are history, never an input.
 *
 * `onDelete: 'cascade'` for the same reason artifacts cascade. Rows are bounded per attempt (see
 * `posting-verification-store.ts`), looked up through `(attempt_id, observed_at)`, and a changed
 * posting's full text is kept only while the person has not yet decided about it.
 */
export const applicationPostingVerifications = sqliteTable('application_posting_verifications', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  attemptId: text('attempt_id')
    .notNull()
    .references(() => applicationAttempts.id, { onDelete: 'cascade' }),
  /** When the authority was actually contacted (or revalidated). Never the time of a later reuse. */
  observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
  /** `greenhouse` | `lever` | `workable` | `jobgether` | `none` (no authoritative route; no request). */
  source: text('source').notNull(),
  /** Host and route shape only: no ids, no query. */
  sourceRef: text('source_ref').notNull().default(''),
  /** The raw finding of the check. */
  outcome: text('outcome', { enum: ['open', 'closed', 'unable'] }).notNull(),
  /** The finding as the person sees it, derived against the snapshot at the time of the check. */
  result: text('result', {
    enum: ['confirmed_open', 'confirmed_closed', 'materially_changed', 'unable_to_verify'],
  }).notNull(),
  /** A stable code (`not_found`, `denied`, `timeout`, ...). Never free text from the remote. */
  reason: text('reason').notNull(),
  httpStatus: integer('http_status'),
  /** sha256 of the normalised posting text; null when the check returned no text. */
  contentHash: text('content_hash'),
  /** Per attempt: the snapshot the work was prepared against is version 1. */
  contentVersion: integer('content_version').notNull().default(1),
  /** The normalised hash of the attempt's `jdSnapshot` this check was compared against. */
  baselineHash: text('baseline_hash').notNull().default(''),
  /** `YYYY-MM-DD` as the posting explicitly states it, or null. Never inferred from dates seen. */
  deadline: text('deadline'),
  deadlineProvenance: text('deadline_provenance', { mode: 'json' }).$type<{ source: 'posting_text'; excerpt: string } | null>(),
  etag: text('etag'),
  lastModified: text('last_modified'),
  /** What changed (a few capped lines), kept only for `materially_changed`. */
  changeSummary: text('change_summary', { mode: 'json' }).$type<{ added: string[]; removed: string[] } | null>(),
  /** The changed posting's full text, kept only for `materially_changed` so a refresh needs no second fetch. */
  observedText: text('observed_text'),
  /**
   * The person's decision about this finding, or null while it is still open. `superseded` = a later
   * definitive check replaced it before anyone decided (no decision was made). `confirmed_by_person`
   * (#720) = on a "could not check" row: the person looked at the posting and recorded that it is open.
   */
  resolution: text('resolution', {
    enum: ['refreshed', 'prepare_anyway', 'keep_current', 'superseded', 'confirmed_by_person'],
  }),
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  /**
   * A prepared package this finding took out of review while the person decides: the attempt's
   * checkpoint, detail and prepared answers exactly as they were, restored unchanged by Keep / Get
   * ready anyway (or by a later check that finds the posting open and unchanged). Null otherwise.
   */
  heldCheckpoint: text('held_checkpoint'),
  heldCheckpointDetail: text('held_checkpoint_detail'),
  heldPreparedFields: text('held_prepared_fields', { mode: 'json' }).$type<PreparedApplicationFields | null>(),
}, (table) => [
  index('application_posting_verifications_attempt_observed_idx').on(table.attemptId, table.observedAt),
]);

/**
 * The durable evidence record behind every submission-outcome claim this app makes (#271).
 *
 * Before this table, "submitted" was a single enum value on the attempt with nothing standing
 * behind it: a click that returned was recorded as a delivered application, and there was no way,
 * afterwards, to ask *why* the app believed that. Every row here answers exactly that question for
 * one observation, and rows are append-only in practice -- a later observation adds a row, it never
 * rewrites an earlier one, so a reconciliation is visible as the second record rather than as a
 * silently changed first one.
 *
 * Deliberately separate from `applicationAttempts.checkpoint`: the checkpoint is the attempt's
 * current *stage*, this is the *evidence*, and #271's scope explicitly asks for stage, delivery
 * evidence and hiring outcome to stay separate rather than being collapsed into one status.
 *
 * `onDelete: 'cascade'` for the same reason artifacts cascade: a receipt has no meaning
 * independent of the attempt it belongs to.
 */
export const applicationSubmissionReceipts = sqliteTable('application_submission_receipts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  attemptId: text('attempt_id')
    .notNull()
    .references(() => applicationAttempts.id, { onDelete: 'cascade' }),
  /** What this one observation established. `unknown` rows are kept, not discarded: "we looked and
   * could not tell" is exactly the fact a person needs to see, and is what a later delayed receipt
   * reconciles against. */
  outcome: text('outcome', { enum: ['submitted', 'rejected', 'unknown', 'user_reported'] }).notNull(),
  /** Where the claim came from. `page_observation` is the post-click observer; `delayed_receipt`
   * is an out-of-band acknowledgement that arrived later; `user_reported` is a person's own
   * statement, which is never machine evidence of delivery and is recorded as its own source so it
   * can never be mistaken for one. */
  source: text('source', { enum: ['page_observation', 'delayed_receipt', 'user_reported'] }).notNull(),
  /** The URL this attempt was actually submitted to -- #271 requires a `submitted` record to name
   * its destination, not just its attempt. Recorded for every outcome, not only the successful one. */
  destination: text('destination').notNull().default(''),
  /** What kind of proof this row rests on. `none` is the honest answer for a rejection or an
   * unresolved observation, and is never allowed to coexist with `outcome: 'submitted'` (enforced
   * in `repository.ts`, which is where every write to this table goes through). */
  evidenceKind: text('evidence_kind', {
    enum: ['confirmation_page', 'receipt_reference', 'delivery_receipt', 'user_statement', 'none'],
  }).notNull(),
  /** The matched confirmation text, receipt identifier, or the person's own note. Bounded by the
   * executor package before it ever reaches here. Untrusted third-party page text: display data
   * only, never parsed for control flow. */
  evidenceReference: text('evidence_reference').notNull().default(''),
  /** A short human-readable account of what was observed, for the attempt drawer. */
  detail: text('detail').notNull().default(''),
  /** When the observation itself happened -- distinct from `createdAt`, which is when it was
   * written down. A delayed receipt is observed long after the click but written immediately. */
  observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

/**
 * A candidate-authored library of reusable application-form answers (#372): a person writes an
 * answer to a recurring text/textarea question once and can reuse it on a later application
 * instead of retyping it.
 *
 * Populated ONLY by explicit user action -- an answer is saved here because the person chose to
 * save it, never because it was inferred from a CV/profile, produced by a model, or captured
 * silently from a value observed on a live page. Looked up by an exact match on normalized label
 * plus control type (`application-answer-key.ts`'s `applicationAnswerKey`); there is deliberately
 * no fuzzy or semantic matching, so "why do you want to work here?" and "why do you want to work
 * with us?" remain two different questions here rather than being guessed at as the same one.
 *
 * This table is pure storage: nothing here fills a form. The confirm step that offers a saved
 * answer back to the user and actually applies it to a live field -- always a deliberate confirm,
 * never an auto-fill -- lives in `application-review-session.ts`, not in this module.
 */
export const applicationAnswers = sqliteTable('application_answers', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /**
   * The lookup key: `applicationAnswerKey(label, controlType)`, e.g.
   * `"text::why do you want to work here"`. Not unique-constrained at the DB level -- this schema
   * declares no indices or unique constraints anywhere else either -- "one answer per key" is
   * app-level logic enforced by `saveApplicationAnswer`'s upsert-on-save, not a DB constraint.
   */
  normalizedKey: text('normalized_key').notNull(),
  /** The original, unnormalized field label, kept for display in the answer-library management UI. */
  label: text('label').notNull(),
  /** V1 covers these two control types only (#372) -- a select/checkbox/radio answer is not a
   * reusable free-text answer the way a text/textarea one is. */
  controlType: text('control_type', { enum: ['text', 'textarea'] }).notNull(),
  /** The saved answer body itself. */
  answer: text('answer').notNull(),
  /** Which application this answer was first (and most recently) saved from, for context in the
   * management UI -- not an identity field, so it is overwritten on every upsert. */
  originCompany: text('origin_company').notNull().default(''),
  /** Same idea as `originCompany`, the role title. */
  originRole: text('origin_role').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  /** Bumped on every save/update to the answer text itself (an edit from the management UI, or a
   * re-save from a later application with the same normalized key). */
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  /** Bumped every time this saved answer is actually used ("Use this answer" clicked elsewhere) --
   * deliberately separate from `updatedAt`, which tracks edits to the answer text, not uses of it. */
  lastConfirmedAt: integer('last_confirmed_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
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
  /** Whether the user has been shown the Welcome modal. False by default so a truly fresh
   * app_settings row (a brand-new install) is not skipped by default; the separate "don't
   * re-show for an upgrading existing user who already has a CV" logic lives in the renderer. */
  welcomeSeen: integer('welcome_seen', { mode: 'boolean' }).notNull().default(false),
  /** Whether the app periodically re-scans for vacancies on its own while minimized to the tray
   * (#195). Off by default -- and a no-op in practice unless `minimizeToTrayOnClose` is also on,
   * since nothing else keeps the process alive to run the timer. */
  autoScanEnabled: integer('auto_scan_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Whether the app scouts new ATS sources on its own while it is open (#348). Off by default and
   * independent of `autoScanEnabled`: refreshing vacancies and widening the source list are two
   * separate background jobs. It needs a saved role or keyword and never runs while OVR is closed. */
  autoSourceScoutEnabled: integer('auto_source_scout_enabled', { mode: 'boolean' }).notNull().default(false),
  /** Whether the app downloads the company list by itself when none is saved yet (#637). On by default. */
  autoRosterDownloadEnabled: integer('auto_roster_download_enabled', { mode: 'boolean' }).notNull().default(true),
  /**
   * Whether this app is allowed to treat any site as automated-submission eligible at all -- the
   * MVP kill switch over #193's auto-apply track. Off by default, and off in every shipped build of
   * this release: `parseSettingsPatch` deliberately does not accept it, so the renderer cannot turn
   * it on, and no settings control writes it.
   *
   * main.ts reads it alongside the other settings mirrors and hands it to
   * `application-target-policies.ts`, where it gates `resolvePolicyIdForCanonicalUrl` -- the one
   * function every caller holding a URL goes through. With it off, no URL resolves to a compiled
   * policy, so every attempt lands on the manual review card regardless of what the policy table
   * contains. See that file's own comment for why the switch sits on the resolver rather than on
   * the table being empty.
   */
  autoApplyEnabled: integer('auto_apply_enabled', { mode: 'boolean' }).notNull().default(false),
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
  /** #421: whether the local MCP endpoint listens at all. Off by default, the same reasoning
   * `autoApplyEnabled` above already states for a feature that expands what an outside actor may
   * do on the candidate's behalf -- this one is a literal new network listener in Electron main,
   * so the default-off posture matters even more than usual. Closing the app removes the endpoint
   * regardless of this setting; it only controls whether one is stood up on the next launch or
   * settings change. */
  mcpEndpointEnabled: integer('mcp_endpoint_enabled', { mode: 'boolean' }).notNull().default(false),
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
  /** #503: the one-time "Support OVR" ask. One small JSON value, following the precedent of the
   * two JSON columns above; read tolerantly by `readSupportPrompt`, so a missing or malformed
   * value means "never asked". Lives here for the same reason as ADI-07's state: it travels with
   * the workspace database. */
  supportPrompt: text('support_prompt', { mode: 'json' })
    .notNull()
    .$type<SupportPromptState>()
    .default({ answered: false, asks: 0, successesSinceDismissal: 0 }),
});

/**
 * #689: one employer, keyed by a VERIFIED identity (an ATS tenant, the employer's own posting host,
 * or a domain the person confirmed) plus an optional disambiguating entity reference. A company
 * name is never a key: two look-alike names with different domains are two rows that share nothing
 * until a reviewed identity link says so. Candidate data never lives here: the table holds public
 * claims about an employer, separate from the CV and from every application note.
 */
export const companyEvidenceRecords = sqliteTable('company_evidence_records', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /** `ats:<provider>:<board>` | `host:<host>` | `domain:<host>`. */
  verifiedKey: text('verified_key').notNull(),
  keyKind: text('key_kind', { enum: ['ats_tenant', 'posting_host', 'user_domain'] }).notNull(),
  /** Disambiguator the person entered (a registry number, a legal entity name); '' when none. */
  entityRef: text('entity_ref').notNull().default(''),
  displayName: text('display_name').notNull(),
  /** Normalised name, used only to PROPOSE links between look-alike records. */
  nameKey: text('name_key').notNull().default(''),
  /** The employer's own registrable website (posting host / confirmed domain); null for an ATS tenant. */
  host: text('host'),
  /**
   * The concrete vacancies (`application:<id>`, `posting:<canonical url key>`) the PERSON confirmed
   * this domain for, so a vacancy that only names the company (no ATS tenant or own-host URL) can
   * reach its record. A bare name never does: another vacancy with the same name gets a suggestion
   * only, and a vacancy bound to two records is treated as ambiguous (unverified). (Column name kept
   * from the first migration; the values are target keys.)
   */
  confirmedTargets: text('confirmed_name_keys', { mode: 'json' }).notNull().$type<string[]>().default([]),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  /** The last explicit research run: stable codes, counts and the model's public queries only. */
  lastResearch: text('last_research', { mode: 'json' }).$type<CompanyResearchDiagnostics | null>(),
}, (table) => [
  uniqueIndex('company_evidence_records_identity_idx').on(table.verifiedKey, table.entityRef),
  index('company_evidence_records_name_idx').on(table.nameKey),
]);

export const companyEvidenceFacts = sqliteTable('company_evidence_facts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  recordId: text('record_id')
    .notNull()
    .references(() => companyEvidenceRecords.id, { onDelete: 'cascade' }),
  scope: text('scope', { enum: ['company', 'role'] }).notNull(),
  /** '' for company scope; otherwise the role the claim is about (never matched against another role). */
  roleKey: text('role_key').notNull().default(''),
  roleLabel: text('role_label').notNull().default(''),
  topic: text('topic', {
    enum: ['general', 'products', 'size', 'location', 'remote_policy', 'funding', 'leadership', 'sponsorship', 'other'],
  }).notNull().default('general'),
  claim: text('claim').notNull(),
  sourceUrl: text('source_url').notNull(),
  sourceKind: text('source_kind', { enum: ['company_site', 'ats_posting', 'public_web', 'ind_register'] }).notNull(),
  quote: text('quote').notNull().default(''),
  /** When the source was actually fetched; null for a claim whose source was never fetched. */
  retrievedAt: integer('retrieved_at', { mode: 'timestamp_ms' }),
  observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
  /** Written at observation time and moved only by a successful re-fetch of the source. */
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  verification: text('verification', { enum: ['unverified', 'source_confirmed', 'user_confirmed'] }).notNull(),
  origin: text('origin', { enum: ['user', 'research'] }).notNull(),
  status: text('status', { enum: ['active', 'superseded', 'withdrawn'] }).notNull().default('active'),
  contentHash: text('content_hash'),
  lastRefreshAt: integer('last_refresh_at', { mode: 'timestamp_ms' }),
  lastRefreshOutcome: text('last_refresh_outcome', { enum: ['renewed', 'failed', 'source_changed', 'cache_hit'] }),
  lastRefreshReason: text('last_refresh_reason'),
  /** User correction provenance: the claim (and the passage it rested on) before the person changed it. */
  correction: text('correction', { mode: 'json' }).$type<{ originalClaim: string; correctedAt: string; originalQuote?: string } | null>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('company_evidence_facts_record_idx').on(table.recordId, table.status),
]);

export const companyEvidenceContradictions = sqliteTable('company_evidence_contradictions', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  recordId: text('record_id')
    .notNull()
    .references(() => companyEvidenceRecords.id, { onDelete: 'cascade' }),
  factAId: text('fact_a_id')
    .notNull()
    .references(() => companyEvidenceFacts.id, { onDelete: 'cascade' }),
  factBId: text('fact_b_id')
    .notNull()
    .references(() => companyEvidenceFacts.id, { onDelete: 'cascade' }),
  topic: text('topic').notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
  /** The fact the person chose when resolving; the other one is kept as `superseded`. */
  resolvedFactId: text('resolved_fact_id'),
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('company_evidence_contradictions_pair_idx').on(table.factAId, table.factBId),
]);

export const companyEvidenceIdentityLinks = sqliteTable('company_evidence_identity_links', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /** Ordered so each pair has exactly one row: recordAId < recordBId. */
  recordAId: text('record_a_id')
    .notNull()
    .references(() => companyEvidenceRecords.id, { onDelete: 'cascade' }),
  recordBId: text('record_b_id')
    .notNull()
    .references(() => companyEvidenceRecords.id, { onDelete: 'cascade' }),
  reason: text('reason', { enum: ['near_name'] }).notNull().default('near_name'),
  status: text('status', { enum: ['proposed', 'confirmed', 'rejected'] }).notNull().default('proposed'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('company_evidence_identity_links_pair_idx').on(table.recordAId, table.recordBId),
]);

/**
 * What a prepared letter actually used, snapshotted at assembly. Deliberately NO foreign key to the
 * fact: correcting or deleting evidence later must not rewrite the history of what a prepared (or
 * submitted) package said. Cascades with the attempt, so it follows the attempt's own retention.
 */
export const applicationAttemptEvidenceUses = sqliteTable('application_attempt_evidence_uses', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  attemptId: text('attempt_id')
    .notNull()
    .references(() => applicationAttempts.id, { onDelete: 'cascade' }),
  usedIn: text('used_in', { enum: ['cover_letter'] }).notNull(),
  claim: text('claim').notNull(),
  sourceUrl: text('source_url').notNull(),
  scope: text('scope', { enum: ['company', 'role'] }).notNull(),
  retrievedAt: integer('retrieved_at', { mode: 'timestamp_ms' }),
  observedAt: integer('observed_at', { mode: 'timestamp_ms' }).notNull(),
  verification: text('verification', { enum: ['source_confirmed', 'user_confirmed'] }).notNull(),
  recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('application_attempt_evidence_uses_attempt_idx').on(table.attemptId),
]);

/**
 * #688: one compact decision brief per CANONICAL job. `identityKey` is the strongest identity known
 * (an ATS requisition, else a specific posting URL, else a company/title/location fingerprint); every
 * other way the same job was seen is an alias row, so two source copies of one requisition share this
 * row while two requisitions at one employer stay two rows. Holds the employer-side scan facts, the
 * stored posting text its sections were derived under (so a changed posting is detected, not guessed)
 * and the derived assessment summary with the inputs it came from. It never holds CV text, notes or
 * letters, and a preference correction never writes to `sourceFacts`.
 */
export const applicationBriefs = sqliteTable('application_briefs', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  identityKey: text('identity_key').notNull(),
  identityKind: text('identity_kind', { enum: ['requisition', 'canonical_url', 'semantic'] }).notNull(),
  employerKey: text('employer_key'),
  requisitionId: text('requisition_id'),
  /** Display copies from the newest source; never part of the identity. */
  company: text('company').notNull(),
  role: text('role').notNull(),
  location: text('location').notNull().default(''),
  sourceFacts: text('source_facts', { mode: 'json' }).$type<BriefSourceFacts | null>(),
  jdText: text('jd_text'),
  jdHash: text('jd_hash'),
  jdComplete: integer('jd_complete', { mode: 'boolean' }).notNull().default(true),
  jdCapturedAt: integer('jd_captured_at', { mode: 'timestamp_ms' }),
  /** When the stored posting text last changed (null until it has changed once). */
  jdChangedAt: integer('jd_changed_at', { mode: 'timestamp_ms' }),
  assessment: text('assessment', { mode: 'json' }).$type<StoredAssessment | null>(),
  /** Short, human-readable invalidation history, newest first. */
  notices: text('notices', { mode: 'json' }).notNull().$type<BriefNotice[]>().default([]),
  /** Incremented whenever employer-side facts or the posting text change; used as a write fence. */
  factsVersion: integer('facts_version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('application_briefs_identity_idx').on(table.identityKey),
]);

/**
 * Every way a brief's job was seen: identity keys (`req:`, `url:`, `sem:`), a discovery row key per
 * source copy (`key:`), and the saved jobs / attempts that point at it (`saved:`, `attempt:`). The
 * last two double as references: a brief with none left is deleted. `provider`/`url` keep the original
 * source reference visible.
 */
export const applicationBriefAliases = sqliteTable('application_brief_aliases', {
  aliasKey: text('alias_key').primaryKey(),
  briefId: text('brief_id')
    .notNull()
    .references(() => applicationBriefs.id, { onDelete: 'cascade' }),
  kind: text('kind', {
    enum: ['requisition', 'canonical_url', 'semantic', 'vacancy_key', 'saved_job', 'attempt'],
  }).notNull(),
  label: text('label').notNull().default(''),
  provider: text('provider'),
  url: text('url'),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('application_brief_aliases_brief_idx').on(table.briefId),
]);

/**
 * The brief as it read when preparation of an attempt started. INSERT-ONLY: nothing updates it, and
 * it has no foreign key to the live brief, so a later change to the posting, the CV or a preference
 * can never rewrite what the person knew when they started. Cascades only with the attempt.
 */
export const applicationBriefPins = sqliteTable('application_brief_pins', {
  attemptId: text('attempt_id')
    .primaryKey()
    .references(() => applicationAttempts.id, { onDelete: 'cascade' }),
  snapshot: text('snapshot', { mode: 'json' }).notNull().$type<FrozenBrief>(),
  pinnedAt: integer('pinned_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * #690: the exact documents of a prepared package, as structured drafts. Before this the resume and the
 * letter existed only as rendered PDFs, so "what was reviewed" could not be named, hashed or versioned.
 *
 * One row per (attempt, document, version). A re-preparation or an accepted critique revision appends
 * the next version and marks the previous one `superseded`; rows are never edited in place except to
 * re-tie an unchanged draft to the PDF that was re-rendered from it. `artifactHash` is the hash the
 * document acceptance contract passed for the PDF this version produced, so a draft whose artifact has
 * since changed or gone is known to be out of date without reading any file.
 *
 * Never written for a submitted/historical attempt (the store refuses), and cascades with the attempt.
 */
export const applicationDocumentDrafts = sqliteTable('application_document_drafts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  attemptId: text('attempt_id')
    .notNull()
    .references(() => applicationAttempts.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['cv', 'cover_letter', 'motivation_letter'] }).notNull(),
  version: integer('version').notNull(),
  origin: text('origin', { enum: ['prepared', 'user_letter', 'critique_revision'] }).notNull(),
  status: text('status', { enum: ['current', 'superseded'] }).notNull().default('current'),
  content: text('content', { mode: 'json' }).notNull().$type<DraftContent>(),
  contentHash: text('content_hash').notNull(),
  artifactHash: text('artifact_hash').notNull(),
  /** The posting / source-CV hashes the attempt held when this version was made. */
  jdHash: text('jd_hash').notNull(),
  sourceCvHash: text('source_cv_hash').notNull(),
  /** Which critique run proposed this version (null for prepared/user letters). A plain id, not a key. */
  critiqueRunId: text('critique_run_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  supersededAt: integer('superseded_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('application_document_drafts_version_idx').on(table.attemptId, table.kind, table.version),
  index('application_document_drafts_attempt_idx').on(table.attemptId),
]);

/**
 * #690: the optional independent critique of one attempt's package. ONE row per attempt, replaced only
 * by an explicit new review. `fence` is exactly which inputs the stored review describes; staleness is
 * computed against it on every read. A failed, cancelled, timed-out or rate-limited run records only
 * `lastRun*` and leaves the previous review and every document untouched.
 */
export const applicationCritiques = sqliteTable('application_critiques', {
  attemptId: text('attempt_id')
    .primaryKey()
    .references(() => applicationAttempts.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
  fence: text('fence', { mode: 'json' }).$type<InputFence | null>(),
  findings: text('findings', { mode: 'json' }).notNull().$type<StoredFinding[]>().default([]),
  refused: text('refused', { mode: 'json' }).notNull().$type<RefusedFinding[]>().default([]),
  proposals: text('proposals', { mode: 'json' }).notNull().$type<StoredProposal[]>().default([]),
  provider: text('provider').notNull().default(''),
  model: text('model'),
  /** Model calls this review made (always 1 when reviewed; a failed run is recorded in lastRun). */
  callCount: integer('call_count').notNull().default(0),
  /** Token usage exactly as the provider reported it, or null when none was reported. */
  usage: text('usage', { mode: 'json' }).$type<{ inputTokens?: number; outputTokens?: number } | null>(),
  lastRunOutcome: text('last_run_outcome', {
    enum: ['reviewed', 'failed', 'cancelled', 'timed_out', 'provider_limit', 'invalid_output', 'discarded'],
  }),
  lastRunDetail: text('last_run_detail').notNull().default(''),
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * #691: what was actually sent for one application, as a versioned manifest. INSERT-ONLY: a new
 * version supersedes the previous one (kept, never edited), so a later statement or a later draft
 * can never rewrite the record of an earlier one.
 *
 * Exactly one subject. An attempt (`attempt:<id>`, the normal case: bound when the attempt's
 * submission is recorded, cascades with the attempt like its artifacts and receipts), or an
 * Applications row that has no attempt (`application:<id>`, a row the person tracks by hand:
 * written only when the person states what they sent, cascades with the row).
 *
 * The manifest names drafts and artifacts by id, version and hash; it copies text only when the
 * person supplied it (pasted, or "my linked CV as it reads now"), because no other owner holds it.
 */
export const applicationSubmissionPackages = sqliteTable('application_submission_packages', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  subjectKey: text('subject_key').notNull(),
  attemptId: text('attempt_id').references(() => applicationAttempts.id, { onDelete: 'cascade' }),
  applicationId: text('application_id').references(() => applications.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: text('status', { enum: ['current', 'superseded'] }).notNull().default('current'),
  /** `submission` = bound by the recorded submission itself; `person` = appended by the person's statement. */
  boundBy: text('bound_by', { enum: ['submission', 'person'] }).notNull(),
  manifest: text('manifest', { mode: 'json' }).notNull().$type<PackageManifestContent>(),
  manifestHash: text('manifest_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  supersededAt: integer('superseded_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('application_submission_packages_version_idx').on(table.subjectKey, table.version),
  index('application_submission_packages_attempt_idx').on(table.attemptId),
  index('application_submission_packages_application_idx').on(table.applicationId),
]);

/**
 * #691: one interview round as the person recorded it. A local record only: it never changes the
 * application's status, the CV, the profile or any evidence. `scheduledOn` is null when the person
 * did not record a date (never guessed). `feedback` and `openTopics` are the person's own report of
 * what they were told or noticed. Cascades with the Applications row.
 */
export const applicationInterviewRounds = sqliteTable('application_interview_rounds', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  applicationId: text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  roundType: text('round_type', {
    enum: ['recruiter_screen', 'phone_screen', 'technical', 'hiring_manager', 'panel', 'take_home', 'onsite', 'final', 'other'],
  }).notNull(),
  scheduledOn: text('scheduled_on'),
  state: text('state', { enum: ['planned', 'held'] }).notNull(),
  feedback: text('feedback').notNull().default(''),
  openTopics: text('open_topics', { mode: 'json' }).notNull().$type<string[]>().default([]),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('application_interview_rounds_application_idx').on(table.applicationId),
]);

/* ================================================================================ #692 ===== */

/**
 * #692: a structured, local next action on one Applications row. It never replaces `applications.next_step`
 * or `notes` (the person's own text, untouched by anything here). Due fields follow
 * `application-actions-core.ts`: a named IANA zone always, `due_at` (UTC ms) is what overdue is judged
 * against. `request_id` makes a retried create return the same row; `version` fences stale edits.
 */
export const applicationActions = sqliteTable('application_actions', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  applicationId: text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  requestId: text('request_id').notNull(),
  kind: text('kind', { enum: ['follow_up', 'thank_you', 'send_information', 'prepare', 'other'] }).notNull(),
  title: text('title').notNull().default(''),
  note: text('note').notNull().default(''),
  channel: text('channel', {
    enum: ['email', 'phone', 'linkedin', 'portal', 'in_person', 'other', 'unspecified'],
  }).notNull().default('unspecified'),
  contactDetail: text('contact_detail').notNull().default(''),
  dueKind: text('due_kind', { enum: ['date', 'datetime'] }).notNull(),
  dueDate: text('due_date'),
  dueLocal: text('due_local'),
  dueTimeZone: text('due_time_zone').notNull(),
  dueUtcOffsetMinutes: integer('due_utc_offset_minutes'),
  dueResolution: text('due_resolution', { enum: ['unique', 'earlier', 'later'] }),
  dueAt: integer('due_at', { mode: 'timestamp_ms' }).notNull(),
  firstDueAt: integer('first_due_at', { mode: 'timestamp_ms' }).notNull(),
  rescheduleCount: integer('reschedule_count').notNull().default(0),
  state: text('state', { enum: ['open', 'completed', 'dismissed'] }).notNull().default('open'),
  /** `user`: the person created it. `suggestion_accepted`: they accepted the offered "Plan a follow-up". */
  origin: text('origin', { enum: ['user', 'suggestion_accepted'] }).notNull().default('user'),
  /** How the row's "sent" state was known when this was created (SubmissionClass). */
  basisClass: text('basis_class').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' }),
}, (table) => [
  uniqueIndex('application_actions_request_idx').on(table.applicationId, table.requestId),
  index('application_actions_application_idx').on(table.applicationId),
]);

/** #692: the person's own switch to stop suggesting follow-ups for one application. */
export const applicationActionPrefs = sqliteTable('application_action_prefs', {
  applicationId: text('application_id')
    .primaryKey()
    .references(() => applications.id, { onDelete: 'cascade' }),
  suggestionsSuppressed: integer('suggestions_suppressed', { mode: 'boolean' }).notNull().default(false),
  suppressedAt: integer('suppressed_at', { mode: 'timestamp_ms' }),
});

/**
 * #692: a follow-up draft. Preparing/approving a draft and the person REPORTING that they sent it are
 * separate columns: nothing in this app sends a message, so `send_state` only ever becomes
 * `user_reported_sent` through the person's own confirmation. `generated_body` is the model's text
 * (immutable); `body` is what the person edited and approved.
 */
export const applicationFollowUpDrafts = sqliteTable('application_follow_up_drafts', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  applicationId: text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  actionId: text('action_id').references(() => applicationActions.id, { onDelete: 'set null' }),
  requestId: text('request_id').notNull(),
  kind: text('kind', { enum: ['follow_up', 'thank_you', 'send_information', 'prepare', 'other'] }).notNull(),
  basis: text('basis', { mode: 'json' }).notNull().$type<FollowUpDraftBasis>(),
  subject: text('subject').notNull().default(''),
  generatedBody: text('generated_body').notNull(),
  body: text('body').notNull(),
  generatedHash: text('generated_hash').notNull(),
  bodyHash: text('body_hash').notNull(),
  status: text('status', { enum: ['prepared', 'approved', 'discarded'] }).notNull().default('prepared'),
  approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
  sendState: text('send_state', { enum: ['not_sent', 'user_reported_sent'] }).notNull().default('not_sent'),
  sentReportedAt: integer('sent_reported_at', { mode: 'timestamp_ms' }),
  sentOn: text('sent_on'),
  provider: text('provider').notNull(),
  usage: text('usage', { mode: 'json' }).$type<{ inputTokens?: number; outputTokens?: number } | null>(),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('application_follow_up_drafts_request_idx').on(table.applicationId, table.requestId),
  index('application_follow_up_drafts_application_idx').on(table.applicationId),
]);
