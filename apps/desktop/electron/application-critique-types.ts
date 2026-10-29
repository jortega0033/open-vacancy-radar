import { z } from 'zod';

/**
 * The wire contract of `window.applicationCritique` (#690), as schemas. One definition serves three
 * readers: the main-process service builds objects of these types, the preload REBUILDS every result
 * from them (unknown keys are dropped and anything malformed fails closed to a plain error), and the
 * renderer imports only the types. No runtime import of Node or Electron here: the preload and the
 * renderer both load this file.
 *
 * Nothing in a result is a command. The renderer can show findings and send back an id and a hash; it
 * cannot hand the main process a document, a fact or a permission.
 */

export const DRAFT_KINDS = ['cv', 'cover_letter', 'motivation_letter'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const FINDING_KINDS = [
  'unsupported_claim',
  'omitted_requirement',
  'cross_document_inconsistency',
  'unclear_wording',
  'unnecessary_detail',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const UNAVAILABLE_CODES = [
  'sent',
  'not_prepared',
  'held',
  'source_cv_missing',
  'no_reviewed_source',
  'no_job_description',
  'package_not_recorded',
] as const;
export type UnavailableCode = (typeof UNAVAILABLE_CODES)[number];

export const RUN_OUTCOMES = ['reviewed', 'failed', 'cancelled', 'timed_out', 'provider_limit', 'invalid_output', 'discarded'] as const;
export type LastRunOutcome = (typeof RUN_OUTCOMES)[number];

export const ACTION_CODES = [
  'not_available',
  'already_running',
  'failed',
  'cancelled',
  'timed_out',
  'provider_limit',
  'invalid_output',
  'discarded',
  'outdated',
  'not_found',
  'not_accepted',
  'busy',
  'invalid_request',
] as const;
export type CritiqueActionCode = (typeof ACTION_CODES)[number];

const text = (max: number) => z.string().max(max);
const id = z.string().min(1).max(200);
const draftKind = z.enum(DRAFT_KINDS);

const EvidenceSchema = z.union([
  z.object({ source: z.enum(['jd', 'cv_draft', 'cover_letter_draft', 'motivation_letter_draft']), quote: text(700) }),
  z.object({ source: z.literal('cv_fact'), id, text: text(2000) }),
  z.object({ source: z.literal('company_fact'), id, text: text(2000) }),
  z.object({ source: z.literal('gap'), note: text(400) }),
]);

const FindingViewSchema = z.object({
  id,
  kind: z.enum(FINDING_KINDS),
  label: text(120),
  summary: text(500),
  documents: z.array(draftKind).max(3),
  evidence: z.array(EvidenceSchema).max(8),
  suggestion: text(500).nullable(),
  current: z.boolean(),
  outdatedBecause: z.array(text(80)).max(8),
});

const RefusedViewSchema = z.object({
  kind: text(60).nullable(),
  summary: text(300),
  code: text(60),
  reason: text(200),
  detail: text(500),
});

const ProposalViewSchema = z.object({
  document: draftKind,
  label: text(60),
  status: z.enum(['pending', 'accepted', 'rejected', 'refused']),
  reasons: z.array(text(600)).max(20),
  changes: z.array(text(1200)).max(60),
  preview: text(60_000).nullable(),
  baseVersion: z.number().int().min(0),
  baseContentHash: text(100),
  current: z.boolean(),
  outdatedBecause: z.array(text(80)).max(8),
  acceptable: z.boolean(),
  acceptedVersion: z.number().int().min(0).nullable(),
});

const ReviewViewSchema = z.object({
  runId: id,
  reviewedAt: text(40),
  provider: text(40),
  model: text(80).nullable(),
  calls: z.number().int().min(0),
  tokens: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).nullable(),
  state: z.enum(['current', 'partly_outdated', 'outdated']),
  outdatedBecause: z.array(text(80)).max(8),
  noFindings: z.boolean(),
  findings: z.array(FindingViewSchema).max(40),
  refused: z.array(RefusedViewSchema).max(60),
  proposals: z.array(ProposalViewSchema).max(4),
});

export const CritiqueViewSchema = z.object({
  attemptId: id,
  canReview: z.boolean(),
  unavailable: z.object({ code: z.enum(UNAVAILABLE_CODES), message: text(400) }).nullable(),
  running: z.boolean(),
  documents: z
    .array(
      z.object({
        kind: draftKind,
        label: text(60),
        version: z.number().int().min(0),
        origin: z.enum(['prepared', 'user_letter', 'critique_revision']),
        authored: z.enum(['generated', 'user']).nullable(),
      }),
    )
    .max(4),
  review: ReviewViewSchema.nullable(),
  lastRun: z.object({ outcome: z.enum(RUN_OUTCOMES), detail: text(600), at: text(40) }).nullable(),
});

export type CritiqueView = z.infer<typeof CritiqueViewSchema>;
export type CritiqueDocumentView = CritiqueView['documents'][number];
export type FindingView = z.infer<typeof FindingViewSchema>;
export type RefusedView = z.infer<typeof RefusedViewSchema>;
export type ProposalView = z.infer<typeof ProposalViewSchema>;
export type ReviewView = z.infer<typeof ReviewViewSchema>;

export const CritiqueResultSchema = z.union([
  z.object({ ok: z.literal(true), view: CritiqueViewSchema }),
  z.object({ ok: z.literal(false), code: z.enum(ACTION_CODES), message: text(500), view: CritiqueViewSchema.nullable() }),
]);
export type CritiqueActionResult = z.infer<typeof CritiqueResultSchema>;

export interface ProposalTarget {
  attemptId: string;
  runId: string;
  document: DraftKind;
  baseContentHash: string;
}

const FAILED: CritiqueActionResult = {
  ok: false,
  code: 'failed',
  message: 'Something went wrong. Your documents were not changed.',
  view: null,
};

/** Rebuilds a result from known fields only; anything malformed becomes a plain failure. */
export function parseCritiqueResult(raw: unknown): CritiqueActionResult {
  const parsed = CritiqueResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : FAILED;
}

/** The `window.applicationCritique` capability. Only `run` and `accept` can reach a model or a document. */
export interface ApplicationCritiqueBridge {
  /** Local read of the stored review. Never starts a session, a render or a request. */
  get(attemptId: string): Promise<CritiqueActionResult>;
  /** The explicit "Review this application": ONE hardened no-network session, no retry. */
  run(attemptId: string): Promise<CritiqueActionResult>;
  /** Stops a running review. Documents are never touched. */
  cancel(attemptId: string): Promise<{ ok: boolean }>;
  /** Declines a suggestion. Changes its status only. */
  reject(target: ProposalTarget): Promise<CritiqueActionResult>;
  /** Applies a suggestion the person has read: a new document version, never a submission. */
  accept(target: ProposalTarget): Promise<CritiqueActionResult>;
}
