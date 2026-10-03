import type { SubmitApplicationReviewResult } from '../../../electron/application-executor-types.js';

/**
 * What a person needs to know after a review step fails (#468): did anything reach the employer?
 * Exactly three answers exist, and the wording for each is fixed here so every error path in the
 * review dialog says the same thing.
 *
 *  - `not_sent`: the app knows nothing was delivered. Trying again or skipping is safe.
 *  - `sent`: the application is already recorded as delivered. There is nothing left to retry.
 *  - `unconfirmed`: a submit may have gone out and the app cannot tell. Trying again risks a
 *    duplicate application, so the dialog keeps that action locked until the person has checked.
 */
export type ReviewOutcome = 'not_sent' | 'sent' | 'unconfirmed';

export interface ReviewFailure {
  outcome: ReviewOutcome;
  /** The sentence the person reads first. */
  message: string;
  /** What the main process said, kept as a secondary line. Never replaces `message`. */
  detail?: string;
}

type RefusalReason = NonNullable<SubmitApplicationReviewResult['reason']>;

const UNCONFIRMED_MESSAGE = 'We could not confirm whether this was sent. Check the employer site before trying again.';

/**
 * Refusals the main process raises before the submit control is ever clicked, plus
 * `submission_rejected`, where the employer's own page refused the submission. Anything not listed
 * here, including a reason added to the main process later, falls through to `unconfirmed`: an
 * unknown reason must never be presented as proof that nothing went out.
 */
const NOT_SENT_REASONS: Partial<Record<RefusalReason, string>> = {
  source_cv_changed: 'Your CV changed after these documents were prepared.',
  jd_changed: 'The job description changed after these documents were prepared.',
  company_not_found_in_documents: 'The prepared documents do not mention this company.',
  role_not_found_in_documents: 'The prepared documents do not mention this role.',
  placeholder_text_detected: 'The prepared documents still contain placeholder text.',
  source_cv_not_found: 'The CV these documents were built from could not be found.',
  artifact_read_failed: 'A prepared document could not be read.',
  artifact_bytes_changed: 'A prepared document changed after it was approved.',
  no_open_review: 'The review is no longer open.',
  no_snapshot: 'The review has no form to send yet.',
  captcha_detected: 'The employer page is showing a CAPTCHA.',
  form_not_ready: 'The form still has checks to finish.',
  handoff_in_progress: 'The live page is still open.',
  unresolved_submit_control: 'We could not find the submit button.',
  submit_refused: 'This site needs you to submit it yourself.',
  submission_rejected: 'The employer page rejected the application.',
};

function cleanDetail(detail: string | undefined): string | undefined {
  const trimmed = detail?.trim();
  return trimmed ? trimmed : undefined;
}

/** Capitalises and terminates a lowercase error fragment such as "could not skip this attempt". */
export function toSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/u.test(capitalised) ? capitalised : `${capitalised}.`;
}

export function notSentFailure(sentence: string, detail?: string): ReviewFailure {
  const cleaned = cleanDetail(detail);
  return { outcome: 'not_sent', message: `Not sent. ${toSentence(sentence)}`, ...(cleaned ? { detail: cleaned } : {}) };
}

export function unconfirmedFailure(detail?: string): ReviewFailure {
  const cleaned = cleanDetail(detail);
  return { outcome: 'unconfirmed', message: UNCONFIRMED_MESSAGE, ...(cleaned ? { detail: cleaned } : {}) };
}

export function alreadySentFailure(detail?: string): ReviewFailure {
  const cleaned = cleanDetail(detail);
  return {
    outcome: 'sent',
    message: 'Already sent. This application is recorded as submitted, so there is nothing to retry.',
    ...(cleaned ? { detail: cleaned } : {}),
  };
}

/** Maps the result of `submitReview` when it came back `ok: false`. */
export function describeSubmitRefusal(result: Pick<SubmitApplicationReviewResult, 'reason' | 'detail'>): ReviewFailure {
  const sentence = result.reason ? NOT_SENT_REASONS[result.reason] : undefined;
  if (sentence) return notSentFailure(sentence, result.detail);
  return unconfirmedFailure(result.detail);
}

export function errorText(err: unknown): string | undefined {
  return err instanceof Error && err.message ? err.message : undefined;
}
