import { createHash } from 'node:crypto';
import { utf8ByteLength, validateJsonBounds, type JsonBounds } from '@agent-dock/shared';

/**
 * Size limits applied to a single provider stdout frame before it is considered for the ledger.
 *
 * Deliberately **not** `OPAQUE_JSON_BOUNDS` from `@agent-dock/shared`, even though that constant
 * exists and would type-check here. That one bounds capability-constraint payloads travelling over
 * the v2 negotiation wire — small, structured, authored by us — and is tuned tight
 * (a few kilobytes, 256-byte strings) precisely because nothing legitimate on that wire is large.
 *
 * A provider CLI frame is a completely different population. A single `tool.completed` frame can
 * legitimately carry the entire stdout of a build, a full file diff, or a large MCP tool result;
 * `run-session.ts` already tolerates 200 KB of stderr for one session. Reusing the negotiation
 * bounds here would classify ordinary, correct provider output as a bounds violation and fill the
 * ledger with false positives, destroying its value as a signal. These bounds are set to catch a
 * genuinely pathological frame (a runaway CLI, a corrupted stream), not a merely large one.
 */
export const PROVIDER_FRAME_BOUNDS: Readonly<JsonBounds> = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 16,
  maxItems: 1024,
  maxStringBytes: 256 * 1024,
});

export type UnknownFrameKind =
  | 'unrecognized_event_type'
  | 'unparseable_line'
  | 'frame_bounds_exceeded'
  | 'non_object_frame';

export interface NormalizedUnknownFrame {
  readonly kind: UnknownFrameKind;
  /** Absent for kinds that have no event type, and for the overflow bucket. */
  readonly eventType?: string;
  /** UTF-8 byte length of the raw line this entry was first created from. */
  readonly bytes: number;
  /** SHA-256 of the raw line's UTF-8 bytes. Lets two reports be correlated without either carrying content. */
  readonly sha256: string;
  readonly boundsViolation?: string;
  readonly occurrences: number;
  readonly firstSeenAtMs: number;
  readonly lastSeenAtMs: number;
}

const MAX_EVENT_TYPE_BYTES = 128;
const DEFAULT_MAX_KINDS = 64;
const DEFAULT_MAX_OBSERVATIONS = 100_000;
/** The stand-in hashed for the overflow bucket, so the bucket's `sha256` is a constant, not a leak. */
const OVERFLOW_SENTINEL = '<overflow>';

/**
 * True for C0 controls, DEL, and C1 controls. Written as a codepoint range test rather than a
 * character class so no literal control byte ever appears in this source file (which would be
 * invisible in review and fragile across editors and encodings).
 */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * Normalizes a provider-supplied event type into something safe to store and print.
 *
 * A provider's `type` field is untrusted input from a third-party CLI's stdout. Two hazards, both
 * handled here: control characters (a `\r` or an ANSI escape would corrupt any log line or
 * terminal this value is later rendered into, and NUL breaks C-string boundaries downstream), and
 * unbounded length (a multi-megabyte `type` would let one malformed frame dominate the ledger's
 * whole memory budget).
 *
 * Truncation is done on the UTF-8 *byte* sequence and then decoded loosely, so a multi-byte
 * character straddling the cut is replaced rather than producing a lone surrogate.
 */
// A generous multiple of the actual byte budget, not the budget itself: every character the
// pre-slice below keeps still has to survive control-character stripping, so slicing at exactly
// MAX_EVENT_TYPE_BYTES would let a handful of leading control characters eat into the budget of
// meaningful content that should have survived (a single leading control character would cost the
// result one otherwise-legitimate trailing character). This stays comfortably ahead of any
// realistic control-character density while remaining a tiny, fast-to-iterate bound compared to
// the multi-megabyte input this exists to cut off.
const NORMALIZE_PRE_SLICE_CODE_UNITS = MAX_EVENT_TYPE_BYTES * 8;

function normalizeEventType(eventType: string): string {
  // Cheap pre-truncation via a native `.slice()`, BEFORE the per-character scan below: a provider's
  // `type` field is untrusted and bounded only by the line-reader's 10 MB line cap, not by anything
  // specific to this field. Without this, a multi-megabyte `type` value would make the
  // control-character loop below iterate the whole string one codepoint at a time before any bound
  // applied -- measured at roughly 100ms per megabyte, a real event-loop-blocking cost from a single
  // hostile or malfunctioning provider line, for a value this function was going to truncate away
  // regardless.
  const candidate =
    eventType.length > NORMALIZE_PRE_SLICE_CODE_UNITS ? eventType.slice(0, NORMALIZE_PRE_SLICE_CODE_UNITS) : eventType;
  let stripped = '';
  for (const character of candidate) {
    if (!isControlCodePoint(character.codePointAt(0) ?? 0)) stripped += character;
  }
  if (utf8ByteLength(stripped) <= MAX_EVENT_TYPE_BYTES) return stripped;
  const truncated = Buffer.from(stripped, 'utf8').subarray(0, MAX_EVENT_TYPE_BYTES).toString('utf8');
  // A partial trailing character decodes to U+FFFD, which itself costs 3 bytes and can push the
  // result back over the limit; drop it rather than return an over-budget string.
  return utf8ByteLength(truncated) <= MAX_EVENT_TYPE_BYTES
    ? truncated
    : truncated.slice(0, -1);
}

