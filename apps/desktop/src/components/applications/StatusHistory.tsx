import { useEffect, useState } from 'react';
import type { ApplicationStatusEventEntry, ApplicationStatusEventRecord } from '../../window.js';
import { APPLICATION_STATUS_LABEL } from './application-status.js';

/** A YYYY-MM-DD the person typed, shown as that calendar day in local time (no time-zone shift). */
function formatCalendarDay(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatInstantDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Who asserted the change, in the person's terms. Never a cause or a reason. */
export function statusEventSourceLabel(event: ApplicationStatusEventRecord): string {
  if (event.source === 'app_observed') {
    return event.evidence === 'receipt_confirmed'
      ? 'This app saw the employer confirmation.'
      : 'This app recorded it as sent. No confirmation was recorded.';
  }
  if (event.evidence === 'user_statement') return 'You reported sending it.';
  return 'Set by you.';
}

export const STATUS_HISTORY_LEGACY_LINE = 'Changes made before this version were not recorded.';

/**
 * #708: the short status history in the application drawer. Read-only: it shows what was recorded
 * and says plainly when a date is unknown. It never infers a date, a reply or a reason.
 */
export function StatusHistory({ applicationId }: { applicationId: string }) {
  const [entries, setEntries] = useState<ApplicationStatusEventEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (typeof window.workspace?.listApplicationStatusEvents !== 'function') return undefined;
    let cancelled = false;
    window.workspace
      .listApplicationStatusEvents(applicationId)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  return (
    <section aria-label="Status history" className="space-y-1.5">
      <h3 className="ovr-eyebrow">Status history</h3>
      {failed ? (
        <p className="text-sm text-base-content/70">Could not load the status history.</p>
      ) : entries === null ? null : (
        <ul className="space-y-1.5 text-sm">
          {entries.map((entry) =>
            entry.readable ? (
              <li key={entry.id}>
                <span className="font-medium">{APPLICATION_STATUS_LABEL[entry.toStatus]}</span>
                {entry.fromStatus ? ` (from ${APPLICATION_STATUS_LABEL[entry.fromStatus]})` : ''}
                {'. '}
                {entry.occurredOn ? `Happened on ${formatCalendarDay(entry.occurredOn)}.` : 'Date not given.'}{' '}
                {statusEventSourceLabel(entry)}{' '}
                <span className="text-base-content/70">Recorded {formatInstantDay(entry.recordedAt)}.</span>
              </li>
            ) : (
              <li key={entry.id} className="text-base-content/70">
                Recorded by a newer version of the app on {formatInstantDay(entry.recordedAt)}.
              </li>
            ),
          )}
          <li className="text-base-content/70">{STATUS_HISTORY_LEGACY_LINE}</li>
        </ul>
      )}
    </section>
  );
}
