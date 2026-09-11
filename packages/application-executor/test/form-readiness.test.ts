import { describe, expect, it } from 'vitest';
import { describeBlockers, evaluateFormReadiness, type LiveFieldState } from '../src/form-readiness.js';
import type { FormSnapshot, SnapshotField, VerifiedFieldState } from '../src/form-snapshot.js';

/**
 * The readiness rules in isolation (#277): no transport, no browser, no clock. Everything here is
 * about which facts are allowed to contribute to `verifiedFilledCount` and which ones must block.
 */

const FINGERPRINT = 'fingerprint-v1';

function field(overrides: Partial<SnapshotField> & { fieldRef: string }): SnapshotField {
  return {
    label: overrides.fieldRef,
    controlType: 'text',
    required: false,
    frameId: 0,
    active: true,
    ...overrides,
  };
}

function snapshot(fields: readonly SnapshotField[], overrides: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    generation: 3,
    fields,
    submitControls: [],
    capturedAt: '2026-01-01T00:00:00.000Z',
    challengeDetected: false,
    activeFrameId: 0,
    pageStateFingerprint: FINGERPRINT,
    ...overrides,
  };
}

function verification(overrides: Partial<VerifiedFieldState> & { fieldRef: string }): VerifiedFieldState {
  return {
    status: 'verified',
    intendedValue: 'x',
    committedValue: 'x',
    generation: 3,
    verifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function live(entries: Record<string, LiveFieldState>): Map<string, LiveFieldState> {
  return new Map(Object.entries(entries));
}

describe('evaluateFormReadiness', () => {
  it('is ready, with nothing verified, for a page whose only field is optional and empty', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1' })]),
      liveState: live({ f1: { value: '' } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.ready).toBe(true);
    expect(result.verifiedFilledCount).toBe(0);
    expect(result.discoveredFieldCount).toBe(1);
  });

  it('counts only verified writes as filled, never discovered fields and never mismatches', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1' }), field({ fieldRef: 'f2' }), field({ fieldRef: 'f3' })]),
      liveState: live({ f1: { value: 'a' }, f2: { value: 'wrong' }, f3: { value: '' } }),
      verifications: [
        verification({ fieldRef: 'f1' }),
        verification({ fieldRef: 'f2', status: 'mismatch' }),
        verification({ fieldRef: 'f3', status: 'unreadable' }),
      ],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.discoveredFieldCount).toBe(3);
    expect(result.verifiedFilledCount).toBe(1);
    expect(result.blockers.map((blocker) => blocker.kind).sort()).toEqual(['unverified_write', 'value_mismatch']);
  });

  it('ignores a verification from an earlier snapshot generation entirely', () => {
    // Those refs named controls in a page that has since been re-read. Counting them would let a
    // "verified" claim outlive the read it was made against.
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1' })]),
      liveState: live({ f1: { value: 'a' } }),
      verifications: [verification({ fieldRef: 'f1', generation: 2 })],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.verifiedFilledCount).toBe(0);
    expect(result.blockers).toEqual([]);
  });

  it('blocks an empty required text field', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1', label: 'Full name', required: true })]),
      liveState: live({ f1: { value: '   ' } }), // whitespace is not an answer
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ kind: 'required_field_empty', fieldRef: 'f1', label: 'Full name' }]);
    expect(result.requiredFieldsSatisfied).toBe(0);
  });

  it('blocks a required field that was never read at all, rather than assuming it is fine', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1', label: 'Full name', required: true })]),
      liveState: live({}),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.ready).toBe(false);
  });

  it('answers a required checkbox with its checked state, not with text', () => {
    const unchecked = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1', controlType: 'checkbox', required: true })]),
      liveState: live({ f1: { checked: false } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(unchecked.ready).toBe(false);

    const checked = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1', controlType: 'checkbox', required: true })]),
      liveState: live({ f1: { checked: true } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(checked.ready).toBe(true);
  });

  it('counts a same-name required radio group once, satisfied when any active member is checked', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([
        field({ fieldRef: 'remote', label: 'Remote', controlType: 'radio', name: 'workplace', required: true }),
        field({ fieldRef: 'hybrid', label: 'Hybrid', controlType: 'radio', name: 'workplace', required: true }),
        field({ fieldRef: 'office', label: 'On-site', controlType: 'radio', name: 'workplace', required: true }),
      ]),
      liveState: live({ remote: { checked: false }, hybrid: { checked: true }, office: { checked: false } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });

    expect(result.ready).toBe(true);
    expect(result.requiredFieldCount).toBe(1);
    expect(result.requiredFieldsSatisfied).toBe(1);
    expect(result.blockers).toEqual([]);
  });

  it('keeps same-name required radio groups separate across frames and forms', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([
        field({ fieldRef: 'topRemote', label: 'Remote', controlType: 'radio', name: 'workplace', required: true, frameId: 0, formScope: 1 }),
        field({ fieldRef: 'topHybrid', label: 'Hybrid', controlType: 'radio', name: 'workplace', required: true, frameId: 0, formScope: 1 }),
        field({ fieldRef: 'frameRemote', label: 'Remote', controlType: 'radio', name: 'workplace', required: true, frameId: 1, formScope: 1 }),
      ]),
      liveState: live({ topRemote: { checked: false }, topHybrid: { checked: true }, frameRemote: { checked: false } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });

    expect(result.ready).toBe(false);
    expect(result.requiredFieldCount).toBe(2);
    expect(result.requiredFieldsSatisfied).toBe(1);
    expect(result.blockers).toEqual([{ kind: 'required_field_empty', fieldRef: 'frameRemote', label: 'workplace' }]);
  });

  it('blocks a required file input with no attachment, as attachment_missing rather than empty', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1', label: 'Resume', controlType: 'file', required: true })]),
      liveState: live({ f1: { attachmentNames: [] } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.blockers).toEqual([{ kind: 'attachment_missing', fieldRef: 'f1', label: 'Resume' }]);
  });

  it('blocks a validation error on an optional field too, since the page still will not accept it', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1', label: 'Portfolio' })]),
      liveState: live({ f1: { value: 'not a url', invalid: true, validationMessage: 'Enter a valid URL.' } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ kind: 'validation_error', fieldRef: 'f1', label: 'Portfolio', message: 'Enter a valid URL.' }]);
  });

  it('blocks an invalid field the page gave no reason for, with a stated reason of its own', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1', label: 'Portfolio' })]),
      liveState: live({ f1: { value: 'x', invalid: true } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.blockers[0]).toMatchObject({ kind: 'validation_error', message: expect.stringContaining('without saying why') });
  });

  it('ignores inactive fields entirely, including their required-ness', () => {
    // A required field inside a hidden duplicate is not something anyone can answer; treating it as
    // a blocker would make such a page permanently un-submittable for the wrong reason.
    const result = evaluateFormReadiness({
      snapshot: snapshot([
        field({ fieldRef: 'f1', required: true }),
        field({ fieldRef: 'decoy', required: true, active: false, frameId: 1 }),
      ]),
      liveState: live({ f1: { value: 'answered' } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.ready).toBe(true);
    expect(result.discoveredFieldCount).toBe(1);
    expect(result.requiredFieldCount).toBe(1);
  });

  it('ignores structurally classified fields, whose emptiness is correct rather than a problem', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'pw', required: true, classification: 'credential_field' })]),
      liveState: live({}),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.ready).toBe(true);
    expect(result.discoveredFieldCount).toBe(0);
  });

  it('blocks on a fingerprint that no longer matches the snapshot under review', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1' })]),
      liveState: live({ f1: { value: 'a' } }),
      verifications: [],
      currentPageStateFingerprint: 'something-else',
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map((blocker) => blocker.kind)).toEqual(['stale_page_state']);
  });

  it('does not check freshness at all when no current fingerprint is supplied', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1' })]),
      liveState: live({ f1: { value: 'a' } }),
      verifications: [],
    });
    expect(result.ready).toBe(true);
  });

  it('blocks on a live challenge', () => {
    const result = evaluateFormReadiness({
      snapshot: snapshot([field({ fieldRef: 'f1' })], { challengeDetected: true }),
      liveState: live({ f1: { value: 'a' } }),
      verifications: [],
      currentPageStateFingerprint: FINGERPRINT,
    });
    expect(result.blockers.map((blocker) => blocker.kind)).toEqual(['challenge_detected']);
  });

  it('collects every blocker rather than stopping at the first', () => {
    // A person deciding whether to take the form over by hand needs the whole list.
    const result = evaluateFormReadiness({
      snapshot: snapshot([
        field({ fieldRef: 'f1', label: 'Name', required: true }),
        field({ fieldRef: 'f2', label: 'Resume', controlType: 'file', required: true }),
      ]),
      liveState: live({ f1: { value: '' }, f2: { attachmentNames: [] } }),
      verifications: [],
      currentPageStateFingerprint: 'changed',
    });
    expect(result.blockers.map((blocker) => blocker.kind).sort()).toEqual([
      'attachment_missing',
      'required_field_empty',
      'stale_page_state',
    ]);
  });
});

describe('describeBlockers', () => {
  it('names every blocker without ever quoting a committed value', () => {
    const described = describeBlockers([
      { kind: 'required_field_empty', fieldRef: 'f1', label: 'Full name' },
      { kind: 'validation_error', fieldRef: 'f2', label: 'Email', message: 'Enter a valid email.' },
      { kind: 'value_mismatch', fieldRef: 'f3', label: 'Phone' },
      { kind: 'unverified_write', fieldRef: 'f4', label: 'Notes' },
      { kind: 'attachment_missing', fieldRef: 'f5', label: 'Resume' },
      { kind: 'stale_page_state', detail: 'the page changed' },
      { kind: 'challenge_detected' },
    ]);
    expect(described).toContain('required field "Full name" is empty');
    expect(described).toContain('"Email" has a validation error: Enter a valid email.');
    expect(described).toContain('"Phone" does not hold what was written to it');
    expect(described).toContain('"Notes" was written to but its committed value could not be read back');
    expect(described).toContain('required upload "Resume" has no attachment');
    expect(described).toContain('the page changed');
    expect(described).toContain('CAPTCHA');
  });

  it('is empty for no blockers', () => {
    expect(describeBlockers([])).toBe('');
  });
});
