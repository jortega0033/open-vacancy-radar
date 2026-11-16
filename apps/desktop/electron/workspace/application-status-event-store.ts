import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { WorkspaceDb } from './client.js';
import { applicationStatusEvents } from './schema.js';
import type {
  ApplicationAttemptCheckpoint,
  ApplicationCompletionEvidence,
  ApplicationStatus,
  ApplicationStatusEventEntry,
  ApplicationStatusEventEvidence,
  ApplicationStatusEventSource,
  ApplicationStatusEventVia,
} from './types.js';
import { WorkspaceInputError } from './validate.js';

/**
 * #708: the append-only status history of one Applications row. `applications.status` stays the
 * source of truth; nothing here reads an event back into a status, a profile, a preference, a
 * search weight or a score.
 *
 * Every write goes through `recordStatusChange`, called inside the same transaction as the status
 * write it describes, and only when the stored value actually changes. That comparison is also what
 * makes a retried change safe: the retry finds the status already set and writes nothing. Events are
 * never edited and never deleted one by one; they go with their application or with Reset.
 */

export const STATUS_EVENT_VERSION = 1;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u;

type Row = typeof applicationStatusEvents.$inferSelect;
type Tx = Pick<WorkspaceDb, 'select' | 'insert' | 'delete'>;

/** The local calendar date of `now`, YYYY-MM-DD. */
export function localCalendarDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** True for a real YYYY-MM-DD calendar date (no 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

/**
 * Refuses a date the person could not yet know: a real calendar date, not later than today in local
 * time. Past dates are allowed, and nothing is cross-checked against `applied_at` or other events.
 */
export function assertOccurredOn(value: string | null | undefined, now: Date): string | null {
  if (value === null || value === undefined) return null;
  if (!isCalendarDate(value)) throw new WorkspaceInputError('"statusOccurredOn" must be a calendar date (YYYY-MM-DD)');
  if (value > localCalendarDate(now)) throw new WorkspaceInputError('"statusOccurredOn" cannot be later than today');
  return value;
}

export interface StatusChange {
  applicationId: string;
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus;
  source: ApplicationStatusEventSource;
  via: ApplicationStatusEventVia;
  attemptId?: string | null;
  evidence?: ApplicationStatusEventEvidence | null;
  /** Only ever the date the person typed; already checked with `assertOccurredOn`. */
  occurredOn?: string | null;
  observedAt?: Date | null;
  now: Date;
}

/** Writes one event when the status really changed. Returns whether it wrote one. */
export function recordStatusChange(tx: Tx, change: StatusChange): boolean {
  if (change.fromStatus === change.toStatus) return false;
  tx.insert(applicationStatusEvents)
    .values({
      id: randomUUID(),
      applicationId: change.applicationId,
      eventVersion: STATUS_EVENT_VERSION,
      fromStatus: change.fromStatus,
      toStatus: change.toStatus,
      source: change.source,
      via: change.via,
      attemptId: change.attemptId ?? null,
      evidence: change.evidence ?? null,
      occurredOn: change.occurredOn ?? null,
      // A time the app saw is only ever attached to something the app observed.
      observedAt: change.source === 'app_observed' ? (change.observedAt ?? null) : null,
      recordedAt: change.now,
    })
    .run();
  return true;
}

/**
 * Who asserted an attempt-sync move to `applied`, and on what. A person's report stays `user_set`
 * even though the sync writes it; only a `submitted` attempt with no person's report behind it is
 * something this app observed. The app's own time is the attempt's `submittedAt` and nothing else:
 * no fallback to `updatedAt`, which is when the row last changed, not when anything was sent.
 */
export function attemptSyncAssertion(attempt: {
  checkpoint: ApplicationAttemptCheckpoint;
  completionEvidence: ApplicationCompletionEvidence | null;
  submittedAt: Date | null;
}): { source: ApplicationStatusEventSource; evidence: ApplicationStatusEventEvidence; observedAt: Date | null } {
  if (attempt.checkpoint === 'user_reported' || attempt.completionEvidence === 'user_reported') {
    return { source: 'user_set', evidence: 'user_statement', observedAt: null };
  }
  return {
    source: 'app_observed',
    evidence: attempt.completionEvidence === 'receipt_confirmed' ? 'receipt_confirmed' : 'not_recorded',
    observedAt: attempt.submittedAt ?? null,
  };
}

function toEntry(row: Row): ApplicationStatusEventEntry {
  if (row.eventVersion !== STATUS_EVENT_VERSION) {
    return {
      readable: false,
      id: row.id,
      applicationId: row.applicationId,
      eventVersion: row.eventVersion,
      recordedAt: row.recordedAt.toISOString(),
    };
  }
  return {
    readable: true,
    id: row.id,
    applicationId: row.applicationId,
    eventVersion: STATUS_EVENT_VERSION,
    fromStatus: row.fromStatus as ApplicationStatus | null,
    toStatus: row.toStatus as ApplicationStatus,
    source: row.source,
    via: row.via,
    attemptId: row.attemptId,
    evidence: row.evidence,
    occurredOn: row.occurredOn,
    observedAt: row.observedAt ? row.observedAt.toISOString() : null,
    recordedAt: row.recordedAt.toISOString(),
  };
}

/** One application's history, newest recorded first (insertion order breaks a same-millisecond tie). An empty list means "nothing recorded", not "no changes". */
export function listStatusEvents(db: Pick<WorkspaceDb, 'select'>, applicationId: string): ApplicationStatusEventEntry[] {
  return db
    .select()
    .from(applicationStatusEvents)
    .where(eq(applicationStatusEvents.applicationId, applicationId))
    .orderBy(desc(applicationStatusEvents.recordedAt), sql`rowid desc`)
    .all()
    .map(toEntry);
}

/** Counted and deleted explicitly by the application data reset. */
export function deleteAllStatusEvents(tx: Pick<WorkspaceDb, 'select' | 'delete'>): { applicationStatusEvents: number } {
  const count = tx.select({ id: applicationStatusEvents.id }).from(applicationStatusEvents).all().length;
  tx.delete(applicationStatusEvents).run();
  return { applicationStatusEvents: count };
}
