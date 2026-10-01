import { describe, expect, it } from 'vitest';
import type { ActivityEntry, HistoryEntry, SessionCapacity, SessionSummary } from '../../../src/window.js';
import {
  INITIAL_WORKSPACE_STATE,
  hasOnlyDigestHistory,
  isRunning,
  visibleSessionIds,
  workspaceReducer,
  type WorkspaceAction,
  type WorkspaceState,
} from '../../../src/components/agent-workspace/workspace-reducer.js';

/**
 * The reducer's core correctness property (ADI-07).
 *
 * The ticket exists to remove an `activeSessionId`-shaped design, so the decisive test is not that
 * the reducer produces the right values; it is that a session-scoped action for session B leaves
 * session A **reference-identical**. Deep equality would not prove it: a reducer that rebuilt every
 * session's entry on every action (the exact shape a coupling bug takes, because it means some
 * shared per-render buffer is being re-derived) produces deep-equal objects with new identities.
 * So every assertion below is `toBe`, not `toEqual`.
 */

const CAPACITY: SessionCapacity = { global: { active: 1, limit: 4 }, provider: { active: 1, limit: 2 } };

function view(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    provider: 'claude',
    protocolVersion: 1,
    transportId: 'legacy-one-shot',
    status: 'running',
    acceptedWork: 'prompt',
    rootSessionId: id,
    continuationKind: 'fresh',
    startedAt: '2026-09-02T10:00:00.000Z',
    earliestSequence: 0,
    eventCount: 0,
    eventsTruncated: false,
    scope: { authenticated: 'authenticated', platform: 'win32', accountEvidence: 'cli_owned' },
    unknownFrameCount: 0,
    ...overrides,
  };
}

function live(seq: number, body: Partial<ActivityEntry> = {}): ActivityEntry {
  return { seq, at: 't', origin: 'live', kind: 'status', status: 'thinking', ...body } as ActivityEntry;
}

function history(seq: number): HistoryEntry {
  return { seq, at: 't', origin: 'history', kind: 'status', status: 'thinking' };
}

/** Two sessions listed, A selected. The starting point for every isolation assertion. */
function twoSessions(): WorkspaceState {
  let state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
    type: 'list/loaded',
    sessions: [view('A'), view('B')],
    capacity: CAPACITY,
    replace: true,
  });
  state = workspaceReducer(state, { type: 'session/selected', sessionId: 'A' });
  return state;
}

/**
 * Every session-scoped action in the union, each targeting session B.
 *
 * Spelled out rather than sampled: the property has to hold for *all* of them, and a new
 * session-scoped action added without a row here is the case most likely to reintroduce coupling.
 */
const SESSION_SCOPED_ACTIONS_FOR_B: ReadonlyArray<[name: string, action: WorkspaceAction]> = [
  ['session/updated', { type: 'session/updated', session: view('B', { status: 'completed' }) }],
  ['history/loaded', { type: 'history/loaded', sessionId: 'B', entries: [history(0), history(1)] }],
  ['activity/received', { type: 'activity/received', sessionId: 'B', entry: live(0) }],
  ['activity/closed', { type: 'activity/closed', sessionId: 'B', reason: 'stream_ended' }],
  ['live/attaching', { type: 'live/attaching', sessionId: 'B' }],
  ['live/attached', { type: 'live/attached', sessionId: 'B' }],
  ['live/refused', { type: 'live/refused', sessionId: 'B', reason: 'attach_limit' }],
  ['live/detached', { type: 'live/detached', sessionId: 'B' }],
  ['session/archived', { type: 'session/archived', sessionId: 'B', archived: true }],
];

