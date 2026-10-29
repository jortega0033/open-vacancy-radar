import { z } from 'zod';
import {
  ACTION_CHANNELS,
  ACTION_KINDS,
  ACTION_LIMITS,
  ACTION_ORIGINS,
  ACTION_STATES,
  AMBIGUITY_CHOICES,
  DUE_ISSUES,
  SUBMISSION_CLASSES,
  SUGGESTION_REASONS,
  parseCalendarDate,
  parseWallTime,
} from './application-actions-core.js';

/**
 * The wire contract of `window.applicationActions` (#692), as schemas. The main-process service builds
 * these objects, the preload REBUILDS every result from them (unknown keys dropped, anything malformed
 * fails closed to a plain error) and the renderer imports only the types. No Node or Electron import
 * here: the preload and the renderer both load this file.
 *
 * The renderer names an application, an action it was shown and the version it was looking at, and
 * says what the person typed. It cannot name a basis, a class of evidence, a provider or a path.
 */

const id = z.string().min(1).max(300);
const iso = z.string().max(40);
const kind = z.enum(ACTION_KINDS);

export const ActionViewSchema = z.object({
  id,
  applicationId: id,
  kind,
  title: z.string().max(ACTION_LIMITS.titleChars),
  note: z.string().max(ACTION_LIMITS.noteChars),
  channel: z.enum(ACTION_CHANNELS),
  contactDetail: z.string().max(ACTION_LIMITS.contactChars),
  dueKind: z.enum(['date', 'datetime']),
  dueDate: z.string().max(10).nullable(),
  dueLocal: z.string().max(16).nullable(),
  dueTimeZone: z.string().max(64),
  dueUtcOffsetMinutes: z.number().int().nullable(),
  dueResolution: z.enum(['unique', 'earlier', 'later']).nullable(),
  dueAt: iso,
  firstDueAt: iso,
  rescheduleCount: z.number().int().min(0),
  state: z.enum(ACTION_STATES),
  origin: z.enum(ACTION_ORIGINS),
  basisClass: z.string().max(40),
  version: z.number().int().min(1),
  createdAt: iso,
  updatedAt: iso,
  completedAt: iso.nullable(),
  dismissedAt: iso.nullable(),
});
export type ActionView = z.infer<typeof ActionViewSchema>;

const SuggestionSchema = z.object({
  eligible: z.boolean(),
  reason: z.enum(SUGGESTION_REASONS),
  line: z.string().max(300),
});
export type SuggestionView = z.infer<typeof SuggestionSchema>;

export const ActionsViewSchema = z.object({
  applicationId: id,
  /** When the main process read this, ISO-8601. The renderer judges overdue against its own clock. */
  asOf: iso,
  application: z.object({
    role: z.string().max(500),
    company: z.string().max(500),
    status: z.enum(['preparing', 'applied', 'recruiter_screen', 'interview', 'offer', 'rejected', 'withdrawn']),
    archived: z.boolean(),
    appliedAt: iso.nullable(),
    submissionClass: z.enum(SUBMISSION_CLASSES),
    submissionLabel: z.string().max(200),
  }),
  actions: z.array(ActionViewSchema).max(ACTION_LIMITS.perApplication),
  suggestion: SuggestionSchema,
  suppressed: z.boolean(),
});
export type ActionsView = z.infer<typeof ActionsViewSchema>;

export const OverviewItemSchema = z.object({
  applicationId: id,
  openActions: z.array(ActionViewSchema).max(ACTION_LIMITS.perApplication),
  suggestion: SuggestionSchema,
});
export const OverviewSchema = z.object({
  ok: z.literal(true),
  asOf: iso,
  items: z.array(OverviewItemSchema).max(5000),
});
export type OverviewResult = z.infer<typeof OverviewSchema> | { ok: false; code: 'failed'; message: string };

export const ACTION_CODES = [
  'invalid_request',
  'not_found',
  'outdated',
  'not_open',
  'limit',
  'invalid_due',
  'failed',
] as const;

