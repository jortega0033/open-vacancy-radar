/**
 * Deterministic classification of what actually happened after the one irreversible click
 * (`executor.ts`'s `submit()`), issue #271.
 *
 * The gap this closes: a click that *returns* is not a submission. A page's own handler can run,
 * re-render the same form with "This field is required", and resolve the click promise perfectly
 * normally; an endpoint can answer `200 OK` with a body that says the application was rejected.
 * Before this module, the only thing observed was "the click did not throw", and that was recorded
 * as `submitted`.
 *
 * Three rules shape everything below, and none of them is a heuristic that can be tuned looser:
 *
 * 1. **Only positive evidence produces `submitted`.** Absence of an error is never evidence of
 *    delivery. Every path that cannot show a real receipt lands on `unknown`, which the caller
 *    records as the existing `submission_unknown` checkpoint (#202) -- a state this app already
 *    treats as "a real submit action may or may not have gone through", and which blocks a blind
 *    unforced retry at the same vacancy (`NON_TERMINAL_ATTEMPT_CHECKPOINTS`).
 * 2. **An error signal always wins.** Checked before any confirmation marker, and checked in the
 *    response payload before the page, so a transport-level success carrying an application-level
 *    error is never read as delivery.
 * 3. **Evidence must be new.** A marker that was already on the page *before* the click is not
 *    evidence that the click did anything -- every confirmation phrase is matched against the
 *    pre-click baseline text too, and discarded if it was already there. This is what stops a
 *    posting whose own boilerplate happens to read "thank you for applying" from auto-confirming
 *    every attempt against it.
 *
 * Pure and transport-free on purpose: it takes an already-collected observation and returns a
 * verdict, so every branch below is unit-testable against a hand-built fixture with no browser,
 * no CDP, and above all no live submission to a real employer.
 */

export type SubmissionOutcome = 'submitted' | 'rejected' | 'unknown';

/** What kind of thing is being offered as proof of delivery. `user_statement` is deliberately in
 * the same enum as the machine-observed kinds, and deliberately never produces `submitted`: a
 * person saying they finished an application by hand is recorded as its own outcome by the caller
 * (`user_reported`), not folded into the evidence-backed one. */
export type SubmissionEvidenceKind =
  | 'confirmation_page'
  | 'receipt_reference'
  /** An out-of-band acknowledgement observed after the fact (a delayed receipt), not the page. */
  | 'delivery_receipt'
  | 'user_statement'
  | 'none';

export interface SubmissionEvidence {
  kind: SubmissionEvidenceKind;
  /**
   * The exact matched text or identifier, bounded to `MAX_EVIDENCE_REFERENCE_LENGTH`. This is the
   * "evidence reference" #271 requires a `submitted` record to carry, so a person can later check
   * the claim rather than take the app's word for it.
   *
   * Third-party page text, so a caller must treat it as untrusted display data. It is never parsed
   * for control flow after this module and never interpolated anywhere it could be executed.
   */
  reference: string;
}

export type SubmissionRejectedReason = 'form_validation_error' | 'application_error_payload';

export type SubmissionUnknownReason =
  | 'no_receipt_observed'
  | 'navigation_lost'
  | 'observation_timeout'
  | 'observation_failed';

/** A discriminated union, not a bag of optional fields: `evidence` exists only on the one outcome
 * that is allowed to claim delivery, so no caller can read an evidence reference off a verdict
 * that never established one. */
export type SubmissionOutcomeReport =
  | { outcome: 'submitted'; evidence: SubmissionEvidence; detail: string; observedAt: string }
  | { outcome: 'rejected'; reason: SubmissionRejectedReason; detail: string; observedAt: string }
  | { outcome: 'unknown'; reason: SubmissionUnknownReason; detail: string; observedAt: string };

