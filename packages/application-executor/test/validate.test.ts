import { describe, expect, it } from 'vitest';
import { validateFieldMap, type ValueTableEntry } from '../src/validate.js';
import type { FormSnapshot } from '../src/form-snapshot.js';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ATTEMPT_ID = '99999999-9999-4999-8999-999999999999';
const ARTIFACT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';

// Well-formed (16 lowercase hex chars after the prefix) so every "unknown ref" case below exercises
// rule 4 (closed-set membership) rather than failing schema validation at rule 1 for the wrong reason.
const NAME_FIELD = 'f0000000000000001';
const RESUME_FIELD = 'f0000000000000002';
const COUNTRY_FIELD = 'f0000000000000003';
const PASSWORD_FIELD = 'f0000000000000004';
const REQUIRED_UNCOVERED_FIELD = 'f0000000000000005';
const UNKNOWN_FIELD = 'f0000000000000006';

const OPTION_NL = 'o0000000000000001';
const UNKNOWN_OPTION = 'o0000000000000002';

const VALUE_NAME = 'v0000000000000001';
const VALUE_JD = 'v0000000000000002';
const UNKNOWN_VALUE = 'v0000000000000003';

const SNAPSHOT: FormSnapshot = {
  generation: 5,
  capturedAt: '2026-01-01T00:00:00.000Z',
  fields: [
    { fieldRef: NAME_FIELD, label: 'Name', controlType: 'text', required: true },
    { fieldRef: RESUME_FIELD, label: 'Resume', controlType: 'file', required: true },
    { fieldRef: COUNTRY_FIELD, label: 'Country', controlType: 'select', required: false, options: [{ optionRef: OPTION_NL, label: 'Netherlands' }] },
    { fieldRef: PASSWORD_FIELD, label: 'Password', controlType: 'text', required: false, classification: 'credential_field' },
    { fieldRef: REQUIRED_UNCOVERED_FIELD, label: 'Salary expectation', controlType: 'text', required: true },
  ],
};

const VALUE_TABLE: ValueTableEntry[] = [
  { valueRef: VALUE_NAME, value: 'Jamie Rivera', provenance: 'cv' },
  { valueRef: VALUE_JD, value: 'Senior Engineer', provenance: 'jd' },
];

function baseRaw() {
  return {
    attemptId: ATTEMPT_ID,
    snapshotGeneration: 5,
    assignments: [
      { fieldRef: NAME_FIELD, source: { kind: 'value', valueRef: VALUE_NAME } },
      { fieldRef: RESUME_FIELD, source: { kind: 'artifact', artifactId: ARTIFACT_ID } },
    ],
    unmapped: [{ fieldRef: REQUIRED_UNCOVERED_FIELD, reason: 'needs_user' }],
  };
}

function baseInput(overrides: Partial<Parameters<typeof validateFieldMap>[0]> = {}) {
  return {
    raw: baseRaw(),
    attemptId: ATTEMPT_ID,
    snapshot: SNAPSHOT,
    valueTable: VALUE_TABLE,
    ownedArtifactIds: [ARTIFACT_ID],
    ...overrides,
  };
}

describe('validateFieldMap: the happy path', () => {
  it('accepts a well-formed, fully-covered field map', () => {
    const result = validateFieldMap(baseInput());
    expect(result.ok).toBe(true);
    expect(result.fieldMap).toBeDefined();
  });
});

describe('validateFieldMap: rule 1, schema', () => {
  it('refuses a raw value that fails the field-map schema', () => {
    const result = validateFieldMap(baseInput({ raw: { nonsense: true } }));
    expect(result).toMatchObject({ ok: false, reason: 'invalid_shape' });
  });
});

describe('validateFieldMap: rule 2, generation match', () => {
  it('refuses a field map targeting a stale snapshot generation', () => {
    const result = validateFieldMap(baseInput({ raw: { ...baseRaw(), snapshotGeneration: 4 } }));
    expect(result).toMatchObject({ ok: false, reason: 'stale_snapshot_generation' });
  });
});

describe('validateFieldMap: rule 3, attempt binding', () => {
  it('refuses a field map produced for a different attempt', () => {
    const result = validateFieldMap(baseInput({ raw: { ...baseRaw(), attemptId: OTHER_ATTEMPT_ID } }));
    expect(result).toMatchObject({ ok: false, reason: 'attempt_mismatch' });
  });
});

