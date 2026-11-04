import { randomUUID } from 'node:crypto';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { applicationAttempts } from './schema.js';

/**
 * Blind Apply (#722) storage: one explicit authorization, the vacancies evaluated under it, an
 * append-only event trail, and the answers a person chose to remember for it.
 *
 * Kept in its own module so the reviewed flow's `schema.ts` stays readable, and re-exported from
 * `schema.ts` so drizzle-kit and the repository see one schema.
 */

/** The plain states of one Blind Apply item. The attempt's own checkpoint stays the source of truth
 * for submission; these add only the facts Blind Apply itself owns (why it was skipped, what it needs). */
export const BLIND_APPLY_ITEM_STATES = [
  'queued',
  'preparing',
  'ready',
  'submitting',
  'submitted',
  'outcome_unknown',
  'could_not_submit',
  'needs_answer',
  'needs_you',
  'apply_yourself',
  'skipped',
  'stopped',
] as const;
export type BlindApplyItemState = (typeof BLIND_APPLY_ITEM_STATES)[number];

/** What a person has to do for a `needs_you` item. Never solved, never entered by this app. */
export const BLIND_APPLY_INTERVENTIONS = [
  'captcha',
  'login',
  'verification_code',
  'consent',
  'upload_unsupported',
  'other',
] as const;
export type BlindApplyIntervention = (typeof BLIND_APPLY_INTERVENTIONS)[number];

export const BLIND_APPLY_SKIP_REASONS = [
  'closed',
  'duplicate',
  'not_frontend',
  'filters',
  'unverified_link',
  'unverifiable_posting',
] as const;
export type BlindApplySkipReason = (typeof BLIND_APPLY_SKIP_REASONS)[number];

export const BLIND_APPLY_EVENT_KINDS = [
  'gate',
  'prepare',
  'answer_used',
  'submit_click',
  'receipt',
  'stop',
  'recover',
  'user_action',
] as const;
export type BlindApplyEventKind = (typeof BLIND_APPLY_EVENT_KINDS)[number];

/** What a `needs_answer` card asks for, kept as data so the card can render it without a live page. */
export interface BlindApplyMissingField {
  label: string;
  controlType: 'text' | 'textarea' | 'select';
  /** Present for a select: the option labels the page offered. Display data from the employer page. */
  options?: string[];
}

/** What the gates decided and on what evidence, stored verbatim with the item. */
export interface BlindApplyGateEvidence {
  family: string | null;
  filters: 'eligible' | 'not_eligible' | 'unknown';
  linkStatus: 'verified' | 'unverified' | 'unknown';
  policyId: string | null;
  livenessStatus: string | null;
  livenessVerificationId: string | null;
  duplicateCheck: 'clear' | 'duplicate';
}

/** One answer used to fill a form, by provenance. The value itself lives on the attempt's prepared fields. */
export interface BlindApplyAnswerUse {
  label: string;
  provenance: 'cv' | 'profile' | 'saved_answer';
  answerId?: string;
}

/**
 * One explicit, one-time Blind Apply authorization. Created only by the native confirmation dialog in
 * main; the renderer cannot write it. There is deliberately NO cap, quota or per-day column: the user
 * chose on 2026-10-30 that Blind Apply has no daily limit, and the absence of a column is what stops a
 * later change from quietly adding one. A stopped authorization is never deleted.
 */
export const blindApplyAuthorizations = sqliteTable('blind_apply_authorizations', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  roleFamilies: text('role_families', { mode: 'json' }).notNull().$type<string[]>(),
  filtersSnapshot: text('filters_snapshot', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  filtersHash: text('filters_hash').notNull(),
  profileVersion: text('profile_version').notNull(),
  sourceCvId: text('source_cv_id'),
  sourceCvContentHash: text('source_cv_content_hash').notNull(),
  useSavedAnswers: integer('use_saved_answers', { mode: 'boolean' }).notNull(),
  policyIds: text('policy_ids', { mode: 'json' }).notNull().$type<string[]>(),
  confirmTextHash: text('confirm_text_hash').notNull(),
  stoppedAt: integer('stopped_at', { mode: 'timestamp_ms' }),
  stopReason: text('stop_reason'),
});

/** One vacancy evaluated under one authorization. Evaluated once per authorization (unique index). */
export const blindApplyItems = sqliteTable('blind_apply_items', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  authorizationId: text('authorization_id')
    .notNull()
    .references(() => blindApplyAuthorizations.id),
  vacancyKey: text('vacancy_key').notNull(),
  identityKey: text('identity_key').notNull(),
  company: text('company').notNull(),
  role: text('role').notNull(),
  applyUrl: text('apply_url').notNull(),
  /** Null means "Apply yourself": no compiled policy covers this target. */
  policyId: text('policy_id'),
  /** The preparation attempt. `set null`, not cascade: an audit record must outlive a deleted attempt. */
  attemptId: text('attempt_id').references(() => applicationAttempts.id, { onDelete: 'set null' }),
  state: text('state', { enum: BLIND_APPLY_ITEM_STATES }).notNull(),
  stateDetail: text('state_detail').notNull().default(''),
  skipReason: text('skip_reason', { enum: BLIND_APPLY_SKIP_REASONS }),
  intervention: text('intervention', { enum: BLIND_APPLY_INTERVENTIONS }),
  missingFields: text('missing_fields', { mode: 'json' }).$type<BlindApplyMissingField[] | null>(),
  gateEvidence: text('gate_evidence', { mode: 'json' }).notNull().$type<BlindApplyGateEvidence>(),
  prepRetries: integer('prep_retries').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('blind_apply_items_auth_vacancy_idx').on(table.authorizationId, table.vacancyKey),
  index('blind_apply_items_identity_idx').on(table.identityKey),
  index('blind_apply_items_state_idx').on(table.state),
]);

/** Append-only trail of what Blind Apply did and why. The store exposes insert and read only. */
export const blindApplyEvents = sqliteTable('blind_apply_events', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  itemId: text('item_id')
    .notNull()
    .references(() => blindApplyItems.id),
  at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  kind: text('kind', { enum: BLIND_APPLY_EVENT_KINDS }).notNull(),
  detail: text('detail').notNull().default(''),
  cvArtifactHash: text('cv_artifact_hash'),
  letterArtifactHash: text('letter_artifact_hash'),
  answers: text('answers', { mode: 'json' }).$type<BlindApplyAnswerUse[] | null>(),
  receiptId: text('receipt_id'),
  postingVerificationId: text('posting_verification_id'),
}, (table) => [index('blind_apply_events_item_idx').on(table.itemId, table.at)]);

/**
 * Answers the person gave a `needs_answer` card and chose to remember for Blind Apply. A table of its
 * own rather than extra columns on `application_answers`, so the reviewed flow's answer library (text
 * and textarea only, confirmed on every use) is untouched. Matched by exact normalized label, control
 * type and -- for a select -- the exact option set, so a changed option list asks again. No fuzzy match.
 */
export const blindApplyAnswers = sqliteTable('blind_apply_answers', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  /** `blindAnswerKey(label, controlType, optionSetHash)`. Unique: one remembered answer per question. */
  matchKey: text('match_key').notNull(),
  label: text('label').notNull(),
  controlType: text('control_type', { enum: ['text', 'textarea', 'select'] }).notNull(),
  /** The answer text, or for a select the option label that was chosen. */
  answer: text('answer').notNull(),
  optionSetHash: text('option_set_hash'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
}, (table) => [uniqueIndex('blind_apply_answers_match_key_idx').on(table.matchKey)]);
