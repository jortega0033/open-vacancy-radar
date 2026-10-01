import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../../../src/window.js';
import {
  EMPTY_TIMELINE,
  MAX_TIMELINE_ENTRIES_PER_SESSION,
  MAX_TIMELINE_TEXT_BYTES_PER_SESSION,
  entryTextBytes,
  insertEntries,
  insertEntry,
  type TimelineState,
} from '../../../src/components/agent-workspace/timeline.js';

/**
 * The four merge rules `timeline.ts` documents, one describe block each, plus the convergence
 * property they exist to provide: the same set of inputs reaches the same timeline regardless of
 * arrival order, and replaying inputs changes nothing.
 */

function liveText(seq: number, text: string): ActivityEntry {
  return { seq, at: 't', origin: 'live', kind: 'assistant.message', text };
}

function historyDigest(seq: number, bytes = 20): ActivityEntry {
  return { seq, at: 't', origin: 'history', kind: 'assistant.message', digest: { bytes, sha256: 'a'.repeat(64) } };
}

function liveStatus(seq: number): ActivityEntry {
  return { seq, at: 't', origin: 'live', kind: 'status', status: 'thinking' };
}

describe('rule 1: live wins a collision', () => {
  it('a history page landing on live entries does not blank out the prose being read', () => {
    let state = insertEntry(EMPTY_TIMELINE, liveText(0, 'hello'));
    state = insertEntry(state, historyDigest(0));
    expect(state.entries[0]).toEqual(liveText(0, 'hello'));
  });

  it('a live entry landing on a history one upgrades it', () => {
    let state = insertEntry(EMPTY_TIMELINE, historyDigest(0));
    state = insertEntry(state, liveText(0, 'hello'));
    expect(state.entries[0]).toEqual(liveText(0, 'hello'));
    // The byte accounting follows the swap, so the text budget stays honest.
    expect(state.textBytes).toBe(entryTextBytes(liveText(0, 'hello')));
  });

  it('is idempotent for every collision that carries no new information', () => {
    // The reducer decides "did this session change?" by reference, so these must be the SAME object.
    const live = insertEntry(EMPTY_TIMELINE, liveText(0, 'hello'));
    expect(insertEntry(live, liveText(0, 'hello'))).toBe(live);
    expect(insertEntry(live, historyDigest(0))).toBe(live);

    const hist = insertEntry(EMPTY_TIMELINE, historyDigest(0));
    expect(insertEntry(hist, historyDigest(0))).toBe(hist);
  });

  it('a lastSeq reconnect that replays held events changes nothing at all', () => {
    const first = insertEntries(EMPTY_TIMELINE, [liveStatus(0), liveText(1, 'a'), liveStatus(2)]);
    const replayed = insertEntries(first, [liveText(1, 'a'), liveStatus(2)]);
    expect(replayed).toBe(first);
  });
});

describe('rule 2: a trimmed range never comes back', () => {
  it('discards an entry below the watermark instead of re-opening the convergence problem', () => {
    let state: TimelineState = EMPTY_TIMELINE;
    for (let seq = 0; seq <= MAX_TIMELINE_ENTRIES_PER_SESSION; seq += 1) {
      state = insertEntry(state, liveStatus(seq));
    }
    expect(state.entries).toHaveLength(MAX_TIMELINE_ENTRIES_PER_SESSION);
    expect(state.truncatedBefore).toBe(1);

    // A history page covering the dropped range must not re-insert it and restart the trim cycle.
    const after = insertEntries(state, [historyDigest(0)]);
    expect(after).toBe(state);
    expect(after.entries).toHaveLength(MAX_TIMELINE_ENTRIES_PER_SESSION);
  });

  it('trims from the front, so a running session keeps its newest activity', () => {
    let state: TimelineState = EMPTY_TIMELINE;
    for (let seq = 0; seq <= MAX_TIMELINE_ENTRIES_PER_SESSION + 4; seq += 1) {
      state = insertEntry(state, liveStatus(seq));
    }
    expect(state.entries[0]?.seq).toBe(5);
    expect(state.entries.at(-1)?.seq).toBe(MAX_TIMELINE_ENTRIES_PER_SESSION + 4);
    expect(state.highestSeq).toBe(MAX_TIMELINE_ENTRIES_PER_SESSION + 4);
    expect(state.seenSeq.has(0)).toBe(false);
  });
});

