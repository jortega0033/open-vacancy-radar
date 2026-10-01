import { useEffect, useRef, useState } from 'react';
import { ErrorBanner, PageLoading } from '../shell/index.js';
import type { SessionSearchMatch } from '../../window.js';

/**
 * A bounded literal search over persisted session history (ADI-28).
 *
 * ## What this can find, and what it cannot
 *
 * Only a handful of already-plaintext fields the daemon's durable store persists unredacted: a
 * tool's name, a status word, an error code, a rate-limit's name. It can never find a word from the
 * agent's own reply or from a tool's input/output, because ADI-05's durable store never writes that
 * text to disk in the first place -- it keeps a SHA-256 digest instead. This panel says so plainly
 * rather than let a user assume the search is broken when a real conversation term finds nothing.
 *
 * ## Why the searched query is held separately from the typed query
 *
 * `query` is what the input box shows right now; `searchedQuery` is the text the current
 * `matches`/`cursor` actually came from. Without that split, editing the box after a search (without
 * resubmitting) and then pressing "Load more" would fetch the *next page of the new, unsearched
 * text* using the *previous query's* pagination cursor -- a real bug a review caught, since the
 * daemon's cursor has no idea what query it was issued for and will happily page through anything.
 *
 * ## Why a generation counter guards every response
 *
 * A slow first search (scanning close to the daemon's own session-scan bound) can still be in flight
 * when a second, faster one starts. Without a check, the slow response can land after the fast one
 * and overwrite its results, leaving the visible query and the visible results permanently
 * mismatched. Each call captures the generation it was issued at and only applies its result if that
 * generation is still current -- the same shape of fix `useAgentRun.ts` uses for the same reason.
 *
 * No em dashes: this is user-facing copy.
 */

export interface SessionSearchPanelProps {
  onOpenSession(sessionId: string): void;
}

type SearchStatus = 'idle' | 'loading' | 'error' | 'done';

const FIELD_LABEL: Record<string, string> = {
  toolName: 'Tool name',
  status: 'Status',
  code: 'Error code',
  limitId: 'Rate limit',
  limitName: 'Rate limit',
};

function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

export function SessionSearchPanel({ onOpenSession }: SessionSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [matches, setMatches] = useState<SessionSearchMatch[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [expanded, setExpanded] = useState(false);

  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const runSearch = async (q: string, append: boolean) => {
    const trimmed = q.trim();
    const generation = ++generationRef.current;
    if (trimmed.length === 0) {
      setStatus('idle');
      setMatches([]);
      setCursor(undefined);
      setSearchedQuery('');
      return;
    }
    setStatus('loading');
    try {
      const page = await window.agentWorkspace.searchSessions(
        trimmed,
        append && cursor !== undefined ? { cursor } : undefined,
      );
      if (!mountedRef.current || generation !== generationRef.current) return;
      setMatches((current) => (append ? [...current, ...page.matches] : page.matches));
      setCursor(page.nextCursor);
      setSearchedQuery(trimmed);
      setStatus('done');
    } catch {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setStatus('error');
    }
  };

  const loading = status === 'loading';
  // A page can legitimately come back with zero matches and a cursor at the same time: the daemon
  // stopped after its own per-request session-scan bound, not because it searched everything. That
  // is "nothing found yet", not "nothing found" -- the two need different copy, or a real match
  // sitting just past the bound reads as a confident false negative.
  const exhausted = status === 'done' && cursor === undefined;

  return (
    <div className="rounded-box border border-base-300 bg-base-100 p-2.5">
      <button
        type="button"
        className="w-full text-left text-xs font-semibold tracking-wide text-base-content/60 uppercase"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? 'Hide search' : 'Search session history'}
      </button>
      {expanded && (
        <div className="mt-2">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(query, false);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              className="input input-sm input-bordered w-full"
              placeholder="Tool name, status, error code..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search session history"
            />
            <button type="submit" className="btn btn-sm" disabled={query.trim().length === 0 || loading}>
              Search
            </button>
          </form>
          <p className="mt-1.5 text-xs text-base-content/50">
            Finds tool names, status words, error codes, and rate-limit names only. It cannot search
            what the agent said or what a tool read or wrote.
          </p>

          {status === 'error' && (
            <ErrorBanner className="mt-2">The search could not be completed. Try again.</ErrorBanner>
          )}

          {loading && matches.length === 0 && <PageLoading label="Searching session history…" />}

          {exhausted && matches.length === 0 && (
            <p className="mt-2 text-xs text-base-content/50">No matches for "{searchedQuery}".</p>
          )}

          {matches.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5" aria-label="Search results">
              {matches.map((match, index) => (
                <li key={`${match.sessionId}-${match.sequence}-${index}`}>
                  <button
                    type="button"
                    className="w-full rounded-box border border-base-300 bg-base-200 p-2 text-left text-xs hover:border-base-content/30"
                    onClick={() => onOpenSession(match.sessionId)}
                  >
                    <span className="font-semibold">{fieldLabel(match.field)}:</span> {match.excerpt}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {cursor !== undefined && (
            <button
              type="button"
              className="btn btn-ghost btn-xs mt-2 w-full"
              onClick={() => void runSearch(searchedQuery, true)}
              disabled={loading}
            >
              {matches.length === 0 ? 'Keep searching' : 'Load more results'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
