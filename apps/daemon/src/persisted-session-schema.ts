import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  providerIdSchema,
  sessionStatusV2Schema,
  terminalReasonV2Schema,
  unknownFrameViewSchema,
  type AgentEventEnvelope,
  type AgentEventType,
  type AgentSession,
  type ProviderId,
  type SessionStatusV2,
  type TerminalReasonV2,
} from '@agent-dock/shared';
import type { NormalizedUnknownFrame } from '@agent-dock/agent-runtime';

/**
 * The on-disk shape of the durable session store, and the redaction that produces it.
 *
 * ## The one rule
 *
 * **No event content is ever written to disk.** Not prompt text, not assistant messages, not
 * thinking deltas, not tool inputs or results, not error or failure messages. Every content-bearing
 * field is replaced by a `{ ...Bytes, ...Sha256 }` pair: enough to answer "did the same thing
 * happen twice?", "how big was it?", and "does this match what the user reported?", and not enough
 * to reconstruct a single character of it.
 *
 * This is not a policy that a reviewer has to enforce by reading carefully. It is enforced three
 * ways, and all three are load-bearing:
 *
 * 1. `redactEnvelope`'s switch is exhaustive over the `AgentEvent` discriminated union, with a
 *    `never` assignment in the default branch. Adding an event variant to `packages/shared` without
 *    adding a case here is a **compile error**, not a silently unhandled event that falls through
 *    to some permissive default.
 * 2. `REDACTED_V1_EVENT_TYPES` is checked against the union at compile time in the same way, and
 *    `apps/daemon/test/persisted-session-schema.test.ts` additionally extracts the real literal
 *    `type` values out of `agentEventEnvelopeSchema` at *runtime* and asserts the two sets match
 *    exactly -- so a variant added to the Zod schema but not to the TypeScript union (or vice
 *    versa) is caught too.
 * 3. Both persisted shapes are `.strict()` Zod schemas, so a record carrying `prompt` or `error`
 *    fails to parse rather than merely failing a code review.
 */

/** Bumped only for an incompatible change to the shapes in this file. See the store's preflight. */
export const PERSISTED_SCHEMA_VERSION = 1;

/**
 * What a v1 client is shown for a session the daemon recovered as `interrupted` after a restart.
 *
 * v1's `sessionStatusSchema` has no `'interrupted'` member and is frozen, so the recovered state is
 * projected onto the nearest honest v1 answer -- `failed`, plus this exact string as the `error` --
 * rather than inventing a status a v1 client was never built to render. A v2 client sees the real
 * `status: 'interrupted'` with `terminalReason: 'daemon_restart'`.
 */
export const INTERRUPTED_SESSION_V1_ERROR = 'daemon restarted before the session completed';

const MAX_STATUS_BYTES = 256;
const MAX_TOOL_NAME_BYTES = 256;
const MAX_ERROR_CODE_BYTES = 128;
/** An error `code` is an identifier, never prose: anything outside this charset is dropped. */
const ERROR_CODE_DISALLOWED = /[^A-Za-z0-9._-]+/g;

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Truncates on the UTF-8 byte sequence, then drops a trailing partial character.
 *
 * Slicing bytes can cut a multi-byte character in half, which decodes to U+FFFD -- itself three
 * bytes, which can push the result back over the budget. Dropping the last code unit in that case
 * keeps the guarantee the caller actually needs ("never more than N bytes") rather than an
 * approximate one.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return utf8Bytes(cut) <= maxBytes ? cut : cut.slice(0, -1);
}

/**
 * The canonical string form of an `unknown` payload (`tool.started.input`,
 * `tool.completed.result`), used only as hash input and never stored.
 *
 * A value that cannot be serialized (circular, a BigInt) still needs *some* stable digest, because
 * silently omitting the pair would make "this tool produced nothing" and "this tool produced
 * something we could not encode" indistinguishable on disk. The sentinel below is a constant, so it
 * leaks nothing while remaining recognizable.
 */
const UNSERIALIZABLE_SENTINEL = '<unserializable>';

