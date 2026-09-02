import type { ActivityEntry } from '../../window.js';

/**
 * One session's timeline: a permanently sorted, deduplicated, bounded merge of two streams that
 * describe the same events differently (ADI-07).
 *
 * ## The two streams, and why merging them is not trivial
 *
 * - **Live** entries come from the sanitized SSE relay and carry the model's real prose.
 * - **History** entries come from `GET /v2/sessions/:id/events`, whose durable store is
 *   content-free by design, so the *same* event arrives carrying only a digest of that prose.
 *
 * Both are keyed on the daemon's per-session `seq`, and both can arrive in either order: a page of
 * history can land after the live stream already delivered those events (an ordinary refresh), and
 * a live reconnect resuming from `lastSeq` re-delivers events already held. So the merge has to be
 * **convergent**: the same set of inputs must reach the same timeline regardless of arrival order.
 *
 * Four rules make that true, and each one is a test in `timeline.test.ts`:
 *
 * 1. **Live wins a collision.** When a live entry and a history entry share a `seq`, the live one
 *    is kept. This is the rule that matters most: history carries strictly *less* information for
 *    the same event, so letting it overwrite would make refreshing a session silently lose the
 *    prose the user was reading.
 * 2. **A trimmed range never comes back.** Once the entry cap forces the front of the timeline to
 *    be dropped, `truncatedBefore` records the watermark and every later entry below it is
 *    discarded on arrival. Without this the merge would not converge at all: a history page below
 *    the watermark would re-insert entries, push the timeline back over the cap, trim the front
 *    again, and re-fetch forever.
 * 3. **Sorted by construction.** Entries are inserted at their sorted position, so an out-of-order
 *    history page produces an ascending timeline rather than one that needs re-sorting later.
 * 4. **Bounded in both dimensions.** Entry count and total kept text are capped separately, because
 *    they fail differently: 100k tiny status events and one session that streamed 40 MB of prose
 *    are both real, and only one of them is caught by an entry count.
 */

/**
 * Entry-count ceiling per session.
 *
 * A long session emits thousands of events, most of them `status` and `usage` frames nobody reads
 * twice. 2,000 is far more than fits on screen, far more than the daemon's own 5,000-line durable
 * cap will typically be asked for in one view, and small enough that the array operations here stay
 * trivially cheap.
 */
export const MAX_TIMELINE_ENTRIES_PER_SESSION = 2_000;

/**
 * Kept-text ceiling per session, in bytes.
 *
 * Past this, further live entries keep their structure but drop their prose (`textOmitted`). Note
 * the asymmetry with the entry cap: exceeding the entry cap *removes* old entries, while exceeding
 * the text cap *stops keeping new text*. That direction is deliberate. Dropping the oldest text to
 * make room for the newest would mean a user scrolling back through a long session watches earlier
 * messages blank out behind them, which reads as data loss; refusing to keep more, and saying so,
 * is a bound the user can understand and act on (the session's full output is still in their own
 * terminal-free CLI history and, in digest form, in the daemon's durable log).
 */
export const MAX_TIMELINE_TEXT_BYTES_PER_SESSION = 512_000;

/** The mutable half of a `SessionEntry`, split out so this file can be tested without a reducer. */
export interface TimelineState {
  /** Always sorted ascending by `seq`, with no duplicate `seq`. */
  entries: readonly ActivityEntry[];
  /** Every `seq` present in `entries`. An index, kept in step, never derived on read. */
  seenSeq: ReadonlySet<number>;
  /** The highest `seq` held, or `-1` for an empty timeline. Makes the append case O(1). */
  highestSeq: number;
  /** Everything below this `seq` was trimmed and must never be re-inserted. */
  truncatedBefore?: number;
  /** Total UTF-8 bytes of kept prose across `entries`. */
  textBytes: number;
}

export const EMPTY_TIMELINE: TimelineState = Object.freeze({
  entries: Object.freeze([]) as readonly ActivityEntry[],
  seenSeq: new Set<number>(),
  highestSeq: -1,
  textBytes: 0,
});

const encoder = new TextEncoder();

/** UTF-8 byte length of an entry's kept prose. Zero for every entry that carries none. */
export function entryTextBytes(entry: ActivityEntry): number {
  if (entry.kind !== 'assistant.message' && entry.kind !== 'thinking.delta') return 0;
  return entry.text === undefined ? 0 : encoder.encode(entry.text).length;
}

/** Strips an entry's prose while keeping the fact that it had some. */
function withoutText(entry: ActivityEntry): ActivityEntry {
  if (entry.kind !== 'assistant.message' && entry.kind !== 'thinking.delta') return entry;
  if (entry.text === undefined) return entry;
  const { text: _dropped, textTruncated: _alsoDropped, ...rest } = entry;
  void _dropped;
  void _alsoDropped;
  return { ...rest, textOmitted: true };
}

