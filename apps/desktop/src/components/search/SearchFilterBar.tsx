import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';
import { useEscapeToClose } from '../shell/index.js';
import { countryOptions, type SearchFilters } from './results.js';

const SALARY_CURRENCIES = ['EUR', 'USD', 'GBP', 'CAD', 'AUD', 'CHF'];

export interface SearchFilterBarProps {
  filters: SearchFilters;
  onFiltersChange: (patch: Partial<SearchFilters>) => void;
  /** Updates the draft country criterion; a successful scan commits it. */
  onLocationChange: (value: string) => void;
  /** Starts a fresh upstream scan and commits its criteria with the completed report. */
  onSearch: () => void;
  /** Starts the deliberate broad scan flow. */
  onBrowseAll: () => void;
  onClear: () => void;
  /** Provider ids present in the loaded report: never a hardcoded list. */
  sources: string[];
  /** Employment types present in the loaded report. */
  employmentTypes: string[];
  busy: boolean;
  /** One honest line about the money the report actually carries. */
  salaryNote: string;
  hasReport: boolean;
  /**
   * Issue #398 Phase 1: whether the next scan should also run an on-demand AI-web-search discovery
   * pass. Deliberately not part of `SearchFilters`/`browseAllViewFilters` -- this is a scan-time
   * request option (like `country`/`employment`), not a client-side result refinement, so it never
   * interacts with the results-list filtering machinery.
   */
  aiWebDiscovery: boolean;
  onAiWebDiscoveryChange: (value: boolean) => void;
  /** Whether the candidate search profile is configured enough for AI web discovery to run at all
   * (see `runAiWebDiscovery`'s own "never runs without a usable profile projection" contract). The
   * checkbox stays visible either way -- so it is discoverable even before a profile exists -- but
   * is disabled with an explanatory note until one is. */
  aiWebDiscoveryAvailable: boolean;
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
  onBrowseAll,
  onClear,
  sources,
  employmentTypes,
  busy,
  salaryNote,
  hasReport,
  aiWebDiscovery,
  onAiWebDiscoveryChange,
  aiWebDiscoveryAvailable,
}: SearchFilterBarProps) {
  const hasQuery = filters.query.trim().length > 0;

  /**
   * The Salary popover is a native `<details>`, not a React-controlled overlay -- see below for why
   * that means Escape and outside-click dismissal (open-vacancy-radar#386) need their own wiring
   * rather than reusing the drawer/dialog pattern directly. `salaryOpen` mirrors the element's own
   * `open` property (updated via the native `toggle` event) purely so the effects below know when to
   * listen; the element's `open` property stays the actual source of truth, closed imperatively via
   * `salaryDetailsRef` rather than through React state.
   */
  const salaryDetailsRef = useRef<HTMLDetailsElement>(null);
  const [salaryOpen, setSalaryOpen] = useState(false);

  useEscapeToClose(() => {
    if (salaryDetailsRef.current) salaryDetailsRef.current.open = false;
  }, !salaryOpen);

  // Closes on `mousedown`, not `click`: the popover used to sit on top of (and swallow clicks meant
  // for) whatever it visually overlapped, since nothing closed it first. Acting on `mousedown` closes
  // it before the browser resolves the subsequent `click`'s target, so a single click both dismisses
  // the popover and reaches the control it had been covering, instead of requiring two.
  useEffect(() => {
    if (!salaryOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (salaryDetailsRef.current && !salaryDetailsRef.current.contains(event.target as Node)) {
        salaryDetailsRef.current.open = false;
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [salaryOpen]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !hasReport) onSearch();
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

        <details
          ref={salaryDetailsRef}
          className="relative"
          onToggle={(event) => setSalaryOpen(event.currentTarget.open)}
        >
          <summary className="btn btn-outline btn-sm list-none">Salary</summary>
          <div className="absolute left-0 top-full z-20 mt-1 w-80 max-w-[calc(100vw-3rem)] rounded-box border border-base-300 bg-base-100 p-3 shadow-lg">
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1 text-xs font-medium text-base-content/70">
                Minimum annual salary
                <input
                  className="input input-sm mt-1 w-full"
                  type="text"
                  inputMode="decimal"
                  aria-label="Minimum annual salary"
                  placeholder="e.g. 60000 or 60 000"
                  value={filters.salaryMinimum}
                  onChange={(event) => onFiltersChange({ salaryMinimum: event.target.value })}
                  disabled={busy}
                />
              </label>
              <label className="text-xs font-medium text-base-content/70">
                Currency
                <select
                  className="select select-sm mt-1 w-24"
                  aria-label="Salary currency"
                  value={filters.salaryCurrency}
                  onChange={(event) => onFiltersChange({ salaryCurrency: event.target.value })}
                  disabled={busy}
                >
                  {SALARY_CURRENCIES.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-base-content/70">
              <input
                className="checkbox checkbox-sm mt-0.5"
                type="checkbox"
                checked={filters.includeUnknownSalary}
                onChange={(event) => onFiltersChange({ includeUnknownSalary: event.target.checked })}
                disabled={busy}
              />
              <span>Include vacancies without comparable salary</span>
            </label>
            <p className="mt-2 text-xs text-base-content/60">
              Gross annual compensation. Hourly values use the configured 40 hours/week and 52 weeks/year assumption.
            </p>
          </div>
        </details>

        <label
          className="ml-1 flex cursor-pointer items-center gap-2 text-sm text-base-content/70"
          title={aiWebDiscoveryAvailable ? undefined : 'Fill in a search profile (target roles or strongest skills) to use this.'}
        >
          <input
            className="checkbox checkbox-sm"
            type="checkbox"
            aria-label="Include AI web search"
            checked={aiWebDiscovery}
            onChange={(event) => onAiWebDiscoveryChange(event.target.checked)}
            disabled={busy || !aiWebDiscoveryAvailable}
          />
          Include AI web search
        </label>

        <button className="btn btn-primary btn-sm" type="button" onClick={onSearch} disabled={busy || !hasQuery}>
          {busy && <span className="loading loading-spinner loading-xs text-primary-content" aria-hidden="true" />}
          {hasReport ? 'Run new scan' : 'Run scan'}
        </button>

        {!hasQuery && (
          <button className="btn btn-outline btn-sm" type="button" onClick={onBrowseAll} disabled={busy}>
            Browse all vacancies
          </button>
        )}

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

      {!hasQuery && (
        <p className="mt-2 text-xs text-base-content/60" role="status">
          Enter a role or keyword to start a new scan. Existing reports remain available to browse and filter.
        </p>
      )}

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
              {discoveryProviderLabel(source)}
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