function digestOfUnknown(value: unknown): { bytes: number; sha256: string } {
  let text: string;
  try {
    const encoded = JSON.stringify(value);
    text = encoded === undefined ? UNSERIALIZABLE_SENTINEL : encoded;
  } catch {
    text = UNSERIALIZABLE_SENTINEL;
  }
  return { bytes: utf8Bytes(text), sha256: sha256Of(text) };
}

function digestOfText(text: string): { bytes: number; sha256: string } {
  return { bytes: utf8Bytes(text), sha256: sha256Of(text) };
}

// ---------------------------------------------------------------------------------------------
// Persisted event records
// ---------------------------------------------------------------------------------------------

interface PersistedEventBase {
  readonly v: 1;
  readonly sequence: number;
  readonly timestamp: string;
}

export type PersistedEventRecordV1 = PersistedEventBase &
  (
    | { type: 'session.started'; sessionId: string; provider: ProviderId; providerSessionId?: string }
    | { type: 'status'; status: string; detailBytes?: number; detailSha256?: string }
    | { type: 'assistant.message'; bytes: number; sha256: string }
    | { type: 'thinking.delta'; bytes: number; sha256: string }
    | {
        type: 'tool.started';
        toolName: string;
        toolCallId?: string;
        inputBytes?: number;
        inputSha256?: string;
      }
    | {
        type: 'tool.completed';
        toolName?: string;
        toolCallId?: string;
        isError?: boolean;
        resultBytes?: number;
        resultSha256?: string;
      }
    | {
        type: 'usage';
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        cost?: number;
      }
    | { type: 'error'; code?: string; recoverable: boolean; messageBytes: number; messageSha256: string }
    | { type: 'session.completed'; providerSessionId?: string }
    | { type: 'session.failed'; messageBytes: number; messageSha256: string }
    | { type: 'session.cancelled' }
    /**
     * Synthetic, written only by the store's crash-recovery pass. It has no v1 counterpart and no
     * provider ever produces it: it records that a session which was still `starting`/`running`
     * when the daemon stopped was closed out by the *next* daemon, not by its provider.
     */
    | { type: 'session.interrupted'; reason: 'daemon_restart' }
  );

