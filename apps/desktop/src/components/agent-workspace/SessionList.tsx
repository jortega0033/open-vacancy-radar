import type { SessionCapacity } from '../../window.js';
import { STATUS_BADGE_CLASS, formatInstant, provenanceLine, statusCopy } from './status.js';
import type { SessionEntry, WorkspaceState } from './workspace-reducer.js';
import { visibleSessionIds } from './workspace-reducer.js';

/**
 * The left rail: every v2 session the daemon reports, in the daemon's own order (ADI-07).
 *
 * ## Why every row is here at once, and none of them is privileged
 *
 * There is no "active session" in this list. Each row reads its own entry out of the state map,
 * shows its own live indicator, and carries its own unread badge; selection changes which row is
 * highlighted and which one the detail pane shows, and nothing else. Two sessions can both be
 * streaming, both be accumulating a timeline, and both show live indicators here while neither is
 * selected. That is the property `workspace-reducer.ts`'s reference-identity test proves at the
 * state layer, and this component is the reason it matters at the view layer.
 *
 * ## What a row can never show
 *
 * The folder. `SessionSummary` has no path-shaped field, so a row identifies a session by its
 * provider, its model, and when it started. That is a deliberate cost of ADI-07's boundary and
 * worth stating plainly: the user knows which folder they approved because they approved it in a
 * native dialog, and the renderer is not told again.
 *
 * No em dashes: this is user-facing copy.
 */

export interface SessionListProps {
  state: WorkspaceState;
  archived: boolean;
  onSelect(sessionId: string): void;
  onSetArchived(sessionId: string, archived: boolean): void;
  onLoadMore(): void;
}

export function SessionList({ state, archived, onSelect, onSetArchived, onLoadMore }: SessionListProps) {
  const ids = visibleSessionIds(state, archived);

  if (ids.length === 0) {
    return (
      <p className="p-3 text-sm text-base-content/60" data-testid="session-list-empty">
        {archived ? 'No archived sessions.' : 'No agent sessions yet. Start one to see it here.'}
      </p>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-1.5" aria-label={archived ? 'Archived sessions' : 'Agent sessions'}>
        {ids.map((id) => {
          const entry = state.sessions[id];
          if (entry === undefined) return null;
          return (
            <li key={id}>
              <SessionRow
                entry={entry}
                selected={id === state.selectedId}
                onSelect={() => onSelect(id)}
                onToggleArchived={() => onSetArchived(id, !entry.archived)}
              />
            </li>
          );
        })}
      </ul>
      {!archived && state.listCursor !== undefined && (
        <button type="button" className="btn btn-ghost btn-sm mt-2 w-full" onClick={onLoadMore}>
          Load more
        </button>
      )}
    </>
  );
}

interface SessionRowProps {
  entry: SessionEntry;
  selected: boolean;
  onSelect(): void;
  onToggleArchived(): void;
}

function SessionRow({ entry, selected, onSelect, onToggleArchived }: SessionRowProps) {
  const status = statusCopy(entry.view.status);
  const streaming = entry.liveStatus === 'live' || entry.liveStatus === 'attaching';

  return (
    <div
      className={[
        'rounded-box border p-2.5',
        selected ? 'border-base-content/30 bg-base-200' : 'border-base-300 bg-base-100',
      ].join(' ')}
    >
      <button
        type="button"
        className="w-full text-left"
        onClick={onSelect}
        {...(selected ? { 'aria-current': 'true' as const } : {})}
        aria-label={`Session ${provenanceLine(entry.view)}, ${status.label}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={`badge badge-sm ${STATUS_BADGE_CLASS[status.tone]}`}>{status.label}</span>
          {entry.unread > 0 && (
            <span className="badge badge-sm badge-neutral" aria-label={`${entry.unread} unread updates`}>
              {entry.unread}
            </span>
          )}
        </div>
        <div className="mt-1.5 truncate text-sm font-medium">{provenanceLine(entry.view)}</div>
        <div className="mt-0.5 truncate text-xs text-base-content/50">{formatInstant(entry.view.startedAt)}</div>
        {streaming && (
          <div className="mt-1 text-xs text-info" data-testid="live-indicator">
            {entry.liveStatus === 'attaching' ? 'Connecting to live updates' : 'Live'}
          </div>
        )}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-xs mt-1.5"
        onClick={onToggleArchived}
        aria-label={
          entry.archived
            ? `Restore session ${provenanceLine(entry.view)}`
            : `Archive session ${provenanceLine(entry.view)}`
        }
      >
        {entry.archived ? 'Restore' : 'Archive'}
      </button>
    </div>
  );
}

/**
 * The daemon's own capacity aggregate, stated honestly.
 *
 * The `provider` bucket reports the *busiest* provider rather than the one any particular session
 * uses (see `aggregateCapacity` in the daemon's v2 route, and `toCapacity`'s note). ADI-07 does not
 * add a `?provider=` query to narrow it, so this line says "across providers" rather than implying
 * a per-provider number the app did not ask for.
 */
export function CapacityLine({ capacity }: { capacity: SessionCapacity | undefined }) {
  if (capacity === undefined) return null;
  const full = capacity.global.limit > 0 && capacity.global.active >= capacity.global.limit;
  return (
    <p className={`text-xs ${full ? 'text-warning' : 'text-base-content/60'}`} data-testid="capacity-line">
      {capacity.global.active} of {capacity.global.limit} concurrent sessions in use
      {full ? '. Stop one before starting another.' : '.'}
    </p>
  );
}