describe('workspace-reducer: there is no activeSessionId (ADI-07)', () => {
  it.each(SESSION_SCOPED_ACTIONS_FOR_B)(
    'leaves the selected session A reference-identical when %s targets B',
    (_name, action) => {
      const previous = twoSessions();
      const next = workspaceReducer(previous, action);

      // The decisive assertion. `toBe`, never `toEqual`.
      expect(next.sessions.A).toBe(previous.sessions.A);
      // And B genuinely did change, so the test is not passing because nothing happened at all.
      expect(next.sessions.B).not.toBe(previous.sessions.B);
      // Selection is untouched by any of them: it is a render pointer, not a subscription key.
      expect(next.selectedId).toBe('A');
      expect(next.order).toBe(previous.order);
    },
  );

  it('leaves an unselected session reference-identical too, so the rule is not about selection', () => {
    // Same property with NOTHING selected: if the isolation only held for the selected session, it
    // would be selection-dependent behavior, which is the thing being removed.
    let state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      type: 'list/loaded',
      sessions: [view('A'), view('B'), view('C')],
      capacity: CAPACITY,
      replace: true,
    });
    expect(state.selectedId).toBeUndefined();

    const previous = state;
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'B', entry: live(0) });
    expect(state.sessions.A).toBe(previous.sessions.A);
    expect(state.sessions.C).toBe(previous.sessions.C);
  });

  it('accumulates two sessions concurrently, with neither selected', () => {
    // The capability the ticket is actually about, expressed as state rather than as a promise.
    let state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      type: 'list/loaded',
      sessions: [view('A'), view('B')],
      capacity: CAPACITY,
      replace: true,
    });
    state = workspaceReducer(state, { type: 'live/attaching', sessionId: 'A' });
    state = workspaceReducer(state, { type: 'live/attached', sessionId: 'A' });
    state = workspaceReducer(state, { type: 'live/attaching', sessionId: 'B' });
    state = workspaceReducer(state, { type: 'live/attached', sessionId: 'B' });
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'A', entry: live(0) });
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'B', entry: live(0) });
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'A', entry: live(1) });

    expect(state.sessions.A?.liveStatus).toBe('live');
    expect(state.sessions.B?.liveStatus).toBe('live');
    expect(state.sessions.A?.timeline.entries).toHaveLength(2);
    expect(state.sessions.B?.timeline.entries).toHaveLength(1);
    expect(state.selectedId).toBeUndefined();
  });

  it('returns the identical state object for a genuinely no-op action', () => {
    const previous = twoSessions();
    // Archiving an already-unarchived session, and selecting the already-selected one.
    expect(workspaceReducer(previous, { type: 'session/archived', sessionId: 'B', archived: false })).toBe(previous);
    expect(workspaceReducer(previous, { type: 'session/selected', sessionId: 'A' })).toBe(previous);
    expect(workspaceReducer(previous, { type: 'live/attaching', sessionId: 'zzz' })).toBe(previous);
  });

  it('does not resurrect a session it has never listed', () => {
    const previous = twoSessions();
    for (const action of SESSION_SCOPED_ACTIONS_FOR_B) {
      const [, template] = action;
      if (template.type === 'session/updated') continue; // that one is allowed to insert, by design
      const retargeted = { ...template, sessionId: 'ghost' } as WorkspaceAction;
      expect(workspaceReducer(previous, retargeted)).toBe(previous);
    }
  });

  it('re-delivering an event changes nothing and does not bump an unread badge', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'B', entry: live(0) });
    const afterFirst = state;
    expect(afterFirst.sessions.B?.unread).toBe(1);

    // The common case after a `lastSeq` reconnect: the daemon replays *from* that id.
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'B', entry: live(0) });
    expect(state).toBe(afterFirst);
    expect(state.sessions.B?.unread).toBe(1);
  });
});

describe('workspace-reducer: selection is a render pointer only', () => {
  it('clears only the newly selected session badge, and only that one', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'B', entry: live(0) });
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'B', entry: live(1) });
    expect(state.sessions.B?.unread).toBe(2);

    const previous = state;
    state = workspaceReducer(state, { type: 'session/selected', sessionId: 'B' });
    expect(state.sessions.B?.unread).toBe(0);
    expect(state.sessions.A).toBe(previous.sessions.A);
  });

  it('does not increment unread for the session that is already selected', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'A', entry: live(0) });
    expect(state.sessions.A?.unread).toBe(0);
  });

  it('clearing selection zeroes nobody', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'B', entry: live(0) });
    const previous = state;
    state = workspaceReducer(state, { type: 'session/selected' });
    expect(state.selectedId).toBeUndefined();
    expect(state.sessions.B).toBe(previous.sessions.B);
    expect(state.sessions.B?.unread).toBe(1);
  });
});

