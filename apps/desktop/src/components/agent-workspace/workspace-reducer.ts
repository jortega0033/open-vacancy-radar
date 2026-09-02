import type {
  ActivityEntry,
  ActivityCloseReason,
  AttachRefusal,
  HistoryEntry,
  SessionCapacity,
  SessionSummary,
  StartSessionDenialReason,
} from '../../window.js';
import { EMPTY_TIMELINE, insertEntries, insertEntry, type TimelineState } from './timeline.js';

/**
 * The AI Workspace's state machine (ADI-07).
 *
 * ## Why a plain `useReducer`, written from scratch
 *
 * There is no upstream counterpart to port: upstream AgentDock's renderer is a different app with
 * different screens, and nothing in *this* repo's `src/` uses a reducer at all today (every other
 * page is `useState` + `useEffect`, which is right for pages that show one list). So this is new
 * code rather than an adaptation, and it is a bare `useReducer` rather than a state library because
 * the thing that makes this screen hard is not state plumbing -- it is the merge rules in
 * `timeline.ts` and the reference-identity discipline below, neither of which a library provides.
 *
 * ## The one rule this file exists to enforce
 *
 * **There is no "active session".** `sessions` is a genuine map keyed by session id, `order` is the
 * daemon's own listing order, and `selectedId` is a *render pointer only*. It is read in exactly
 * two places in this module -- the unread-increment check in `activity/received`, and nowhere else
 * -- and in the view layer. No fetch, no subscription, no timeout, and no timeline mutation is
 * gated on it.
 *
 * That is testable, and it is tested: dispatching a session-scoped action for session B while A is
 * selected must leave `next.sessions.A` **reference-identical** to `prev.sessions.A`. A design that
 * quietly coupled the two -- an effect keyed on the selected id, a shared "current" buffer, a
 * timeline that only merges for the visible session -- would fail that test immediately, which is
 * why it is written as an identity assertion rather than a deep-equality one.
 *
 * ## Why `pendingStarts` is keyed by a renderer-minted key
 *
 * A start has no session id until the daemon answers, and the two round trips before that (the
 * native grant dialog, then the consume) can each take as long as the user takes to read them. Two
 * starts in flight at once are therefore two things with no ids, and keying them by anything the
 * daemon supplies would mean serializing them behind one "pending" slot -- the same single-slot
 * mistake as an `activeSessionId`, one layer up. A client key minted at the moment the user clicks
 * makes them genuinely independent: one can be refused while the other succeeds, in either order.
 */

export type LiveStatus = 'detached' | 'attaching' | 'live' | 'ended';

export interface SessionEntry {
  /** The daemon's own view. Authoritative for everything except the four local fields below. */
  view: SessionSummary;
  timeline: TimelineState;
  /** The next history page, or absent. `historyComplete` distinguishes "not started" from "done". */
  historyCursor?: string;
  historyComplete: boolean;
  liveStatus: LiveStatus;
  /** Activity entries that arrived while this session was not the selected one. */
  unread: number;
  archived: boolean;
  /**
   * `toolAlias -> toolName`, mirroring what the main-process sanitizer assigned.
   *
   * A `tool.completed` frame may legitimately carry no `toolName` (the CLI already said it on the
   * matching `tool.started`), so without this the UI would render an unnamed completion. Main mints
   * the aliases; this is the renderer's index over them.
   */
  toolNamesByAlias: Readonly<Record<string, string>>;
  /** Why this session's last live attach was refused, if it was. Reason-only, never prose. */
  lastRefusal?: AttachRefusal;
}

export interface PendingStart {
  clientKey: string;
  provider: string;
  phase: 'granting' | 'starting' | 'refused' | 'started';
  /** The folder name the user approved, for the panel's own confirmation line. Never a path. */
  workspaceName?: string;
  reason?: StartSessionDenialReason;
  /** Set once the daemon answers, so the panel can point at the session it created. */
  sessionId?: string;
}

export interface WorkspaceState {
  sessions: Readonly<Record<string, SessionEntry>>;
  /** The daemon's listing order, verbatim. The renderer never re-sorts it. */
  order: readonly string[];
  /** A render pointer. See this module's docstring for the rule that governs it. */
  selectedId?: string;
  pendingStarts: Readonly<Record<string, PendingStart>>;
  capacity?: SessionCapacity;
  listCursor?: string;
  listStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** A fixed message this build wrote, never a daemon-authored one. */
  listError?: string;
  prefsLoaded: boolean;
}

