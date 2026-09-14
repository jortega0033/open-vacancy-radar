import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, ProviderId } from '@agent-dock/shared';

/**
 * One-shot "send a prompt, stream the answer back" runner on top of the AgentDock bridge.
 *
 * This exists because the AI features need exactly the same lifecycle and exactly the same
 * failure discipline, and because that lifecycle has three ways to hang that a naive
 * `createSession` + `onSessionEvent` wiring gets wrong:
 *
 * - **A session that never reaches a terminal event.** The daemon guarantees one, but a killed
 *   CLI, a dropped SSE stream, or a provider that stalls mid-answer would otherwise leave the UI
 *   spinning forever. `RUN_TIMEOUT_MS` converts that into an explicit, actionable failure.
 * - **A "successful" run that produced no text.** `session.completed` with an empty buffer is a
 *   failure from the user's point of view; surfacing it as an empty success panel is the worst
 *   possible outcome, so it is reported as an error.
 * - **Cross-talk between runs.** `onSessionEvent` is a process-wide stream; every event is
 *   filtered against a ref holding *this* run's session id, so a stale session (or the other
 *   feature's session) can never append text to this one.
 */
export type AgentRunStatus =
  'idle' | 'starting' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface AgentRunOptions {
  model?: string;
  /** Which installed CLI to run through. Defaults to Claude Code, matching every existing call
   * site that didn't previously have a choice. */
  provider?: ProviderId;
}

export interface UseAgentRunOptions {
  /**
   * Joins successive `assistant.message` chunks. Defaults to `"\n\n"`, right for every existing
   * consumer (Gap Analysis, Letters) that displays the accumulated text as prose. A consumer that
   * needs the accumulated text to parse as something exact (e.g. one JSON object) should pass
   * `""` instead: a coding-agent CLI can legitimately emit one answer across more than one
   * `assistant.message` event, and `"\n\n"` inserted between two of them would either break
   * parsing outright or, worse, silently land inside what was meant to be one contiguous value.
   */
  chunkSeparator?: string;
}

export interface AgentRun {
  status: AgentRunStatus;
  /** Everything the assistant has said so far, accumulated across `assistant.message` chunks. */
  text: string;
  error?: string;
  /** True while a session is being created or is streaming: the "don't touch it yet" flag. */
  isBusy: boolean;
  start(prompt: string, options?: AgentRunOptions): Promise<void>;
  cancel(): Promise<void>;
  reset(): void;
}

/**
 * Generous enough for a long answer on a slow model, short enough that a wedged run becomes a
 * visible error in the same sitting rather than an indefinite spinner.
 */
export const RUN_TIMEOUT_MS = 240_000;

/**
 * IPC rejections arrive as "Error invoking remote method 'x': Error: <the real message>". Showing
 * that verbatim buries the one part the user can act on.
 */
export function describeError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return fallback;
  const match = /Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?(.*)$/s.exec(
    message,
  );
  return (match?.[1] ?? message).trim() || fallback;
}