describe('workspace-reducer: listing', () => {
  it('keeps an existing entry object across a refresh so a timeline being read is not discarded', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'activity/received', sessionId: 'A', entry: live(0) });
    const timeline = state.sessions.A?.timeline;

    state = workspaceReducer(state, {
      type: 'list/loaded',
      sessions: [view('A', { status: 'completed' }), view('B')],
      capacity: CAPACITY,
      replace: true,
    });

    expect(state.sessions.A?.timeline).toBe(timeline);
    expect(state.sessions.A?.view.status).toBe('completed');
  });

  it('appends a page without dropping what is held, and never duplicates an id in order', () => {
    let state = twoSessions();
    state = workspaceReducer(state, {
      type: 'list/loaded',
      sessions: [view('B'), view('C')],
      capacity: CAPACITY,
      replace: false,
    });
    expect(state.order).toEqual(['A', 'B', 'C']);
  });

  it('clears the cursor when a page reports no next one', () => {
    let state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      type: 'list/loaded',
      sessions: [view('A')],
      nextCursor: 'abc',
      capacity: CAPACITY,
      replace: true,
    });
    expect(state.listCursor).toBe('abc');
    state = workspaceReducer(state, { type: 'list/loaded', sessions: [view('A')], capacity: CAPACITY, replace: true });
    expect(state.listCursor).toBeUndefined();
  });

  it('appends a session the list has not seen yet rather than inventing a sort position', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'session/updated', session: view('Z') });
    expect(state.order).toEqual(['A', 'B', 'Z']);
  });

  it('keeps a fixed error message and never a daemon-authored one', () => {
    const state = workspaceReducer(INITIAL_WORKSPACE_STATE, { type: 'list/failed', error: 'fixed copy' });
    expect(state.listStatus).toBe('error');
    expect(state.listError).toBe('fixed copy');
  });
});

describe('workspace-reducer: live status settles honestly', () => {
  it('a terminal activity entry ends the stream without waiting for the transport', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'live/attached', sessionId: 'B' });
    state = workspaceReducer(state, {
      type: 'activity/received',
      sessionId: 'B',
      entry: { seq: 0, at: 't', origin: 'live', kind: 'session.completed' },
    });
    expect(state.sessions.B?.liveStatus).toBe('ended');
  });

  it('an attach acknowledgement never reopens a stream that already reported itself finished', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'activity/closed', sessionId: 'B', reason: 'stream_ended' });
    state = workspaceReducer(state, { type: 'live/attached', sessionId: 'B' });
    expect(state.sessions.B?.liveStatus).toBe('ended');
  });

  it('a refused attach ends as "ended" with a reason, never as an error', () => {
    // The restart-recovered case: the durable record exists, the live stream does not, and that is
    // not a failure the UI may draw as one.
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'live/attaching', sessionId: 'B' });
    state = workspaceReducer(state, { type: 'live/refused', sessionId: 'B', reason: 'daemon_unavailable' });
    expect(state.sessions.B?.liveStatus).toBe('ended');
    expect(state.sessions.B?.lastRefusal).toBe('daemon_unavailable');
    expect(state.listStatus).not.toBe('error');
  });

  it('a new attach attempt clears the previous refusal', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'live/refused', sessionId: 'B', reason: 'attach_limit' });
    state = workspaceReducer(state, { type: 'live/attaching', sessionId: 'B' });
    expect(state.sessions.B?.lastRefusal).toBeUndefined();
  });
});

describe('workspace-reducer: pending starts are independent', () => {
  it('runs two starts concurrently, with either able to resolve first', () => {
    let state = INITIAL_WORKSPACE_STATE;
    state = workspaceReducer(state, { type: 'start/begin', clientKey: 'k1', provider: 'claude' });
    state = workspaceReducer(state, { type: 'start/begin', clientKey: 'k2', provider: 'codex' });

    // k2 is refused while k1 is still waiting on its native dialog.
    state = workspaceReducer(state, { type: 'start/refused', clientKey: 'k2', reason: 'workspace_lease_conflict' });
    expect(state.pendingStarts.k1?.phase).toBe('granting');
    expect(state.pendingStarts.k2?.phase).toBe('refused');

    state = workspaceReducer(state, { type: 'start/granted', clientKey: 'k1', workspaceName: 'my-project' });
    state = workspaceReducer(state, { type: 'start/succeeded', clientKey: 'k1', sessionId: 'A' });
    expect(state.pendingStarts.k1?.phase).toBe('started');
    expect(state.pendingStarts.k1?.workspaceName).toBe('my-project');
    expect(state.pendingStarts.k2?.reason).toBe('workspace_lease_conflict');
  });

  it('dismissing one pending start leaves the other reference-identical', () => {
    let state = workspaceReducer(INITIAL_WORKSPACE_STATE, { type: 'start/begin', clientKey: 'k1', provider: 'claude' });
    state = workspaceReducer(state, { type: 'start/begin', clientKey: 'k2', provider: 'codex' });
    const previous = state;
    state = workspaceReducer(state, { type: 'start/dismissed', clientKey: 'k2' });
    expect(state.pendingStarts.k1).toBe(previous.pendingStarts.k1);
    expect(state.pendingStarts.k2).toBeUndefined();
  });

  it('ignores an update for a client key it does not hold', () => {
    const previous = workspaceReducer(INITIAL_WORKSPACE_STATE, { type: 'start/begin', clientKey: 'k1', provider: 'claude' });
    expect(workspaceReducer(previous, { type: 'start/refused', clientKey: 'gone', reason: 'refused' })).toBe(previous);
    expect(workspaceReducer(previous, { type: 'start/dismissed', clientKey: 'gone' })).toBe(previous);
  });
});

