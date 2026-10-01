// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FieldMap, FormSnapshot, SnapshotField } from '@agent-dock/application-executor';
import {
  buildApplicationValueTable,
  buildFieldMapGenerationPrompt,
  sanitiseGeneratedFieldMap,
  summarisePreparedFields,
} from '../electron/application-value-table.js';

/**
 * Unit coverage for the closed value table, the prompt built from it, and the narrowing that
 * decides which of a generation session's proposals this app is willing to commit (#272).
 *
 * These are unit tests of the pieces. `application-pipeline.test.ts` is the one that runs all of it
 * together through the production entry point, and says so explicitly.
 */

const CV_CONTACT = {
  name: 'Jamie Rivera',
  title: 'Senior Engineer',
  location: 'Amsterdam',
  email: 'jamie@example.invalid',
  phone: '+31 6 1234 5678',
  links: ['https://www.linkedin.com/in/jamie-rivera', 'https://github.com/jamie', 'https://jamie.example.invalid'],
};

const PROFILE = {
  candidateName: 'J. Rivera',
  currentRole: 'Staff Engineer',
  location: 'Rotterdam',
  professionalLanguage: 'English, Dutch',
};

function labelled(entries: ReturnType<typeof buildApplicationValueTable>, label: string) {
  return entries.find((entry) => entry.label === label);
}

function field(overrides: Partial<SnapshotField> & { fieldRef: string; label: string; controlType: SnapshotField['controlType']; required: boolean }): SnapshotField {
  return { frameId: 0, active: true, ...overrides };
}

describe('buildApplicationValueTable', () => {
  it('offers only details a reviewed record actually holds', () => {
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: PROFILE });

    expect(labelled(entries, 'Full name')).toMatchObject({ value: 'Jamie Rivera', provenance: 'cv' });
    expect(labelled(entries, 'Email address')).toMatchObject({ value: 'jamie@example.invalid', provenance: 'cv' });
    expect(labelled(entries, 'LinkedIn profile URL')).toMatchObject({ value: 'https://www.linkedin.com/in/jamie-rivera' });
    expect(labelled(entries, 'GitHub profile URL')).toMatchObject({ value: 'https://github.com/jamie' });
    expect(labelled(entries, 'Working languages')).toMatchObject({ value: 'English, Dutch', provenance: 'profile' });

    // The third link is neither LinkedIn nor GitHub, and is not offered under either name.
    expect(entries.map((entry) => entry.value)).not.toContain('https://jamie.example.invalid');
  });

  it('mints a distinct, well-formed valueRef for every entry', () => {
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: PROFILE });
    for (const entry of entries) expect(entry.valueRef).toMatch(/^v[0-9a-f]{16}$/u);
    expect(new Set(entries.map((entry) => entry.valueRef)).size).toBe(entries.length);
  });

  it('prefers the reviewed CV over an older profile value for the same fact', () => {
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: PROFILE });
    expect(labelled(entries, 'Full name')?.value).toBe('Jamie Rivera');
    expect(labelled(entries, 'Current location')?.value).toBe('Amsterdam');
    expect(entries.filter((entry) => entry.label === 'Full name')).toHaveLength(1);
  });

  it('falls back to the profile only for facts the CV does not carry', () => {
    const entries = buildApplicationValueTable({
      cvContact: { ...CV_CONTACT, name: '', location: '   ', links: [] },
      profile: PROFILE,
    });
    expect(labelled(entries, 'Full name')).toMatchObject({ value: 'J. Rivera', provenance: 'profile' });
    expect(labelled(entries, 'Current location')).toMatchObject({ value: 'Rotterdam', provenance: 'profile' });
    expect(labelled(entries, 'LinkedIn profile URL')).toBeUndefined();
  });

  it('defaults nothing at all when neither source is configured', () => {
    expect(buildApplicationValueTable({ cvContact: null, profile: null })).toEqual([]);
  });
});

