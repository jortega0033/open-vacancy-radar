import {
  digestOfText,
  digestOfUnknown,
  truncateToBytes,
  utf8Bytes,
  type AgentEventEnvelope,
  type AgentEventType,
} from '@agent-dock/shared';
import type { ActivityDigest, ActivityEntry, ActivityText, HistoryEntry } from './agent-workspace-types.js';

/**
 * Turns a raw v1 `AgentEventEnvelope` into the bounded, identifier-free `ActivityEntry` the
 * renderer is allowed to see (ADI-07).
 *
 * ## Why this exists at all
 *
 * The v2 read routes ADI-05 built are **content-free by design**: the durable session store never
 * writes a character of model output, so `GET /v2/sessions/:id/events` can only ever answer with
 * digests. That is the right rule for a file on disk and the wrong answer for a live timeline --
 * a user watching a session run wants to read what the agent is saying, not a list of SHA-256
 * hashes. So ADI-07 relays the *live* v1 SSE stream, per v2 session id, through this function.
 *
 * That makes this the ADI-07 counterpart of ADI-05's `redactEnvelope`, with one deliberately
 * different rule and every other rule identical:
 *
 * | field | `redactEnvelope` (to disk) | `toActivityEntry` (to renderer) |
 * |---|---|---|
 * | `assistant.message.text`, `thinking.delta.text` | digested | **kept**, byte-capped, flagged |
 * | `providerSessionId` | kept (bounded) | **dropped** |
 * | `toolCallId` | kept (bounded) | **replaced with a local alias** |
 * | `tool.*` input/result | digested | digested |
 * | `status.detail` | digested | dropped |
 * | `error.message`, `session.failed.message` | digested | dropped |
 *
 * The prose is kept because the renderer is where it is *for*: it is the user's own model output,
 * displayed on their own screen, in the same process that already renders their CV text and their
 * saved-job notes. The two identifier columns go the other way for the opposite reason: the disk
 * keeps them because a lineage reader acts on them, and the renderer has no legitimate use for
 * either -- a native provider thread id is a resume capability, and a native tool-call id is a
 * correlation key the alias below already provides.
 *
 * ## The `never` default branch is the whole safety argument
 *
 * Read the `default` case first. TypeScript narrows the discriminated union case by case, so
 * reaching it with anything other than `never` means a variant was added to `packages/shared` and
 * not handled here -- a build failure, rather than an event quietly falling through some
 * permissive catch-all that might carry its content. `agent-activity-sanitize.test.ts` closes the
 * remaining gap at runtime, by extracting the literal `type` values out of
 * `agentEventEnvelopeSchema` and requiring this switch's covered set to match exactly.
 */

/**
 * Per-entry cap on kept prose.
 *
 * 8 KB is far more than any single `assistant.message` a CLI legitimately emits in one frame, and
 * far less than a size at which one hostile frame could wedge the renderer. Past it the text is
 * cut and `textTruncated` is set, so the UI states the truncation rather than silently showing a
 * partial answer as if it were whole.
 */
export const MAX_TEXT_BYTES_PER_ENTRY = 8_000;

/** Same cap ADI-05 applies to `status`, for the same reason: a short adapter label, not content. */
const MAX_STATUS_BYTES = 256;
const MAX_TOOL_NAME_BYTES = 256;
const MAX_ERROR_CODE_BYTES = 64;
/** A timestamp is an ISO-8601 instant. Bounded because it arrives from the daemon over HTTP. */
const MAX_TIMESTAMP_BYTES = 64;
const MAX_PROVIDER_BYTES = 64;

/**
 * An error `code` is an identifier, never prose.
 *
 * Note this is an **anchored full-string test**, not ADI-05's character-class strip. The disk
 * store can afford to salvage a partly-valid code because nothing renders it as a sentence; here
 * the code selects a row in a closed renderer-side copy table, so a value that is not already a
 * clean identifier has no row to select and is better dropped than laundered into one.
 */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Mints a stable, per-session, local alias for a native tool-call id.
 *
 * The native id never crosses to the renderer, but a `tool.started` and its matching
 * `tool.completed` still have to be pairable in the UI -- otherwise a session that ran six tools
 * renders as twelve unrelated rows. `t1`, `t2`, ... are minted in first-seen order and remembered
 * in the caller's map, so the same native id always maps to the same alias within one session and
 * two different native ids can never collide onto one alias.
 *
 * The map is the caller's, not this module's, on purpose: the relay owns exactly one per attached
 * session, and the history reader uses that same map, so a live entry and a history entry for the
 * same tool call agree on the alias.
 */
