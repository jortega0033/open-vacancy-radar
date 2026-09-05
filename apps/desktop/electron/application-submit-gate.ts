/**
 * The pre-submit validation gate (#196 §5, issue #202): a deterministic, non-LLM check that runs
 * immediately before any real submit action, independent of and in addition to the user's own
 * explicit confirmation. Confirmation approves *content* the user looked at; this gate verifies
 * *integrity* -- that the content about to be sent is still exactly what was reviewed, and that it
 * plausibly belongs to the employer/role the attempt record claims. Refusing here is not optional
 * even when a confirmation click is already on record: per #202's acceptance criteria, a tampered
 * or stale attempt must be refused regardless of what was confirmed earlier.
 *
 * Pure and Electron-free by design, matching `packages/application-executor`'s own discipline: no
 * CDP, no filesystem, no daemon call. The caller resolves every input (the attempt record, the
 * rendered document text, and freshly recomputed hashes of the CV/JD the attempt actually used) and
 * gets back a plain refuse-or-pass verdict, the same shape as `validateFieldMap`'s own result.
 *
 * This gate does not re-check "every field traces back to structured source data" -- that is
 * `validateFieldMap`'s rule 4 (closed-set membership), already enforced the moment each field was
 * filled (#201). What this gate cannot see is whether the CV, JD, or rendered documents changed
 * *after* the user reviewed them and *before* the (not-yet-built) submit action runs; the hash
 * comparisons below are what catches that.
 */

export type PreSubmitGateRefusalReason =
  | 'source_cv_changed'
  | 'jd_changed'
  | 'company_not_found_in_documents'
  | 'role_not_found_in_documents'
  | 'placeholder_text_detected';

export interface PreSubmitGateAttempt {
  company: string;
  role: string;
  /** The hash recorded on the attempt at creation time (`sourceCvContentHash`/`jdSnapshotHash` on
   * `application_attempts` -- #198). */
  sourceCvContentHash: string;
  jdSnapshotHash: string;
}

export interface PreSubmitGateInput {
  attempt: PreSubmitGateAttempt;
  /** Recomputed by the caller, right now, from whatever CV content the submit action would
   * actually use -- never trusted from a value stored earlier in this same call. */
  currentSourceCvContentHash: string;
  currentJdSnapshotHash: string;
  renderedCvText: string;
  /** Null when this attempt has no cover letter. */
  renderedLetterText: string | null;
}

export interface PreSubmitGateResult {
  ok: boolean;
  reason?: PreSubmitGateRefusalReason;
  detail?: string;
}

function refuse(reason: PreSubmitGateRefusalReason, detail: string): PreSubmitGateResult {
  return { ok: false, reason, detail };
}

/**
 * Patterns for template/placeholder text that must never reach a real employer. Deliberately
 * narrow and literal (no attempt to catch every conceivable placeholder style): a false negative
 * here is caught by the user's own review; a false positive would block a legitimate application
 * for using the word "TBD" in a real sentence, so each pattern targets a recognizable placeholder
 * shape, not a common English word or phrase on its own.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\[insert[^\]]*\]/i,
  /\[your[^\]]*\]/i,
  /\[company[^\]]*\]/i,
  /\[role[^\]]*\]/i,
  /\[position[^\]]*\]/i,
  /\{\{[^}]*\}\}/,
  /\blorem ipsum\b/i,
  /\bTODO\b/,
];

function containsCaseInsensitive(haystack: string, needle: string): boolean {
  if (needle.trim().length === 0) return true; // nothing to find is trivially found
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Runs every rule in order, refusing on the first failure -- matching `validateFieldMap`'s own
 * "a single violation means the whole thing cannot be trusted" discipline. */
export function runPreSubmitGate(input: PreSubmitGateInput): PreSubmitGateResult {
  if (input.currentSourceCvContentHash !== input.attempt.sourceCvContentHash) {
    return refuse('source_cv_changed', 'the source CV has changed since this attempt was created');
  }
  if (input.currentJdSnapshotHash !== input.attempt.jdSnapshotHash) {
    return refuse('jd_changed', 'the job description has changed since this attempt was created');
  }

  const combinedText = `${input.renderedCvText}\n${input.renderedLetterText ?? ''}`;

  if (!containsCaseInsensitive(combinedText, input.attempt.company)) {
    return refuse('company_not_found_in_documents', `"${input.attempt.company}" does not appear in the rendered documents`);
  }
  if (!containsCaseInsensitive(combinedText, input.attempt.role)) {
    return refuse('role_not_found_in_documents', `"${input.attempt.role}" does not appear in the rendered documents`);
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = pattern.exec(combinedText);
    if (match) {
      return refuse('placeholder_text_detected', `matched placeholder-shaped text: "${match[0]}"`);
    }
  }

  return { ok: true };
}
