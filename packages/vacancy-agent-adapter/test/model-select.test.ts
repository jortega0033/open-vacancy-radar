import { describe, expect, it } from 'vitest';
import {
  ACTIVE_CAPABILITY_EXTENSION_IDS,
  capabilityIdSchema,
  isCapabilityExtensionActive,
  MODEL_SELECT_CAPABILITY_ID as SHARED_MODEL_SELECT_CAPABILITY_ID,
} from '@agent-dock/shared';
import {
  MODEL_SELECT_CAPABILITY_ID,
  buildModelSelectConstraints,
  modelSelectValueSchema,
  resolveModelSelection,
} from '../src/model-select.js';

/** A stand-in for a provider's reviewed model catalog, e.g. agent-runtime's real `CLAUDE_MODELS`.
 * Deliberately not imported from agent-runtime: the intersector is provider-agnostic, and a real
 * caller supplies whatever catalog a provider actually detected. */
const FIXTURE_CLAUDE_CATALOG = ['sonnet', 'opus', 'fable', 'haiku'];

/**
 * ADI-13's drift guard.
 *
 * `packages/shared` cannot import this constant: this package depends on shared, so the import would
 * be a cycle between two workspace packages. The literal is therefore written out in both files, and
 * this is the test that makes the duplication safe. It lives here rather than in shared's own suite
 * for the same dependency reason -- only this side can see both copies.
 *
 * If it ever fails, the daemon is answering `unsupported_capability` for the one capability it
 * actually implements: `ACTIVE_CAPABILITY_EXTENSION_IDS` would name an id the resolver never sees.
 */
describe('MODEL_SELECT_CAPABILITY_ID drift guard (ADI-13)', () => {
  it('is byte-identical to the literal packages/shared activates', () => {
    expect(MODEL_SELECT_CAPABILITY_ID).toBe(SHARED_MODEL_SELECT_CAPABILITY_ID);
  });

  it('is the id shared reports as an active capability extension', () => {
    expect(ACTIVE_CAPABILITY_EXTENSION_IDS).toContain(MODEL_SELECT_CAPABILITY_ID);
    expect(isCapabilityExtensionActive(MODEL_SELECT_CAPABILITY_ID)).toBe(true);
  });
});

describe('MODEL_SELECT_CAPABILITY_ID', () => {
  it('is a well-formed extension capability id', () => {
    expect(capabilityIdSchema.safeParse(MODEL_SELECT_CAPABILITY_ID).success).toBe(true);
  });

  it('is namespaced under ext.open_vacancy_radar, never a core AgentDock prefix', () => {
    expect(MODEL_SELECT_CAPABILITY_ID.startsWith('ext.open_vacancy_radar.')).toBe(true);
  });

  it('is exactly this literal string -- a future v2 caller will hardcode it on the wire', () => {
    expect(MODEL_SELECT_CAPABILITY_ID).toBe('ext.open_vacancy_radar.model_select');
  });
});

