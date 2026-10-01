import type { AgentEvent } from '@agent-dock/shared';

/**
 * The three terminal `AgentEvent` types every provider transport in this repo ends with -- exactly
 * one of, always last (see `types.ts`'s `ProviderSessionHandle.events` doc comment). Shared so each
 * transport's own terminal-detection logic can't drift from another's by listing the three types
 * slightly differently. Third real use is `transport-selection.ts` (ADI-08 stage 7), after
 * `run-session.ts` and `app-server/transport.ts` each independently declared the same set.
 */
export const TERMINAL_AGENT_EVENT_TYPES = new Set<AgentEvent['type']>(['session.completed', 'session.failed', 'session.cancelled']);

/**
 * The standard two-event pair (`error` then `session.failed`) every `AsyncChannel`-backed transport
 * in this repo emits when its bounded event buffer overflows -- see `AsyncChannel.push`'s own doc
 * comment for why overflow drops the item rather than auto-closing, and why the terminal pair still
 * needs to get through via `closeWith`/`closeWith`-equivalent bypassing the cap. Centralized so the
 * three independent call sites that construct this exact pair (`run-session.ts`,
 * `app-server/transport.ts`, `transport-selection.ts`) can't drift out of sync with each other's
 * wording or shape.
 */
export function overflowTerminalEvents(): AgentEvent[] {
  return [
    { type: 'error', code: 'EVENT_OVERFLOW', message: 'session event buffer overflowed', recoverable: false },
    { type: 'session.failed', message: 'session event buffer overflowed' },
  ];
}
