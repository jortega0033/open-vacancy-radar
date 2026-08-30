import { randomUUID } from 'node:crypto';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Personal workspace data (saved jobs, applications, CV library, generated letters, settings) —
 * deliberately a separate small schema/database from `@open-vacancy-radar/vacancy-engine`'s.
 * The engine's database is scan/discovery state with its own lifecycle (migrations, advisory
 * locks, content-hash reuse); this is plain per-user CRUD the desktop app owns outright. Keeping
 * them apart means neither schema's migration history constrains the other.
 *
 * `market` is deliberately just the two tracks this app can actually search — 'netherlands' (the
 * IND-sponsor pipeline) and 'worldwide' (the global-remote pipeline) — not an invented per-country
 * list. There is no real backend for a UK/DE/US/etc. structured search today; adding fake markets
 * here would be a UI promise the app can't keep.
 */

export const savedJobs = sqliteTable('saved_jobs', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /** Links back to a DiscoveryVacancyAudit/report row's `key`, when saved from a live search
   * result. Null for a manually-entered saved job (the prototype's "add saved job" flow). */
  vacancyKey: text('vacancy_key'),
  role: text('role').notNull(),
  company: text('company').notNull(),
  market: text('market', { enum: ['netherlands', 'worldwide'] }).notNull(),
  location: text('location').notNull(),
  salary: text('salary'),
  arrangement: text('arrangement'),
  verification: text('verification'),
  matchPercent: integer('match_percent'),
  sourceUrl: text('source_url'),
  notes: text('notes').notNull().default(''),
  status: text('status', { enum: ['considering', 'preparing', 'applied'] }).notNull().default('considering'),
  savedAt: integer('saved_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const cvDocuments = sqliteTable('cv_documents', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['uploaded', 'manual'] }).notNull(),
  targetRole: text('target_role').notNull().default(''),
  /** Full extracted text for an uploaded CV (PDF/txt/md) — what the AI features actually read.
   * Empty for a manual profile, which instead relies entirely on `profile`. */
  text: text('text').notNull().default(''),
  /** Structured profile fields, editable regardless of kind — { title, years, location,
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
  /** The generated letter body, as returned by the AI session — plain text, user-editable. */
  body: text('body').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
});

export const applications = sqliteTable('applications', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  savedJobId: text('saved_job_id').references(() => savedJobs.id, { onDelete: 'set null' }),
  role: text('role').notNull(),
  company: text('company').notNull(),
  location: text('location').notNull().default(''),
  market: text('market', { enum: ['netherlands', 'worldwide'] }).notNull(),
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

/** Single fixed row (id fixed at 1) — this is app-wide preference state, not a multi-row table. */
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
  defaultMarket: text('default_market', { enum: ['netherlands', 'worldwide'] }).notNull().default('netherlands'),
  defaultLocation: text('default_location').notNull().default(''),
  sponsorOnlyDefault: integer('sponsor_only_default', { mode: 'boolean' }).notNull().default(true),
  indVerificationEnabled: integer('ind_verification_enabled', { mode: 'boolean' }).notNull().default(true),
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
});