/** The index `seq` belongs at in a sorted array, found by binary search. */
function insertionIndex(entries: readonly ActivityEntry[], seq: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const candidate = entries[mid];
    if (candidate !== undefined && candidate.seq < seq) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The index of an existing `seq`, or `-1`. Only called when `seenSeq` already said it is present. */
function indexOfSeq(entries: readonly ActivityEntry[], seq: number): number {
  const index = insertionIndex(entries, seq);
  return entries[index]?.seq === seq ? index : -1;
}

/**
 * Merges one entry into a timeline, returning a new state (or the same object when nothing changed).
 *
 * Returning the *identical* object for a no-op matters beyond allocation: the reducer above this
 * relies on reference equality to decide whether a session's slice actually changed, and a
 * re-delivered event that produced a fresh-but-equal object would re-render the whole session for
 * nothing.
 */
export function insertEntry(state: TimelineState, incoming: ActivityEntry): TimelineState {
  // Rule 2, checked first: a trimmed range is closed, and re-admitting one entry from it would
  // re-open the whole convergence problem.
  if (state.truncatedBefore !== undefined && incoming.seq < state.truncatedBefore) return state;

  const overTextBudget = state.textBytes >= MAX_TIMELINE_TEXT_BYTES_PER_SESSION;
  const entry = overTextBudget ? withoutText(incoming) : incoming;

  if (state.seenSeq.has(entry.seq)) return replaceExisting(state, entry);
  return insertNew(state, entry);
}

/** Merges many entries. Equivalent to folding `insertEntry`, and used by every history page. */
export function insertEntries(state: TimelineState, incoming: readonly ActivityEntry[]): TimelineState {
  let next = state;
  for (const entry of incoming) next = insertEntry(next, entry);
  return next;
}

function replaceExisting(state: TimelineState, entry: ActivityEntry): TimelineState {
  const index = indexOfSeq(state.entries, entry.seq);
  const existing = index === -1 ? undefined : state.entries[index];
  if (existing === undefined) return state;

  // Rule 1, stated as what it actually is: **the only collision that carries new information is a
  // live entry landing on a history one.** `origin` decides all four cases, and three of them are
  // no-ops:
  //
  //   existing | incoming | outcome
  //   ---------|----------|---------------------------------------------------------------
  //   history  | live     | replace. The upgrade: digest-only becomes real prose.
  //   history  | history  | keep. The same record re-read from a re-fetched page.
  //   live     | history  | keep. History carries strictly less for the same event.
  //   live     | live     | keep. A `lastSeq` reconnect replays *from* that id, so the daemon
  //                         re-delivers events already held; the frames are the same frames.
  //
  // Returning the identical state object for all three is not an optimization. The reducer above
  // decides "did this session's slice change?" by reference, and it must answer *no* for a
  // re-delivered event, or a reconnect bumps the unread badge for messages the user already read.
  // It also makes the merge genuinely idempotent, which is what "convergent" in this module's
  // docstring means: replaying any prefix of the input twice reaches the same timeline.
  if (existing.origin === 'live' || entry.origin === 'history') return state;

  const entries = [...state.entries];
  entries[index] = entry;
  return {
    ...state,
    entries,
    textBytes: state.textBytes - entryTextBytes(existing) + entryTextBytes(entry),
  };
}

function insertNew(state: TimelineState, entry: ActivityEntry): TimelineState {
  const entries = [...state.entries];
  // The overwhelmingly common case is a live event arriving in order, so it is the O(1) branch.
  if (entry.seq > state.highestSeq) entries.push(entry);
  else entries.splice(insertionIndex(entries, entry.seq), 0, entry);

  const seenSeq = new Set(state.seenSeq);
  seenSeq.add(entry.seq);

  let next: TimelineState = {
    entries,
    seenSeq,
    highestSeq: Math.max(state.highestSeq, entry.seq),
    ...(state.truncatedBefore === undefined ? {} : { truncatedBefore: state.truncatedBefore }),
    textBytes: state.textBytes + entryTextBytes(entry),
  };

  if (next.entries.length > MAX_TIMELINE_ENTRIES_PER_SESSION) next = trimFront(next);
  return next;
}

/**
 * Drops the oldest entries back to the cap and records the watermark.
 *
 * The watermark is the `seq` of the first *retained* entry, so "below `truncatedBefore`" is exactly
 * the set that was dropped. Dropping from the front rather than the back is not a preference: the
 * back is where a running session's newest activity is, and a timeline that discarded the live tail
 * to keep old history would show the user a session frozen in the past.
 */
function trimFront(state: TimelineState): TimelineState {
  const dropCount = state.entries.length - MAX_TIMELINE_ENTRIES_PER_SESSION;
  const dropped = state.entries.slice(0, dropCount);
  const entries = state.entries.slice(dropCount);

  const seenSeq = new Set(state.seenSeq);
  let textBytes = state.textBytes;
  for (const entry of dropped) {
    seenSeq.delete(entry.seq);
    textBytes -= entryTextBytes(entry);
  }

  const firstRetained = entries[0];
  const watermark = firstRetained === undefined ? state.highestSeq + 1 : firstRetained.seq;

  return {
    entries,
    seenSeq,
    highestSeq: state.highestSeq,
    truncatedBefore: Math.max(state.truncatedBefore ?? 0, watermark),
    textBytes: Math.max(0, textBytes),
  };
}
