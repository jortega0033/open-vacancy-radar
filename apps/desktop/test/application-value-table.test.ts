// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FieldMap, FormSnapshot } from '@agent-dock/application-executor';
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
      { fieldRef: 'f1111111111111111', label: 'fullName', controlType: 'text', required: true },
      { fieldRef: 'f2222222222222222', label: 'agreeToTerms', controlType: 'checkbox', required: true, classification: 'consent_field' },
    ],
    submitControls: [{ controlRef: 'c1111111111111111', label: 'Submit Application' }],
    capturedAt: '2026-09-11T12:00:00.000Z',
    challengeDetected: false,
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

  it('keeps the value assignments and removes the kinds this app will not commit', () => {
    const result = sanitiseGeneratedFieldMap(base);
    expect(result.fieldMap.assignments).toEqual([base.assignments[0]]);
    expect(result.uploadFieldRefs).toEqual(['f2222222222222222']);
    expect(result.optionFieldRefs).toEqual(['f3333333333333333']);
  });

  it('moves each removed assignment into unmapped rather than dropping it silently', () => {
    const result = sanitiseGeneratedFieldMap(base);
    expect(result.fieldMap.unmapped).toEqual([
      { fieldRef: 'f4444444444444444', reason: 'needs_user' },
      { fieldRef: 'f2222222222222222', reason: 'needs_user' },
      { fieldRef: 'f3333333333333333', reason: 'needs_user' },
    ]);
  });

  it('does not list a removed field twice when the session also listed it as unmapped', () => {
    const result = sanitiseGeneratedFieldMap({
      ...base,
      unmapped: [{ fieldRef: 'f2222222222222222', reason: 'unrecognized' }],
    });
    expect(result.fieldMap.unmapped.filter((entry) => entry.fieldRef === 'f2222222222222222')).toHaveLength(1);
  });
});

describe('summarisePreparedFields', () => {
  const snapshot: FormSnapshot = {
    generation: 1,
    fields: [
      { fieldRef: 'f1111111111111111', label: 'fullName', controlType: 'text', required: true },
      { fieldRef: 'f2222222222222222', label: 'resume', controlType: 'file', required: true },
      { fieldRef: 'f3333333333333333', label: 'workArrangement', controlType: 'select', required: true, options: [] },
      { fieldRef: 'f4444444444444444', label: 'agreeToTerms', controlType: 'checkbox', required: true, classification: 'consent_field' },
      { fieldRef: 'f5555555555555555', label: 'coverLetter', controlType: 'textarea', required: false },
    ],
    submitControls: [],
    capturedAt: '2026-09-11T12:00:00.000Z',
    challengeDetected: false,
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
    expect(blockers[0]).toContain('verified uploads are not wired up yet');
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