const persistedEventBaseShape = {
  v: z.literal(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
};

export const persistedEventRecordV1Schema = z.discriminatedUnion('type', [
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('session.started'),
      sessionId: z.string(),
      provider: providerIdSchema,
      providerSessionId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('status'),
      status: z.string(),
      detailBytes: z.number().int().nonnegative().optional(),
      detailSha256: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('assistant.message'),
      bytes: z.number().int().nonnegative(),
      sha256: z.string(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('thinking.delta'),
      bytes: z.number().int().nonnegative(),
      sha256: z.string(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('tool.started'),
      toolName: z.string(),
      toolCallId: z.string().optional(),
      inputBytes: z.number().int().nonnegative().optional(),
      inputSha256: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('tool.completed'),
      toolName: z.string().optional(),
      toolCallId: z.string().optional(),
      isError: z.boolean().optional(),
      resultBytes: z.number().int().nonnegative().optional(),
      resultSha256: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('usage'),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cachedInputTokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('error'),
      code: z.string().optional(),
      recoverable: z.boolean(),
      messageBytes: z.number().int().nonnegative(),
      messageSha256: z.string(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('session.completed'),
      providerSessionId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('session.failed'),
      messageBytes: z.number().int().nonnegative(),
      messageSha256: z.string(),
    })
    .strict(),
  z.object({ ...persistedEventBaseShape, type: z.literal('session.cancelled') }).strict(),
  z
    .object({
      ...persistedEventBaseShape,
      type: z.literal('session.interrupted'),
      reason: z.literal('daemon_restart'),
    })
    .strict(),
]);

/**
 * The v1 event types `redactEnvelope` handles. Declared as a `const` tuple and checked against the
 * union below, so this list cannot drift from the switch or from `AgentEvent`.
 */
const REDACTED_EVENT_TYPE_TUPLE = [
  'session.started',
  'status',
  'assistant.message',
  'thinking.delta',
  'tool.started',
  'tool.completed',
  'usage',
  'error',
  'session.completed',
  'session.failed',
  'session.cancelled',
] as const satisfies readonly AgentEventType[];

/**
 * Compile-time exhaustiveness for the list above: if `AgentEvent` gains a variant that is missing
 * from `REDACTED_EVENT_TYPE_TUPLE`, this type resolves to that type name instead of `never` and the
 * assignment fails to compile. The `never` branch inside `redactEnvelope` covers the switch itself;
 * this covers the exported inventory the tests and docs read from.
 */
type MissingRedactedEventType = Exclude<AgentEventType, (typeof REDACTED_EVENT_TYPE_TUPLE)[number]>;
const _allEventTypesRedacted: MissingRedactedEventType extends never ? true : MissingRedactedEventType = true;
void _allEventTypesRedacted;

export const REDACTED_V1_EVENT_TYPES: readonly AgentEventType[] = REDACTED_EVENT_TYPE_TUPLE;

/**
 * Turns one v1 event envelope into its content-free persisted form.
 *
 * Read the `default` branch first: `envelope satisfies never` is what makes this function safe to
 * trust over time. TypeScript narrows the discriminated union case by case, so reaching the default
 * with anything other than `never` means a variant was added upstream and not handled here -- and
 * that is a build failure rather than an event that quietly gets persisted through some catch-all
 * path that might carry its content.
 */
export function redactEnvelope(envelope: AgentEventEnvelope): PersistedEventRecordV1 {
  const base = { v: 1, sequence: envelope.sequence, timestamp: envelope.timestamp } as const;

  switch (envelope.type) {
    case 'session.started':
      return {
        ...base,
        type: 'session.started',
        sessionId: envelope.sessionId,
        provider: envelope.provider,
        ...(envelope.providerSessionId === undefined ? {} : { providerSessionId: envelope.providerSessionId }),
      };

    case 'status': {
      // `status` is a short adapter-authored label (`"thinking"`, `"tool_use"`), not user content,
      // so it is kept -- bounded, because it still originates in a provider's stdout. `detail` is
      // free-form prose from the CLI and is digested, never kept.
      const detail = envelope.detail === undefined ? undefined : digestOfText(envelope.detail);
      return {
        ...base,
        type: 'status',
        status: truncateToBytes(envelope.status, MAX_STATUS_BYTES),
        ...(detail === undefined ? {} : { detailBytes: detail.bytes, detailSha256: detail.sha256 }),
      };
    }

    case 'assistant.message':
      return { ...base, type: 'assistant.message', ...digestOfText(envelope.text) };

    case 'thinking.delta':
      return { ...base, type: 'thinking.delta', ...digestOfText(envelope.text) };

    case 'tool.started': {
      const input = envelope.input === undefined ? undefined : digestOfUnknown(envelope.input);
      return {
        ...base,
        type: 'tool.started',
        toolName: truncateToBytes(envelope.toolName, MAX_TOOL_NAME_BYTES),
        ...(envelope.toolCallId === undefined ? {} : { toolCallId: envelope.toolCallId }),
        ...(input === undefined ? {} : { inputBytes: input.bytes, inputSha256: input.sha256 }),
      };
    }

    case 'tool.completed': {
      const result = envelope.result === undefined ? undefined : digestOfUnknown(envelope.result);
      return {
        ...base,
        type: 'tool.completed',
        ...(envelope.toolName === undefined
          ? {}
          : { toolName: truncateToBytes(envelope.toolName, MAX_TOOL_NAME_BYTES) }),
        ...(envelope.toolCallId === undefined ? {} : { toolCallId: envelope.toolCallId }),
        ...(envelope.isError === undefined ? {} : { isError: envelope.isError }),
        ...(result === undefined ? {} : { resultBytes: result.bytes, resultSha256: result.sha256 }),
      };
    }

    case 'usage':
      return {
        ...base,
        type: 'usage',
        ...(envelope.inputTokens === undefined ? {} : { inputTokens: envelope.inputTokens }),
        ...(envelope.outputTokens === undefined ? {} : { outputTokens: envelope.outputTokens }),
        ...(envelope.cachedInputTokens === undefined ? {} : { cachedInputTokens: envelope.cachedInputTokens }),
        ...(envelope.cost === undefined ? {} : { cost: envelope.cost }),
      };

    case 'error': {
      const code =
        envelope.code === undefined
          ? undefined
          : truncateToBytes(envelope.code.replace(ERROR_CODE_DISALLOWED, ''), MAX_ERROR_CODE_BYTES);
      const message = digestOfText(envelope.message);
      return {
        ...base,
        type: 'error',
        ...(code === undefined || code.length === 0 ? {} : { code }),
        recoverable: envelope.recoverable,
        messageBytes: message.bytes,
        messageSha256: message.sha256,
      };
    }

    case 'session.completed':
      return {
        ...base,
        type: 'session.completed',
        ...(envelope.providerSessionId === undefined ? {} : { providerSessionId: envelope.providerSessionId }),
      };

    case 'session.failed': {
      const message = digestOfText(envelope.message);
      return { ...base, type: 'session.failed', messageBytes: message.bytes, messageSha256: message.sha256 };
    }

    case 'session.cancelled':
      return { ...base, type: 'session.cancelled' };

    default: {
      // See this function's docstring: reaching here with anything but `never` is a compile error.
      const unhandled: never = envelope;
      throw new Error(
        `unhandled agent event type in redactEnvelope: ${String((unhandled as { type?: unknown }).type)}`,
      );
    }
  }
}

/** Builds the synthetic record the recovery pass appends for an interrupted session. */
export function interruptedEventRecord(sequence: number, timestamp: string): PersistedEventRecordV1 {
  return { v: 1, sequence, timestamp, type: 'session.interrupted', reason: 'daemon_restart' };
}

// ---------------------------------------------------------------------------------------------
// Persisted session records
// ---------------------------------------------------------------------------------------------

export interface PersistedLaunchScope {
  executablePath?: string;
  providerVersion?: string;
  authenticated: string;
  platform: string;
  accountEvidence: 'cli_owned';
}

/**
 * The persisted `acceptedWork` domain, deliberately **narrower** than `AcceptedWorkState`.
 *
 * `'not_accepted'` is missing on purpose and its absence is the safety property. `'not_accepted'`
 * is a positive claim that nothing was delivered to the provider, and the only moment that claim is
 * provable is *before the record exists at all* -- by the time a record is on disk, the daemon has
 * committed to launching, and a crash in the next microsecond leaves us unable to prove the prompt
 * did not reach the CLI. So a fresh record is written `'unknown'` (fail-closed: not safe to retry),
 * and the single permitted transition is `unknown -> accepted`. Nothing can ever move it back down.
 */
export type PersistedAcceptedWork = 'unknown' | 'accepted';

export interface PersistedSessionRecordV1 {
  schemaVersion: 1;
  protocolVersion: 1 | 2;
  session: {
    id: string;
    provider: ProviderId;
    cwd: string;
    model?: string;
    status: SessionStatusV2;
    terminalReason?: TerminalReasonV2;
    providerSessionId?: string;
    startedAt: string;
    completedAt?: string;
    acceptedWork: PersistedAcceptedWork;
    transportId: 'legacy-one-shot';
    rootSessionId: string;
    parentSessionId?: string;
    continuationKind: 'fresh' | 'resume';
    earliestSequence: number;
    eventCount: number;
    eventsTruncated: boolean;
    scope: PersistedLaunchScope;
    unknownFrames: NormalizedUnknownFrame[];
  };
}

export const persistedLaunchScopeSchema = z
  .object({
    executablePath: z.string().optional(),
    providerVersion: z.string().optional(),
    authenticated: z.string(),
    platform: z.string(),
    accountEvidence: z.literal('cli_owned'),
  })
  .strict();

export const persistedSessionRecordV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.union([z.literal(1), z.literal(2)]),
    session: z
      .object({
        id: z.string().uuid(),
        provider: providerIdSchema,
        cwd: z.string(),
        model: z.string().optional(),
        status: sessionStatusV2Schema,
        terminalReason: terminalReasonV2Schema.optional(),
        providerSessionId: z.string().optional(),
        startedAt: z.string(),
        completedAt: z.string().optional(),
        acceptedWork: z.enum(['unknown', 'accepted']),
        transportId: z.literal('legacy-one-shot'),
        rootSessionId: z.string().uuid(),
        parentSessionId: z.string().uuid().optional(),
        continuationKind: z.enum(['fresh', 'resume']),
        earliestSequence: z.number().int().nonnegative(),
        eventCount: z.number().int().nonnegative(),
        eventsTruncated: z.boolean(),
        scope: persistedLaunchScopeSchema,
        unknownFrames: z.array(unknownFrameViewSchema),
      })
      .strict(),
  })
  .strict();

