import type { KeyboardEvent } from 'react';
import {
  countryOptions,
  MARKET_OPTIONS,
  supportedFilters,
  type SearchFilters,
  type SearchMarket,
} from './results.js';

export interface SearchFilterBarProps {
  market: SearchMarket;
  onMarketChange: (market: SearchMarket) => void;
  filters: SearchFilters;
  onFiltersChange: (patch: Partial<SearchFilters>) => void;
  /** Always runs a fresh scan of this market's sources, whether or not one is already loaded --
   * there is no separate "just filter" action, since typing in a filter field already re-filters
   * the loaded report live (see the `onChange` handlers below), with no button needed for that. */
  onSearch: () => void;
  onClear: () => void;
  /** Provider ids present in the loaded report: never a hardcoded list. */
  sources: string[];
  /** Employment types present in the loaded report (worldwide only). */
  employmentTypes: string[];
  busy: boolean;
  /** One honest line about the money the current market's report actually carries. */
  salaryNote: string;
}

/**
 * The search header: role/keyword, market, city/region, the search action, and (for the
 * Netherlands only) the IND sponsor filter, plus the secondary client-side filter chips.
 *
 * Which secondary filters appear is driven by `supportedFilters(market)`, i.e. by what the
 * selected pipeline's data actually carries. The prototype's "experience level" chip is
 * deliberately absent: neither report has a seniority field, and inferring one from the job title
 * would be a filter dimension the data cannot honestly support.
 */
export function SearchFilterBar({
  market,
  onMarketChange,
  filters,
  onFiltersChange,
  onSearch,
  onClear,
  sources,
  employmentTypes,
  busy,
  salaryNote,
}: SearchFilterBarProps) {
  const supported = supportedFilters(market);

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
          aria-label="Market"
          value={market}
          onChange={(event) => onMarketChange(event.target.value as SearchMarket)}
          disabled={busy}
        >
          {MARKET_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <input
          className="input input-sm w-40"
          type="text"
          aria-label="City or region"
          placeholder="City or region"
          value={filters.location}
          onChange={(event) => onFiltersChange({ location: event.target.value })}
          onKeyDown={handleKeyDown}
          disabled={busy}
        />

        <button className="btn btn-primary btn-sm" type="button" onClick={onSearch} disabled={busy}>
          {busy && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
          Search
        </button>

        {supported.sponsorOnly && (
          <label className="ml-1 flex cursor-pointer items-center gap-2 text-sm text-base-content/70">
            <input
              className="checkbox checkbox-sm"
              type="checkbox"
              checked={filters.sponsorOnly}
              onChange={(event) => onFiltersChange({ sponsorOnly: event.target.checked })}
              disabled={busy}
            />
            IND-recognised sponsors only
          </label>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {supported.arrangement && (
          <select
            className="select select-xs w-36"
            aria-label="Arrangement"
            value={filters.arrangement}
            onChange={(event) =>
              onFiltersChange({ arrangement: event.target.value as SearchFilters['arrangement'] })
            }
          >
            <option value="any">Any arrangement</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">On-site</option>
            <option value="unknown">Not stated</option>
          </select>
        )}

        {supported.postedWithin && (
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
        )}

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

        {supported.employment && employmentTypes.length > 0 && (
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

        {supported.country && (
          <select
            className="select select-xs w-40"
            aria-label="Country"
            value={filters.country}
            onChange={(event) => onFiltersChange({ country: event.target.value })}
          >
            <option value="all">All countries</option>
            {countryOptions().map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
        )}

        <span className="badge badge-ghost badge-sm font-normal">{salaryNote}</span>

        <button className="btn btn-ghost btn-xs" type="button" onClick={onClear}>
          Clear filters
        </button>
      </div>

      {supported.postedWithin && filters.postedWithin !== 'any' && (
        <p className="mt-2 text-xs text-base-content/60">
          Vacancies with no known posting date are excluded while this filter is narrowed, so the
          list means exactly what it says.
        </p>
      )}
    </div>
  );
}