export function aliasForToolCall(aliases: Map<string, string>, nativeId: string): string {
  const existing = aliases.get(nativeId);
  if (existing !== undefined) return existing;
  const alias = `t${aliases.size + 1}`;
  aliases.set(nativeId, alias);
  return alias;
}

/** Keeps prose up to the per-entry cap, flagging the cut rather than hiding it. */
function keptText(text: string): ActivityText {
  const bytes = utf8Bytes(text);
  if (bytes <= MAX_TEXT_BYTES_PER_ENTRY) return { text };
  return { text: truncateToBytes(text, MAX_TEXT_BYTES_PER_ENTRY), textTruncated: true };
}

/** `Number.isFinite` or nothing: `NaN`, `Infinity`, and a non-number all become absent. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toDigest(value: { bytes: number; sha256: string }): ActivityDigest {
  return { bytes: value.bytes, sha256: value.sha256 };
}

/**
 * The exhaustive projection. Returns `null` only for an envelope whose `sequence` is not a real
 * non-negative integer: the timeline is a sorted structure keyed on that number, and an entry that
 * cannot be ordered is worse than an entry that is missing.
 */
export function toActivityEntry(
  envelope: AgentEventEnvelope,
  toolAliases: Map<string, string>,
): ActivityEntry | null {
  const seq = envelope.sequence;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;

  const base = {
    seq,
    at: typeof envelope.timestamp === 'string' ? truncateToBytes(envelope.timestamp, MAX_TIMESTAMP_BYTES) : '',
    origin: 'live' as const,
  };

  switch (envelope.type) {
    case 'session.started':
      // `sessionId` is dropped (the push envelope already names the session, and repeating it here
      // would be a second place for the two to disagree) and so is `providerSessionId`, which is
      // the provider CLI's own native thread identifier.
      return {
        ...base,
        kind: 'session.started',
        provider: truncateToBytes(String(envelope.provider), MAX_PROVIDER_BYTES),
      };

    case 'status':
      // The bounded label is kept; `detail` is free-form CLI prose about the label and is dropped
      // outright. Unlike `assistant.message`, nothing about a status detail is content the user
      // asked the model for, so there is no reason to spend the boundary's budget on it.
      return { ...base, kind: 'status', status: truncateToBytes(envelope.status, MAX_STATUS_BYTES) };

    case 'assistant.message':
      return { ...base, kind: 'assistant.message', ...keptText(envelope.text) };

    case 'thinking.delta':
      return { ...base, kind: 'thinking.delta', ...keptText(envelope.text) };

    case 'tool.started': {
      const input = envelope.input === undefined ? undefined : toDigest(digestOfUnknown(envelope.input));
      return {
        ...base,
        kind: 'tool.started',
        toolName: truncateToBytes(envelope.toolName, MAX_TOOL_NAME_BYTES),
        ...(envelope.toolCallId === undefined
          ? {}
          : { toolAlias: aliasForToolCall(toolAliases, envelope.toolCallId) }),
        ...(input === undefined ? {} : { input }),
      };
    }

    case 'tool.completed': {
      const result = envelope.result === undefined ? undefined : toDigest(digestOfUnknown(envelope.result));
      return {
        ...base,
        kind: 'tool.completed',
        ...(envelope.toolName === undefined
          ? {}
          : { toolName: truncateToBytes(envelope.toolName, MAX_TOOL_NAME_BYTES) }),
        ...(envelope.toolCallId === undefined
          ? {}
          : { toolAlias: aliasForToolCall(toolAliases, envelope.toolCallId) }),
        ...(envelope.isError === undefined ? {} : { isError: envelope.isError === true }),
        ...(result === undefined ? {} : { result }),
      };
    }

    case 'usage': {
      const inputTokens = finiteNumber(envelope.inputTokens);
      const outputTokens = finiteNumber(envelope.outputTokens);
      const cachedInputTokens = finiteNumber(envelope.cachedInputTokens);
      const cost = finiteNumber(envelope.cost);
      return {
        ...base,
        kind: 'usage',
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(cost === undefined ? {} : { cost }),
      };
    }

    case 'error':
      // `message` is never passed through. The user-facing sentence comes from a closed table in
      // `src/components/agent-workspace/refusal-copy.ts`, selected by this `code`, exactly as
      // main.ts's `DAEMON_REFUSAL_MESSAGES` chooses one by the daemon's code rather than quoting
      // its `error` text. A message this build did not write can therefore never be rendered.
      return {
        ...base,
        kind: 'error',
        ...(envelope.code !== undefined && ERROR_CODE_PATTERN.test(envelope.code)
          ? { code: truncateToBytes(envelope.code, MAX_ERROR_CODE_BYTES) }
          : {}),
        recoverable: envelope.recoverable === true,
      };

    case 'session.completed':
      // `providerSessionId` dropped, same as `session.started`.
      return { ...base, kind: 'session.completed' };

    case 'session.failed':
      // `message` dropped for the reason `error` drops its own.
      return { ...base, kind: 'session.failed' };

    case 'session.cancelled':
      return { ...base, kind: 'session.cancelled' };

    default: {
      // See this function's docstring: reaching here with anything but `never` is a compile error.
      const unhandled: never = envelope;
      throw new Error(
        `unhandled agent event type in toActivityEntry: ${String((unhandled as { type?: unknown }).type)}`,
      );
    }
  }
}