export interface RedactSessionExtras {
  protocolVersion: 1 | 2;
  status: SessionStatusV2;
  terminalReason?: TerminalReasonV2;
  acceptedWork: PersistedAcceptedWork;
  rootSessionId: string;
  parentSessionId?: string;
  continuationKind: 'fresh' | 'resume';
  earliestSequence: number;
  eventCount: number;
  eventsTruncated: boolean;
  scope: PersistedLaunchScope;
  unknownFrames: NormalizedUnknownFrame[];
}

/**
 * Projects a live `AgentSession` onto its persisted form.
 *
 * `prompt` and `error` are removed by **destructuring them into named, unused bindings** rather
 * than by listing the fields we do want. Both approaches produce the same object today, but only
 * this one keeps working when `AgentSession` gains a field: an explicit allowlist would silently
 * drop a new field (fine), while a spread-minus-omissions makes a new content-bearing field visible
 * at this exact line, where somebody has to decide about it. The `rest` binding is deliberately
 * never spread into the result for the same reason -- it exists to name what is being discarded.
 */
export function redactSessionForPersistence(
  session: AgentSession,
  extra: RedactSessionExtras,
): PersistedSessionRecordV1 {
  const { prompt: _discardedPrompt, error: _discardedError, ...safe } = session;
  void _discardedPrompt;
  void _discardedError;

  return {
    schemaVersion: 1,
    protocolVersion: extra.protocolVersion,
    session: {
      id: safe.id,
      provider: safe.provider,
      cwd: safe.cwd,
      ...(safe.model === undefined ? {} : { model: safe.model }),
      status: extra.status,
      ...(extra.terminalReason === undefined ? {} : { terminalReason: extra.terminalReason }),
      ...(safe.providerSessionId === undefined ? {} : { providerSessionId: safe.providerSessionId }),
      startedAt: safe.startedAt,
      ...(safe.completedAt === undefined ? {} : { completedAt: safe.completedAt }),
      acceptedWork: extra.acceptedWork,
      transportId: 'legacy-one-shot',
      rootSessionId: extra.rootSessionId,
      ...(extra.parentSessionId === undefined ? {} : { parentSessionId: extra.parentSessionId }),
      continuationKind: extra.continuationKind,
      earliestSequence: extra.earliestSequence,
      eventCount: extra.eventCount,
      eventsTruncated: extra.eventsTruncated,
      scope: extra.scope,
      unknownFrames: extra.unknownFrames,
    },
  };
}

/**
 * Projects a persisted record back onto the v1 `AgentSession` a v1 client expects.
 *
 * `prompt` cannot be recovered -- it was never written -- so it comes back as the empty string.
 * That is the honest answer: the field is required by the frozen v1 shape, and fabricating a
 * placeholder like `"(recovered)"` would be indistinguishable from a real prompt to any client
 * rendering it.
 */
export function toV1Session(record: PersistedSessionRecordV1): AgentSession {
  const s = record.session;
  const interrupted = s.status === 'interrupted';
  return {
    id: s.id,
    provider: s.provider,
    cwd: s.cwd,
    prompt: '',
    ...(s.model === undefined ? {} : { model: s.model }),
    status: interrupted ? 'failed' : (s.status as AgentSession['status']),
    ...(s.providerSessionId === undefined ? {} : { providerSessionId: s.providerSessionId }),
    ...(interrupted ? { error: INTERRUPTED_SESSION_V1_ERROR } : {}),
    startedAt: s.startedAt,
    ...(s.completedAt === undefined ? {} : { completedAt: s.completedAt }),
  };
}
