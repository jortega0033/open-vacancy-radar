import type { FormSnapshot, SnapshotField, VerifiedFieldState } from './form-snapshot.js';

/**
 * The one place "is this application actually ready to submit?" is answered (#277), and the one
 * place the difference between *discovered*, *written to*, and *verified* is made structural rather
 * than a matter of wording.
 *
 * Before this existed, the review path counted the fields a snapshot happened to find and described
 * them as filled. A field inventory is evidence that a form exists. A screenshot is evidence that a
 * page rendered. Neither is evidence that a value was committed, and this module never lets either
 * one contribute to `verifiedFilledCount`: only a `VerifiedFieldState` with `status: 'verified'`,
 * produced by reading a control's committed state back out of the browser, counts.
 *
 * Pure: no CDP transport, no I/O, no clock. `executor.ts` gathers the live reads and hands them
 * here, so every rule below is unit-testable against hand-built state.
 */

export type ReadinessBlocker =
  /** A required field holds nothing. The single most common way an "applied" application is
   * silently incomplete. */
  | { kind: 'required_field_empty'; fieldRef: string; label: string }
  /** The page is showing a validation error for this field. `message` is untrusted page text,
   * carried for a person to read. */
  | { kind: 'validation_error'; fieldRef: string; label: string; message: string }
  /** A field the executor wrote to does not hold what was written -- a controlled input that
   * rejected the value, a select that did not move, a truncating `maxlength`. */
  | { kind: 'value_mismatch'; fieldRef: string; label: string }
  /** The executor wrote to this field but could not read any committed state back, so nothing can
   * be claimed about it either way. */
  | { kind: 'unverified_write'; fieldRef: string; label: string }
  /** A required file input reports no attachment, or an attach whose file name never came back. */
  | { kind: 'attachment_missing'; fieldRef: string; label: string }
  /** The page's own observable form state changed since the snapshot under review was taken: a new
   * required field, a validation error that has appeared, the form replaced, a challenge raised.
   * Nothing about the reviewed state describes the live page any more. */
  | { kind: 'stale_page_state'; detail: string }
  /** A CAPTCHA/bot-detection challenge is live on the page. */
  | { kind: 'challenge_detected' };

export interface FormReadiness {
  /** True only when there are no blockers at all. */
  ready: boolean;
  /**
   * Fields whose committed value was read back out of the browser and matched what was written.
   * This is the number a review UI may honestly describe as "filled".
   */
  verifiedFilledCount: number;
  /**
   * Fields the snapshot found on the active form. Emphatically NOT a count of filled fields --
   * kept as its own separate number precisely so no caller can reach for it by accident when it
   * means `verifiedFilledCount`.
   */
  discoveredFieldCount: number;
  /** Required fields on the active form. */
  requiredFieldCount: number;
  /** Required fields whose committed value was read back and is non-empty. */
  requiredFieldsSatisfied: number;
  blockers: readonly ReadinessBlocker[];
}

export interface EvaluateFormReadinessInput {
  snapshot: FormSnapshot;
  /** The live committed state of every active field, keyed by `fieldRef`, as read back right now.
   * A field missing from this map was not read at all. */
  liveState: ReadonlyMap<string, LiveFieldState>;
  /** Every read-back the executor recorded for its own writes during this snapshot generation. */
  verifications: readonly VerifiedFieldState[];
  /** The fingerprint of a fresh read of the page, to compare against the snapshot's own. Omit only
   * when freshness is deliberately not being checked -- every submission path must pass it. */
  currentPageStateFingerprint?: string;
}

/** What one field's control holds right now, independent of whether this executor ever wrote to it
 * (a person may have typed into it themselves during a live handoff). */
export interface LiveFieldState {
  /** `undefined` means the browser published no value for this control at all. */
  value?: string;
  checked?: boolean;
  invalid?: boolean;
  validationMessage?: string;
  attachmentNames?: readonly string[];
}

interface RadioGroupReadiness {
  fieldRef: string;
  label: string;
  satisfied: boolean;
}

/** Whether a control holding `state` counts as answered. A checkbox/radio answers with its checked
 * state, not with text; every other control answers with a non-blank value. */
function isAnswered(field: SnapshotField, state: LiveFieldState | undefined): boolean {
  if (!state) return false;
  if (field.controlType === 'checkbox' || field.controlType === 'radio') {
    return state.checked === true;
  }
  if (field.controlType === 'file') {
    return (state.attachmentNames ?? []).length > 0;
  }
  return (state.value ?? '').trim().length > 0;
}

function radioGroupKey(field: SnapshotField): string {
  return JSON.stringify([field.frameId, field.formScope ?? null, field.name ?? field.fieldRef]);
}

/**
 * Evaluates readiness over one snapshot plus a live read of it.
 *
 * Only `active` fields are considered (see `SnapshotField.active`): a required field sitting in a
 * hidden duplicate form is not something a person can answer, and treating it as a blocker would
 * make every such page permanently un-submittable for the wrong reason. Structurally classified
 * fields (credential/consent) are excluded too -- this executor never fills them by design, so
 * their emptiness is correct rather than a blocker.
 *
 * Every blocker is collected rather than short-circuiting on the first: a person deciding whether
 * to take over a form manually needs the whole list, not the first item of it.
 */
