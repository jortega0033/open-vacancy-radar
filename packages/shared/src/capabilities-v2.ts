import { z } from 'zod';

/**
 * The bounded-JSON and capability-id primitives from AgentDock v2's much larger capability
 * negotiation system (upstream `capabilities-v2.ts`), ported verbatim where reusable and narrowed
 * everywhere else. Deliberately NOT ported: `CORE_CAPABILITY_IDS`, the per-capability constraint
 * catalog, `negotiateCapabilities`, and every schema describing a specific capability (MCP,
 * component, attachment, worktree, structured-output, filesystem/network isolation, ...). Those
 * describe what a v2 *daemon* can do; this repo ships no v2 daemon yet, and several of them
 * (generic MCP, components, attachments, workflows, worktrees, subagents) are permanent non-goals
 * for this product, not just deferred. See docs/adr-agentdock-v2-provenance.md for the wider plan.
 *
 * This module shipped inert (ADI-02) and is inert no longer. ADI-13 gave it its first real
 * consumer: `createSessionV2RequestSchema` (session-v2.ts) carries an `OpaqueExtension` list on the
 * wire, `POST /v2/sessions` resolves it, and `ACTIVE_CAPABILITY_EXTENSION_IDS` below now names the
 * one extension this build implements rather than being an empty list. The bounds machinery is
 * unchanged; only the activation registry and its consumers are new.
 */

const MAX_OPAQUE_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ITEMS = 1_024;
const MAX_WIRE_STRING_BYTES = 256;
const MAX_EXTENSIONS = 64;
const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export interface JsonBounds {
  maxBytes: number;
  maxDepth: number;
  maxItems: number;
  maxStringBytes: number;
}

/** The bounds `boundedJsonSchema` enforces. Exported so a future daemon-side check can cite the same numbers instead of re-guessing them. */
export const OPAQUE_JSON_BOUNDS: Readonly<JsonBounds> = Object.freeze({
  maxBytes: MAX_OPAQUE_BYTES,
  maxDepth: MAX_JSON_DEPTH,
  maxItems: MAX_JSON_ITEMS,
  maxStringBytes: MAX_WIRE_STRING_BYTES,
});

/**
 * Ported verbatim from upstream: an iterative (not recursive) walk, so hostile nesting cannot blow
 * the call stack the way a naive recursive JSON validator would. Rejects cycles, non-plain
 * prototypes, symbol/non-enumerable keys, sparse arrays, and non-finite numbers, in addition to the
 * four numeric bounds. Returns a human-readable reason string, or `undefined` when `value` is
 * within bounds.
 */
export function validateJsonBounds(value: unknown, bounds: JsonBounds): string | undefined {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const activePath = new WeakSet<object>();
  let aggregateItems = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.exit) {
      if (current.value !== null && typeof current.value === 'object') activePath.delete(current.value);
      continue;
    }
    if (current.depth > bounds.maxDepth) return `JSON nesting exceeds depth ${bounds.maxDepth}`;
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) return 'JSON numbers must be finite';
      continue;
    }
    if (typeof current.value === 'string') {
      if (utf8ByteLength(current.value) > bounds.maxStringBytes) {
        return `JSON strings must be at most ${bounds.maxStringBytes} UTF-8 bytes`;
      }
      continue;
    }
    if (typeof current.value !== 'object') return 'value is not JSON-compatible';
    if (activePath.has(current.value)) return 'cyclic values are not JSON-compatible';
    activePath.add(current.value);
    stack.push({ value: current.value, depth: current.depth, exit: true });

    if (Array.isArray(current.value)) {
      aggregateItems += current.value.length;
      if (aggregateItems > bounds.maxItems) return `JSON aggregate items exceed ${bounds.maxItems}`;
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        if (!Object.prototype.hasOwnProperty.call(current.value, index)) return 'sparse arrays are not JSON-compatible';
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) return 'JSON objects must be plain objects';
    const keys = Object.keys(current.value);
    if (Reflect.ownKeys(current.value).length !== keys.length) return 'JSON objects may only have enumerable string keys';
    aggregateItems += keys.length;
    if (aggregateItems > bounds.maxItems) return `JSON aggregate items exceed ${bounds.maxItems}`;
    for (const key of keys) {
      if (utf8ByteLength(key) > bounds.maxStringBytes) return `JSON keys must be at most ${bounds.maxStringBytes} UTF-8 bytes`;
      stack.push({ value: (current.value as Record<string, unknown>)[key], depth: current.depth + 1 });
    }
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return 'value is not JSON-compatible';
  }
  if (utf8ByteLength(encoded) > bounds.maxBytes) return `encoded JSON exceeds ${bounds.maxBytes} bytes`;
  return undefined;
}

export type BoundedJson =
  | string
  | number
  | boolean
  | null
  | BoundedJson[]
  | { [key: string]: BoundedJson };

export const boundedJsonSchema: z.ZodType<BoundedJson, z.ZodTypeDef, unknown> = z
  .unknown()
  .superRefine((value, ctx) => {
    const issue = validateJsonBounds(value, OPAQUE_JSON_BOUNDS);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  })
  .transform((value) => value as BoundedJson);