describe('buildFieldMapGenerationPrompt', () => {
  const snapshot: FormSnapshot = {
    generation: 3,
    fields: [
      field({ fieldRef: 'f1111111111111111', label: 'fullName', controlType: 'text', required: true }),
      field({ fieldRef: 'f2222222222222222', label: 'agreeToTerms', controlType: 'checkbox', required: true, classification: 'consent_field' }),
    ],
    submitControls: [{ controlRef: 'c1111111111111111', label: 'Submit Application' }],
    capturedAt: '2026-09-11T12:00:00.000Z',
    challengeDetected: false,
    activeFrameId: 0,
    pageStateFingerprint: 'fingerprint',
  };

  it('names every field and every value, and pins the attempt and generation', () => {
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: null });
    const prompt = buildFieldMapGenerationPrompt({ attemptId: 'attempt-1', snapshot, valueTable: entries });

    expect(prompt).toContain('ref: f1111111111111111, label: "fullName", type: text, required: true');
    expect(prompt).toContain('excluded: consent_field');
    expect(prompt).toContain(`- ${entries[0]!.valueRef}: Full name`);
    expect(prompt).toContain('"attemptId" must be exactly "attempt-1"');
    expect(prompt).toContain('"snapshotGeneration" exactly 3');
  });

  it('never sends the value itself, only what it is', () => {
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: PROFILE });
    const prompt = buildFieldMapGenerationPrompt({ attemptId: 'attempt-1', snapshot, valueTable: entries });
    for (const entry of entries) expect(prompt).not.toContain(entry.value);
  });

  it('is deterministic for the same snapshot and value table', () => {
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: PROFILE });
    const first = buildFieldMapGenerationPrompt({ attemptId: 'attempt-1', snapshot, valueTable: entries });
    const second = buildFieldMapGenerationPrompt({ attemptId: 'attempt-1', snapshot, valueTable: entries });
    expect(first).toBe(second);
  });

  it('tells the session which fields live in a different frame, so it can avoid an assignment Domain B will refuse anyway (draft-cross-origin-ipc-bridge-visibility)', () => {
    // Reuses the shape from `application-executor`'s `cross-origin-frame-fill.test.ts`: a
    // same-origin required field on the real form, plus an inactive field the executor found in
    // a third-party widget's frame and would refuse to write into.
    const crossOriginSnapshot: FormSnapshot = {
      ...snapshot,
      topFrameOrigin: 'https://careers.employer.invalid',
      fields: [
        ...snapshot.fields,
        field({
          fieldRef: 'f3333333333333333',
          label: 'visitorEmail',
          controlType: 'text',
          required: false,
          active: false,
          frameId: 1,
          frameOrigin: 'https://chat.vendor.invalid',
        }),
      ],
    };
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: null });
    const prompt = buildFieldMapGenerationPrompt({ attemptId: 'attempt-1', snapshot: crossOriginSnapshot, valueTable: entries });

    expect(prompt).toContain(
      'ref: f3333333333333333, label: "visitorEmail", type: text, required: false, frame origin: https://chat.vendor.invalid (not this page\'s own origin, and not part of the active form)',
    );
    expect(prompt).toContain('Never assign anything to a field carrying a "frame origin" note');
    // The employer's own field carries no such annotation: only a field whose `frameOrigin`
    // actually differs from `topFrameOrigin` gets one, active or not.
    expect(prompt).toContain('ref: f1111111111111111, label: "fullName", type: text, required: true');
    expect(prompt).not.toContain('ref: f1111111111111111, label: "fullName", type: text, required: true, frame origin');
  });

  it('flags the whole form when the only fields on the page are in one disallowed embed, even though every one of them is active', () => {
    // The zero-eligible-group page, and the exact state the real executor produces for it:
    // `resolveActiveGroup` filters the page's field groups through `isFrameFillAllowed`, finds
    // none eligible, and falls back to the count-based dominant group anyway
    // (`executor.ts`: `if (eligible.length === 0) return fallback;`), so `readPageState` marks
    // the vendor's fields `active: true` with the vendor's own `frameOrigin`. Nothing here is
    // same-origin: the top document holds no form of its own.
    //
    // Keying the annotation on `!field.active` made this page silently unannotated, which is
    // worse here than anywhere else: the session would map values onto every one of these
    // fields and `fill()` would refuse the first of them at `requireFillableFrame`, part-way
    // through applying the map.
    const embeddedOnlySnapshot: FormSnapshot = {
      ...snapshot,
      topFrameOrigin: 'https://careers.employer.invalid',
      activeFrameId: 1,
      fields: [
        field({ fieldRef: 'f4444444444444444', label: 'fullName', controlType: 'text', required: true, active: true, frameId: 1, frameOrigin: 'https://boards.ats-vendor.invalid' }),
        field({ fieldRef: 'f5555555555555555', label: 'email', controlType: 'text', required: true, active: true, frameId: 1, frameOrigin: 'https://boards.ats-vendor.invalid' }),
      ],
    };
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: null });
    const prompt = buildFieldMapGenerationPrompt({ attemptId: 'attempt-1', snapshot: embeddedOnlySnapshot, valueTable: entries });

    for (const ref of ['f4444444444444444', 'f5555555555555555']) {
      expect(prompt).toContain(
        `ref: ${ref}, label: ${ref === 'f4444444444444444' ? '"fullName"' : '"email"'}, type: text, required: true, frame origin: https://boards.ats-vendor.invalid (not this page's own origin: the form found here is inside a third-party embed)`,
      );
    }
    expect(prompt).toContain('Never assign anything to a field carrying a "frame origin" note');
    // The wording for an active field says the form itself is embedded, not that the field is
    // "not part of the active form" -- it is the active form, and saying otherwise would be a
    // plainly false statement about the page.
    expect(prompt).not.toContain('not part of the active form');
  });

  it('never annotates a field with a frame origin when the snapshot never carries a topFrameOrigin to judge it against', () => {
    // `topFrameOrigin` is itself optional (a read that established no baseline) -- absent one, a
    // field's own `frameOrigin` cannot be judged against anything, so nothing is flagged even for
    // an inactive field that does carry one.
    const entries = buildApplicationValueTable({ cvContact: CV_CONTACT, profile: null });
    const prompt = buildFieldMapGenerationPrompt({
      attemptId: 'attempt-1',
      snapshot: {
        ...snapshot,
        fields: [
          ...snapshot.fields,
          field({ fieldRef: 'f3333333333333333', label: 'x', controlType: 'text', required: false, active: false, frameOrigin: 'https://chat.vendor.invalid' }),
        ],
      },
      valueTable: entries,
    });
    expect(prompt).not.toContain(', frame origin:');
  });
});

