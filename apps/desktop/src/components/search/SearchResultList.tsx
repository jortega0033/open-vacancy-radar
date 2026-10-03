import { Fragment, memo, useLayoutEffect, useRef } from 'react';
import noResultsIllustration from '../../../assets/illustrations/no-results.svg?no-inline';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';
import { EmptyState } from '../shell/index.js';
import {
  descriptionExcerpt,
  formatDate,
  isStalePosting,
  orNotStated,
  profileFitSpoken,
  profileFitText,
  type SearchResult,
} from './results.js';

export interface SearchResultRowProps {
  result: SearchResult;
  selected: boolean;
  onSelect: (result: SearchResult) => void;
  saved: boolean;
  /** Whether a scan is running right now. A provisional row only reads "Live" while this is true. */
  scanActive?: boolean;
}

export const SearchResultRow = memo(function SearchResultRow({
  result,
  selected,
  onSelect,
  saved,
  scanActive = false,
}: SearchResultRowProps) {
  const stale = isStalePosting(result.postedAt);
  const excerpt = descriptionExcerpt(result.description);
  // Verification has the identical "not available" tone on almost every row (the pipeline has no
  // per-employer verification step for most vacancies), so the badge would carry zero per-row
  // information there -- it is already explained once, correctly, in the detail pane. Only a real
  // per-row outcome (a possible sponsor match) earns a badge here.
  //
  // `decision` (the pipeline's internal `DiscoveryDecision`, e.g. `role_mismatch`) deliberately does
  // NOT get a badge here. QA audit finding: in every populated screenshot reviewed, this read as
  // "role mismatch" on essentially every card, which looks exactly like "this job doesn't match you"
  // on 100% of listings to a candidate -- it is a pipeline classification, not a per-candidate match
  // rejection, and styling it identically to the salary/employment-type chips actively misled. It
  // already has an accurate home, unchanged, in the detail pane's Overview section ("Discovery
  // decision" -- see `VacancyDetail.tsx`).
  const badges = [
    // Always first: a provisional row (issue #364's live view) must never read as an ordinary,
    // fully-final result -- it has no score and no official-source cross-reference yet. Only while a
    // scan is actually running: the badge claims the row is still arriving (issue #464).
    result.provisional && scanActive ? { text: 'Live · not yet scored', tone: 'warning' as const } : null,
    result.verification.tone !== null ? { text: result.verification.label, tone: result.verification.tone } : null,
    result.employmentType ? { text: result.employmentType, tone: null } : null,
    result.salary ? { text: result.salary, tone: null } : null,
  ].filter((badge): badge is { text: string; tone: 'success' | 'warning' | null } => badge !== null);

  return (
    <button
      type="button"
      aria-current={selected}
      data-result-key={result.key}
      onClick={() => onSelect(result)}
      className={`ovr-row flex w-full gap-2.5 border-b border-base-300 px-4 text-left ${
        selected ? 'ovr-row-selected' : 'hover:bg-base-200'
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
        </div>
        <div className="truncate text-xs font-medium text-base-content/70">
          {result.company} · {orNotStated(result.location)}
        </div>

        {excerpt && <p className="mt-1 line-clamp-2 text-xs text-base-content/60">{excerpt}</p>}

        {(result.profileScore != null || badges.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {result.profileScore != null && (
              <span
                className="badge badge-xs badge-soft badge-primary font-mono"
                title="Deterministic score against your search profile. It does not compare this vacancy to a CV."
              >
                <span aria-hidden="true">{profileFitText(result.profileScore)}</span>
                <span className="sr-only">{profileFitSpoken(result.profileScore)}</span>
              </span>
            )}
            {badges.map((badge) => (
              <span
                key={badge.text}
                className={`badge badge-sm font-normal ${
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
          <span className={`flex-none text-xs ${stale ? 'text-warning' : 'text-base-content/60'}`}>
            {saved ? 'Saved · ' : ''}
            {result.postedAt ? formatDate(result.postedAt) : 'Date unknown'}
            {stale ? ' (over a month old)' : ''}
          </span>
          <span className="flex-none text-xs text-base-content/60">{discoveryProviderLabel(result.provider)}</span>
        </div>
      </div>
    </button>
  );
});

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
  /** Whether a scan is running right now; passed through to each row's "Live" badge. */
  scanActive?: boolean;
  /** Listings the loaded report checked, for the zero-match hint. */
  checkedCount?: number;
  /** How many rows in the whole filtered list lack a score. Defaults to the count on this page. */
  unscoredCount?: number;
  /** 0-indexed. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  scrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  /** Side-by-side with the detail pane (a fixed-width column), or on its own taking the whole width
   * (#451). Chosen by the page from the width it actually has, not from the viewport. */
  split?: boolean;
}

export const SearchResultList = memo(function SearchResultList({
  results,
  totalCount,
  selectedKey,
  onSelect,
  savedKeys,
  summary,
  scanActive = false,
  checkedCount,
  unscoredCount,
  page,
  pageCount,
  onPageChange,
  scrollTop = 0,
  onScrollTopChange,
  split = true,
}: SearchResultListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current && scrollRef.current.scrollTop !== scrollTop) scrollRef.current.scrollTop = scrollTop;
  }, [scrollTop]);
  return (
    <div
      className={`flex min-h-0 flex-col border-base-300 ${
        split ? 'w-2/5 min-w-80 max-w-md flex-none border-r' : 'flex-1'
      }`}
    >
      <div className="sticky top-0 z-10 border-b border-base-300 bg-base-100 px-4 py-2 text-xs text-base-content/60">
        {summary}
      </div>

      <div
        ref={scrollRef}
        aria-label="Vacancy results"
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
      >
        {results.length === 0 ? (
          <EmptyState
            illustration={noResultsIllustration}
            title={scanActive ? 'Searching job sites' : 'No vacancies found'}
            description={
              scanActive
                ? 'Jobs appear here as they are found.'
                : totalCount > 0
                  ? 'No vacancy in the loaded report matches these filters. Widen the role, location or filter chips.'
                  : checkedCount
                    ? `Checked ${checkedCount.toLocaleString()} listings, none matched. Try fewer words or a related title.`
                    : 'The latest report contains no vacancies.'
            }
          />
        ) : (
          results.map((result, index) => (
            <Fragment key={result.key}>
              {/* Scored rows sort first, so the divider goes before the first unscored row on this
                  page (which is the top of the page when the page starts inside the unscored group). */}
              {result.profileScore == null && (index === 0 || results[index - 1]?.profileScore != null) && (
                <h3 className="border-b border-base-300 bg-base-200 px-4 py-1.5 text-xs font-semibold text-base-content/70">
                  Not scored yet ({(unscoredCount ?? results.filter((row) => row.profileScore == null).length).toLocaleString()})
                </h3>
              )}
              <SearchResultRow
                result={result}
                selected={result.key === selectedKey}
                onSelect={onSelect}
                saved={savedKeys.has(result.key)}
                scanActive={scanActive}
              />
            </Fragment>
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
});
