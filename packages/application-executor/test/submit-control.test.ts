import { describe, expect, it } from 'vitest';
import { resolveSubmitControl } from '../src/submit-control.js';
import type { SnapshotSubmitControl } from '../src/form-snapshot.js';

function control(controlRef: string, label: string): SnapshotSubmitControl {
  return { controlRef, label };
}

describe('resolveSubmitControl', () => {
  it('resolves the one control whose label reads as a real submit action', () => {
    const controls = [control('c1', 'Submit Application')];
    expect(resolveSubmitControl(controls)).toEqual(controls[0]);
  });

  it('matches "Apply" and "Send" wording too', () => {
    expect(resolveSubmitControl([control('c1', 'Apply Now')])).toEqual({ controlRef: 'c1', label: 'Apply Now' });
    expect(resolveSubmitControl([control('c1', 'Send my application')])).toEqual({ controlRef: 'c1', label: 'Send my application' });
  });

  it('refuses when there are zero plausible candidates', () => {
    expect(resolveSubmitControl([control('c1', 'Continue')])).toBeUndefined();
    expect(resolveSubmitControl([])).toBeUndefined();
  });

  it('refuses when more than one control reads as a plausible submit action, rather than guessing', () => {
    const controls = [control('c1', 'Submit'), control('c2', 'Apply')];
    expect(resolveSubmitControl(controls)).toBeUndefined();
  });

  it('excludes a control whose label matches "save as draft" wording even though it also says submit-ish things', () => {
    expect(resolveSubmitControl([control('c1', 'Save as draft')])).toBeUndefined();
    expect(resolveSubmitControl([control('c1', 'Save for later')])).toBeUndefined();
  });

  it('excludes cancel/back/clear/reset controls', () => {
    for (const label of ['Cancel', 'Back', 'Clear', 'Reset']) {
      expect(resolveSubmitControl([control('c1', label)])).toBeUndefined();
    }
  });

  it('picks the one real submit control out of a mixed set including a draft-save and a cancel button', () => {
    const controls = [control('c1', 'Save as draft'), control('c2', 'Cancel'), control('c3', 'Submit Application')];
    expect(resolveSubmitControl(controls)).toEqual(controls[2]);
  });

  it('is case-insensitive', () => {
    expect(resolveSubmitControl([control('c1', 'SUBMIT')])).toEqual({ controlRef: 'c1', label: 'SUBMIT' });
  });

  it('excludes a label that says both a submit word AND a non-submit word at once', () => {
    // Every other exclusion test uses a label that never matches SUBMIT_LABEL_PATTERN to begin
    // with ('Cancel', 'Save as draft', ...), so NON_SUBMIT_LABEL_PATTERN's own `&&` clause was
    // never actually exercised by this suite -- found during PR #214's own review. This is the one
    // case that clause exists for: a label containing both a submit-ish word and a non-submit-ish
    // one, which SUBMIT_LABEL_PATTERN alone would otherwise accept.
    expect(resolveSubmitControl([control('c1', 'Submit and Save as Draft')])).toBeUndefined();
  });
});
