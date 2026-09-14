import { createHash, randomBytes } from 'node:crypto';

/**
 * The structured field inventory the `snapshot` action produces, and the closed set every
 * `FieldMap` (`field-map.ts`) is validated against. Mints `fieldRef`/`optionRef` identifiers --
 * opaque, valid only within one attempt and one snapshot generation, matching the exact shapes
 * `field-map.ts`'s regexes expect (`f`/`o` + 16 hex chars).
 *
 * A snapshot generation increments every time the page is re-read (a fresh `snapshot` call): a
 * field map produced against an earlier generation is stale and must be refused by Domain B
 * (validate.ts's rule 2), the same way `workspace-grant.ts` invalidates a grant on navigation.
 */

export type FieldControlType = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file' | 'unknown';

/** Structural classification of a field the executor must never let a field map assign to,
 * regardless of what the generation session proposes (#196 §1.2, §2.4 rule 8). Detected from the
 * DOM itself (input type, autocomplete token, ARIA label patterns) -- never inferred from prose. */
export type FieldClassification = 'credential_field' | 'consent_field';

export interface SnapshotOption {
  optionRef: string;
  label: string;
}

/** A `<button>` (default-submit or explicit `type="submit"`) or `<input type="submit">` found
 * anywhere on the page at snapshot time. Deliberately not a `SnapshotField`: it is never a target
 * for `fill`/`select`/`attach`, and a field map (`field-map.ts`) never assigns anything to it --
 * the only action that ever targets a `controlRef` is `submit()` itself, chosen by
 * `submit-control.ts`'s `resolveSubmitControl`, never by the LLM generation session. */
export interface SnapshotSubmitControl {
  controlRef: string;
  label: string;
}

export interface SnapshotField {
  fieldRef: string;
  label: string;
  controlType: FieldControlType;
  /** DOM `name`, when present. Radio groups use this with frame/form scope for required-state checks. */
  name?: string;
  required: boolean;
  /** Present only for `select`/`radio` controls. */
  options?: readonly SnapshotOption[];
  /** Present only when the field was structurally classified as excluded. */
  classification?: FieldClassification;
  /** Present only for `checkbox` controls: whether the DOM's own `checked` attribute was set at
   * snapshot time. Read so `fill()` can toggle a checkbox in *either* direction -- without it, a
   * checkbox that started pre-checked could never be unchecked (a real gap found during #201's
   * review: `fill()` used to assume every checkbox starts unchecked). */
  checked?: boolean;
  /**
   * Which document this field was extracted from: `0` is the top-level document, and every pierced
   * `<iframe>` gets its own id (#277). Part of a field's *identity*, not decoration: a page that
   * embeds two copies of the same application form (one live, one a hidden decoy, or a stale
   * previously-rendered step still in the DOM) produces two fields with identical labels, and the
   * only thing distinguishing them is the frame and form they live in.
   */
  frameId: number;
  /** The `backendNodeId` of the nearest enclosing `<form>`, or `undefined` for a field that is not
   * inside one. The second half of a field's identity, alongside `frameId` -- see above. */
  formScope?: number;
  /**
   * Whether this field belongs to the one frame/form pair the snapshot resolved as active (#277).
   * `false` means the field was found on the page but is not part of the form a person is actually
   * looking at: a duplicate in a hidden frame, a decoy copy, an unrelated newsletter form.
   * `fill`/`select`/`attach` refuse a field with `active: false`, and `validate.ts` refuses a field
   * map that targets one -- "we found a field with the right label" has never been sufficient
   * evidence that it is the field the applicant would have typed into.
   */
  active: boolean;
  /**
   * Whether the browser actually laid this field out, resolved via `DOM.getContentQuads` (#277).
   * `undefined` when no rendering probe was run for this field -- the probe only runs when the page
   * is genuinely ambiguous (more than one frame/form group holds fields), so an ordinary
   * single-form page pays no extra CDP round trips. Never conflate `undefined` with `false`: the
   * former is "not asked", the latter is "asked, and the browser rendered nothing".
   */
  rendered?: boolean;
  /**
   * A validation message the page itself is currently showing for this field, read from the DOM at
   * snapshot time: the text of whatever `aria-errormessage` (or, for a control the page marked
   * `aria-invalid`, `aria-describedby`) points at. Untrusted third-party page text, carried as data
   * for a person to read and for `form-readiness.ts` to treat as a blocker -- never interpreted,
   * never matched against anything that decides which CDP command runs next.
   */
  validationMessage?: string;
  /** Whether the page marked this control `aria-invalid` at snapshot time. */
  invalid?: boolean;
}

export interface FormSnapshot {
  generation: number;
  fields: readonly SnapshotField[];
  /** Every submit-shaped button/input found on the page, unfiltered -- `submit-control.ts`'s
   * `resolveSubmitControl` is what narrows this to the one real "submit this application" control,
   * or refuses when the page has none or more than one plausible candidate. */
  submitControls: readonly SnapshotSubmitControl[];
  /** ISO-8601 */
  capturedAt: string;
  /** Whether a known CAPTCHA/bot-detection widget was found anywhere on the page at snapshot time.
   * A caller must treat this as an immediate `handoff('captcha')` signal -- see
   * `dom-extract.ts`'s `extractSnapshotFields` for what is and isn't detected. */
  challengeDetected: boolean;
  /** The frame every `active` field was found in (#277). `0` is the top-level document. */
  activeFrameId: number;
  /** The `<form>` (by `backendNodeId`) every `active` field was found in, or `undefined` when the
   * active fields are not inside a `<form>` element at all -- a real and common shape on a
   * JS-driven application page, and deliberately distinct from "no active form resolved". */
  activeFormScope?: number;
  /**
   * A fingerprint of the page's own observable form state at the moment this snapshot was read
   * (#277): every field's identity, type, required-ness, active/rendered status and currently
   * displayed validation message, plus the submit controls and the challenge flag. Never a typed
   * value -- this answers "did the page change under us?", not "what did we type?".
   *
   * This is the freshness token `executor.ts`'s readiness evaluation compares a fresh read against
   * before a submission is allowed to proceed. A page that grew a new required field, started
   * showing a validation error, swapped its form out, or raised a challenge since a person last
   * looked at it produces a different fingerprint, and readiness refuses rather than submitting
   * against state nobody reviewed.
   */
  pageStateFingerprint: string;
}