export const INITIAL_WORKSPACE_STATE: WorkspaceState = Object.freeze({
  sessions: Object.freeze({}) as Readonly<Record<string, SessionEntry>>,
  order: Object.freeze([]) as readonly string[],
  pendingStarts: Object.freeze({}) as Readonly<Record<string, PendingStart>>,
  listStatus: 'idle' as const,
  prefsLoaded: false,
});

export type WorkspaceAction =
  | { type: 'list/loading' }
  | {
      type: 'list/loaded';
      sessions: readonly SessionSummary[];
      nextCursor?: string;
      capacity: SessionCapacity;
      /** `true` for a fresh listing, `false` when appending the next page. */
      replace: boolean;
    }
  | { type: 'list/failed'; error: string }
  | { type: 'session/updated'; session: SessionSummary }
  | { type: 'history/loaded'; sessionId: string; entries: readonly HistoryEntry[]; nextCursor?: string }
  | { type: 'activity/received'; sessionId: string; entry: ActivityEntry }
  | { type: 'activity/closed'; sessionId: string; reason: ActivityCloseReason }
  | { type: 'live/attaching'; sessionId: string }
  | { type: 'live/attached'; sessionId: string }
  | { type: 'live/refused'; sessionId: string; reason: AttachRefusal }
  | { type: 'live/detached'; sessionId: string }
  | { type: 'session/selected'; sessionId?: string }
  | { type: 'session/archived'; sessionId: string; archived: boolean }
  | {
      type: 'prefs/loaded';
      selectedSessionId: string | null;
      archivedSessionIds: readonly string[];
      unreadCounts: Readonly<Record<string, number>>;
    }
  | { type: 'start/begin'; clientKey: string; provider: string }
  | { type: 'start/granted'; clientKey: string; workspaceName: string }
  | { type: 'start/refused'; clientKey: string; reason: StartSessionDenialReason }
  | { type: 'start/succeeded'; clientKey: string; sessionId: string }
  | { type: 'start/dismissed'; clientKey: string };

function emptyEntry(view: SessionSummary): SessionEntry {
  return {
    view,
    timeline: EMPTY_TIMELINE,
    historyComplete: false,
    liveStatus: 'detached',
    unread: 0,
    archived: false,
    toolNamesByAlias: {},
  };
}

/**
 * Rewrites exactly one session's entry, leaving every other entry reference-identical.
 *
 * Every session-scoped branch below goes through this. It is the mechanical reason the
 * no-coupling test passes: a branch that built a fresh `sessions` map by mapping over all of them
 * would produce new objects for untouched sessions, and that is the shape a coupling bug takes.
 * `update` returning the same entry it was given short-circuits to the same state object too, so a
 * genuinely-no-op action re-renders nothing.
 */
function withSession(
  state: WorkspaceState,
  sessionId: string,
  update: (entry: SessionEntry) => SessionEntry,
): WorkspaceState {
  const existing = state.sessions[sessionId];
  if (existing === undefined) return state;
  const next = update(existing);
  if (next === existing) return state;
  return { ...state, sessions: { ...state.sessions, [sessionId]: next } };
}

function withPendingStart(
  state: WorkspaceState,
  clientKey: string,
  update: (pending: PendingStart) => PendingStart,
): WorkspaceState {
  const existing = state.pendingStarts[clientKey];
  if (existing === undefined) return state;
  const next = update(existing);
  if (next === existing) return state;
  return { ...state, pendingStarts: { ...state.pendingStarts, [clientKey]: next } };
}

/** Indexes a `tool.started`'s name under its alias, so a nameless completion can still be labelled. */
function withToolName(
  names: Readonly<Record<string, string>>,
  entry: ActivityEntry,
): Readonly<Record<string, string>> {
  if (entry.kind !== 'tool.started') return names;
  const { toolAlias, toolName } = entry;
  if (toolAlias === undefined || toolName.length === 0 || names[toolAlias] === toolName) return names;
  return { ...names, [toolAlias]: toolName };
}

