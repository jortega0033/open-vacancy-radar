import { z } from 'zod';

/**
 * The wire contract of `window.applyCopyFields` (#660), as schemas. The main-process service builds
 * these objects, the preload REBUILDS every result from them (unknown keys dropped, anything malformed
 * fails closed to a plain error) and the renderer imports only the types. No Node or Electron import
 * here: the preload and the renderer both load this file.
 *
 * The renderer may name an attempt. It gets back only values the person is about to paste into an
 * employer form themselves: the letter body a staged PDF was rendered from, and the contact fields
 * printed on the staged CV. Never a path, a draft id of another attempt, or anything live-editable.
 */

export const APPLY_COPY_LIMITS = {
  /** Mirrors the interview-context document view cap; a letter body is far below it. */
  letterChars: 60_000,
  /** Mirrors CV_SOURCE_LIMITS.shortField / listItem. */
  shortField: 512,
  links: 10,
} as const;

/** Why a document's values are not offered. `changed` covers every hash mismatch: edited stored
 * content, a draft pointing at no artifact of this attempt, or file bytes that differ. */
const UNAVAILABLE = ['no_draft', 'changed', 'file_missing'] as const;
export type ApplyCopyUnavailable = (typeof UNAVAILABLE)[number];

const hash = z.string().max(100);
const version = z.number().int().min(1);
const short = z.string().max(APPLY_COPY_LIMITS.shortField);

const LetterCopySchema = z.object({
  kind: z.enum(['cover_letter', 'motivation_letter']),
  /** The letter body the staged PDF was rendered from, in the PDF's own paragraph layout:
   * paragraphs split on blank lines, trimmed, joined with one blank line. No heading, no
   * automatically added signature line (a sign-off the body itself carries stays). */
  text: z.string().max(APPLY_COPY_LIMITS.letterChars),
  version,
  artifactHash: hash,
});

const ContactCopySchema = z.object({
  name: short,
  email: short,
  phone: short,
  location: short,
  links: z.array(short).max(APPLY_COPY_LIMITS.links),
  version,
  artifactHash: hash,
});

const ViewSchema = z.object({
  letters: z.array(LetterCopySchema).max(2),
  /** Set when a staged letter PDF exists but no current draft passes verification against it. */
  letterUnavailable: z.enum(UNAVAILABLE).nullable(),
  contact: ContactCopySchema.nullable(),
  /** Set when a staged CV PDF exists but no current CV draft passes verification against it. */
  contactUnavailable: z.enum(UNAVAILABLE).nullable(),
});

const ResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), view: ViewSchema }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['invalid_request', 'not_found', 'failed']),
    message: z.string().max(300),
    view: z.null(),
  }),
]);

export type ApplyCopyLetter = z.infer<typeof LetterCopySchema>;
export type ApplyCopyContact = z.infer<typeof ContactCopySchema>;
export type ApplyCopyView = z.infer<typeof ViewSchema>;
export type ApplyCopyResult = z.infer<typeof ResultSchema>;

export function parseApplyCopyResult(raw: unknown): ApplyCopyResult {
  const parsed = ResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { ok: false, code: 'failed', message: 'The copy fields could not be read.', view: null };
}

export const ApplyCopyGetInput = z.object({ attemptId: z.string().trim().min(1).max(300) }).strict();

export interface ApplyCopyBridge {
  get(attemptId: string): Promise<ApplyCopyResult>;
}