describe('sanitiseGeneratedFieldMap', () => {
  const base: FieldMap = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    snapshotGeneration: 1,
    assignments: [
      { fieldRef: 'f1111111111111111', source: { kind: 'value', valueRef: 'v1111111111111111' } },
      { fieldRef: 'f2222222222222222', source: { kind: 'artifact', artifactId: '22222222-2222-4222-8222-222222222222' } },
      { fieldRef: 'f3333333333333333', source: { kind: 'option', optionRef: 'o3333333333333333' } },
    ],
    unmapped: [{ fieldRef: 'f4444444444444444', reason: 'needs_user' }],
  };

  it('keeps value and artifact assignments, but removes option choices this app will not commit', () => {
    const result = sanitiseGeneratedFieldMap(base, { generation: 1, fields: [], submitControls: [], capturedAt: '', challengeDetected: false, activeFrameId: 0, pageStateFingerprint: '' });
    expect(result.fieldMap.assignments).toEqual([base.assignments[0], base.assignments[1]]);
    expect(result.uploadFieldRefs).toEqual(['f2222222222222222']);
    expect(result.optionFieldRefs).toEqual(['f3333333333333333']);
  });

  it('moves each removed option into unmapped rather than dropping it silently', () => {
    const result = sanitiseGeneratedFieldMap(base, { generation: 1, fields: [], submitControls: [], capturedAt: '', challengeDetected: false, activeFrameId: 0, pageStateFingerprint: '' });
    expect(result.fieldMap.unmapped).toEqual([
      { fieldRef: 'f4444444444444444', reason: 'needs_user' },
      { fieldRef: 'f3333333333333333', reason: 'needs_user' },
    ]);
  });

  it('does not list a removed field twice when the session also listed it as unmapped', () => {
    const result = sanitiseGeneratedFieldMap({
      ...base,
      unmapped: [{ fieldRef: 'f3333333333333333', reason: 'unrecognized' }],
    }, { generation: 1, fields: [], submitControls: [], capturedAt: '', challengeDetected: false, activeFrameId: 0, pageStateFingerprint: '' });
    expect(result.fieldMap.unmapped.filter((entry) => entry.fieldRef === 'f3333333333333333')).toHaveLength(1);
  });
});