describe('workspace-reducer: preferences', () => {
  /** The real order of operations: the list lands, then prefs, with nothing selected in between. */
  function listedOnly(): WorkspaceState {
    return workspaceReducer(INITIAL_WORKSPACE_STATE, {
      type: 'list/loaded',
      sessions: [view('A'), view('B')],
      capacity: CAPACITY,
      replace: true,
    });
  }

  it('drops ids the daemon has since evicted rather than resurrecting them', () => {
    const state = workspaceReducer(listedOnly(), {
      type: 'prefs/loaded',
      selectedSessionId: 'evicted',
      archivedSessionIds: ['B', 'evicted'],
      unreadCounts: { B: 4, evicted: 9 },
    });

    expect(state.prefsLoaded).toBe(true);
    expect(state.sessions.B?.archived).toBe(true);
    expect(state.sessions.B?.unread).toBe(4);
    expect(state.sessions.evicted).toBeUndefined();
    // A remembered selection pointing at a session that is gone stays unselected, not a ghost row.
    expect(state.selectedId).toBeUndefined();
  });

  it('restores a remembered selection that is still real', () => {
    const state = workspaceReducer(listedOnly(), {
      type: 'prefs/loaded',
      selectedSessionId: 'B',
      archivedSessionIds: [],
      unreadCounts: {},
    });
    expect(state.selectedId).toBe('B');
  });

  it('never clears a selection the user made while the prefs read was in flight', () => {
    // Hydration may only ever *set* a selection. The read is asynchronous, so the user can already
    // have clicked a session by the time it lands, and yanking them off it would be the same
    // mistake App.tsx's `hasNavigatedRef` exists to avoid for the remembered start page.
    const state = workspaceReducer(twoSessions(), {
      type: 'prefs/loaded',
      selectedSessionId: 'evicted',
      archivedSessionIds: [],
      unreadCounts: {},
    });
    expect(state.selectedId).toBe('A');
  });

  it('caps nothing and invents nothing for a session it does not hold', () => {
    const state = workspaceReducer(listedOnly(), {
      type: 'prefs/loaded',
      selectedSessionId: null,
      archivedSessionIds: [],
      unreadCounts: {},
    });
    expect(Object.keys(state.sessions).sort()).toEqual(['A', 'B']);
    expect(state.sessions.A?.unread).toBe(0);
  });
});

describe('workspace-reducer selectors', () => {
  it('filters by archive flag without re-sorting the daemon order', () => {
    let state = workspaceReducer(INITIAL_WORKSPACE_STATE, {
      type: 'list/loaded',
      sessions: [view('A'), view('B'), view('C')],
      capacity: CAPACITY,
      replace: true,
    });
    state = workspaceReducer(state, { type: 'session/archived', sessionId: 'B', archived: true });
    expect(visibleSessionIds(state, false)).toEqual(['A', 'C']);
    expect(visibleSessionIds(state, true)).toEqual(['B']);
  });

  it('treats only starting and running as worth streaming', () => {
    expect(isRunning(view('A', { status: 'starting' }))).toBe(true);
    expect(isRunning(view('A', { status: 'running' }))).toBe(true);
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'nonsense']) {
      expect(isRunning(view('A', { status }))).toBe(false);
    }
  });

  it('detects a finished session whose timeline carries only digests', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'history/loaded', sessionId: 'B', entries: [history(0)] });
    state = workspaceReducer(state, { type: 'activity/closed', sessionId: 'B', reason: 'stream_unavailable' });
    const entry = state.sessions.B;
    expect(entry).toBeDefined();
    expect(entry !== undefined && hasOnlyDigestHistory(entry)).toBe(true);

    // Real prose anywhere in the timeline means there is something to read, so it is not that state.
    state = workspaceReducer(state, {
      type: 'activity/received',
      sessionId: 'B',
      entry: { seq: 1, at: 't', origin: 'live', kind: 'assistant.message', text: 'hello' },
    });
    const withProse = state.sessions.B;
    expect(withProse !== undefined && hasOnlyDigestHistory(withProse)).toBe(false);
  });

  it('is false while a session is still attaching or live, whatever its timeline holds', () => {
    let state = twoSessions();
    state = workspaceReducer(state, { type: 'history/loaded', sessionId: 'B', entries: [history(0)] });
    state = workspaceReducer(state, { type: 'live/attaching', sessionId: 'B' });
    const entry = state.sessions.B;
    expect(entry !== undefined && hasOnlyDigestHistory(entry)).toBe(false);
  });
});