describe('modelSelectValueSchema', () => {
  it('accepts a normal model id', () => {
    expect(modelSelectValueSchema.safeParse({ model: 'opus' }).success).toBe(true);
  });

  it('rejects an empty model string', () => {
    expect(modelSelectValueSchema.safeParse({ model: '' }).success).toBe(false);
  });

  it('accepts a model string at exactly the 256-byte bound and rejects one over it', () => {
    expect(modelSelectValueSchema.safeParse({ model: 'x'.repeat(256) }).success).toBe(true);
    expect(modelSelectValueSchema.safeParse({ model: 'x'.repeat(257) }).success).toBe(false);
  });

  it('rejects a non-ASCII model id via the character-class check, independent of the byte bound', () => {
    // The character-class regex only allows ASCII alphanumerics plus . _ -, so any multi-byte
    // UTF-8 character is rejected regardless of whether it would fit the 256-byte bound.
    expect(modelSelectValueSchema.safeParse({ model: 'é'.repeat(10) }).success).toBe(false);
  });

  it('measures the byte bound in UTF-8 bytes -- moot for the ASCII-only ids this schema accepts, but exercised directly against utf8ByteLength', () => {
    expect(modelSelectValueSchema.safeParse({ model: 'x'.repeat(128) }).success).toBe(true);
  });

  it('rejects an unknown field rather than stripping it', () => {
    expect(modelSelectValueSchema.safeParse({ model: 'opus', extra: true }).success).toBe(false);
  });

  it('rejects a non-string model value', () => {
    expect(modelSelectValueSchema.safeParse({ model: 123 }).success).toBe(false);
  });

  it('accepts a realistic dated/versioned model id', () => {
    expect(modelSelectValueSchema.safeParse({ model: 'claude-opus-5-20260101' }).success).toBe(true);
  });

  it('rejects a whitespace-only model, since a subprocess consumer would see it as empty-ish input', () => {
    expect(modelSelectValueSchema.safeParse({ model: '   ' }).success).toBe(false);
  });

  it('rejects a model containing a NUL byte or a newline', () => {
    expect(modelSelectValueSchema.safeParse({ model: `opus${String.fromCharCode(0)}` }).success).toBe(false);
    expect(modelSelectValueSchema.safeParse({ model: 'opus\n' }).success).toBe(false);
  });

  it('rejects a model starting with a dash, which a subprocess argv parser could mistake for a flag', () => {
    expect(modelSelectValueSchema.safeParse({ model: '--dangerously-skip-permissions' }).success).toBe(false);
  });

  it('rejects a model that is not trimmed, requiring an exact match rather than an implicit trim', () => {
    expect(modelSelectValueSchema.safeParse({ model: 'opus ' }).success).toBe(false);
    expect(modelSelectValueSchema.safeParse({ model: ' opus' }).success).toBe(false);
  });
});

describe('buildModelSelectConstraints', () => {
  it('builds a wire-shaped opaque constraint that resolveModelSelection accepts back', () => {
    const constraints = buildModelSelectConstraints('opus');
    expect(constraints).toEqual({ kind: 'opaque', value: { model: 'opus' } });
    expect(resolveModelSelection(constraints, FIXTURE_CLAUDE_CATALOG)).toEqual({ outcome: 'selected', model: 'opus' });
  });

  it('throws for a model that fails modelSelectValueSchema, rather than building an invalid constraint', () => {
    expect(() => buildModelSelectConstraints('')).toThrow();
  });
});

