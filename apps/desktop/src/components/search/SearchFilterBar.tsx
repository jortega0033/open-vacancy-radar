import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';
import { useEscapeToClose } from '../shell/index.js';
import { countryOptions, DEFAULT_FILTERS, type SearchFilters } from './results.js';

const SALARY_CURRENCIES = ['EUR', 'USD', 'GBP', 'CAD', 'AUD', 'CHF'];

const POSTED_LABELS: Record<string, string> = {
  '1': 'Last 24 hours',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
};

interface FilterChip {
  key: string;
  label: string;
  /** What removing this chip resets. */
  reset: Partial<SearchFilters>;
}

/** The secondary filters that are currently narrowing the list. All default to off. */
function activeFilterChips(filters: SearchFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.postedWithin !== 'any') {
    chips.push({
      key: 'posted',
      label: POSTED_LABELS[filters.postedWithin] ?? `Last ${filters.postedWithin} days`,
      reset: { postedWithin: DEFAULT_FILTERS.postedWithin },
    });
  }
  if (filters.source !== 'all') {
    chips.push({ key: 'source', label: discoveryProviderLabel(filters.source), reset: { source: 'all' } });
  }
  if (filters.employment !== 'any') {
    chips.push({ key: 'employment', label: filters.employment, reset: { employment: 'any' } });
  }
  if (filters.salaryMinimum.trim()) {
    const amount = parseInt(filters.salaryMinimum.replace(/\s/g, ''), 10);
    chips.push({
      key: 'salary',
      label: Number.isFinite(amount) ? `Salary ${amount.toLocaleString()} or more` : 'Salary',
      reset: { salaryMinimum: '' },
    });
  }
  if (filters.hideOnsiteHybrid) {
    chips.push({ key: 'remote', label: 'No on-site or hybrid', reset: { hideOnsiteHybrid: false } });
  }
  if (filters.sponsorOnly) {
    chips.push({ key: 'sponsor', label: 'IND sponsor match', reset: { sponsorOnly: false } });
  }
  return chips;
}

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
  /** The query the loaded report was scanned with. When it differs from the draft keywords, the
   * bar says so, because the list below keeps showing the old report until a new scan succeeds. */
  appliedQuery?: string;
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
  /** Called when the user clicks the link to open their search profile. Optional; if absent, the explanation is shown without a link. */
  onOpenSearchProfile?: () => void;
  /** The vacancy engine cannot run (#441): scanning and browsing are disabled, not merely failing. */
  scanUnavailable?: boolean;
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
  appliedQuery = '',
  aiWebDiscovery,
  onAiWebDiscoveryChange,
  aiWebDiscoveryAvailable,
  onOpenSearchProfile,
  scanUnavailable = false,
}: SearchFilterBarProps) {
  const hasQuery = filters.query.trim().length > 0;
  const draftQuery = filters.query.trim();
  const appliedQueryText = appliedQuery.trim();
  const draftDiffersFromApplied = hasReport && hasQuery && appliedQueryText !== '' && draftQuery !== appliedQueryText;

  /**
   * The Filters popover is React-controlled. Escape goes through the shared overlay stack
   * (`useEscapeToClose`) and returns focus to the button; an outside press closes it on `mousedown`
   * (not `click`) so one click both dismisses it and reaches whatever it had been covering
   * (open-vacancy-radar#386).
   */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersButtonRef = useRef<HTMLButtonElement>(null);
  const filtersWrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const aiWebHelpId = useId();
  const chips = activeFilterChips(filters);

  const closeFilters = useCallback((returnFocus: boolean) => {
    setFiltersOpen(false);
    if (returnFocus) filtersButtonRef.current?.focus();
  }, []);

  useEscapeToClose(() => closeFilters(true), !filtersOpen);

  useEffect(() => {
    if (!filtersOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (filtersWrapRef.current && !filtersWrapRef.current.contains(event.target as Node)) {
        setFiltersOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [filtersOpen]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter always means "Search"; an empty keyword still reaches the page's own guard message
    // rather than starting anything. Ignored while busy so a repeated Enter cannot start a second run,
    // and while an IME composition is still being confirmed.
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || busy || scanUnavailable) return;
    onSearch();
  }

  return (
    <div className="flex-none border-b border-base-300 pb-3 short:pb-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-44 flex-1 flex-col gap-1 short:min-w-32 text-xs font-medium text-base-content/70 md:max-w-96">
          <span className="short:sr-only">Role or keywords</span>
          <input
            className="input input-sm w-full text-sm font-normal text-base-content"
            type="text"
            role="searchbox"
            placeholder="Role or keywords, e.g. Nurse, Data analyst"
            value={filters.query}
            onChange={(event) => onFiltersChange({ query: event.target.value })}
            onKeyDown={handleKeyDown}
            disabled={busy}
            {...(draftDiffersFromApplied ? { 'aria-describedby': 'search-draft-hint' } : {})}
          />
        </label>

        <select
          className="select select-sm w-40 short:w-36"
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

        <div ref={filtersWrapRef} className="relative">
          <button
            ref={filtersButtonRef}
            className="btn btn-outline btn-sm"
            type="button"
            aria-expanded={filtersOpen}
            aria-controls={panelId}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters
            {chips.length > 0 && (
              <span className="badge badge-primary badge-sm" aria-label={`${chips.length} active`}>
                {chips.length}
              </span>
            )}
          </button>
          {filtersOpen && (
            <div
              id={panelId}
              role="group"
              aria-label="Filters"
              className="absolute left-0 top-full z-20 mt-1 w-80 max-w-[calc(100vw-3rem)] rounded-box border border-base-300 bg-base-100 p-3 shadow-lg"
            >
              <div className="flex flex-col gap-2">
                <select
                  className="select select-sm w-full"
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
                  className="select select-sm w-full"
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
                    className="select select-sm w-full"
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
                <label className="flex cursor-pointer items-start gap-2 text-xs text-base-content/70">
                  <input
                    className="checkbox checkbox-sm mt-0.5"
                    type="checkbox"
                    checked={filters.includeUnknownSalary}
                    onChange={(event) => onFiltersChange({ includeUnknownSalary: event.target.checked })}
                    disabled={busy}
                    aria-label="Include jobs with no salary"
                  />
                  <span>Include jobs with no salary</span>
                </label>
                <p className="text-xs text-base-content/60">Yearly gross pay. Hourly pay is converted.</p>
                {salaryNote && <p className="text-xs text-base-content/60">{salaryNote}</p>}

                <label className="flex cursor-pointer items-center gap-2 text-sm text-base-content/70">
                  <input
                    className="checkbox checkbox-sm"
                    type="checkbox"
                    aria-label="Hide on-site and hybrid"
                    checked={filters.hideOnsiteHybrid ?? false}
                    onChange={(event) => onFiltersChange({ hideOnsiteHybrid: event.target.checked })}
                  />
                  Hide on-site and hybrid
                </label>

                {/* The engine only ever attempts this check for a Netherlands-located vacancy (see
                    `worldwideSponsorMatch`'s own gate), so the filter is meaningless -- and would just
                    silently empty the list -- for any other country selection. */}
                {filters.country === 'Netherlands' && (
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-base-content/70">
                    <input
                      className="checkbox checkbox-sm"
                      type="checkbox"
                      checked={filters.sponsorOnly}
                      onChange={(event) => onFiltersChange({ sponsorOnly: event.target.checked })}
                      disabled={busy}
                      aria-label="Possible IND sponsor match only"
                    />
                    Possible IND sponsor match only
                  </label>
                )}

                {filters.postedWithin !== 'any' && (
                  <p className="text-xs text-base-content/60">Jobs without a posting date are hidden.</p>
                )}

                <button className="btn btn-ghost btn-sm self-start" type="button" onClick={onClear}>
                  Clear filters
                </button>
              </div>
            </div>
          )}
        </div>

        <label
          className="flex cursor-pointer items-center gap-2 text-sm text-base-content/70"
        >
          <input
            className="checkbox checkbox-sm"
            type="checkbox"
            aria-label="Also search the web with AI"
            checked={aiWebDiscovery}
            onChange={(event) => onAiWebDiscoveryChange(event.target.checked)}
            disabled={busy || !aiWebDiscoveryAvailable}
            {...(!aiWebDiscoveryAvailable ? { 'aria-describedby': aiWebHelpId } : {})}
          />
          Also search the web with AI
        </label>

        <button className="btn btn-primary btn-sm" type="button" onClick={onSearch} disabled={busy || scanUnavailable || !hasQuery}>
          {busy && <span className="loading loading-spinner loading-xs text-primary-content" aria-hidden="true" />}
          Search
        </button>
      </div>

      {chips.length > 0 && (
        <ul className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {chips.map((chip) => (
            <li key={chip.key} className="badge badge-outline h-auto gap-1 py-1 pr-1 text-xs">
              {chip.label}
              <button
                className="btn btn-ghost btn-xs h-5 min-h-0 w-5 p-0"
                type="button"
                aria-label={`Remove filter: ${chip.label}`}
                onClick={() => {
                  onFiltersChange(chip.reset);
                  filtersButtonRef.current?.focus();
                }}
              >
                <span aria-hidden="true">&times;</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!aiWebDiscoveryAvailable && (
        <p id={aiWebHelpId} className="mt-2 text-xs text-base-content/60">
          Add a role or skill to your profile to also search the web with AI.
          {onOpenSearchProfile && (
            <>
              {' '}
              <button
                className="link link-primary"
                type="button"
                onClick={onOpenSearchProfile}
              >
                Open search profile
              </button>
            </>
          )}
        </p>
      )}

      {draftDiffersFromApplied && (
        <p id="search-draft-hint" className="mt-2 text-xs text-base-content/60" role="status">
          Press Enter to search for &apos;{draftQuery}&apos;. Showing results for &apos;{appliedQueryText}&apos;.
        </p>
      )}

      {!hasQuery && (
        <p className="mt-2 text-xs text-base-content/60" role="status">
          Enter a role to search, or{' '}
          <button
            className="link link-primary"
            type="button"
            onClick={onBrowseAll}
            disabled={busy || scanUnavailable}
          >
            Browse all vacancies
          </button>
          .
        </p>
      )}
    </div>
  );
}
