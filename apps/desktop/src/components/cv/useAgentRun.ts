import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, ProviderId } from '@agent-dock/shared';

/**
 * One-shot "send a prompt, stream the answer back" runner on top of the AgentDock bridge.
 *
 * This exists because both AI features need exactly the same lifecycle and exactly the same
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
export type AgentRunStatus = 'idle' | 'starting' | 'streaming' | 'completed' | 'failed' | 'cancelled';

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
   * needs the accumulated text to parse as something exact — e.g. one JSON object — should pass
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
  /** True while a session is being created or is streaming — the "don't touch it yet" flag. */
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
  const match = /Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?(.*)$/s.exec(message);
  return (match?.[1] ?? message).trim() || fallback;
}

export function useAgentRun(options: UseAgentRunOptions = {}): AgentRun {
  const [status, setStatus] = useState<AgentRunStatus>('idle');
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();

  const sessionIdRef = useRef<string>();
  const textRef = useRef('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  // Read from inside the mount-once effect below via ref, not a dependency — options is a fresh
  // object every render, and the effect must not resubscribe on every render because of it.
  const chunkSeparatorRef = useRef(options.chunkSeparator ?? '\n\n');
  chunkSeparatorRef.current = options.chunkSeparator ?? '\n\n';

  const clearWatchdog = useCallback(() => {
    if (timeoutRef.current !== undefined) clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
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
          // Not terminal on its own — the daemon still owes us session.failed/completed — but
          // worth capturing so a completed-with-nothing run can explain itself.
          setError((current) => current ?? event.message);
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
    };
  }, [clearWatchdog]);

  const start = useCallback(
    async (prompt: string, options: AgentRunOptions = {}) => {
      clearWatchdog();
      sessionIdRef.current = undefined;
      textRef.current = '';
      setText('');
      setError(undefined);
      setStatus('starting');

      try {
        // The daemon validates that `cwd` exists, so it comes from main (an app-owned scratch
        // directory) rather than being guessed in the renderer. See main.ts's ensureAiWorkspaceDir.
        const cwd = await window.cv.getWorkspaceDir();
        const session = await window.agentDock.createSession({
          provider: options.provider ?? 'claude',
          cwd,
          prompt,
          ...(options.model ? { model: options.model } : {}),
        });
        sessionIdRef.current = session.id;
        setStatus((current) => (current === 'starting' ? 'streaming' : current));

        timeoutRef.current = setTimeout(() => {
          if (sessionIdRef.current !== session.id) return;
          sessionIdRef.current = undefined;
          setStatus('failed');
          setError(`no response after ${Math.round(RUN_TIMEOUT_MS / 1000)}s — the run was stopped; try again`);
          void window.agentDock.cancelSession(session.id).catch(() => {});
        }, RUN_TIMEOUT_MS);
      } catch (err) {
        sessionIdRef.current = undefined;
        setStatus('failed');
        setError(describeError(err, 'failed to start the agent session'));
      }
    },
    [clearWatchdog],
  );

  const cancel = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      await window.agentDock.cancelSession(sessionId);
    } catch {
      // the session-event stream still carries the true terminal state; nothing to add here
    }
  }, []);

  const reset = useCallback(() => {
    clearWatchdog();
    sessionIdRef.current = undefined;
    textRef.current = '';
    setText('');
    setError(undefined);
    setStatus('idle');
  }, [clearWatchdog]);

  return { status, text, error, isBusy: status === 'starting' || status === 'streaming', start, cancel, reset };
}
