import noResultsIllustration from '../../../assets/illustrations/no-results.svg?no-inline';
import { EmptyState } from '../shell/index.js';
import { decisionLabel, formatDate, isStalePosting, orNotStated, type SearchResult } from './results.js';

export interface SearchResultRowProps {
  result: SearchResult;
  selected: boolean;
  onSelect: (result: SearchResult) => void;
  saved: boolean;
}

export function SearchResultRow({ result, selected, onSelect, saved }: SearchResultRowProps) {
  const stale = isStalePosting(result.postedAt);
  // A market with no verification concept at all (worldwide) has the identical tone on every row,
  // so the badge would carry zero per-row information -- it is already explained once, correctly,
  // in the detail pane. Only a real per-row outcome (Netherlands) earns a badge here.
  const badges = [
    result.verification.tone !== null ? { text: result.verification.label, tone: result.verification.tone } : null,
    result.arrangement ? { text: result.arrangement, tone: null } : null,
    result.employmentType ? { text: result.employmentType, tone: null } : null,
    result.salary ? { text: result.salary, tone: null } : null,
    result.market === 'worldwide' ? { text: decisionLabel(result.raw.decision), tone: null } : null,
    // A hint only, and a neutral one: the row stays in the list at its own rank, selectable and
    // saveable on its own. The detail pane carries the full, hedged explanation.
    result.market === 'netherlands' && result.raw.duplicateGroup
      ? { text: 'Possible duplicate', tone: null }
      : null,
  ].filter((badge): badge is { text: string; tone: 'success' | 'warning' | null } => badge !== null);

  return (
    <button
      type="button"
      aria-current={selected}
      onClick={() => onSelect(result)}
      className={`ovr-row flex w-full gap-2.5 border-b border-base-300 px-4 text-left hover:bg-base-200 ${
        selected ? 'bg-base-200' : ''
      }`}
    >
      <div className="avatar avatar-placeholder flex-none pt-0.5" aria-hidden="true">
        <div className="w-8 rounded-full bg-neutral text-neutral-content">
          <span className="text-xs">{result.company.charAt(0).toUpperCase() || '?'}</span>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold">{result.title}</span>
          {result.profileScore != null && (
            <span className="flex-none font-mono text-xs text-base-content/70" title="Deterministic profile score">
              {result.profileScore}
            </span>
          )}
        </div>
        <div className="truncate text-xs font-medium text-base-content/70">
          {result.company} · {orNotStated(result.location)}
        </div>

        {badges.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {badges.map((badge) => (
              <span
                key={badge.text}
                className={`badge badge-xs font-normal ${
                  badge.tone === 'success'
                    ? 'badge-success badge-soft'
                    : badge.tone === 'warning'
                      ? 'badge-warning badge-soft'
                      : 'badge-ghost'
                }`}
              >
                {badge.text}
              </span>
            ))}
          </div>
        )}

        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className={`flex-none text-xs ${stale ? 'text-warning' : 'text-base-content/50'}`}>
            {saved ? 'Saved · ' : ''}
            {result.postedAt ? formatDate(result.postedAt) : 'Date unknown'}
            {stale ? ' (over a month old)' : ''}
          </span>
          <span className="flex-none text-xs text-base-content/50">{result.provider}</span>
        </div>
      </div>
    </button>
  );
}

export interface SearchResultListProps {
  /** Already sliced to the current page: `page * pageSize` .. `(page + 1) * pageSize`. */
  results: SearchResult[];
  /** How many rows the loaded report had before the client-side filters ran. */
  totalCount: number;
  selectedKey: string | null;
  onSelect: (result: SearchResult) => void;
  /** `vacancyKey`s already in the workspace database, so a saved row can say so. */
  savedKeys: ReadonlySet<string>;
  summary: string;
  /** 0-indexed. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}

export function SearchResultList({
  results,
  totalCount,
  selectedKey,
  onSelect,
  savedKeys,
  summary,
  page,
  pageCount,
  onPageChange,
}: SearchResultListProps) {
  return (
    <div className="flex min-h-0 flex-col border-base-300 lg:w-2/5 lg:min-w-80 lg:max-w-md lg:border-r">
      <div className="sticky top-0 z-10 border-b border-base-300 bg-base-100 px-4 py-2 text-xs text-base-content/60">
        {summary}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.length === 0 ? (
          <EmptyState
            illustration={noResultsIllustration}
            title="No vacancies found"
            description={
              totalCount > 0
                ? 'No vacancy in the loaded report matches these filters. Widen the role, location or filter chips.'
                : 'The latest report for this market contains no vacancies.'
            }
          />
        ) : (
          results.map((result) => (
            <SearchResultRow
              key={result.key}
              result={result}
              selected={result.key === selectedKey}
              onSelect={onSelect}
              saved={savedKeys.has(result.key)}
            />
          ))
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex flex-none items-center justify-between gap-2 border-t border-base-300 bg-base-100 px-4 py-2 text-xs">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 0}
          >
            Previous
          </button>
          <span className="text-base-content/60">
            Page {page + 1} of {pageCount}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount - 1}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