export function evaluateFormReadiness(input: EvaluateFormReadinessInput): FormReadiness {
  const { snapshot, liveState } = input;
  const blockers: ReadinessBlocker[] = [];

  if (
    input.currentPageStateFingerprint !== undefined &&
    input.currentPageStateFingerprint !== snapshot.pageStateFingerprint
  ) {
    blockers.push({
      kind: 'stale_page_state',
      detail: 'the page changed since the snapshot under review was taken, so nothing reviewed describes it any more',
    });
  }

  if (snapshot.challengeDetected) blockers.push({ kind: 'challenge_detected' });

  const activeFields = snapshot.fields.filter((field) => field.active && !field.classification);
  let requiredFieldCount = 0;
  let requiredFieldsSatisfied = 0;
  const requiredRadioGroups = new Map<string, RadioGroupReadiness>();

  for (const field of activeFields) {
    const state = liveState.get(field.fieldRef);
    const answered = isAnswered(field, state);

    if (field.required) {
      if (field.controlType === 'radio') {
        const key = radioGroupKey(field);
        const group = requiredRadioGroups.get(key);
        if (group) {
          group.satisfied = group.satisfied || answered;
        } else {
          requiredRadioGroups.set(key, { fieldRef: field.fieldRef, label: field.name ?? field.label, satisfied: answered });
        }
      } else if (field.controlType === 'file') {
        requiredFieldCount += 1;
        if (answered) requiredFieldsSatisfied += 1;
        else blockers.push({ kind: 'attachment_missing', fieldRef: field.fieldRef, label: field.label });
      } else {
        requiredFieldCount += 1;
        if (answered) requiredFieldsSatisfied += 1;
        else blockers.push({ kind: 'required_field_empty', fieldRef: field.fieldRef, label: field.label });
      }
    }

    // A validation message is a blocker on any field, required or not: a page showing an error on
    // an optional field is still a page telling the applicant it will not accept what is there.
    const message = state?.validationMessage ?? field.validationMessage;
    if (message) {
      blockers.push({ kind: 'validation_error', fieldRef: field.fieldRef, label: field.label, message });
    } else if (state?.invalid === true || (state === undefined && field.invalid === true)) {
      blockers.push({
        kind: 'validation_error',
        fieldRef: field.fieldRef,
        label: field.label,
        message: 'the page marked this field invalid without saying why',
      });
    }
  }

  for (const group of requiredRadioGroups.values()) {
    requiredFieldCount += 1;
    if (group.satisfied) {
      requiredFieldsSatisfied += 1;
    } else {
      blockers.push({ kind: 'required_field_empty', fieldRef: group.fieldRef, label: group.label });
    }
  }

  // Only verifications from this exact snapshot generation mean anything: an earlier generation
  // describes a page that has since been re-read, and its refs no longer identify these controls.
  const activeRefs = new Set(activeFields.map((field) => field.fieldRef));
  const currentVerifications = input.verifications.filter(
    (verification) => verification.generation === snapshot.generation && activeRefs.has(verification.fieldRef),
  );

  let verifiedFilledCount = 0;
  for (const verification of currentVerifications) {
    const field = activeFields.find((candidate) => candidate.fieldRef === verification.fieldRef);
    if (!field) continue;
    if (verification.status === 'verified') {
      verifiedFilledCount += 1;
      continue;
    }
    if (verification.status === 'mismatch') {
      blockers.push({ kind: 'value_mismatch', fieldRef: field.fieldRef, label: field.label });
    } else {
      blockers.push({ kind: 'unverified_write', fieldRef: field.fieldRef, label: field.label });
    }
  }

  return {
    ready: blockers.length === 0,
    verifiedFilledCount,
    discoveredFieldCount: activeFields.length,
    requiredFieldCount,
    requiredFieldsSatisfied,
    blockers,
  };
}

/**
 * How long a summary this function will ever produce (#277).
 *
 * Its output becomes a refusal `detail`, which on the automatic path ends up in a desktop
 * notification body. Labels and validation messages are page-authored text and are already bounded
 * individually where they are read, but a page with a hundred fields could still assemble a very
 * long summary out of individually reasonable pieces.
 */
const MAX_BLOCKER_SUMMARY_LENGTH = 1000;

/** A short, non-sensitive summary of why readiness refused, for a refusal `detail` string. Never
 * includes a committed value -- only labels and validation text the page itself is already
 * displaying to the person looking at it, bounded in total. */
export function describeBlockers(blockers: readonly ReadinessBlocker[]): string {
  const summary = blockers
    .map((blocker) => {
      switch (blocker.kind) {
        case 'required_field_empty':
          return `required field "${blocker.label}" is empty`;
        case 'validation_error':
          return `"${blocker.label}" has a validation error: ${blocker.message}`;
        case 'value_mismatch':
          return `"${blocker.label}" does not hold what was written to it`;
        case 'unverified_write':
          return `"${blocker.label}" was written to but its committed value could not be read back`;
        case 'attachment_missing':
          return `required upload "${blocker.label}" has no attachment`;
        case 'stale_page_state':
          return blocker.detail;
        case 'challenge_detected':
          return 'the page has an active CAPTCHA/bot-detection challenge';
      }
    })
    .join('; ');
  return summary.length > MAX_BLOCKER_SUMMARY_LENGTH ? `${summary.slice(0, MAX_BLOCKER_SUMMARY_LENGTH)}...` : summary;
}
