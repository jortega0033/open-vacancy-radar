import type { SessionSummary } from '../../window.js';

/**
 * The renderer's closed vocabulary for a v2 session's status and terminal reason (ADI-07).
 *
 * Split out of the components for the same reason `refusal-copy.ts` is its own module: every
 * sentence the AI Workspace shows must come from a table this build wrote, never from a string the
 * daemon chose. `SessionSummary.status` and `SessionSummary.terminalReason` arrive as plain
 * `string` on purpose (main rebuilds them as bounded strings rather than asserting a union it does
 * not control), so the lookup below is a *closed table with a fallback*, not a cast.
 *
 * No em dashes: everything here is user-facing copy.
 */

export type StatusTone = 'running' | 'done' | 'bad' | 'neutral';

export interface StatusCopy {
  /** A short label for the list row's badge. */
  label: string;
  tone: StatusTone;
}

const STATUS_COPY: Readonly<Record<string, StatusCopy>> = Object.freeze({
  starting: { label: 'Starting', tone: 'running' },
  running: { label: 'Running', tone: 'running' },
  completed: { label: 'Completed', tone: 'done' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
  // v2-only. A session the daemon recovered after a restart: it did not fail, it was cut off.
  interrupted: { label: 'Interrupted', tone: 'neutral' },
});

export function statusCopy(status: string): StatusCopy {
  return STATUS_COPY[status] ?? { label: 'Unknown', tone: 'neutral' };
}

/**
 * Why the session stopped, in words, or nothing when the daemon did not say.
 *
 * `daemon_restart` is the one worth spelling out: it is the state a user meets most often and the
 * one most easily misread as a failure, so it gets a sentence rather than a label.
 */
const TERMINAL_REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
  provider_completed: 'The agent finished on its own.',
  provider_error: 'The agent stopped because of an error.',
  cancelled_by_client: 'You stopped this session.',
  launch_failed: 'The agent could not be started.',
  daemon_restart: 'The local runtime restarted while this session was running, so it was cut off.',
});

export function terminalReasonCopy(reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : TERMINAL_REASON_COPY[reason];
}

/** daisyUI badge classes per tone. Colour is never the only signal: the label always says it too. */
export const STATUS_BADGE_CLASS: Readonly<Record<StatusTone, string>> = Object.freeze({
  running: 'badge-info',
  done: 'badge-success',
  bad: 'badge-error',
  neutral: 'badge-ghost',
});

/**
 * A short, path-free description of where the session came from.
 *
 * Note what it cannot say: which folder the session runs in. The renderer has never been told, and
 * `SessionSummary` has nowhere to put it. What it can say is the provider, the model the daemon
 * recorded, and whether this was a fresh start or a continuation.
 */
export function provenanceLine(view: SessionSummary): string {
  const parts = [view.provider];
  if (view.model !== undefined && view.model.length > 0) parts.push(view.model);
  if (view.continuationKind !== 'fresh') parts.push('continued');
  return parts.join(' · ');
}

/** A locale-formatted instant, or the raw bounded string when it is not a date this build can parse. */
export function formatInstant(value: string): string {
  if (value.length === 0) return 'Unknown time';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