describe('summarisePreparedFields', () => {
  const snapshot: FormSnapshot = {
    generation: 1,
    fields: [
      field({ fieldRef: 'f1111111111111111', label: 'fullName', controlType: 'text', required: true }),
      field({ fieldRef: 'f2222222222222222', label: 'resume', controlType: 'file', required: true }),
      field({ fieldRef: 'f3333333333333333', label: 'workArrangement', controlType: 'select', required: true, options: [] }),
      field({ fieldRef: 'f4444444444444444', label: 'agreeToTerms', controlType: 'checkbox', required: true, classification: 'consent_field' }),
      field({ fieldRef: 'f5555555555555555', label: 'coverLetter', controlType: 'textarea', required: false }),
    ],
    submitControls: [],
    capturedAt: '2026-09-11T12:00:00.000Z',
    challengeDetected: false,
    activeFrameId: 0,
    pageStateFingerprint: 'fingerprint',
  };

  const valueTable = [{ valueRef: 'v1111111111111111', label: 'Full name', value: 'Jamie Rivera', provenance: 'cv' as const }];

  function summarise() {
    return summarisePreparedFields({
      snapshot,
      fieldMap: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: 1,
        assignments: [{ fieldRef: 'f1111111111111111', source: { kind: 'value', valueRef: 'v1111111111111111' } }],
        unmapped: [],
      },
      valueTable,
      uploadFieldRefs: ['f2222222222222222'],
      optionFieldRefs: [],
      company: 'Northwind Freight',
      role: 'Logistics Platform Engineer',
      preparedAt: '2026-09-11T12:00:00.000Z',
    });
  }

  it('gives every field on the page a row, so nothing is missing by omission', () => {
    const { prepared } = summarise();
    expect(prepared.fields.map((field) => field.label)).toEqual(['fullName', 'resume', 'workArrangement', 'agreeToTerms', 'coverLetter']);
  });

  it('records what was committed, with its value and where it came from', () => {
    const { prepared } = summarise();
    expect(prepared.fields[0]).toEqual({
      label: 'fullName',
      controlType: 'text',
      required: true,
      status: 'committed',
      value: 'Jamie Rivera',
      provenance: 'cv',
    });
  });

  it('blocks readiness on a required upload, and on nothing else', () => {
    const { prepared, blockers } = summarise();
    expect(prepared.fields[1]).toMatchObject({ label: 'resume', status: 'pending_upload' });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('did not confirm the attachment yet');
  });

  it('leaves a consent field to the person and never counts it as a blocker', () => {
    const { prepared, blockers } = summarise();
    expect(prepared.fields[3]).toMatchObject({ label: 'agreeToTerms', status: 'awaiting_you' });
    expect(blockers.join(' ')).not.toContain('agreeToTerms');
  });

  it('distinguishes "you answer this" from "nothing to put here"', () => {
    const { prepared } = summarise();
    expect(prepared.fields[2]).toMatchObject({ label: 'workArrangement', status: 'awaiting_you' });
    expect(prepared.fields[4]).toMatchObject({ label: 'coverLetter', status: 'left_blank' });
  });

  it('records the employer and role it was prepared for, and claims only that it applied them', () => {
    const { prepared } = summarise();
    expect(prepared).toMatchObject({ version: 1, company: 'Northwind Freight', role: 'Logistics Platform Engineer', verification: 'applied' });
  });
});
