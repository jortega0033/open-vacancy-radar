import { z } from 'zod';

/**
 * The wire contract of `window.interviewContext` (#691), as schemas. The main-process service builds
 * these objects, the preload REBUILDS every result from them (unknown keys dropped, anything malformed
 * fails closed to a plain error) and the renderer imports only the types. No Node or Electron import
 * here: the preload and the renderer both load this file.
 *
 * The renderer may name an application, a package it was shown, the version it was looking at and
 * what the person said about a document. It cannot name a draft, an artifact, a receipt or a path.
 */

export const VIEW_TEXT_LIMITS = {
  documentChars: 60_000,
  jdChars: 100_000,
  suppliedTextChars: 60_000,
} as const;

const SLOTS = ['cv', 'letter'] as const;
const PROVENANCES = ['prepared', 'user_confirmed', 'receipt_backed', 'unknown'] as const;
const SOURCES = ['draft', 'artifact_only', 'person_text', 'linked_copy', 'none'] as const;
const EVIDENCE = ['receipt', 'user_reported', 'none'] as const;
const DRAFT_KINDS = ['cv', 'cover_letter', 'motivation_letter'] as const;
export const ROUND_TYPES = [
  'recruiter_screen',
  'phone_screen',
  'technical',
  'hiring_manager',
  'panel',
  'take_home',
  'onsite',
  'final',
  'other',
] as const;
export const ROUND_STATES = ['planned', 'held'] as const;
export const STATEMENT_CHOICES = ['prepared_file', 'supplied_text', 'linked_document', 'unknown'] as const;

const id = z.string().min(1).max(300);
const hash = z.string().max(100);
const iso = z.string().max(40);

const DocumentViewSchema = z.object({
  slot: z.enum(SLOTS),
  kind: z.enum(DRAFT_KINDS).nullable(),
  provenance: z.enum(PROVENANCES),
  source: z.enum(SOURCES),
  version: z.number().int().min(0).nullable(),
  contentHash: hash.nullable(),
  artifactHash: hash.nullable(),
  fileName: z.string().max(300).nullable(),
  statedAt: iso.nullable(),
  /** The document's text when this app holds it and it still matches its recorded hash. */
  text: z.string().max(VIEW_TEXT_LIMITS.documentChars).nullable(),
  textTruncated: z.boolean(),
  /** available | changed (stored text no longer matches its hash) | missing (record gone) | not_stored. */
  textState: z.enum(['available', 'changed', 'missing', 'not_stored']),
  /** present | missing (file gone) | changed (bytes differ) | not_recorded (no file was recorded). */
  fileState: z.enum(['present', 'missing', 'changed', 'not_recorded']),
});

const PackageViewSchema = z.object({
  id,
  attemptId: id.nullable(),
  /** recorded (bound when the submission was recorded) | legacy (sent before this app kept the list) |
   * prepared (not recorded as sent) | row (stated by the person on an application with no prepared package). */
  kind: z.enum(['recorded', 'legacy', 'prepared', 'row']),
  version: z.number().int().min(1).nullable(),
  manifestHash: hash.nullable(),
  role: z.string().max(500),
  company: z.string().max(500),
  requisition: z.string().max(500),
  submission: z.object({
    evidence: z.enum(EVIDENCE),
    receiptKind: z.string().max(60).nullable(),
    recordedAt: iso.nullable(),
  }),
  posting: z.object({
    text: z.string().max(VIEW_TEXT_LIMITS.jdChars).nullable(),
    hash: hash.nullable(),
    complete: z.boolean().nullable(),
    /** False when the stored posting text no longer matches the hash the package recorded. */
    matches: z.boolean().nullable(),
  }),
  candidate: z.object({
    sourceCvHash: hash.nullable(),
    reviewedEvidenceHash: hash.nullable(),
    reviewedEvidenceFrom: z.enum(['review', 'submission']).nullable(),
  }),
  documents: z.array(DocumentViewSchema).max(2),
  /** Documents this app prepared for this application that the person may confirm as sent. */
  heldSlots: z.array(z.enum(SLOTS)).max(2),
  supersedesAttemptId: id.nullable(),
  createdAt: iso,
});