describe('rule 3: sorted by construction', () => {
  it('produces an ascending timeline from an out-of-order history page', () => {
    const state = insertEntries(EMPTY_TIMELINE, [liveStatus(5), liveStatus(1), liveStatus(9), liveStatus(3)]);
    expect(state.entries.map((entry) => entry.seq)).toEqual([1, 3, 5, 9]);
    expect(state.highestSeq).toBe(9);
  });

  it('reaches the same timeline whichever order the two streams arrive in', () => {
    const forwards = insertEntries(EMPTY_TIMELINE, [liveText(0, 'a'), historyDigest(1), liveText(2, 'c')]);
    const backwards = insertEntries(EMPTY_TIMELINE, [liveText(2, 'c'), historyDigest(1), liveText(0, 'a')]);
    expect(forwards.entries).toEqual(backwards.entries);
    expect(forwards.textBytes).toBe(backwards.textBytes);
  });
});

describe('rule 4: bounded in both dimensions', () => {
  it('counts UTF-8 bytes of kept prose only', () => {
    expect(entryTextBytes(liveText(0, 'naïve 😀'))).toBe(Buffer.byteLength('naïve 😀', 'utf8'));
    expect(entryTextBytes(liveStatus(0))).toBe(0);
    expect(entryTextBytes(historyDigest(0))).toBe(0);
  });

  it('stops keeping new text past the session budget, rather than dropping old text', () => {
    // The asymmetry is deliberate: exceeding the entry cap removes old entries, exceeding the text
    // cap stops keeping new text. Blanking earlier messages behind a scrolling reader reads as data
    // loss; refusing to keep more, and saying so, is a bound the user can understand.
    const chunk = 'x'.repeat(64_000);
    let state: TimelineState = EMPTY_TIMELINE;
    for (let seq = 0; seq < 10; seq += 1) state = insertEntry(state, liveText(seq, chunk));

    expect(state.textBytes).toBeGreaterThanOrEqual(MAX_TIMELINE_TEXT_BYTES_PER_SESSION);
    // The first entry still has its prose.
    expect((state.entries[0] as { text?: string }).text).toBe(chunk);
    // The one that crossed the line kept its structure and lost its prose, and says so.
    const last = state.entries.at(-1) as { text?: string; textOmitted?: boolean };
    expect(last.text).toBeUndefined();
    expect(last.textOmitted).toBe(true);
  });

  it('keeps a non-prose entry whole even past the text budget', () => {
    const chunk = 'x'.repeat(MAX_TIMELINE_TEXT_BYTES_PER_SESSION + 1);
    let state = insertEntry(EMPTY_TIMELINE, liveText(0, chunk));
    state = insertEntry(state, liveStatus(1));
    expect(state.entries[1]).toEqual(liveStatus(1));
  });
});

describe('timeline bookkeeping', () => {
  it('keeps seenSeq and highestSeq in step with entries at every step', () => {
    let state = insertEntries(EMPTY_TIMELINE, [liveStatus(4), liveStatus(0), liveStatus(2)]);
    expect([...state.seenSeq].sort((a, b) => a - b)).toEqual([0, 2, 4]);
    expect(state.highestSeq).toBe(4);
    state = insertEntry(state, liveStatus(7));
    expect(state.highestSeq).toBe(7);
    expect(state.seenSeq.size).toBe(state.entries.length);
  });

  it('starts empty with a highestSeq of -1, so the first append is the O(1) branch', () => {
    expect(EMPTY_TIMELINE.highestSeq).toBe(-1);
    expect(EMPTY_TIMELINE.entries).toHaveLength(0);
    expect(EMPTY_TIMELINE.textBytes).toBe(0);
  });
});
