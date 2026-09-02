import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type { SessionSummary } from '../../window.js';
import {
  INITIAL_WORKSPACE_STATE,
  isRunning,
  workspaceReducer,
  type PendingStart,
  type SessionEntry,
  type WorkspaceState,
} from './workspace-reducer.js';

/**
 * The AI Workspace's effects layer (ADI-07): everything the reducer deliberately is not.
 *
 * The reducer is pure and knows nothing about IPC. This hook owns the four asynchronous jobs, and
 * each one is deliberately **not** keyed on the selected session:
 *
 * 1. **Listing.** One page on mount, more on demand. The daemon's order is kept verbatim.
 * 2. **History paging.** Forward until exhausted, for the selected session *and* for a bounded
 *    prefetch window of the newest non-archived ones, so switching selection to a recently-seen
 *    session shows content immediately instead of starting a fetch.
 * 3. **Live attachment.** For every session the daemon reports as `starting`/`running`, whether or
 *    not it is selected. This is the concurrency the ticket is about: two sessions stream at once,
 *    with no selection set at all.
 * 4. **Preferences.** Read once, written back when they change, through the same SQLite-backed
 *    `workspace:settings:*` channel every other setting in this app uses.
 *
 * ## `attachedRef` is a ref, not state
 *
 * What main is currently streaming is *not* renderer state: it is a fact about the other process,
 * and rendering must never depend on it. Keeping it in a ref means the attach effect can be honest
 * about idempotence (main's `attach` is a no-op for an already-attached id anyway) without the
 * bookkeeping causing a render, and without an extra reducer branch whose only reader is itself.
 */

/**
 * How many non-selected sessions get their history prefetched.
 *
 * Small on purpose. Prefetching everything would page the entire durable log on every mount, and
 * the value of a prefetch is only that the *next* session the user is likely to click is already
 * there. Three is the visible neighbourhood of a list, not a cache strategy.
 */
export const HISTORY_PREFETCH_WINDOW = 3;

/** Page size for both reads. Well under the daemon's own 100 cap. */
const PAGE_LIMIT = 50;

/** A fixed message this build wrote. The daemon's own error text never reaches the UI. */
const LIST_ERROR = 'The list of agent sessions could not be loaded. Check that the AI runtime is running.';

export interface AgentWorkspaceApi {
  state: WorkspaceState;
  /** Re-reads the session list from the daemon, replacing what is held. */
  refresh(): void;
  /** Loads the next page of the session list, if there is one. */
  loadMoreSessions(): void;
  select(sessionId: string | undefined): void;
  setArchived(sessionId: string, archived: boolean): void;
  /** Runs the whole grant flow for one renderer-minted client key. */
  startSession(clientKey: string, provider: ProviderId, prompt: string): Promise<void>;
  dismissPendingStart(clientKey: string): void;
  cancelSession(sessionId: string): Promise<void>;
  /** Mints a key for a start that does not exist yet. See the reducer's note on `pendingStarts`. */
  newClientKey(): string;
}

let clientKeyCounter = 0;