/**
 * The inventory of variants the switch above covers, checked against `AgentEventType` at compile
 * time and against `agentEventEnvelopeSchema` at runtime by this module's test.
 *
 * Duplicating ADI-05's `REDACTED_EVENT_TYPE_TUPLE` pattern rather than importing it: that constant
 * lives in `apps/daemon`, which the desktop app has no dependency on, and the point of the tuple
 * is to be the *local* switch's own inventory anyway.
 */
const SANITIZED_EVENT_TYPE_TUPLE = [
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

type MissingSanitizedEventType = Exclude<AgentEventType, (typeof SANITIZED_EVENT_TYPE_TUPLE)[number]>;
const _allEventTypesSanitized: MissingSanitizedEventType extends never ? true : MissingSanitizedEventType = true;
void _allEventTypesSanitized;

export const SANITIZED_EVENT_TYPES: readonly AgentEventType[] = SANITIZED_EVENT_TYPE_TUPLE;

/*
 * ---------------------------------------------------------------------------------------------
 * The durable-history half.
 *
 * `GET /v2/sessions/:id/events` returns `PersistedEventRecordV1`s: already content-free, but
 * carrying the two identifiers this boundary drops (`providerSessionId`, native `toolCallId`) and
 * arriving as untrusted JSON over HTTP. So it is validated field by field here rather than cast,
 * and mapped onto the *same* `ActivityEntry` shape the live path produces, so the timeline merge
 * has one type to reason about instead of two.
 * ---------------------------------------------------------------------------------------------
 */

function readString(source: Record<string, unknown>, key: string, maxBytes: number): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? truncateToBytes(value, maxBytes) : undefined;
}

function asDigest(bytes: unknown, sha256: unknown): ActivityDigest | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (typeof sha256 !== 'string') return undefined;
  return { bytes, sha256: truncateToBytes(sha256, 64) };
}

/** A `{ <prefix>Bytes, <prefix>Sha256 }` pair from the persisted record, or nothing. */
function readDigest(source: Record<string, unknown>, prefix: string): ActivityDigest | undefined {
  return asDigest(source[`${prefix}Bytes`], source[`${prefix}Sha256`]);
}

/** The unprefixed `{ bytes, sha256 }` pair the two prose records carry. */
function readBareDigest(source: Record<string, unknown>): ActivityDigest | undefined {
  return asDigest(source.bytes, source.sha256);
}

