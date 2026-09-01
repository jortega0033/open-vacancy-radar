import { z } from 'zod';
import { opaqueCapabilityConstraintsSchema, utf8ByteLength, type OpaqueCapabilityConstraints } from '@agent-dock/shared';

/**
 * The capability id Open Vacancy Radar's v2 sessions request to preserve per-run model selection,
 * without adding an ad-hoc `model` field to any upstream-strict v2 session schema (see
 * packages/shared/src/protocol.ts and the ADI-03 ticket). Namespaced under `ext.open_vacancy_radar`
 * per `capabilityIdSchema`'s naming scheme (packages/shared/src/capabilities-v2.ts) so it reads,
 * on the wire, as unambiguously a product extension and never a core AgentDock capability.
 *
 * This module only defines and validates the extension: nothing in this repo constructs a v2
 * session yet (see docs/adr-agentdock-v2-provenance.md and the ADI-04/ADI-05 tickets), so nothing
 * here is wired into a request/response schema. The intended caller is whichever future v2
 * session-creation path exists once that infrastructure lands, requesting this capability as
 * required and resolving it with `resolveModelSelection` before launching a provider process.
 */
export const MODEL_SELECT_CAPABILITY_ID = 'ext.open_vacancy_radar.model_select';

const MAX_MODEL_BYTES = 256;

/**
 * Alphanumeric, starting and ending with an alphanumeric, with `.`/`_`/`-` allowed in the middle.
 * Matches every real model id this repo has ever used (`sonnet`, `opus`, `fable`, `haiku`, or a
 * dated/versioned id like `claude-opus-5-20260101`) and rejects whitespace-only strings, NUL/control
 * bytes, and a leading `-` -- the resolved model is destined for a provider CLI's own argv (see
 * `packages/agent-runtime/src/providers/claude/build-args.ts`), where a leading `-` could be
 * misread as a flag rather than a value. This is a real constraint, not just a length bound: it's
 * the difference between "any 256-byte string a caller's catalog happens to contain" and "a value
 * safe to hand to a subprocess regardless of what produced the catalog."
 */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

/** `{ model: string }`, 1-256 UTF-8 bytes -- the bounded opaque payload this capability's constraint carries. */
export const modelSelectValueSchema = z
  .object({
    model: z
      .string()
      .min(1, 'model must not be empty')
      .regex(MODEL_ID_PATTERN, 'model must be alphanumeric, optionally with . _ - in the middle')
      .refine((value) => utf8ByteLength(value) <= MAX_MODEL_BYTES, {
        message: `model must be at most ${MAX_MODEL_BYTES} UTF-8 bytes`,
      }),
  })
  .strict();

export type ModelSelectValue = z.infer<typeof modelSelectValueSchema>;

/** Builds the wire-shaped opaque constraint for a given model id, for a caller constructing a capability request. */
export function buildModelSelectConstraints(model: string): OpaqueCapabilityConstraints {
  return { kind: 'opaque', value: modelSelectValueSchema.parse({ model }) };
}

export type ModelSelectionResult =
  | { outcome: 'selected'; model: string }
  | { outcome: 'invalid_request'; reason: string }
  | { outcome: 'no_catalog' }
  | { outcome: 'unknown_model' };

/**
 * Resolves a requested model-select capability against a provider's reviewed model catalog,
 * failing closed on every path except an exact match: a malformed request, a provider with no
 * catalog at all (e.g. Codex today -- see packages/agent-runtime/src/providers/codex), and a model
 * absent from a real catalog (e.g. Claude's own `CLAUDE_MODELS`) are all rejected, never silently
 * substituted with a default. Model identity participates in continuation safety (see the ADI-03
 * ticket's Risk note): a silent fallback here would let a resumed session quietly run under a
 * different model than the one it was granted, so every non-exact-match outcome is a distinct,
 * inspectable reason rather than a single opaque `false`.
 *
 * `catalog` is caller-supplied (typically a provider's already-detected `availableModels`, see
 * `ProviderStatus` in packages/shared/src/schemas.ts) rather than imported from a specific
 * provider's internals: this keeps the intersector provider-agnostic and testable against fixture
 * catalogs, and lets the real caller (once one exists) decide how a provider's catalog is obtained.
 */
export function resolveModelSelection(raw: unknown, catalog: readonly string[] | undefined): ModelSelectionResult {
  const constraints = opaqueCapabilityConstraintsSchema.safeParse(raw);
  if (!constraints.success) {
    return { outcome: 'invalid_request', reason: constraints.error.message };
  }
  // `constraints.data.value` already passed `boundedJsonSchema`'s plain-prototype check, but Zod's
  // object-shape parser reads a known key via a live property access (`data['model']`), which
  // follows the prototype chain regardless of enumerability -- so if `Object.prototype` were ever
  // polluted with a non-enumerable `model` property elsewhere in the process, parsing `{}` directly
  // would see an inherited value and this would wrongly report `selected` for a request that
  // specified nothing. Rebuilding a fresh, single-property plain object from an explicit
  // `hasOwnProperty` check closes that off: only a genuine own property on the actual payload can
  // ever reach `modelSelectValueSchema`.
  const container = constraints.data.value;
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    return { outcome: 'invalid_request', reason: 'value must be an object with a single "model" property' };
  }
  if (!Object.prototype.hasOwnProperty.call(container, 'model') || Reflect.ownKeys(container).length !== 1) {
    return { outcome: 'invalid_request', reason: 'value must have exactly one own property: model' };
  }
  const value = modelSelectValueSchema.safeParse({ model: (container as { model: unknown }).model });
  if (!value.success) {
    return { outcome: 'invalid_request', reason: value.error.message };
  }
  // Built defensively rather than calling `catalog.includes(...)` directly: `catalog` crossing a
  // module boundary as `readonly string[]` is a compile-time guarantee only, and a `Set` built here
  // (native, never exposed to the caller) can't be spoofed by a caller-supplied array subclass or
  // array-like object overriding its own `includes`. Filtering to real, non-empty strings also means
  // a provider catalog containing only garbage entries reports `no_catalog`, not a misleading
  // `unknown_model` implying the provider genuinely has a reviewed-but-non-matching catalog.
  const reviewed = new Set(
    (Array.isArray(catalog) ? catalog : []).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
  );
  if (reviewed.size === 0) {
    return { outcome: 'no_catalog' };
  }
  if (!reviewed.has(value.data.model)) {
    return { outcome: 'unknown_model' };
  }
  return { outcome: 'selected', model: value.data.model };
}
