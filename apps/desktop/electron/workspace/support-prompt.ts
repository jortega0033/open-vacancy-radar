/**
 * The one-time "Support OVR" ask (#503): its stored state, the tolerant reader for that state,
 * and the pure transition function the renderer runs. Pure on purpose so the frequency cap is
 * unit-testable without a database or a DOM, and shared by `validate.ts`, the repository and the
 * renderer so the shape is written down once.
 */

export interface SupportPromptState {
  /** Set by Star or Coffee, here or in Settings. Ends the asks for good. */
  answered: boolean;
  /** How many times the dialog was shown and dismissed with "Not now" (0, 1 or 2). */
  asks: number;
  /** Success moments recorded since the last "Not now". Reset to 0 on each one. */
  successesSinceDismissal: number;
}

export type SupportPromptEvent = 'success' | 'not_now' | 'answered';

/** Maximum number of times the dialog is ever shown. */
export const SUPPORT_MAX_ASKS = 2;
/** Success moments needed after the first "Not now" before the dialog is due again. */
export const SUPPORT_SUCCESSES_BEFORE_REASK = 5;

export const DEFAULT_SUPPORT_PROMPT: SupportPromptState = {
  answered: false,
  asks: 0,
  successesSinceDismissal: 0,
};

/** Upper bound on the stored counters, so a corrupted value cannot grow without limit. */
const COUNTER_MAX = 1_000_000;

function counter(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > COUNTER_MAX) return null;
  return value;
}

/** Strict parse used for a renderer patch: returns null when the value is not a valid state. */
export function parseSupportPromptStrict(value: unknown): SupportPromptState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const asks = counter(record.asks);
  const successes = counter(record.successesSinceDismissal);
  if (typeof record.answered !== 'boolean' || asks === null || successes === null) return null;
  if (asks > SUPPORT_MAX_ASKS) return null;
  return { answered: record.answered, asks, successesSinceDismissal: successes };
}

/** Tolerant read of a stored value: anything missing or malformed reads as "never asked". */
export function readSupportPrompt(value: unknown): SupportPromptState {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { ...DEFAULT_SUPPORT_PROMPT };
    }
  }
  return parseSupportPromptStrict(candidate) ?? { ...DEFAULT_SUPPORT_PROMPT };
}

/** Whether the dialog is due given the state after a success moment was recorded. */
export function isSupportDue(state: SupportPromptState): boolean {
  if (state.answered || state.asks >= SUPPORT_MAX_ASKS) return false;
  if (state.asks === 0) return true;
  return state.successesSinceDismissal >= SUPPORT_SUCCESSES_BEFORE_REASK;
}

/**
 * The next stored state for an event.
 *
 * - `success`: a first-ask user is due straight away (state unchanged); after one "Not now" the
 *   success counter goes up. Nothing changes once answered or after the second ask.
 * - `not_now`: the dialog was shown and dismissed. Counts an ask and restarts the success count.
 * - `answered`: Star or Coffee. Ends the asks and leaves the counters alone.
 */
export function nextSupportState(state: SupportPromptState, event: SupportPromptEvent): SupportPromptState {
  if (event === 'answered') return state.answered ? state : { ...state, answered: true };
  if (state.answered || state.asks >= SUPPORT_MAX_ASKS) return state;
  if (event === 'not_now') {
    return { ...state, asks: Math.min(state.asks + 1, SUPPORT_MAX_ASKS), successesSinceDismissal: 0 };
  }
  if (state.asks === 0) return state;
  return { ...state, successesSinceDismissal: state.successesSinceDismissal + 1 };
}
