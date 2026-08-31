import noResultsIllustration from '../../../assets/illustrations/no-results.svg?no-inline';
import { EmptyState } from '../shell/index.js';
import { formatDate, orNotStated, type SearchResult } from './results.js';

/** Status dot for a verification outcome. Never rendered for a market with no verification step. */
function VerificationDot({ tone }: { tone: 'success' | 'warning' | null }) {
  if (tone === null) return null;
  return (
    <span
      className={`size-1.5 rounded-full ${tone === 'success' ? 'bg-success' : 'bg-warning'}`}
      aria-hidden="true"
    />
  );
}

export interface SearchResultRowProps {
  result: SearchResult;
  selected: boolean;
  onSelect: (result: SearchResult) => void;
  saved: boolean;
}

export function SearchResultRow({ result, selected, onSelect, saved }: SearchResultRowProps) {
  // Salary folds into the same line rather than always getting its own: it's absent for every
  // Netherlands row and for most worldwide rows too (advertised only where the source states it),
  // so a dedicated "Salary not published" line on nearly every row was a full row of noise, not
  // information -- the filter bar's own salary note already sets that expectation once per market.
  const meta = [result.company, orNotStated(result.location), result.arrangement, result.salary]
    .filter((part): part is string => !!part)
    .join(' · ');

  return (
    <button
      type="button"
      aria-current={selected}
      onClick={() => onSelect(result)}
      className={`ovr-row w-full border-b border-base-300 px-4 text-left hover:bg-base-200 ${
        selected ? 'bg-base-200' : ''
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{result.title}</span>
        {result.profileScore != null && (
          <span className="flex-none font-mono text-xs text-base-content/70" title="Deterministic profile score">
            {result.profileScore}
          </span>
        )}
      </div>

      <div className="mt-0.5 text-xs text-base-content/60">{meta}</div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="badge badge-outline badge-sm gap-1.5 font-normal">
          <VerificationDot tone={result.verification.tone} />
          {result.verification.label}
        </span>
        <span className="flex-none text-xs text-base-content/50">
          {saved ? 'Saved · ' : ''}
          {result.postedAt ? formatDate(result.postedAt) : 'Date unknown'} · {result.provider}
        </span>
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