const RoundViewSchema = z.object({
  id,
  roundType: z.enum(ROUND_TYPES),
  scheduledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  state: z.enum(ROUND_STATES),
  feedback: z.string().max(4000),
  openTopics: z.array(z.string().max(300)).max(12),
  createdAt: iso,
  updatedAt: iso,
});

const ViewSchema = z.object({
  applicationId: id,
  packages: z.array(PackageViewSchema).max(40),
  defaultPackageId: id.nullable(),
  /** single | chain (the newest of a reapplication chain) | choose (several, the person picks) |
   * prepared (only a package that was not recorded as sent) | none. */
  selection: z.enum(['single', 'chain', 'choose', 'prepared', 'none']),
  rounds: z.array(RoundViewSchema).max(30),
});

export type InterviewDocumentView = z.infer<typeof DocumentViewSchema>;
export type InterviewPackageView = z.infer<typeof PackageViewSchema>;
export type InterviewRoundView = z.infer<typeof RoundViewSchema>;
export type InterviewContextView = z.infer<typeof ViewSchema>;

export const ACTION_CODES = [
  'invalid_request',
  'not_found',
  'outdated',
  'receipt_backed',
  'nothing_prepared',
  'text_required',
  'no_linked_document',
  'limit',
  'failed',
] as const;
export type InterviewContextActionCode = (typeof ACTION_CODES)[number];

const ResultSchema = z.union([
  z.object({ ok: z.literal(true), view: ViewSchema }),
  z.object({ ok: z.literal(false), code: z.enum(ACTION_CODES), message: z.string().max(400), view: ViewSchema.nullable() }),
]);
export type InterviewContextResult = z.infer<typeof ResultSchema>;

/** Rebuilds a result from whatever crossed IPC; anything malformed becomes a plain failure. */
export function parseInterviewContextResult(raw: unknown): InterviewContextResult {
  const parsed = ResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { ok: false, code: 'failed', message: 'The interview details could not be read.', view: null };
}

/* ------------------------------------------------------------------------------- inputs ----- */

const Id = z.string().trim().min(1).max(300);
export const GetInput = z.object({ applicationId: Id }).strict();
export const StatementInput = z
  .object({
    slot: z.enum(SLOTS),
    choice: z.enum(STATEMENT_CHOICES),
    text: z.string().max(VIEW_TEXT_LIMITS.suppliedTextChars).optional(),
  })
  .strict();
export const StateDocumentsInput = z
  .object({
    applicationId: Id,
    packageId: Id,
    expectedVersion: z.number().int().min(1).nullable(),
    statements: z.array(StatementInput).min(1).max(2),
  })
  .strict()
  .refine((input) => new Set(input.statements.map((s) => s.slot)).size === input.statements.length, 'one statement per document');
export const RoundFields = z
  .object({
    roundType: z.enum(ROUND_TYPES),
    scheduledOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'a real date')
      .nullable(),
    state: z.enum(ROUND_STATES),
    feedback: z.string().max(4000),
    openTopics: z.array(z.string().trim().min(1).max(300)).max(12),
  })
  .strict();
export const SaveRoundInput = z
  .object({
    applicationId: Id,
    roundId: Id.nullable(),
    expectedUpdatedAt: z.string().max(40).nullable(),
    round: RoundFields,
  })
  .strict();
export const DeleteRoundInput = z.object({ applicationId: Id, roundId: Id }).strict();

export type StateDocumentsRequest = z.infer<typeof StateDocumentsInput>;
export type SaveRoundRequest = z.infer<typeof SaveRoundInput>;
export type DeleteRoundRequest = z.infer<typeof DeleteRoundInput>;

export interface InterviewContextBridge {
  get(applicationId: string): Promise<InterviewContextResult>;
  stateDocuments(input: StateDocumentsRequest): Promise<InterviewContextResult>;
  saveRound(input: SaveRoundRequest): Promise<InterviewContextResult>;
  deleteRound(input: DeleteRoundRequest): Promise<InterviewContextResult>;
}
