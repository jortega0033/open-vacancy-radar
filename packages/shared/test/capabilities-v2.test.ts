import { describe, expect, it } from 'vitest';
import {
  ACTIVE_CAPABILITY_EXTENSION_IDS,
  boundedJsonSchema,
  capabilityIdSchema,
  isCapabilityExtensionActive,
  MODEL_SELECT_CAPABILITY_ID,
  opaqueExtensionListSchema,
  parseOpaqueExtensions,
  utf8ByteLength,
  validateJsonBounds,
  OPAQUE_JSON_BOUNDS,
} from '../src/capabilities-v2.js';

describe('utf8ByteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    expect(utf8ByteLength('a')).toBe(1);
    // A single multi-byte code point (2 bytes in UTF-8), not 1 code unit.
    expect(utf8ByteLength('é')).toBe(2);
  });
});

describe('validateJsonBounds / boundedJsonSchema', () => {
  it('accepts a small nested object and round-trips it unchanged', () => {
    const value = { a: 1, b: ['x', 'y'], c: { d: true, e: null } };
    expect(validateJsonBounds(value, OPAQUE_JSON_BOUNDS)).toBeUndefined();
    expect(boundedJsonSchema.parse(value)).toEqual(value);
  });

  it('rejects a payload whose encoded size exceeds the byte bound', () => {
    const value = { text: 'x'.repeat(OPAQUE_JSON_BOUNDS.maxBytes) };
    expect(boundedJsonSchema.safeParse(value).success).toBe(false);
  });

  it('rejects nesting deeper than the depth bound, without a stack overflow on hostile input', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10_000; i += 1) deep = { next: deep };
    expect(() => validateJsonBounds(deep, OPAQUE_JSON_BOUNDS)).not.toThrow();
    expect(validateJsonBounds(deep, OPAQUE_JSON_BOUNDS)).toMatch(/depth/);
  });

  it('accepts exactly the item bound and rejects one more, aggregated across the whole tree', () => {
    const atLimit = { items: Array.from({ length: OPAQUE_JSON_BOUNDS.maxItems - 1 }, (_, i) => i) };
    expect(validateJsonBounds(atLimit, OPAQUE_JSON_BOUNDS)).toBeUndefined();
    const overLimit = { items: Array.from({ length: OPAQUE_JSON_BOUNDS.maxItems }, (_, i) => i) };
    expect(validateJsonBounds(overLimit, OPAQUE_JSON_BOUNDS)).toMatch(/items/);
  });

  it('rejects a string value over the per-string byte bound, measured in UTF-8 bytes not characters', () => {
    // 200 two-byte code points = 400 UTF-8 bytes, over the 256-byte string bound, despite being
    // only 200 JS characters long.
    const value = { text: 'é'.repeat(200) };
    expect(validateJsonBounds(value, OPAQUE_JSON_BOUNDS)).toMatch(/bytes/);
  });

  it('rejects an object key over the per-string byte bound', () => {
    const value = { [`${'k'.repeat(OPAQUE_JSON_BOUNDS.maxStringBytes + 1)}`]: 1 };
    expect(validateJsonBounds(value, OPAQUE_JSON_BOUNDS)).toMatch(/keys/);
  });

  it('rejects a cyclic value without hanging', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(validateJsonBounds(value, OPAQUE_JSON_BOUNDS)).toMatch(/cyclic/);
  });

  it('rejects non-finite numbers', () => {
    expect(validateJsonBounds({ n: Number.NaN }, OPAQUE_JSON_BOUNDS)).toMatch(/finite/);
    expect(validateJsonBounds({ n: Number.POSITIVE_INFINITY }, OPAQUE_JSON_BOUNDS)).toMatch(/finite/);
  });

  it('rejects a non-plain prototype and a symbol-keyed object', () => {
    const withPrototype = Object.create({ evil: true }) as Record<string, unknown>;
    withPrototype.value = 1;
    expect(validateJsonBounds(withPrototype, OPAQUE_JSON_BOUNDS)).toMatch(/plain objects/);

    const withSymbol: Record<string | symbol, unknown> = { a: 1 };
    withSymbol[Symbol('hidden')] = 2;
    expect(validateJsonBounds(withSymbol, OPAQUE_JSON_BOUNDS)).toMatch(/enumerable string keys/);
  });

  it('rejects a sparse array', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(validateJsonBounds(sparse, OPAQUE_JSON_BOUNDS)).toMatch(/sparse/);
  });
});