/**
 * Projects one persisted event record onto a `HistoryEntry`.
 *
 * Returns `null` for a record this build cannot interpret -- an unknown `type`, or a `sequence`
 * that is not a real index. Unlike the live path, an unrecognized `type` here is **not** a compile
 * error and must not be: the durable log is written by a daemon that may be a different build, and
 * a record from a newer one is a thing to skip, not a thing to crash the timeline over. The
 * compile-time exhaustiveness that matters is on the live switch, which is the only path that ever
 * sees raw content.
 */
export function toHistoryEntry(record: unknown, toolAliases: Map<string, string>): HistoryEntry | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const source = record as Record<string, unknown>;

  const seq = source.sequence;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;

  const base = {
    seq,
    at: readString(source, 'timestamp', MAX_TIMESTAMP_BYTES) ?? '',
    origin: 'history' as const,
  };

  const alias = (): string | undefined => {
    const nativeId = source.toolCallId;
    return typeof nativeId === 'string' ? aliasForToolCall(toolAliases, nativeId) : undefined;
  };

  switch (source.type) {
    case 'session.started':
      return {
        ...base,
        kind: 'session.started',
        provider: readString(source, 'provider', MAX_PROVIDER_BYTES) ?? '',
      };

    case 'status':
      // The persisted record also carries `detailBytes`/`detailSha256`. Dropped, so a history
      // entry and a live entry for the same `status` event are field-for-field identical and the
      // merge has nothing to reconcile.
      return { ...base, kind: 'status', status: readString(source, 'status', MAX_STATUS_BYTES) ?? '' };

    // The two prose variants are written out separately rather than sharing one branch: the
    // persisted record spells their digest as bare `bytes`/`sha256` (not a prefixed pair), and
    // `kind` has to be a literal for the union to narrow.
    case 'assistant.message': {
      const digest = readBareDigest(source);
      return { ...base, kind: 'assistant.message', ...(digest === undefined ? {} : { digest }) };
    }

    case 'thinking.delta': {
      const digest = readBareDigest(source);
      return { ...base, kind: 'thinking.delta', ...(digest === undefined ? {} : { digest }) };
    }

    case 'tool.started': {
      const toolAlias = alias();
      const input = readDigest(source, 'input');
      return {
        ...base,
        kind: 'tool.started',
        toolName: readString(source, 'toolName', MAX_TOOL_NAME_BYTES) ?? '',
        ...(toolAlias === undefined ? {} : { toolAlias }),
        ...(input === undefined ? {} : { input }),
      };
    }

    case 'tool.completed': {
      const toolAlias = alias();
      const toolName = readString(source, 'toolName', MAX_TOOL_NAME_BYTES);
      const result = readDigest(source, 'result');
      return {
        ...base,
        kind: 'tool.completed',
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolAlias === undefined ? {} : { toolAlias }),
        ...(typeof source.isError === 'boolean' ? { isError: source.isError } : {}),
        ...(result === undefined ? {} : { result }),
      };
    }

    case 'usage': {
      const inputTokens = finiteNumber(source.inputTokens);
      const outputTokens = finiteNumber(source.outputTokens);
      const cachedInputTokens = finiteNumber(source.cachedInputTokens);
      const cost = finiteNumber(source.cost);
      return {
        ...base,
        kind: 'usage',
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(cost === undefined ? {} : { cost }),
      };
    }

    case 'error': {
      const code = typeof source.code === 'string' && ERROR_CODE_PATTERN.test(source.code) ? source.code : undefined;
      return {
        ...base,
        kind: 'error',
        ...(code === undefined ? {} : { code: truncateToBytes(code, MAX_ERROR_CODE_BYTES) }),
        recoverable: source.recoverable === true,
      };
    }

    case 'session.completed':
      return { ...base, kind: 'session.completed' };

    case 'session.failed':
      return { ...base, kind: 'session.failed' };

    case 'session.cancelled':
      return { ...base, kind: 'session.cancelled' };

    case 'session.interrupted':
      return { ...base, kind: 'session.interrupted' };

    default:
      return null;
  }
}

/**
 * Re-exported so the relay and the tests import the digest helpers through one module rather than
 * reaching into `@agent-dock/shared` for something this file is already responsible for.
 */
export { digestOfText, digestOfUnknown };