/** Why a read-back of one field's committed state ended the way it did (#277). */
export type FieldVerificationStatus =
  /** The control's committed state was read back and matches what the executor wrote. */
  | 'verified'
  /** The read-back succeeded, but the control does not hold what the executor wrote -- a
   * controlled input that rejected or rewrote the value, a select that did not move, a truncating
   * `maxlength`, a field the page reset. Never silently retried: this is a reportable state. */
  | 'mismatch'
  /** The browser exposed no committed state for this control, so nothing can be claimed about it.
   * Deliberately not the same as `mismatch` (which is a positive finding) or `verified`. */
  | 'unreadable';

/**
 * What one field's control *actually holds*, read back out of the browser after a write (#277).
 *
 * The distinction this type exists to enforce: issuing `Input.insertText` proves a command was
 * sent, not that a value was committed. Only a record of this shape, with `status: 'verified'`,
 * is evidence that a field was genuinely filled -- a screenshot is not, and neither is the
 * number of fields a snapshot happened to discover.
 */
export interface VerifiedFieldState {
  fieldRef: string;
  status: FieldVerificationStatus;
  /** What the executor asked the control to hold. */
  intendedValue: string;
  /** What the control reports holding now, as read back from the browser. */
  committedValue: string;
  /** Present for checkbox/radio controls: the committed checked state. */
  checked?: boolean;
  /** Present for file inputs: the attachment names the control itself reports, so "the upload
   * landed" is a read fact rather than an assumption that `DOM.setFileInputFiles` resolved. */
  attachmentNames?: readonly string[];
  /** A validation message the browser or page is showing for this control after the write. */
  validationMessage?: string;
  /** The snapshot generation this verification was performed against. A verification from an
   * earlier generation describes a page that has since been re-read, and is never reused. */
  generation: number;
  /** ISO-8601 */
  verifiedAt: string;
}

function mintRef(prefix: 'f' | 'o' | 'c'): string {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

export function mintFieldRef(): string {
  return mintRef('f');
}

export function mintOptionRef(): string {
  return mintRef('o');
}

export function mintSubmitControlRef(): string {
  return mintRef('c');
}

/**
 * The page-state half of a `FormSnapshot`, before the snapshot object itself exists -- what
 * `pageStateFingerprint` is computed over. `executor.ts` builds one of these from a fresh DOM read
 * to ask "is the page still what it was?" without minting a whole new snapshot generation (which
 * would invalidate every field ref a person is currently reviewing).
 */
export interface PageStateFingerprintInput {
  fields: readonly Omit<SnapshotField, 'fieldRef' | 'options'>[];
  submitControlLabels: readonly string[];
  challengeDetected: boolean;
  activeFrameId: number;
  activeFormScope?: number;
}

/**
 * A deterministic fingerprint of the page's own form state (#277). Deliberately excludes every
 * minted ref (`fieldRef`/`optionRef`/`controlRef` are random per snapshot, so including them would
 * make every read differ from every other) and every typed value (this detects a page changing
 * under us, not what an applicant entered).
 *
 * Each field is JSON-encoded individually before being sorted and hashed, for the same reason
 * `application-review-session.ts`'s `computeFormStructureHash` does it: labels and validation
 * messages are unsanitized third-party page text and can contain whatever delimiter a naive join
 * would have used, which would let two genuinely different pages fingerprint identically.
 */
export function computePageStateFingerprint(input: PageStateFingerprintInput): string {
  const fields = input.fields
    .map((field) =>
      JSON.stringify([
        field.label,
        field.controlType,
        field.name ?? null,
        field.required,
        field.classification ?? null,
        field.frameId,
        field.formScope ?? null,
        field.active,
        field.rendered ?? null,
        field.validationMessage ?? null,
        field.invalid ?? null,
      ]),
    )
    .sort();
  const payload = JSON.stringify({
    fields,
    submitControlLabels: [...input.submitControlLabels].sort(),
    challengeDetected: input.challengeDetected,
    activeFrameId: input.activeFrameId,
    activeFormScope: input.activeFormScope ?? null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/** Looks up one field by ref within a snapshot. Returns `undefined` for a ref from a different
 * snapshot generation or a different attempt entirely -- the caller (`validate.ts`) is what turns
 * that into a refusal, not this lookup. */
export function findSnapshotField(snapshot: FormSnapshot, fieldRef: string): SnapshotField | undefined {
  return snapshot.fields.find((field) => field.fieldRef === fieldRef);
}

export function findSnapshotOption(field: SnapshotField, optionRef: string): SnapshotOption | undefined {
  return field.options?.find((option) => option.optionRef === optionRef);
}

export function findSnapshotSubmitControl(snapshot: FormSnapshot, controlRef: string): SnapshotSubmitControl | undefined {
  return snapshot.submitControls.find((control) => control.controlRef === controlRef);
}