export function useAgentWorkspace(): AgentWorkspaceApi {
  const [state, dispatch] = useReducer(workspaceReducer, INITIAL_WORKSPACE_STATE);

  /** Session ids main is currently streaming for us. See the docstring for why this is a ref. */
  const attachedRef = useRef(new Set<string>());
  /** Session ids with a history fetch in flight, so an effect re-run cannot double-fetch. */
  const historyInFlightRef = useRef(new Set<string>());
  /** The last prefs value written, so a re-render does not rewrite an identical row. */
  const lastPrefsRef = useRef<string>();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---------------------------------------------------------------- listing

  const loadSessions = useCallback(async (cursor: string | undefined, replace: boolean) => {
    dispatch({ type: 'list/loading' });
    try {
      const page = await window.agentWorkspace.listSessions(
        cursor === undefined ? { limit: PAGE_LIMIT } : { cursor, limit: PAGE_LIMIT },
      );
      if (!mountedRef.current) return;
      dispatch({
        type: 'list/loaded',
        sessions: page.sessions,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        capacity: page.capacity,
        replace,
      });
    } catch {
      // The reason is never taken from the rejection: an IPC rejection carries main's own message,
      // which is not text this build reviewed for the UI.
      if (mountedRef.current) dispatch({ type: 'list/failed', error: LIST_ERROR });
    }
  }, []);

  useEffect(() => {
    void loadSessions(undefined, true);
  }, [loadSessions]);

  const refresh = useCallback(() => {
    void loadSessions(undefined, true);
  }, [loadSessions]);

  const loadMoreSessions = useCallback(() => {
    if (state.listCursor === undefined) return;
    void loadSessions(state.listCursor, false);
  }, [loadSessions, state.listCursor]);

  // ---------------------------------------------------------------- preferences

  /**
   * Read once, after the first listing lands.
   *
   * The order matters: `prefs/loaded` drops any id that is not in `state.sessions`, so reading
   * prefs before the list would drop everything and reading it after is what makes the staleness
   * check meaningful. A session the daemon has since evicted must not resurrect as a ghost row or
   * an unread badge attached to nothing.
   */
  useEffect(() => {
    if (state.prefsLoaded || state.listStatus !== 'ready') return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await window.workspace.getSettings();
        if (cancelled || !mountedRef.current) return;
        dispatch({
          type: 'prefs/loaded',
          selectedSessionId: settings.agentSelectedSessionId,
          archivedSessionIds: settings.agentArchivedSessionIds,
          unreadCounts: settings.agentUnreadCounts,
        });
      } catch {
        // Losing remembered selection is an acceptable cost of an unavailable database; losing the
        // page is not. Mark them loaded so the write-back effect below can still run.
        if (!cancelled && mountedRef.current) {
          dispatch({ type: 'prefs/loaded', selectedSessionId: null, archivedSessionIds: [], unreadCounts: {} });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.prefsLoaded, state.listStatus]);

  /** Writes prefs back whenever they actually differ from what was last written. */
  useEffect(() => {
    if (!state.prefsLoaded) return;
    const archived: string[] = [];
    const unread: Record<string, number> = {};
    for (const id of state.order) {
      const entry = state.sessions[id];
      if (entry === undefined) continue;
      if (entry.archived) archived.push(id);
      if (entry.unread > 0) unread[id] = entry.unread;
    }
    const patch = {
      agentSelectedSessionId: state.selectedId ?? null,
      agentArchivedSessionIds: archived,
      agentUnreadCounts: unread,
    };
    const serialized = JSON.stringify(patch);
    if (lastPrefsRef.current === serialized) return;
    lastPrefsRef.current = serialized;
    // Fire and forget: remembering a selection is a convenience, and a write failure must never
    // block or fail the interaction the user just performed.
    void window.workspace.updateSettings(patch).catch(() => {});
  }, [state.prefsLoaded, state.order, state.sessions, state.selectedId]);

  // ---------------------------------------------------------------- live activity

  useEffect(() => {
    const unsubscribe = window.agentWorkspace.onActivity((push) => {
      if (!mountedRef.current) return;
      if ('closed' in push) {
        attachedRef.current.delete(push.sessionId);
        dispatch({ type: 'activity/closed', sessionId: push.sessionId, reason: push.closed.reason });
        return;
      }
      dispatch({ type: 'activity/received', sessionId: push.sessionId, entry: push.entry });
    });
    return unsubscribe;
  }, []);

  /**
   * Attaches every running session, selected or not.
   *
   * This is the effect that would be wrong in the design ADI-07 exists to replace: a version keyed
   * on `state.selectedId` would stream one session at a time and call it concurrency. It reads the
   * daemon's own `status` instead, so what is streamed is a fact about the sessions, not about the
   * UI.
   */
  useEffect(() => {
    for (const id of state.order) {
      const entry = state.sessions[id];
      if (entry === undefined || entry.archived) continue;
      if (!isRunning(entry.view)) continue;
      if (attachedRef.current.has(id)) continue;
      if (entry.liveStatus === 'ended') continue;

      attachedRef.current.add(id);
      dispatch({ type: 'live/attaching', sessionId: id });
      const lastSeq = entry.timeline.highestSeq;
      void window.agentWorkspace
        .attachActivity(id, lastSeq >= 0 ? lastSeq : undefined)
        .then((result) => {
          if (!mountedRef.current) return;
          if (result.ok) {
            dispatch({ type: 'live/attached', sessionId: id });
            return;
          }
          attachedRef.current.delete(id);
          dispatch({ type: 'live/refused', sessionId: id, reason: result.reason });
        })
        .catch(() => {
          attachedRef.current.delete(id);
          // A rejected attach is not a session failure: it is simply not streaming.
          if (mountedRef.current) {
            dispatch({ type: 'live/refused', sessionId: id, reason: 'daemon_unavailable' });
          }
        });
    }
  }, [state.order, state.sessions]);

  /** Detaches everything on unmount, so leaving the page does not leave SSE streams open in main. */
  useEffect(() => {
    const attached = attachedRef.current;
    return () => {
      for (const id of [...attached]) {
        attached.delete(id);
        void window.agentWorkspace.detachActivity(id).catch(() => {});
      }
    };
  }, []);

  // ---------------------------------------------------------------- history paging

  /**
   * The set of sessions worth having history for: the selected one, plus a bounded window of the
   * newest non-archived ones.
   *
   * Note that the selected id only *widens* this set. A session in the prefetch window is paged
   * whether or not anything is selected, which is what makes "switching selection does not re-fetch
   * history already held" true rather than incidental.
   */
  const historyTargets = useMemo(() => {
    const targets: string[] = [];
    if (state.selectedId !== undefined) targets.push(state.selectedId);
    for (const id of state.order) {
      if (targets.length >= HISTORY_PREFETCH_WINDOW + 1) break;
      const entry = state.sessions[id];
      if (entry === undefined || entry.archived || targets.includes(id)) continue;
      targets.push(id);
    }
    return targets;
  }, [state.order, state.sessions, state.selectedId]);

  useEffect(() => {
    for (const id of historyTargets) {
      const entry = state.sessions[id];
      if (entry === undefined || entry.historyComplete) continue;
      if (historyInFlightRef.current.has(id)) continue;

      historyInFlightRef.current.add(id);
      const cursor = entry.historyCursor;
      void window.agentWorkspace
        .getSessionEvents(id, cursor === undefined ? { limit: PAGE_LIMIT } : { cursor, limit: PAGE_LIMIT })
        .then((page) => {
          if (!mountedRef.current) return;
          dispatch({
            type: 'history/loaded',
            sessionId: id,
            entries: page.events,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          });
        })
        .catch(() => {
          // Marked complete rather than retried forever: a session whose history cannot be read is
          // still a session whose outcome the list shows, and a retry loop against a failing route
          // is worse than a timeline that stops where it stopped.
          if (mountedRef.current) dispatch({ type: 'history/loaded', sessionId: id, entries: [] });
        })
        .finally(() => {
          historyInFlightRef.current.delete(id);
        });
    }
  }, [historyTargets, state.sessions]);

  // ---------------------------------------------------------------- commands

  const select = useCallback((sessionId: string | undefined) => {
    dispatch({ type: 'session/selected', ...(sessionId === undefined ? {} : { sessionId }) });
  }, []);

  const setArchived = useCallback((sessionId: string, archived: boolean) => {
    // Archiving deliberately does NOT detach a live relay. Archiving is a list-visibility choice,
    // and silently stopping a running session's updates because it was tidied away would mean the
    // user comes back to a session that appears to have stalled.
    dispatch({ type: 'session/archived', sessionId, archived });
  }, []);

  const newClientKey = useCallback(() => {
    clientKeyCounter += 1;
    return `start-${clientKeyCounter}-${Date.now()}`;
  }, []);

  /**
   * The full start flow for one pending start: request a grant, consume it, then start.
   *
   * Keyed entirely by `clientKey` so two of these can be in flight at once with no shared state
   * between them. Nothing in here reads `state`, which is what makes that true: two concurrent
   * calls cannot interfere through a closure over a snapshot that one of them has already
   * invalidated.
   */
  const startSession = useCallback(
    async (clientKey: string, provider: ProviderId, prompt: string) => {
      dispatch({ type: 'start/begin', clientKey, provider });
      try {
        // Step 1: main opens the native picker and the native confirmation dialog. The renderer
        // names only a provider and never learns the folder (ADI-06's ten-step contract).
        const offer = await window.workspaceGrant.requestGrant(provider);
        if (!mountedRef.current) return;
        if (offer === null) {
          // The user cancelled the picker or the dialog. Not a refusal, and nothing was recorded.
          dispatch({ type: 'start/dismissed', clientKey });
          return;
        }

        const consumed = await window.workspaceGrant.consumeGrant(offer.grantHandle);
        if (!mountedRef.current) return;
        if (!consumed.ok || consumed.workspaceSessionRef === undefined) {
          dispatch({
            type: 'start/refused',
            clientKey,
            reason: (consumed.ok ? 'refused' : consumed.reason) as never,
          });
          return;
        }
        dispatch({ type: 'start/granted', clientKey, workspaceName: offer.display.name });

        const started = await window.workspaceGrant.startSession({
          workspaceSessionRef: consumed.workspaceSessionRef,
          prompt,
        });
        if (!mountedRef.current) return;
        if (!started.ok) {
          dispatch({ type: 'start/refused', clientKey, reason: started.reason as never });
          return;
        }

        dispatch({ type: 'start/succeeded', clientKey, sessionId: started.session.sessionId });
        // The daemon's own view is authoritative, so it is fetched rather than synthesized from the
        // start response: that way a freshly started session renders exactly as it will one refresh
        // later, which is the same reason the daemon reuses `toV2View` for its create response.
        const view = await window.agentWorkspace.getSession(started.session.sessionId);
        if (!mountedRef.current) return;
        if (view !== null) dispatch({ type: 'session/updated', session: view });
      } catch {
        if (mountedRef.current) dispatch({ type: 'start/refused', clientKey, reason: 'refused' });
      }
    },
    [],
  );

  const dismissPendingStart = useCallback((clientKey: string) => {
    dispatch({ type: 'start/dismissed', clientKey });
  }, []);

  /**
   * Cancels a session through v1's existing channel.
   *
   * ADI-07 adds no v2 cancel route and no new cancel bridge. `agentDock.cancelSession` already
   * works on a v2 session because both live in the same `SessionManager`, and a second cancel verb
   * would be one more thing to keep in agreement with it for no capability gained.
   */
  const cancelSession = useCallback(async (sessionId: string) => {
    try {
      await window.agentDock.cancelSession(sessionId);
    } catch {
      // The session's own event stream carries the true terminal state; nothing to add here.
    }
  }, []);

  return {
    state,
    refresh,
    loadMoreSessions,
    select,
    setArchived,
    startSession,
    dismissPendingStart,
    cancelSession,
    newClientKey,
  };
}

export type { PendingStart, SessionEntry, SessionSummary };