const capabilitySegment = '[a-z][a-z0-9]*(?:_[a-z0-9]+)*';
const capabilityIdPattern = new RegExp(`^${capabilitySegment}(?:\\.${capabilitySegment})+$`);
const extensionCapabilityIdPattern = new RegExp(
  `^ext\\.${capabilitySegment}\\.${capabilitySegment}(?:\\.${capabilitySegment})*$`,
);
/** Upstream's reserved top-level prefixes for its own (unported) core capability catalog. Kept
 * here only so `capabilityIdSchema` can tell "a malformed core id" apart from "a valid extension
 * id" -- this repo defines no capability under any of these prefixes itself. */
const reservedCapabilityPrefixes = new Set([
  'session',
  'interaction',
  'content',
  'model',
  'integration',
  'agents',
  'input',
  'output',
  'workspace',
  'isolation',
]);

/**
 * A capability id is either a reserved-prefix core id (`session.cancel`) or a product extension id
 * (`ext.<namespace>.<feature>`, e.g. `ext.open_vacancy_radar.model_select`). This schema validates
 * the *shape*, not membership in any catalog: an id can be well-formed and still refer to a
 * capability this build has never heard of, which is exactly the "unknown extension" case
 * `parseOpaqueExtensions` below is built to handle.
 */
export const capabilityIdSchema = z
  .string()
  .min(1)
  .regex(capabilityIdPattern, 'invalid capability id')
  .refine((value) => utf8ByteLength(value) <= MAX_WIRE_STRING_BYTES, {
    message: `must be at most ${MAX_WIRE_STRING_BYTES} UTF-8 bytes`,
  })
  .refine(
    (value) => reservedCapabilityPrefixes.has(value.slice(0, value.indexOf('.'))) || extensionCapabilityIdPattern.test(value),
    'capability IDs must use a reserved AgentDock prefix or ext.<namespace>.<feature>',
  );

/** The wire envelope for a capability whose meaning this build doesn't know: only its bounded JSON payload, never a typed shape. */
export type OpaqueCapabilityConstraints = { kind: 'opaque'; value: BoundedJson };

export const opaqueCapabilityConstraintsSchema = z.object({ kind: z.literal('opaque'), value: boundedJsonSchema }).strict();

/** One capability extension a peer declared, recorded exactly as received. */
export interface OpaqueExtension {
  id: string;
  constraints: OpaqueCapabilityConstraints;
}

export const opaqueExtensionSchema = z
  .object({ id: capabilityIdSchema, constraints: opaqueCapabilityConstraintsSchema })
  .strict();

export const opaqueExtensionListSchema = z
  .array(opaqueExtensionSchema)
  .max(MAX_EXTENSIONS)
  .superRefine((extensions, ctx) => {
    const ids = extensions.map((extension) => extension.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate capability extension ids are not allowed' });
    }
  });

/**
 * Strictly parses a list of capability extensions a peer declared. Throws (via Zod) on anything
 * malformed or over any bound -- "parseable" never means "parseable no matter how large," since an
 * unbounded payload is exactly what acceptance criterion 4 requires rejecting.
 */
export function parseOpaqueExtensions(raw: unknown): readonly OpaqueExtension[] {
  return opaqueExtensionListSchema.parse(raw);
}

/**
 * The model-selection extension id, written out as a literal rather than imported.
 *
 * Its home is `packages/vacancy-agent-adapter/src/model-select.ts` (ADI-03), which owns the
 * resolver, the value schema, and the constraint builder. That package **depends on this one**, so
 * importing the constant back from it would create a cycle between the two workspace packages; the
 * literal is therefore duplicated here on purpose, and
 * `packages/vacancy-agent-adapter/test/model-select.test.ts` pins the two copies as equal. That
 * drift guard is the whole reason the duplication is acceptable: without it, the two packages could
 * silently disagree on the id string, and the daemon would answer `unsupported_capability` for the
 * one capability it actually implements.
 */
export const MODEL_SELECT_CAPABILITY_ID = 'ext.open_vacancy_radar.model_select';

/**
 * The capability extensions this build actually implements: the single place that changes when one
 * is activated. Keeping it as a real list rather than skipping activation entirely makes "inactive"
 * a checkable fact instead of an implicit absence of code -- see `isCapabilityExtensionActive`.
 *
 * ADI-13 is the ticket that added the first entry, and it did so only once there was a real handler
 * behind the id: `POST /v2/sessions` resolves a requested model-select capability against the
 * provider's own reviewed catalog (see apps/daemon/src/routes/v2-sessions-create.ts). An id absent
 * from this list is never a request failure -- it is reported as `unsupported_capability` in the
 * session's `unavailableOptional`, so a newer client asking an older daemon for something it has
 * never heard of still gets a session.
 */
export const ACTIVE_CAPABILITY_EXTENSION_IDS: readonly string[] = Object.freeze([
  MODEL_SELECT_CAPABILITY_ID,
]);

export function isCapabilityExtensionActive(id: string): boolean {
  return ACTIVE_CAPABILITY_EXTENSION_IDS.includes(id);
}