/**
 * A response the *host* layer observed for the submission request, never something this package
 * fetched: the CDP allowlist denies the whole `Network` domain (`cdp-allowlist.ts`), by design, so
 * this package cannot and must not read network traffic itself. The Electron layer is what can
 * observe a response at all, and passes one in here when it has one.
 */
export interface ObservedResponse {
  status: number;
  /** The response body as text, already bounded by whoever observed it. */
  body: string;
}

/** Everything the classifier is allowed to look at. Collected by `executor.ts`'s observer from
 * allowlisted CDP reads only (`dom-extract.ts`'s `extractSubmissionSignals`), plus an optional
 * host-supplied response. */
export interface SubmissionPageObservation {
  /** Visible text of the document after the click, bounded and whitespace-collapsed. */
  text: string;
  /** The same page's visible text captured immediately BEFORE the click. A confirmation phrase
   * present in both is not evidence of anything (rule 3 above). */
  baselineText: string;
  /** Whether the page still presents a submit-shaped control, i.e. the form is still standing. */
  formStillPresent: boolean;
  /** Text of structural error markers found in the DOM (`aria-invalid="true"` or an error-shaped
   * class), empty containers already dropped. */
  errorMarkers: readonly string[];
  /** Only when the host layer actually observed one. */
  response?: ObservedResponse;
}

export const MAX_EVIDENCE_REFERENCE_LENGTH = 300;

/**
 * Confirmation wording, as a fixed, named, reviewable list rather than a general "looks positive"
 * heuristic -- the same discipline `dom-extract.ts` applies to CAPTCHA widget detection, and for
 * the same reason: a list that fails to match simply produces `unknown` (safe), whereas a fuzzy
 * matcher that fires on the wrong page produces a false `submitted` (the exact bug #271 is about).
 */