/** The kinds that mean the provider itself is finished. Used to settle `liveStatus`. */
function isTerminalKind(kind: ActivityEntry['kind']): boolean {
  return (
    kind === 'session.completed' ||
    kind === 'session.failed' ||
    kind === 'session.cancelled' ||
    kind === 'session.interrupted'
  );
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'list/loading':
      return state.listStatus === 'loading' ? state : { ...state, listStatus: 'loading' };

    case 'list/loaded': {
      const sessions: Record<string, SessionEntry> = action.replace ? {} : { ...state.sessions };
      const order: string[] = action.replace ? [] : [...state.order];

      for (const view of action.sessions) {
        // A session already held keeps its entry object and only takes the daemon's new view, so a
        // refresh does not discard a timeline the user is reading. On a `replace` this carries the
        // *previous* map's entry across, which is why `state.sessions` is read here rather than the
        // freshly-emptied local one.
        const previous = state.sessions[view.id];
        sessions[view.id] = previous === undefined ? emptyEntry(view) : { ...previous, view };
        if (!order.includes(view.id)) order.push(view.id);
      }

      return {
        ...state,
        sessions,
        order,
        capacity: action.capacity,
        ...(action.nextCursor === undefined
          ? { listCursor: undefined }
          : { listCursor: action.nextCursor }),
        listStatus: 'ready',
        listError: undefined,
      };
    }

    case 'list/failed':
      return { ...state, listStatus: 'error', listError: action.error };

    case 'session/updated': {
      const existing = state.sessions[action.session.id];
      if (existing === undefined) {
        // A session the list has not seen yet (one this renderer just started). Appended rather
        // than sorted in: the daemon owns ordering, and inventing a position here would make the
        // list disagree with itself until the next refresh.
        return {
          ...state,
          sessions: { ...state.sessions, [action.session.id]: emptyEntry(action.session) },
          order: [...state.order, action.session.id],
        };
      }
      return withSession(state, action.session.id, (entry) => ({ ...entry, view: action.session }));
    }

    case 'history/loaded':
      return withSession(state, action.sessionId, (entry) => {
        const timeline = insertEntries(entry.timeline, action.entries);
        let toolNamesByAlias = entry.toolNamesByAlias;
        for (const historyEntry of action.entries) toolNamesByAlias = withToolName(toolNamesByAlias, historyEntry);
        return {
          ...entry,
          timeline,
          toolNamesByAlias,
          ...(action.nextCursor === undefined
            ? { historyCursor: undefined, historyComplete: true }
            : { historyCursor: action.nextCursor, historyComplete: false }),
        };
      });

    case 'activity/received':
      return withSession(state, action.sessionId, (entry) => {
        const timeline = insertEntry(entry.timeline, action.entry);
        const toolNamesByAlias = withToolName(entry.toolNamesByAlias, action.entry);
        // A re-delivered event (the common case after a `lastSeq` reconnect) changes nothing, and
        // must not bump the unread badge for a message the user has already seen.
        if (timeline === entry.timeline && toolNamesByAlias === entry.toolNamesByAlias) return entry;

        // The ONE place `selectedId` is read in this module. It decides a badge, nothing else: no
        // fetch, no subscription, and no timeline behavior changes with it.
        const unread = action.sessionId === state.selectedId ? entry.unread : entry.unread + 1;

        return {
          ...entry,
          timeline,
          toolNamesByAlias,
          unread,
          // A terminal event is the live stream's own statement that it is finished, which is more
          // trustworthy than waiting for the transport to notice the socket closed.
          liveStatus: isTerminalKind(action.entry.kind) ? 'ended' : entry.liveStatus,
        };
      });

    case 'activity/closed':
      return withSession(state, action.sessionId, (entry) =>
        entry.liveStatus === 'ended' ? entry : { ...entry, liveStatus: 'ended' },
      );

    case 'live/attaching':
      return withSession(state, action.sessionId, (entry) =>
        entry.liveStatus === 'attaching' ? entry : { ...entry, liveStatus: 'attaching', lastRefusal: undefined },
      );

    case 'live/attached':
      return withSession(state, action.sessionId, (entry) =>
        // Never reopens a stream that already reported itself finished: an `attached` acknowledgement
        // can land after the terminal event it was racing.
        entry.liveStatus === 'ended' ? entry : { ...entry, liveStatus: 'live' },
      );

    case 'live/refused':
      return withSession(state, action.sessionId, (entry) => ({
        ...entry,
        // Refused is not an error state for the session: it is simply not being streamed. A
        // restart-recovered session lands here, and the UI says so honestly rather than showing a
        // failure the session did not have.
        liveStatus: 'ended',
        lastRefusal: action.reason,
      }));

    case 'live/detached':
      return withSession(state, action.sessionId, (entry) =>
        entry.liveStatus === 'ended' ? entry : { ...entry, liveStatus: 'detached' },
      );

    case 'session/selected': {
      if (action.sessionId === state.selectedId) return state;
      const next: WorkspaceState = { ...state, selectedId: action.sessionId };
      if (action.sessionId === undefined) return next; // clearing selection zeroes nobody
      // Only the newly selected session's badge clears, and only if it has one.
      return withSession(next, action.sessionId, (entry) =>
        entry.unread === 0 ? entry : { ...entry, unread: 0 },
      );
    }

    case 'session/archived':
      // Idempotent by construction: `withSession` short-circuits when the entry is unchanged, so
      // archiving an already-archived session returns the identical state object.
      return withSession(state, action.sessionId, (entry) =>
        entry.archived === action.archived ? entry : { ...entry, archived: action.archived },
      );

    case 'prefs/loaded': {
      // Stale ids are dropped rather than resurrected. A session the daemon has since evicted is
      // gone; carrying its archived flag or its unread count forward would either recreate a ghost
      // row or attach a badge to nothing.
      const archived = new Set(action.archivedSessionIds.filter((id) => state.sessions[id] !== undefined));
      const sessions: Record<string, SessionEntry> = {};
      for (const [id, entry] of Object.entries(state.sessions)) {
        const unread = action.unreadCounts[id] ?? 0;
        const isArchived = archived.has(id);
        sessions[id] =
          entry.archived === isArchived && entry.unread === unread
            ? entry
            : { ...entry, archived: isArchived, unread };
      }
      const selectedId =
        action.selectedSessionId !== null && state.sessions[action.selectedSessionId] !== undefined
          ? action.selectedSessionId
          : undefined;
      return {
        ...state,
        sessions,
        ...(selectedId === undefined ? {} : { selectedId }),
        prefsLoaded: true,
      };
    }

    case 'start/begin':
      return {
        ...state,
        pendingStarts: {
          ...state.pendingStarts,
          [action.clientKey]: { clientKey: action.clientKey, provider: action.provider, phase: 'granting' },
        },
      };

    case 'start/granted':
      return withPendingStart(state, action.clientKey, (pending) => ({
        ...pending,
        phase: 'starting',
        workspaceName: action.workspaceName,
      }));

    case 'start/refused':
      return withPendingStart(state, action.clientKey, (pending) => ({
        ...pending,
        phase: 'refused',
        reason: action.reason,
      }));

    case 'start/succeeded':
      return withPendingStart(state, action.clientKey, (pending) => ({
        ...pending,
        phase: 'started',
        sessionId: action.sessionId,
      }));

    case 'start/dismissed': {
      if (state.pendingStarts[action.clientKey] === undefined) return state;
      const pendingStarts = { ...state.pendingStarts };
      delete pendingStarts[action.clientKey];
      return { ...state, pendingStarts };
    }

    default: {
      // Exhaustive: an action added to the union without a branch here is a compile error.
      const unhandled: never = action;
      void unhandled;
      return state;
    }
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Selectors. Pure reads, kept here so a component never re-derives a rule the reducer owns.
 * ---------------------------------------------------------------------------------------------
 */

/** The daemon's order, filtered by the archive flag. Never re-sorted. */
export function visibleSessionIds(state: WorkspaceState, archived: boolean): string[] {
  return state.order.filter((id) => {
    const entry = state.sessions[id];
    return entry !== undefined && entry.archived === archived;
  });
}

/** A session the daemon says is still going, so worth streaming. */
export function isRunning(view: SessionSummary): boolean {
  return view.status === 'starting' || view.status === 'running';
}

/**
 * A session whose activity this build cannot show, honestly.
 *
 * True when the daemon's durable record exists but there is nothing to render: no timeline entry
 * carries prose, the session is finished, and the live stream is not (or is no longer) available.
 * This is the *normal* state for a session that ran before the app last restarted -- the v1
 * `SessionManager` that held its events is gone with the previous daemon process, and the durable
 * log the v2 route serves is content-free by design. It is not an error, and the UI must not draw
 * it as one.
 */
export function hasOnlyDigestHistory(entry: SessionEntry): boolean {
  if (entry.liveStatus === 'attaching' || entry.liveStatus === 'live') return false;
  if (entry.timeline.entries.length === 0) return false;
  return !entry.timeline.entries.some(
    (item) => (item.kind === 'assistant.message' || item.kind === 'thinking.delta') && item.text !== undefined,
  );
}