describe('validateFieldMap: rule 4, closed-set membership', () => {
  it('refuses an unknown fieldRef', () => {
    const raw = { ...baseRaw(), assignments: [{ fieldRef: UNKNOWN_FIELD, source: { kind: 'value', valueRef: VALUE_NAME } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'unknown_ref' });
  });

  it('refuses an unknown valueRef', () => {
    const raw = { ...baseRaw(), assignments: [{ fieldRef: NAME_FIELD, source: { kind: 'value', valueRef: UNKNOWN_VALUE } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'unknown_ref' });
  });

  it('refuses an optionRef that is not on the targeted field', () => {
    const raw = { ...baseRaw(), assignments: [{ fieldRef: COUNTRY_FIELD, source: { kind: 'option', optionRef: UNKNOWN_OPTION } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'unknown_ref' });
  });

  it('refuses an unmapped entry naming a field not in the snapshot', () => {
    const raw = { ...baseRaw(), unmapped: [{ fieldRef: UNKNOWN_FIELD, reason: 'needs_user' }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'unknown_ref' });
  });
});

describe('validateFieldMap: rule 5, artifact ownership', () => {
  it('refuses an artifact that does not belong to this attempt', () => {
    const raw = { ...baseRaw(), assignments: [...baseRaw().assignments.slice(0, 1), { fieldRef: RESUME_FIELD, source: { kind: 'artifact', artifactId: OTHER_ARTIFACT_ID } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'artifact_not_owned' });
  });
});

describe('validateFieldMap: rule 6, provenance', () => {
  it('refuses a jd-provenance value by default', () => {
    const raw = { ...baseRaw(), assignments: [{ fieldRef: NAME_FIELD, source: { kind: 'value', valueRef: VALUE_JD } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'disallowed_provenance' });
  });

  it('accepts a jd-provenance value when the caller explicitly opts in', () => {
    const raw = {
      ...baseRaw(),
      assignments: [{ fieldRef: NAME_FIELD, source: { kind: 'value', valueRef: VALUE_JD } }],
      unmapped: [
        { fieldRef: RESUME_FIELD, reason: 'needs_user' },
        { fieldRef: REQUIRED_UNCOVERED_FIELD, reason: 'needs_user' },
      ],
    };
    const result = validateFieldMap(baseInput({ raw, allowJdProvenance: true }));
    expect(result.ok).toBe(true);
  });
});

describe('validateFieldMap: rule 7, type compatibility', () => {
  it('refuses a plain value assigned to a file field', () => {
    const raw = { ...baseRaw(), assignments: [{ fieldRef: RESUME_FIELD, source: { kind: 'value', valueRef: VALUE_NAME } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'type_mismatch' });
  });

  it('refuses an option assigned to a field it does not belong to (caught by rule 4, before rule 7 -- an option only ever belongs to the field that produced it)', () => {
    const raw = { ...baseRaw(), assignments: [{ fieldRef: NAME_FIELD, source: { kind: 'option', optionRef: OPTION_NL } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'unknown_ref' });
  });

  it('refuses an artifact assigned to a non-file field', () => {
    const raw = { ...baseRaw(), assignments: [{ fieldRef: NAME_FIELD, source: { kind: 'artifact', artifactId: ARTIFACT_ID } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'type_mismatch' });
  });
});

describe('validateFieldMap: rule 8, excluded-field veto', () => {
  it('refuses any assignment targeting a structurally classified field, even a plausible one', () => {
    const raw = { ...baseRaw(), assignments: [...baseRaw().assignments, { fieldRef: PASSWORD_FIELD, source: { kind: 'value', valueRef: VALUE_NAME } }] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'excluded_field_targeted' });
  });
});

describe('validateFieldMap: rule 9, completeness', () => {
  it('refuses a field map that leaves a required field neither assigned nor unmapped', () => {
    const raw = { ...baseRaw(), unmapped: [] };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'incomplete' });
  });

  it('accepts a required field that is explicitly listed as unmapped instead of assigned', () => {
    expect(validateFieldMap(baseInput()).ok).toBe(true); // REQUIRED_UNCOVERED_FIELD is in unmapped
  });
});

describe('validateFieldMap: rule 10, bounds (enforced by the schema itself)', () => {
  it('refuses a field map with more assignments than the schema allows', () => {
    const assignments = Array.from({ length: 201 }, () => ({ fieldRef: NAME_FIELD, source: { kind: 'skip', reason: 'not_applicable' } }));
    const raw = { ...baseRaw(), assignments };
    expect(validateFieldMap(baseInput({ raw }))).toMatchObject({ ok: false, reason: 'invalid_shape' });
  });
});
