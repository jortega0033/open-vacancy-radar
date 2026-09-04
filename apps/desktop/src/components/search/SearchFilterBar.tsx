import type { KeyboardEvent } from 'react';
import { countryOptions, type SearchFilters } from './results.js';

export interface SearchFilterBarProps {
  filters: SearchFilters;
  onFiltersChange: (patch: Partial<SearchFilters>) => void;
  /** The country filter: a plain, instant, client-side narrowing of whatever is already loaded. */
  onLocationChange: (value: string) => void;
  /** Always runs a fresh scan, whether or not one is already loaded -- there is no separate "just
   * filter" action, since typing in a filter field already re-filters the loaded report live (see
   * the `onChange` handlers below), with no button needed for that. */
  onSearch: () => void;
  onClear: () => void;
  /** Provider ids present in the loaded report: never a hardcoded list. */
  sources: string[];
  /** Employment types present in the loaded report. */
  employmentTypes: string[];
  busy: boolean;
  /** One honest line about the money the report actually carries. */
  salaryNote: string;
}

/**
 * The search header: role/keyword, the country filter, the search action, the best-effort IND
 * sponsor filter, plus the secondary client-side filter chips.
 *
 * The prototype's "experience level" chip is deliberately absent: the report has no seniority
 * field, and inferring one from the job title would be a filter dimension the data cannot honestly
 * support.
 */
export function SearchFilterBar({
  filters,
  onFiltersChange,
  onLocationChange,
  onSearch,
  onClear,
  sources,
  employmentTypes,
  busy,
  salaryNote,
}: SearchFilterBarProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') onSearch();
  }

  return (
    <div className="flex-none border-b border-base-300 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input input-sm min-w-52 flex-1 md:max-w-96"
          type="text"
          role="searchbox"
          aria-label="Role or keywords"
          placeholder="Role or keywords, e.g. Frontend Engineer"
          value={filters.query}
          onChange={(event) => onFiltersChange({ query: event.target.value })}
          onKeyDown={handleKeyDown}
          disabled={busy}
        />

        <select
          className="select select-sm w-48"
          aria-label="Country"
          value={filters.country}
          onChange={(event) => onLocationChange(event.target.value)}
          disabled={busy}
        >
          <option value="all">All countries</option>
          {countryOptions().map((country) => (
            <option key={country} value={country}>
              {country}
            </option>
          ))}
        </select>

        <button className="btn btn-primary btn-sm" type="button" onClick={onSearch} disabled={busy}>
          {busy && <span className="loading loading-spinner loading-xs text-primary-content" aria-hidden="true" />}
          Search
        </button>

        {/* The engine only ever attempts this check for a Netherlands-located vacancy (see
            `worldwideSponsorMatch`'s own gate), so the filter is meaningless -- and would just
            silently empty the list -- for any other country selection. Shown only once "Netherlands"
            is the selected country, not for "All countries" or any other one. */}
        {filters.country === 'Netherlands' && (
          <label className="ml-1 flex cursor-pointer items-center gap-2 text-sm text-base-content/70">
            <input
              className="checkbox checkbox-sm"
              type="checkbox"
              checked={filters.sponsorOnly}
              onChange={(event) => onFiltersChange({ sponsorOnly: event.target.checked })}
              disabled={busy}
            />
            Possible IND sponsor match only
          </label>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <select
          className="select select-xs w-36"
          aria-label="Posted within"
          value={filters.postedWithin}
          onChange={(event) =>
            onFiltersChange({ postedWithin: event.target.value as SearchFilters['postedWithin'] })
          }
        >
          <option value="any">Posted: any time</option>
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
        </select>

        <select
          className="select select-xs w-36"
          aria-label="Job source"
          value={filters.source}
          onChange={(event) => onFiltersChange({ source: event.target.value })}
        >
          <option value="all">All sources</option>
          {sources.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>

        {employmentTypes.length > 0 && (
          <select
            className="select select-xs w-36"
            aria-label="Employment type"
            value={filters.employment}
            onChange={(event) => onFiltersChange({ employment: event.target.value })}
          >
            <option value="any">Any employment</option>
            {employmentTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        )}

        {/* Separates the filter chips (narrow what's shown) from the trailing meta+reset pair
            (explain/undo), so the row reads as two groups rather than one undifferentiated run. */}
        <div className="mx-1 hidden h-5 w-px self-center bg-base-300 md:block" aria-hidden="true" />

        <span className="badge badge-ghost badge-sm font-normal">{salaryNote}</span>

        <button className="btn btn-ghost btn-sm" type="button" onClick={onClear}>
          Clear filters
        </button>
      </div>

      {filters.postedWithin !== 'any' && (
        <p className="mt-2 text-xs text-base-content/60">
          Vacancies with no known posting date are excluded while this filter is narrowed, so the
          list means exactly what it says.
        </p>
      )}
    </div>
  );
}