describe('capabilityIdSchema', () => {
  it('accepts a namespaced extension id', () => {
    expect(capabilityIdSchema.safeParse('ext.acme.turbo').success).toBe(true);
    expect(capabilityIdSchema.safeParse('ext.acme.turbo.mode').success).toBe(true);
  });

  it('rejects an extension id missing a feature segment', () => {
    expect(capabilityIdSchema.safeParse('ext.acme').success).toBe(false);
  });

  it('accepts a reserved-prefix core id', () => {
    expect(capabilityIdSchema.safeParse('session.cancel').success).toBe(true);
  });

  it('rejects an id under neither a reserved prefix nor the ext. namespace', () => {
    expect(capabilityIdSchema.safeParse('acme.turbo').success).toBe(false);
  });

  it('rejects mixed case and an empty extension segment', () => {
    expect(capabilityIdSchema.safeParse('Ext.Acme.Turbo').success).toBe(false);
    expect(capabilityIdSchema.safeParse('ext..turbo').success).toBe(false);
  });
});

describe('opaqueExtensionListSchema / parseOpaqueExtensions', () => {
  function extension(id: string, value: unknown = { tier: 'fast' }) {
    return { id, constraints: { kind: 'opaque' as const, value } };
  }

  it('parses a well-formed extension list and preserves the payload byte-for-byte', () => {
    const list = [extension('ext.acme.turbo', { tier: 'fast', enabled: true })];
    const parsed = parseOpaqueExtensions(list);
    expect(parsed).toEqual(list);
  });

  it('rejects an extension whose payload exceeds the bounds instead of silently truncating it', () => {
    const list = [extension('ext.acme.turbo', { text: 'x'.repeat(OPAQUE_JSON_BOUNDS.maxBytes) })];
    expect(() => parseOpaqueExtensions(list)).toThrow();
  });

  it('rejects an unknown field on the constraints envelope rather than stripping it', () => {
    expect(
      opaqueExtensionListSchema.safeParse([{ id: 'ext.acme.turbo', constraints: { kind: 'opaque', value: {}, extra: 1 } }])
        .success,
    ).toBe(false);
  });

  it('rejects a non-opaque constraints kind', () => {
    expect(
      opaqueExtensionListSchema.safeParse([{ id: 'ext.acme.turbo', constraints: { kind: 'transparent', value: {} } }]).success,
    ).toBe(false);
  });

  it('rejects duplicate extension ids in the same list', () => {
    const list = [extension('ext.acme.turbo'), extension('ext.acme.turbo')];
    expect(opaqueExtensionListSchema.safeParse(list).success).toBe(false);
  });

  it('rejects a list over the maximum extension count', () => {
    const list = Array.from({ length: 65 }, (_, i) => extension(`ext.acme.turbo${i}`));
    expect(opaqueExtensionListSchema.safeParse(list).success).toBe(false);
  });

  it('accepts an empty list', () => {
    expect(parseOpaqueExtensions([])).toEqual([]);
  });
});

describe('unknown extensions remain parseable but inactive', () => {
  it('activates exactly one capability extension in this release: model-select (ADI-13)', () => {
    // This must only change in a ticket that ports a real handler behind another id -- any future
    // change activating an extension has to touch this line on purpose.
    expect(ACTIVE_CAPABILITY_EXTENSION_IDS).toEqual([MODEL_SELECT_CAPABILITY_ID]);
    expect(isCapabilityExtensionActive(MODEL_SELECT_CAPABILITY_ID)).toBe(true);
  });

  it('is a well-formed extension id, so the activation cannot be an id the parser would reject', () => {
    expect(capabilityIdSchema.safeParse(MODEL_SELECT_CAPABILITY_ID).success).toBe(true);
  });

  it('reports an unrelated extension id as inactive, even one this build just parsed successfully', () => {
    const [parsed] = parseOpaqueExtensions([{ id: 'ext.acme.turbo', constraints: { kind: 'opaque', value: {} } }]);
    expect(isCapabilityExtensionActive(parsed!.id)).toBe(false);
  });
});