const DueOptionSchema = z.object({
  choice: z.enum(AMBIGUITY_CHOICES),
  instant: iso,
  offsetMinutes: z.number().int(),
});

const ResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    view: ActionsViewSchema,
    /** The action this request created/changed, when it was one. */
    actionId: id.nullable(),
    /** True when the request had already been applied (a retry): nothing new was written. */
    unchanged: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(ACTION_CODES),
    message: z.string().max(400),
    view: ActionsViewSchema.nullable(),
    dueIssue: z.enum(DUE_ISSUES).nullable(),
    dueOptions: z.array(DueOptionSchema).max(2),
  }),
]);
export type ActionsResult = z.infer<typeof ResultSchema>;

export function parseActionsResult(raw: unknown): ActionsResult {
  const parsed = ResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {
    ok: false,
    code: 'failed',
    message: 'The follow-ups could not be read.',
    view: null,
    dueIssue: null,
    dueOptions: [],
  };
}

export function parseOverviewResult(raw: unknown): OverviewResult {
  const parsed = OverviewSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { ok: false, code: 'failed', message: 'The follow-ups could not be read.' };
}

/* ------------------------------------------------------------------------------- inputs ----- */

const Id = z.string().trim().min(1).max(300);
const RequestId = z.string().trim().min(8).max(100);

const DueInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('date'),
      date: z.string().max(10).refine((value) => parseCalendarDate(value) !== null, 'a real date'),
      timeZone: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('datetime'),
      local: z.string().max(16).refine((value) => parseWallTime(value) !== null, 'a real time'),
      timeZone: z.string().min(1).max(64),
      ambiguity: z.enum(AMBIGUITY_CHOICES).optional(),
    })
    .strict(),
]);

const Fields = z
  .object({
    kind,
    title: z.string().trim().max(ACTION_LIMITS.titleChars),
    note: z.string().trim().max(ACTION_LIMITS.noteChars),
    channel: z.enum(ACTION_CHANNELS),
    contactDetail: z.string().trim().max(ACTION_LIMITS.contactChars),
  })
  .strict();

export const GetActionsInput = z.object({ applicationId: Id }).strict();
export const CreateActionInput = z
  .object({
    applicationId: Id,
    requestId: RequestId,
    fields: Fields,
    due: DueInput,
    origin: z.enum(ACTION_ORIGINS),
  })
  .strict();
export const UpdateActionInput = z
  .object({ applicationId: Id, actionId: Id, expectedVersion: z.number().int().min(1), fields: Fields, due: DueInput.optional() })
  .strict();
export const RescheduleActionInput = z
  .object({ applicationId: Id, actionId: Id, expectedVersion: z.number().int().min(1), due: DueInput })
  .strict();
export const TransitionActionInput = z
  .object({ applicationId: Id, actionId: Id, expectedVersion: z.number().int().min(1) })
  .strict();
export const SetSuppressedInput = z.object({ applicationId: Id, suppressed: z.boolean() }).strict();

export type CreateActionRequest = z.infer<typeof CreateActionInput>;
export type UpdateActionRequest = z.infer<typeof UpdateActionInput>;
export type RescheduleActionRequest = z.infer<typeof RescheduleActionInput>;
export type TransitionActionRequest = z.infer<typeof TransitionActionInput>;
export type SetSuppressedRequest = z.infer<typeof SetSuppressedInput>;
export type DueRequest = z.infer<typeof DueInput>;

export interface ApplicationActionsBridge {
  get(applicationId: string): Promise<ActionsResult>;
  overview(): Promise<OverviewResult>;
  create(input: CreateActionRequest): Promise<ActionsResult>;
  update(input: UpdateActionRequest): Promise<ActionsResult>;
  reschedule(input: RescheduleActionRequest): Promise<ActionsResult>;
  complete(input: TransitionActionRequest): Promise<ActionsResult>;
  dismiss(input: TransitionActionRequest): Promise<ActionsResult>;
  setSuppressed(input: SetSuppressedRequest): Promise<ActionsResult>;
}