function sha256Of(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A bounded, content-free tally of provider output this repo did not understand.
 *
 * Two hard rules, both of which are what make it safe to attach this to a session outcome that
 * may be logged, surfaced in the UI, or shipped in a diagnostic bundle:
 *
 * 1. **The raw line is never retained.** Only its SHA-256 and byte length are kept. A provider
 *    frame can contain absolutely anything the CLI had in scope — file contents, an API response,
 *    a credential the CLI echoed by mistake — and an "unknown frame" is by definition one whose
 *    contents we have not modelled and therefore cannot claim to have sanitized. The hash still
 *    supports the operational task this ledger exists for ("is this the same unknown frame the
 *    other user reported?") without carrying the content.
 * 2. **Memory is bounded in both dimensions.** Distinct kinds are capped (excess folds into one
 *    overflow bucket) and per-entry counts saturate rather than growing without limit, so a
 *    provider emitting a fresh unrecognized type on every line cannot turn this into an unbounded
 *    in-memory accumulator on a long-running daemon.
 */
export class UnknownFrameLedger {
  private readonly entries_ = new Map<string, NormalizedUnknownFrame>();
  private readonly maxKinds: number;
  private readonly maxObservations: number;

  constructor(options: { maxKinds?: number; maxObservations?: number } = {}) {
    this.maxKinds = options.maxKinds ?? DEFAULT_MAX_KINDS;
    this.maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  }

  record(
    kind: UnknownFrameKind,
    rawLine: string,
    eventType?: string,
    boundsViolation?: string,
  ): void {
    // Cheap key computation and the existing-entry lookup happen before anything that costs time
    // proportional to `rawLine`'s size (hashing, byte-length measurement): the overwhelmingly
    // common case is a repeat of an already-tracked kind/type, which only needs a counter bump.
    const normalizedType = eventType === undefined ? undefined : normalizeEventType(eventType);
    const now = Date.now();

    let key = `${kind}:${normalizedType ?? ''}`;
    let entryType = normalizedType;

    // Overflow folding: once the ledger is full, a *new* key collapses into ONE shared bucket
    // (not one bucket per kind) so total entries genuinely stay at `maxKinds + 1`, matching what
    // this ledger documents and what its own boundedness guarantee promises a caller.
    if (!this.entries_.has(key) && this.entries_.size >= this.maxKinds) {
      key = OVERFLOW_SENTINEL;
      entryType = undefined;
    }

    const existing = this.entries_.get(key);
    if (existing) {
      this.entries_.set(key, {
        ...existing,
        // Saturating, never wrapping: a wrapped counter would read as "seen twice" for something
        // seen four billion times, which is worse than an obviously-pinned ceiling.
        occurrences: Math.min(existing.occurrences + 1, this.maxObservations),
        lastSeenAtMs: now,
      });
      return;
    }

    const isOverflow = key === OVERFLOW_SENTINEL;
    this.entries_.set(key, {
      kind,
      ...(entryType === undefined ? {} : { eventType: entryType }),
      bytes: isOverflow ? utf8ByteLength(OVERFLOW_SENTINEL) : utf8ByteLength(rawLine),
      sha256: isOverflow ? sha256Of(OVERFLOW_SENTINEL) : sha256Of(rawLine),
      ...(boundsViolation === undefined ? {} : { boundsViolation }),
      occurrences: 1,
      firstSeenAtMs: now,
      lastSeenAtMs: now,
    });
  }

  entries(): readonly NormalizedUnknownFrame[] {
    return Object.freeze([...this.entries_.values()]);
  }
}

/**
 * Convenience wrapper so callers do not have to repeat the bounds constant. Returns the violation
 * string (suitable for `record`'s `boundsViolation`) or `undefined` when the frame is in bounds.
 */
export function checkProviderFrameBounds(frame: unknown): string | undefined {
  return validateJsonBounds(frame, PROVIDER_FRAME_BOUNDS);
}