export function useAgentRun(options: UseAgentRunOptions = {}): AgentRun {
  const [status, setStatus] = useState<AgentRunStatus>('idle');
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();

  const sessionIdRef = useRef<string>();
  const textRef = useRef('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  // Bumped by `start`, `cancel`, `reset`, and unmount (issue #362): the one thing that lets `start`
  // notice, after its `await createSession`, that it has been superseded by a newer `start`, an
  // explicit `cancel` (including one that landed before a session id even existed yet), a `reset`,
  // or the component going away -- and so must best-effort cancel the session it just created and
  // never install it into this run's state, rather than silently resurrecting stale output.
  const generationRef = useRef(0);
  // Read from inside the mount-once effect below via ref, not a dependency: options is a fresh
  // object every render, and the effect must not resubscribe on every render because of it.
  const chunkSeparatorRef = useRef(options.chunkSeparator ?? '\n\n');
  chunkSeparatorRef.current = options.chunkSeparator ?? '\n\n';

  const clearWatchdog = useCallback(() => {
    if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
  }, []);

  /** Fire-and-forget cancel for a session this run must never adopt. Swallows its own failure the
   * same way `cancel` below already does: the session-event stream, if the daemon still has one to
   * send, carries the true terminal state, and a cancel-request failure over an obsolete session id
   * is not this run's problem to surface. */
  const cancelSessionBestEffort = useCallback((sessionId: string) => {
    void window.agentDock.cancelSession(sessionId).catch(() => {});
  }, []);

  // Subscribed once for the component's lifetime and filtered by ref, so a session started after
  // this effect ran is still matched (a closure over `sessionId` state would drop those events).
  useEffect(() => {
    const unsubscribe = window.agentDock.onSessionEvent((eventSessionId, event: AgentEvent) => {
      if (sessionIdRef.current !== eventSessionId) return;

      switch (event.type) {
        case 'assistant.message': {
          textRef.current = textRef.current
            ? `${textRef.current}${chunkSeparatorRef.current}${event.text}`
            : event.text;
          setText(textRef.current);
          setStatus((current) => (current === 'starting' ? 'streaming' : current));
          break;
        }
        case 'error': {
          if (event.recoverable) {
            // Not terminal on its own (the daemon still owes us session.failed/completed), but
            // worth capturing so a completed-with-nothing run can explain itself.
            setError((current) => current ?? event.message);
            break;
          }
          // Non-recoverable means the daemon itself cannot send a terminal event for this
          // session anymore (e.g. the SSE stream died because the daemon process died mid-run:
          // see main.ts's forwardSessionEvents catch block, which synthesizes exactly this
          // event since nothing else ever will). Waiting for session.failed/completed here would
          // wait forever; the watchdog would eventually fire, but only after RUN_TIMEOUT_MS and
          // with a generic message that discards this one, which is the real cause.
          clearWatchdog();
          sessionIdRef.current = undefined;
          setStatus('failed');
          setError(event.message);
          break;
        }
        case 'session.completed': {
          clearWatchdog();
          sessionIdRef.current = undefined;
          if (textRef.current.trim().length === 0) {
            setStatus('failed');
            setError((current) => current ?? 'the agent finished without returning any text');
          } else {
            setStatus('completed');
          }
          break;
        }
        case 'session.failed': {
          clearWatchdog();
          sessionIdRef.current = undefined;
          setStatus('failed');
          setError(event.message || 'the agent session failed');
          break;
        }
        case 'session.cancelled': {
          clearWatchdog();
          sessionIdRef.current = undefined;
          setStatus('cancelled');
          break;
        }
        default:
          break;
      }
    });

    return () => {
      unsubscribe();
      clearWatchdog();
      // Issue #362: a component that unmounts while `start`'s `createSession` is still in flight
      // must not let that later resolution write into state nobody is reading anymore.
      generationRef.current += 1;
      if (sessionIdRef.current) cancelSessionBestEffort(sessionIdRef.current);
    };
  }, [cancelSessionBestEffort, clearWatchdog]);

  const start = useCallback(
    async (prompt: string, options: AgentRunOptions = {}) => {
      const generation = ++generationRef.current;
      clearWatchdog();
      sessionIdRef.current = undefined;
      textRef.current = '';
      setText('');
      setError(undefined);
      setStatus('starting');

      try {
        // `cwd` is not a field this call can send (issue #175): main pins every session to its own
        // app-owned scratch directory unconditionally and never reads a renderer-supplied path. See
        // main.ts's `ensureAiWorkspaceDir` and the `daemon:create-session` handler.
        const session = await window.agentDock.createSession({
          provider: options.provider ?? 'claude',
          prompt,
          ...(options.model ? { model: options.model } : {}),
        });
        if (generationRef.current !== generation) {
          // Superseded while this request was in flight -- by a newer `start`, a `cancel` (even one
          // that landed before any session id existed), a `reset`, or unmount (issue #362). Never
          // adopt this session into shared state; best-effort cancel it instead of letting it run
          // unattended to completion.
          cancelSessionBestEffort(session.id);
          return;
        }
        sessionIdRef.current = session.id;
        setStatus((current) => (current === 'starting' ? 'streaming' : current));

        timeoutRef.current = setTimeout(() => {
          if (sessionIdRef.current !== session.id) return;
          sessionIdRef.current = undefined;
          setStatus('failed');
          setError(
            `no response after ${Math.round(RUN_TIMEOUT_MS / 1000)}s: the run was stopped; try again`,
          );
          void window.agentDock.cancelSession(session.id).catch(() => {});
        }, RUN_TIMEOUT_MS);
      } catch (err) {
        if (generationRef.current !== generation) return; // superseded; not this run's error to report
        sessionIdRef.current = undefined;
        setStatus('failed');
        setError(describeError(err, 'failed to start the agent session'));
      }
    },
    [cancelSessionBestEffort, clearWatchdog],
  );

  const cancel = useCallback(async () => {
    // Invalidates a `start` whose `createSession` hasn't resolved yet too (issue #362): without
    // this, clicking Cancel while still "starting" (no session id assigned yet) did nothing, and
    // the run proceeded exactly as if Cancel had never been clicked.
    generationRef.current += 1;
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      // No real session exists yet to send a cancel request for. Reflect the cancellation right
      // away instead of leaving the UI showing "starting" until that request eventually resolves
      // in the background and gets silently discarded by the generation check in `start`.
      clearWatchdog();
      setStatus('cancelled');
      return;
    }
    try {
      await window.agentDock.cancelSession(sessionId);
    } catch {
      // the session-event stream still carries the true terminal state; nothing to add here
    }
  }, [clearWatchdog]);

  const reset = useCallback(() => {
    // Issue #362: a session already known to be running must actually be told to stop, not just
    // forgotten locally -- and invalidating the generation here is what makes an in-flight `start`
    // (one whose `createSession` hasn't resolved yet, so no session id exists to cancel above)
    // discover on its own that it was superseded, rather than resurrecting stale output later.
    generationRef.current += 1;
    if (sessionIdRef.current) cancelSessionBestEffort(sessionIdRef.current);
    clearWatchdog();
    sessionIdRef.current = undefined;
    textRef.current = '';
    setText('');
    setError(undefined);
    setStatus('idle');
  }, [cancelSessionBestEffort, clearWatchdog]);

  return {
    status,
    text,
    error,
    isBusy: status === 'starting' || status === 'streaming',
    start,
    cancel,
    reset,
  };
}
