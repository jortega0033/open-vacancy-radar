import type { AgentEvent, ProviderId } from '@agent-dock/shared';
import { classifyProviderError } from '../../provider-error.js';
import { clearProviderLimit, recordProviderLimit } from '../../provider-limits.js';

/**
 * One cancellable "send a prompt, collect the whole answer" run over the AgentDock bridge, for callers
 * that are not React components (the explicit batch assessment, #688).
 *
 * It is the same lifecycle `useAgentRun` implements for a single panel, with the same three guards:
 * a hard timeout (a session that never reaches a terminal event becomes an explicit failure), an empty
 * "success" is a failure, and every event is matched against THIS run's session id. It adds what a batch
 * needs: an `AbortSignal` that cancels the live session, and buffering of events that arrive between the
 * daemon creating the session and the page learning its id.
 *
 * It starts a session only when called. Nothing in the app calls it on render or navigation.
 */

export type AgentPromptResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'failed'; error: string };

export interface AgentPromptOptions {
  signal: AbortSignal;
  timeoutMs: number;
  provider?: ProviderId;
  model?: string;
}

export function runAgentPrompt(prompt: string, options: AgentPromptOptions): Promise<AgentPromptResult> {
  const provider: ProviderId = options.provider ?? 'claude';
  return new Promise<AgentPromptResult>((resolve) => {
    let settled = false;
    let sessionId: string | undefined;
    let text = '';
    let lastError: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const buffered = new Map<string, AgentEvent[]>();

    const cancelSession = (id: string): void => {
      void window.agentDock.cancelSession(id).catch(() => undefined);
    };

    const finish = (result: AgentPromptResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      options.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const fail = (message: string): void => {
      const info = classifyProviderError(message);
      if (info.kind === 'usage_limit') {
        recordProviderLimit({
          provider,
          reachedAt: Date.now(),
          ...(info.resetLabel ? { resetLabel: info.resetLabel } : {}),
          ...(info.resetAt !== undefined ? { resetAt: info.resetAt } : {}),
        });
      }
      finish({ ok: false, reason: 'failed', error: message || 'the agent session failed' });
    };

    const handle = (event: AgentEvent): void => {
      switch (event.type) {
        case 'assistant.message':
          // A coding-agent CLI can emit one JSON answer across several messages: joined with nothing.
          text += event.text;
          break;
        case 'error':
          if (event.recoverable) lastError ??= event.message;
          else fail(event.message);
          break;
        case 'session.completed':
          if (text.trim().length === 0) fail(lastError ?? 'the agent finished without returning any text');
          else {
            clearProviderLimit(provider);
            finish({ ok: true, text });
          }
          break;
        case 'session.failed':
          fail(event.message || 'the agent session failed');
          break;
        case 'session.cancelled':
          finish({ ok: false, reason: 'cancelled', error: 'cancelled' });
          break;
        default:
          break;
      }
    };

    const unsubscribe = window.agentDock.onSessionEvent((eventSessionId, event) => {
      if (settled) return;
      if (sessionId === undefined) {
        const list = buffered.get(eventSessionId) ?? [];
        list.push(event);
        buffered.set(eventSessionId, list);
        return;
      }
      if (eventSessionId === sessionId) handle(event);
    });

    function onAbort(): void {
      if (sessionId !== undefined) cancelSession(sessionId);
      finish({ ok: false, reason: 'cancelled', error: 'cancelled' });
    }
    if (options.signal.aborted) {
      finish({ ok: false, reason: 'cancelled', error: 'cancelled' });
      return;
    }
    options.signal.addEventListener('abort', onAbort, { once: true });

    window.agentDock
      .createSession({
        provider,
        prompt,
        ...(options.model ? { model: options.model } : {}),
      })
      .then((session) => {
        if (settled) {
          // Cancelled while the session was being created: never let it run unattended.
          cancelSession(session.id);
          return;
        }
        sessionId = session.id;
        timer = setTimeout(() => {
          if (settled) return;
          cancelSession(session.id);
          finish({
            ok: false,
            reason: 'timeout',
            error: `no response after ${Math.round(options.timeoutMs / 1000)}s: the request was stopped`,
          });
        }, options.timeoutMs);
        for (const event of buffered.get(session.id) ?? []) {
          handle(event);
          if (settled) break;
        }
        buffered.clear();
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error.message : 'failed to start the agent session');
      });
  });
}
