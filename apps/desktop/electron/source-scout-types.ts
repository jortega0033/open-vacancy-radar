import type { AtsSourceScoutCounters, AtsSourceScoutStopReason } from '@open-vacancy-radar/vacancy-engine';

/**
 * Wire and storage types for the background source scout (#348). Type-only, so nothing here is
 * emitted into the renderer bundle.
 */

/** How the last scout attempt ended. Only `completed`, `limit_reached`, `nothing_due` and `failed`
 * did network work; the rest are clean skips. */
export type SourceScoutOutcomeKind =
  | 'completed'
  | 'limit_reached'
  | 'nothing_due'
  | 'no_roster'
  | 'no_profile'
  | 'busy'
  | 'cancelled'
  | 'failed';

export interface SourceScoutOutcome {
  kind: SourceScoutOutcomeKind;
  /** ISO time the attempt ended. */
  at: string;
  /** Present for attempts that reached the network. */
  counters?: AtsSourceScoutCounters;
  stoppedBecause?: AtsSourceScoutStopReason;
  /** Sources planned but left alone because they are not due yet. */
  skippedNotDue?: number;
  requestsUsed?: number;
  /** Short plain reason for a failed attempt. */
  message?: string;
}

/** Durable scout state, kept next to the source observation file so it survives a restart. */
export interface SourceScoutState {
  version: 1;
  paused: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** Runs in a row that failed outright or got nothing but failures; drives the longer backoff. */
  consecutiveFailedRuns: number;
  lastOutcome: SourceScoutOutcome | null;
}

/** What Settings shows. */
export interface SourceScoutStatus {
  enabled: boolean;
  paused: boolean;
  running: boolean;
  /** False when no saved role or keyword exists, so no network work can start. */
  hasProfile: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastOutcome: SourceScoutOutcome | null;
}

export type SourceScoutRunRefusal = 'disabled' | 'running';

export type SourceScoutRunStart = { started: true } | { started: false; reason: SourceScoutRunRefusal };
