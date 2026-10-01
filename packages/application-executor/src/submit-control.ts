import type { SnapshotSubmitControl } from './form-snapshot.js';

/**
 * Which of a snapshot's `submitControls` is the one that actually submits the application, as
 * opposed to a "Save as draft", "Back", or "Cancel" button that also happens to render as
 * `type="submit"` (or a plain `<button>`, which defaults to `type="submit"` per the HTML spec
 * whether or not the page intends it as the final action).
 *
 * This is the one click in the whole executor with no way back, so `resolveSubmitControl` is
 * deliberately conservative: it never guesses among multiple plausible candidates and never
 * assumes the sole button on a page is the right one just because it is the only button. It only
 * returns a control when exactly one candidate matches submit-shaped wording and none matches
 * non-submit wording -- anything else (zero matches, more than one, a tie) is `undefined`, and the
 * caller's job is to `handoff('unsupported_control')` rather than click blind.
 */
const SUBMIT_LABEL_PATTERN = /\b(submit|apply|send)\b/i;
const NON_SUBMIT_LABEL_PATTERN = /\b(cancel|back|clear|reset)\b|save\s*(as\s*)?draft|save\s*for\s*later/i;

export function resolveSubmitControl(controls: readonly SnapshotSubmitControl[]): SnapshotSubmitControl | undefined {
  const candidates = controls.filter(
    (control) => SUBMIT_LABEL_PATTERN.test(control.label) && !NON_SUBMIT_LABEL_PATTERN.test(control.label),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