const CONFIRMATION_PHRASES: readonly RegExp[] = Object.freeze([
  /your application (?:has been|was|is) (?:successfully )?(?:submitted|received|sent)/i,
  /application (?:successfully )?(?:submitted|received)/i,
  /we(?:'ve| have) received your application/i,
  /thank you for (?:your )?appl(?:ying|ication)/i,
  /submission (?:was )?(?:successful|complete)/i,
]);

/**
 * A receipt/reference identifier the page (or a response payload) prints for the applicant. The
 * identifier itself must be at least six characters of an id-shaped alphabet: short numbers like
 * "Reference: 3" appear on plenty of pages that have nothing to do with a submission.
 *
 * Every gap between the parts is a *bounded* `[ \t]{0,3}`, never `\s*`. Two adjacent unbounded
 * whitespace quantifiers around an optional group is a polynomial-backtracking shape, and the
 * string this runs against is a third-party page's own text -- exactly the "uncontrolled data"
 * case where that matters. `extractSubmissionSignals` already collapses runs of whitespace to a
 * single space before this sees anything, so three is generous rather than restrictive.
 */
const RECEIPT_REFERENCE_PATTERN =
  /\b(?:application|confirmation|reference|receipt)[ \t]{0,3}(?:id|number|no\.?|#)?[ \t]{0,3}[:#][ \t]{0,3}([A-Za-z0-9][A-Za-z0-9_-]{5,63})\b/;

/**
 * Wording that means the form itself refused. Deliberately narrow: "invalid" alone is not here
 * (it appears in perfectly ordinary page text, including this project's own `.invalid` fixture
 * hostnames), and neither is "error" alone.
 */
const FORM_ERROR_PHRASES: readonly RegExp[] = Object.freeze([
  /\b(?:this )?(?:field|answer|question) is required\b/i,
  /\brequired field\b/i,
  /\bplease (?:complete|fill in|fill out|correct|enter|provide|answer)\b/i,
  /\b(?:fix|correct) the (?:errors?|problems?) below\b/i,
  /\byour application (?:could not be|was not) (?:submitted|sent|received)\b/i,
  /\bsubmission failed\b/i,
  /\bwe could not (?:submit|process) your application\b/i,
]);

/** Error wording for a non-JSON response body, used only when the body does not parse as JSON. */
const RESPONSE_ERROR_PHRASES: readonly RegExp[] = Object.freeze([
  /\berror\b/i,
  /\bfailed\b/i,
  /\brejected\b/i,
  /\bnot (?:submitted|accepted|processed)\b/i,
]);

/** Keys a response payload uses to hand back a real application/confirmation identifier. */
const RESPONSE_REFERENCE_KEYS: readonly string[] = Object.freeze([
  'applicationId',
  'application_id',
  'confirmationId',
  'confirmation_id',
  'confirmationNumber',
  'confirmation_number',
  'receiptId',
  'receipt_id',
  'referenceId',
  'reference_id',
]);

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_EVIDENCE_REFERENCE_LENGTH ? `${collapsed.slice(0, MAX_EVIDENCE_REFERENCE_LENGTH - 3)}...` : collapsed;
}

function firstMatch(patterns: readonly RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a parsed response body carries an application-level error, independent of the HTTP
 * status that delivered it. This is the whole point of #271's fifth acceptance case: `200 OK` is a
 * statement about the transport, never about the application.
 */
function payloadErrorSignal(payload: Record<string, unknown>): string | undefined {
  if (payload.success === false) return 'payload reported success: false';
  if (payload.ok === false) return 'payload reported ok: false';
  const status = payload.status;
  if (typeof status === 'string' && /^(?:error|failed|failure|rejected|invalid)$/i.test(status)) {
    return `payload reported status: ${status}`;
  }
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) return `payload carried ${errors.length} application error(s)`;
  if (isNonEmptyRecord(errors) && Object.keys(errors).length > 0) {
    return `payload carried application errors for: ${Object.keys(errors).join(', ')}`;
  }
  const error = payload.error;
  if (typeof error === 'string' && error.trim().length > 0) return `payload carried an error: ${error}`;
  if (isNonEmptyRecord(error)) return 'payload carried an error object';
  return undefined;
}

function payloadReference(payload: Record<string, unknown>): string | undefined {
  for (const key of RESPONSE_REFERENCE_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return `${key}: ${value.trim()}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `${key}: ${value}`;
  }
  return undefined;
}

interface ResponseSignals {
  error: string | undefined;
  reference: string | undefined;
}

/**
 * Reads an observed response for the only two things that matter: does it say the application was
 * rejected, and does it hand back a real identifier. A body that parses as JSON is read
 * structurally; anything else falls back to the narrow error-wording list, and never contributes
 * positive evidence at all (an unparseable body is not a receipt).
 */
export function readResponseSignals(response: ObservedResponse): ResponseSignals {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    parsed = undefined;
  }

  if (isNonEmptyRecord(parsed)) {
    return { error: payloadErrorSignal(parsed), reference: payloadReference(parsed) };
  }

  const wording = firstMatch(RESPONSE_ERROR_PHRASES, response.body);
  return { error: wording ? `response body carried error wording: ${truncate(wording)}` : undefined, reference: undefined };
}

/**
 * The verdict, in a fixed order that makes the safety property structural rather than a matter of
 * which branch happened to be written first:
 *
 * 1. An application-level error in the observed response -- regardless of HTTP status.
 * 2. A structural or worded form error on the page itself.
 * 3. A confirmation phrase that is genuinely new since before the click, on a page that no longer
 *    stands the form.
 * 4. A receipt identifier (from the response, or from a page that no longer stands the form).
 * 5. Otherwise: unknown. Never `submitted`.
 *
 * `observedAt` is supplied by the caller rather than read from the clock here, so the timestamp
 * that lands in the durable evidence record is the same one the caller's own logic used.
 */
export function classifySubmissionOutcome(observation: SubmissionPageObservation, observedAt: string): SubmissionOutcomeReport {
  const { response } = observation;
  const responseSignals = response ? readResponseSignals(response) : undefined;

  if (responseSignals?.error) {
    return {
      outcome: 'rejected',
      reason: 'application_error_payload',
      // The HTTP status is named here on purpose: a `200` in this message is the whole point.
      detail: `HTTP ${response?.status ?? 0} was not accepted as delivery: ${truncate(responseSignals.error)}`,
      observedAt,
    };
  }

  const markerText = observation.errorMarkers.map((marker) => marker.trim()).filter((marker) => marker.length > 0);
  if (markerText.length > 0) {
    return {
      outcome: 'rejected',
      reason: 'form_validation_error',
      detail: `the form reported ${markerText.length} field error(s): ${truncate(markerText.join('; '))}`,
      observedAt,
    };
  }

  const wordedError = firstMatch(FORM_ERROR_PHRASES, observation.text);
  if (wordedError) {
    return {
      outcome: 'rejected',
      reason: 'form_validation_error',
      detail: `the page still reports an unresolved form error: ${truncate(wordedError)}`,
      observedAt,
    };
  }

  if (!observation.formStillPresent) {
    const confirmation = firstMatch(CONFIRMATION_PHRASES, observation.text);
    // Rule 3: a phrase that was already there before the click proves nothing about the click.
    if (confirmation && !firstMatch(CONFIRMATION_PHRASES, observation.baselineText)) {
      return {
        outcome: 'submitted',
        evidence: { kind: 'confirmation_page', reference: truncate(confirmation) },
        detail: 'the page replaced the application form with a confirmation this attempt had not shown before the click',
        observedAt,
      };
    }

    const pageReference = RECEIPT_REFERENCE_PATTERN.exec(observation.text);
    if (pageReference && !RECEIPT_REFERENCE_PATTERN.test(observation.baselineText)) {
      return {
        outcome: 'submitted',
        evidence: { kind: 'receipt_reference', reference: truncate(pageReference[0]) },
        detail: 'the page printed a receipt reference this attempt had not shown before the click',
        observedAt,
      };
    }
  }

  if (responseSignals?.reference) {
    return {
      outcome: 'submitted',
      evidence: { kind: 'delivery_receipt', reference: truncate(responseSignals.reference) },
      detail: `the observed response carried an application identifier (HTTP ${response?.status ?? 0})`,
      observedAt,
    };
  }

  return {
    outcome: 'unknown',
    reason: 'no_receipt_observed',
    detail: observation.formStillPresent
      ? 'the click completed but the application form is still standing and no receipt was observed'
      : 'the click completed but no confirmation or receipt could be observed',
    observedAt,
  };
}

/**
 * The delayed half of #271's fifth acceptance case: an acknowledgement that arrives after the
 * observation window has already closed and the attempt is sitting on `submission_unknown`.
 *
 * The same rules apply, minus any page: an error payload is still never delivery, and only a real
 * identifier reconciles the attempt. Deliberately cannot return `rejected` for "nothing useful in
 * here" -- silence is not proof of non-delivery any more than it is proof of delivery.
 */
export function classifyDelayedReceipt(response: ObservedResponse, observedAt: string): SubmissionOutcomeReport {
  const signals = readResponseSignals(response);
  if (signals.error) {
    return {
      outcome: 'rejected',
      reason: 'application_error_payload',
      detail: `HTTP ${response.status} was not accepted as delivery: ${truncate(signals.error)}`,
      observedAt,
    };
  }
  if (signals.reference) {
    return {
      outcome: 'submitted',
      evidence: { kind: 'delivery_receipt', reference: truncate(signals.reference) },
      detail: `a delayed receipt carried an application identifier (HTTP ${response.status})`,
      observedAt,
    };
  }
  return {
    outcome: 'unknown',
    reason: 'no_receipt_observed',
    detail: `HTTP ${response.status} carried neither an application identifier nor an application error`,
    observedAt,
  };
}
