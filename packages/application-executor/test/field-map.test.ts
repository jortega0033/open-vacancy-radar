import { describe, expect, it } from 'vitest';
import { parseFieldMap, MAX_FIELD_MAP_ENTRIES } from '../src/field-map.js';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const ARTIFACT_ID = '22222222-2222-4222-8222-222222222222';
const FIELD_REF = 'f0123456789abcdef';
const VALUE_REF = 'v0123456789abcdef';
const OPTION_REF = 'o0123456789abcdef';

function baseFieldMap() {
  return {
    attemptId: ATTEMPT_ID,
    snapshotGeneration: 1,
    assignments: [{ fieldRef: FIELD_REF, source: { kind: 'value', valueRef: VALUE_REF } }],
    unmapped: [],
  };
}

describe('parseFieldMap', () => {
  it('accepts a well-formed field map', () => {
    expect(parseFieldMap(baseFieldMap())).not.toBeNull();
  });

  it('accepts every assignment source kind', () => {
    for (const source of [
      { kind: 'value', valueRef: VALUE_REF },
      { kind: 'option', optionRef: OPTION_REF },
      { kind: 'artifact', artifactId: ARTIFACT_ID },
      { kind: 'skip', reason: 'no_source_value' },
    ]) {
      const map = { ...baseFieldMap(), assignments: [{ fieldRef: FIELD_REF, source }] };
      expect(parseFieldMap(map), JSON.stringify(source)).not.toBeNull();
    }
  });

  it('rejects an unknown top-level key (.strict())', () => {
    expect(parseFieldMap({ ...baseFieldMap(), extra: 'nope' })).toBeNull();
  });

  it('rejects an unknown key inside an assignment source (.strict())', () => {
    const map = { ...baseFieldMap(), assignments: [{ fieldRef: FIELD_REF, source: { kind: 'value', valueRef: VALUE_REF, extra: 1 } }] };
    expect(parseFieldMap(map)).toBeNull();
  });

  it('rejects a fieldRef that is not the minted shape', () => {
    const map = { ...baseFieldMap(), assignments: [{ fieldRef: 'not-a-real-ref', source: { kind: 'value', valueRef: VALUE_REF } }] };
    expect(parseFieldMap(map)).toBeNull();
  });

  it('rejects a valueRef/optionRef/artifactId in the wrong shape for its own kind', () => {
    expect(
      parseFieldMap({ ...baseFieldMap(), assignments: [{ fieldRef: FIELD_REF, source: { kind: 'value', valueRef: OPTION_REF } }] }),
    ).toBeNull();
    expect(
      parseFieldMap({ ...baseFieldMap(), assignments: [{ fieldRef: FIELD_REF, source: { kind: 'artifact', artifactId: 'not-a-uuid' } }] }),
    ).toBeNull();
  });

  it('rejects a non-uuid attemptId', () => {
    expect(parseFieldMap({ ...baseFieldMap(), attemptId: 'not-a-uuid' })).toBeNull();
  });

  it('rejects a negative snapshotGeneration', () => {
    expect(parseFieldMap({ ...baseFieldMap(), snapshotGeneration: -1 })).toBeNull();
  });

  it('rejects more than the maximum number of assignments', () => {
    const assignments = Array.from({ length: MAX_FIELD_MAP_ENTRIES + 1 }, () => ({
      fieldRef: FIELD_REF,
      source: { kind: 'skip', reason: 'not_applicable' },
    }));
    expect(parseFieldMap({ ...baseFieldMap(), assignments })).toBeNull();
  });

  it('rejects an unmapped reason outside the closed enum', () => {
    const map = { ...baseFieldMap(), unmapped: [{ fieldRef: FIELD_REF, reason: 'bogus' }] };
    expect(parseFieldMap(map)).toBeNull();
  });

  it('rejects a plain non-object, and null', () => {
    expect(parseFieldMap(null)).toBeNull();
    expect(parseFieldMap('a string')).toBeNull();
    expect(parseFieldMap(42)).toBeNull();
  });
});