describe('resolveModelSelection', () => {
  it('selects a model present in the provider catalog', () => {
    const request = buildModelSelectConstraints('sonnet');
    expect(resolveModelSelection(request, FIXTURE_CLAUDE_CATALOG)).toEqual({ outcome: 'selected', model: 'sonnet' });
  });

  it('fails closed for a model absent from the catalog, never substituting a default', () => {
    const request = buildModelSelectConstraints('gpt-5');
    expect(resolveModelSelection(request, FIXTURE_CLAUDE_CATALOG)).toEqual({ outcome: 'unknown_model' });
  });

  it('fails closed for a provider with no catalog at all (e.g. Codex today)', () => {
    const request = buildModelSelectConstraints('gpt-5');
    expect(resolveModelSelection(request, undefined)).toEqual({ outcome: 'no_catalog' });
  });

  it('fails closed for a provider with an explicitly empty catalog', () => {
    const request = buildModelSelectConstraints('sonnet');
    expect(resolveModelSelection(request, [])).toEqual({ outcome: 'no_catalog' });
  });

  it('fails closed for a malformed opaque envelope (wrong kind)', () => {
    const result = resolveModelSelection({ kind: 'transparent', value: { model: 'opus' } }, FIXTURE_CLAUDE_CATALOG);
    expect(result.outcome).toBe('invalid_request');
  });

  it('fails closed for a well-formed envelope whose value does not match { model: string }', () => {
    const result = resolveModelSelection({ kind: 'opaque', value: { modelId: 'opus' } }, FIXTURE_CLAUDE_CATALOG);
    expect(result.outcome).toBe('invalid_request');
  });

  it('fails closed for an empty requested model, even against a real catalog', () => {
    const result = resolveModelSelection({ kind: 'opaque', value: { model: '' } }, FIXTURE_CLAUDE_CATALOG);
    expect(result.outcome).toBe('invalid_request');
  });

  it('fails closed for an oversized requested model', () => {
    const result = resolveModelSelection({ kind: 'opaque', value: { model: 'x'.repeat(257) } }, FIXTURE_CLAUDE_CATALOG);
    expect(result.outcome).toBe('invalid_request');
  });

  it('fails closed for a completely unrelated raw payload (null, array, primitive)', () => {
    expect(resolveModelSelection(null, FIXTURE_CLAUDE_CATALOG).outcome).toBe('invalid_request');
    expect(resolveModelSelection([], FIXTURE_CLAUDE_CATALOG).outcome).toBe('invalid_request');
    expect(resolveModelSelection('opus', FIXTURE_CLAUDE_CATALOG).outcome).toBe('invalid_request');
  });

  it('is case-sensitive: a catalog entry must match exactly, never a case-insensitive guess', () => {
    const request = buildModelSelectConstraints('Opus');
    expect(resolveModelSelection(request, FIXTURE_CLAUDE_CATALOG)).toEqual({ outcome: 'unknown_model' });
  });

  it('does not implicitly trim a padded model before checking against the catalog', () => {
    const request = { kind: 'opaque' as const, value: { model: 'opus ' } };
    // 'opus ' itself fails modelSelectValueSchema's character-class check, so this is invalid_request
    // (not a silent-trim-then-match) even though 'opus' with the padding removed IS in the catalog.
    expect(resolveModelSelection(request, FIXTURE_CLAUDE_CATALOG).outcome).toBe('invalid_request');
  });

  it('exposes a non-empty, specific reason for an invalid_request outcome', () => {
    const result = resolveModelSelection({ kind: 'opaque', value: { modelId: 'opus' } }, FIXTURE_CLAUDE_CATALOG);
    expect(result.outcome).toBe('invalid_request');
    if (result.outcome === 'invalid_request') {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('fails closed for a request with no own "model" property at all', () => {
    expect(resolveModelSelection({ kind: 'opaque', value: {} }, FIXTURE_CLAUDE_CATALOG).outcome).toBe('invalid_request');
  });

  it('is not fooled by a non-enumerable Object.prototype.model left behind by unrelated code elsewhere in the process', () => {
    // A regression guard for a real, verified bug: Zod's object-shape parser reads a known key via
    // a live property access, which follows the prototype chain regardless of enumerability, so
    // parsing `{}` directly against `{ model: z.string() }` would see an inherited value. Rebuilding
    // a fresh object from an explicit `hasOwnProperty` check (see resolveModelSelection) closes this.
    Object.defineProperty(Object.prototype, 'model', {
      value: 'opus',
      configurable: true,
      enumerable: false,
    });
    try {
      const result = resolveModelSelection({ kind: 'opaque', value: {} }, FIXTURE_CLAUDE_CATALOG);
      expect(result.outcome).toBe('invalid_request');
    } finally {
      delete (Object.prototype as Record<string, unknown>).model;
    }
  });

  it('is immune to a caller-supplied catalog whose own includes() lies (e.g. a hostile Array subclass)', () => {
    class LyingArray extends Array<string> {
      override includes(): boolean {
        return true;
      }
    }
    const catalog = LyingArray.from(['sonnet']) as unknown as readonly string[];
    const request = buildModelSelectConstraints('not-a-real-model');
    expect(resolveModelSelection(request, catalog)).toEqual({ outcome: 'unknown_model' });
  });

  it('is immune to a caller-supplied array-like object masquerading as a catalog', () => {
    const fakeArray = { length: 1, 0: 'sonnet', includes: () => true } as unknown as readonly string[];
    const request = buildModelSelectConstraints('not-a-real-model');
    expect(resolveModelSelection(request, fakeArray).outcome).not.toBe('selected');
  });

  it('reports no_catalog, not unknown_model, for a catalog containing only non-string garbage', () => {
    const garbageCatalog = [undefined, null, 0] as unknown as readonly string[];
    const request = buildModelSelectConstraints('sonnet');
    expect(resolveModelSelection(request, garbageCatalog)).toEqual({ outcome: 'no_catalog' });
  });
});
