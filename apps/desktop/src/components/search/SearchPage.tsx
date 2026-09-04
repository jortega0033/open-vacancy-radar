import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Info } from '@phosphor-icons/react';
import type { GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import emptySearchIllustration from '../../../assets/illustrations/empty-search.svg?no-inline';
import type { SavedJobInput } from '../../window.js';
import { CvAssistant, type VacancyLead } from '../cv/index.js';
import type { SelectedVacancy } from '../letters/index.js';
import { EmptyState } from '../shell/index.js';
import { SearchFilterBar } from './SearchFilterBar.js';
import { SearchResultList } from './SearchResultList.js';
import { VacancyDetail, type SaveState } from './VacancyDetail.js';
import {
  DEFAULT_FILTERS,
  employmentOptions,
  filterResults,
  isWebUrl,
  sortResults,
  sourceOptions,
  toWorldwideResults,
  type SearchFilters,
  type SearchResult,
} from './results.js';

type EngineState = 'checking' | 'ready' | 'unavailable';

/** How many rows the results list shows per page. A loaded report can carry thousands of
 * vacancies (a worldwide scan easily clears 1000+), and rendering all of them at once with no
 * pagination is both a real DOM-size performance problem and a "where did the rest go" UX gap. */
const PAGE_SIZE = 25;

const SALARY_NOTE = 'Salary shown only where advertised';

/**
 * `SearchResult` → `VacancyLead`, the shape the CV assistant's prompt builders take.
 *
 * The normalisation in `results.ts` already assembles this, because only it knows which fields the
 * report genuinely carries. `description`/`requirements` stay absent: the pipeline stores no
 * posting text, and the prompt builders say so to the model explicitly.
 */
export function toVacancyLead(result: SearchResult): VacancyLead {
  return result.lead;
}

/**
 * `SearchResult` → `SelectedVacancy`, for the "Generate Letter" handoff to the Letters page.
 *
 * `SelectedVacancy` is `VacancyLead` plus the discovery `key` (see components/letters/types.ts),
 * so this is `toVacancyLead` with that one extra field attached -- the same `result.lead` fields a
 * letter can already use, nothing invented on top of it (no `description`/`requirements` beyond
 * what the lead already carries).
 */
export function selectedVacancyFor(result: SearchResult): SelectedVacancy {
  return { ...result.lead, key: result.key };
}

/**
 * `SearchResult` → the `savedJobs` row input.
 *
 * `verification` stores the label the search page itself showed, so an unmatched row is saved as
 * "Not available for this vacancy" (or, for a best-effort sponsor match, that match's own label)
 * rather than as an empty (and later re-readable as "unverified") cell. `matchPercent` takes the
 * deterministic relevance score (a real 0-100 figure against the engine's configured candidate
 * profile) and stays null when scoring didn't run for this vacancy. It is not a comparison against
 * any CV in the library; the only real CV comparison in this app is the on-demand gap analysis.
 */
export function savedJobInputFor(result: SearchResult): SavedJobInput {
  return {
    role: result.title,
    company: result.company,
    location: result.location ?? '',
    vacancyKey: result.key,
    salary: result.salary,
    verification: result.verification.label,
    matchPercent: result.profileScore,
    // The renderer refuses to link a non-http(s) URL, so it must not persist one either.
    sourceUrl: isWebUrl(result.url) ? result.url : null,
    status: 'considering',
  };
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Shown instead of the "No search yet" empty state while a scan/hydration is actually in flight
 * with no report loaded yet: a static illustration sitting still under a spinner banner for up to
 * a couple of minutes reads as frozen, not "working". Mimics the real two-pane layout's shape
 * (row list + detail cards) so the page doesn't visibly jump once real content replaces it.
 */
function SearchLoadingSkeleton() {
  return (
    <div className="mt-3 flex min-h-0 flex-1 flex-col lg:flex-row" aria-hidden="true">
      <div className="flex flex-none flex-col border-base-300 lg:w-2/5 lg:min-w-80 lg:max-w-md lg:border-r">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="ovr-row space-y-2 border-b border-base-300 px-4">
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-3 w-1/2" />
            <div className="skeleton h-3 w-2/3" />
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1 space-y-4 px-6 py-5">
        <div className="skeleton h-6 w-1/3" />
        <div className="skeleton h-4 w-1/4" />
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-3">
          <div className="skeleton h-24" />
          <div className="skeleton h-24" />
          <div className="skeleton h-24" />
        </div>
        <div className="skeleton h-32 w-full" />
      </div>
    </div>
  );
}

/**
 * Top-level Search screen: a client-side filter bar over the worldwide/remote scan pipeline, a
 * results list and a detail pane.
 *
 * The lifecycle rule is hydrate-then-optionally-scan: opening the page reads whatever report the
 * pipeline last produced and never starts a network scan on its own. Scanning hits real external
 * feeds and can take a couple of minutes, so it is always something the user asked for.
 *
 * Filtering (role/keyword, location, chips) is entirely client-side over the loaded report, but
 * deliberately does not apply as those fields change: the form fields are a draft (`filters`)
 * separate from what's actually driving the list (`appliedFilters`), and only clicking "Search"
 * (or pressing Enter in a text field) commits the draft and re-scans. The one "Search" button is
 * the single, always-the-same action for both applying the form and going to get fresh data,
 * whether or not a report is already loaded -- there is deliberately no second "just filter" vs.
 * "rescan" button, which used to be confusing (one of the two did nothing once a report existed).
 * "Clear filters" is the one exception: it resets and re-applies immediately, since an explicit
 * reset needs no confirmation click of its own.
 */
export interface SearchPageProps {
  /**
   * Fired when the user clicks "Generate Letter" on the vacancy detail view, with the selected
   * vacancy already converted to what the Letters page expects. `App.tsx` wires this to the
   * Search -> Letters handoff; the page works standalone (the button becomes a no-op) with nothing
   * supplied.
   */
  onGenerateLetter?: (vacancy: SelectedVacancy) => void;
}

export function SearchPage({ onGenerateLetter }: SearchPageProps = {}) {
  const [engineState, setEngineState] = useState<EngineState>('checking');
  const [engineError, setEngineError] = useState<string>();

  const [worldwideReport, setWorldwideReport] = useState<GlobalRemoteReport | null>(null);
  // Whether the stored report has already been read once. A pipeline that has never been run
  // legitimately answers `null`, so "did we ask?" cannot be inferred from the report state itself.
  const hasHydrated = useRef(false);
  // Settings hydration (the persisted default country) is async, so the user can already have
  // changed the country filter by the time it lands. Restoring the persisted default at that point
  // would clobber a selection the user already made, so hydration only ever writes the filter if
  // the user hasn't touched it yet.
  const hasEditedLocationRef = useRef(false);

  // `filters` is the draft the form fields are bound to; `appliedFilters` is what actually drives
  // `visible` below. They only sync on an explicit Search (or Clear) -- see the class doc comment.
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<SearchFilters>(DEFAULT_FILTERS);

  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (cancelled || hasEditedLocationRef.current) return;
        // Mirrors Settings' own "Default search location" selector: a persisted country pre-fills
        // the same country filter this page's own selector writes to, so opening the page for the
        // first time already reflects that choice.
        if (settings.defaultLocation) {
          const withCountry = { ...DEFAULT_FILTERS, country: settings.defaultLocation };
          setFilters(withCountry);
          setAppliedFilters(withCountry);
        }
      })
      .catch(() => {
        // default filters (already applied) stand
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [hydrating, setHydrating] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string>();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [assistantForKey, setAssistantForKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // Collapsed by default: which sources came back partial/incomplete is useful detail, not
  // something worth greeting every search with a wall of amber text for.
  const [sourceWarningsOpen, setSourceWarningsOpen] = useState(false);

  const [savedKeys, setSavedKeys] = useState<ReadonlySet<string>>(new Set());
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [defaultCvName, setDefaultCvName] = useState<string | null>(null);

  const [engineCheckTick, setEngineCheckTick] = useState(0);
  const [checkingEngine, setCheckingEngine] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCheckingEngine(true);
    void (async () => {
      try {
        const status = await window.vacancyRadar.getStatus();
        if (cancelled) return;
        if (status.ready) setEngineState('ready');
        else {
          setEngineState('unavailable');
          setEngineError(status.error ?? 'vacancy engine is not ready');
        }
      } catch (error) {
        if (cancelled) return;
        setEngineState('unavailable');
        setEngineError(describeError(error, 'failed to reach the vacancy engine'));
      } finally {
        if (!cancelled) setCheckingEngine(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engineCheckTick]);

  const retryEngineCheck = useCallback(() => setEngineCheckTick((tick) => tick + 1), []);

  // Bumped by `retryLoad` to force the hydration effect below to re-run even though nothing else
  // changed: clearing `hasHydrated.current` alone doesn't, since ref mutations don't trigger
  // re-renders or re-run effects.
  const [reloadTick, setReloadTick] = useState(0);

  // Hydrate the last report. This is a `getReport`-style read of stored output; it never runs a
  // scan, so opening the page costs nothing and shows what is already known.
  useEffect(() => {
    if (hasHydrated.current) {
      setHydrating(false);
      return;
    }

    let cancelled = false;
    setHydrating(true);
    setLoadError(undefined);

    void (async () => {
      try {
        const report = await window.vacancyRadar.getReport();
        if (cancelled) return;
        setWorldwideReport(report);
        hasHydrated.current = true;
      } catch (error) {
        if (cancelled) return;
        setLoadError(describeError(error, 'could not load the report'));
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const retryLoad = useCallback(() => {
    hasHydrated.current = false;
    setReloadTick((tick) => tick + 1);
  }, []);

  // Which vacancies are already in the workspace, so a row can say "Saved" rather than offering a
  // duplicate. A failure here is not worth an error banner: it costs a label, not a capability.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const jobs = await window.workspace.listSavedJobs();
        if (cancelled) return;
        setSavedKeys(new Set(jobs.map((job) => job.vacancyKey).filter((key): key is string => !!key)));
      } catch {
        // list stays empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The CV card names the default CV so the gap-analysis offer is concrete about what it compares
  // against. Null (no library, or no default) is a supported state, not an error.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const documents = await window.workspace.listCvDocuments();
        if (cancelled) return;
        setDefaultCvName(documents.find((document) => document.isDefault)?.name ?? null);
      } catch {
        // the card falls back to "a CV you load"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo<SearchResult[]>(
    () => (worldwideReport ? sortResults(toWorldwideResults(worldwideReport)) : []),
    [worldwideReport],
  );

  const visible = useMemo(() => filterResults(results, appliedFilters), [results, appliedFilters]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [visible, page],
  );

  const sources = useMemo(() => sourceOptions(results), [results]);
  const employmentTypes = useMemo(() => employmentOptions(results), [results]);

  // A new filtered set (a fresh search or a rescan) always starts back on page one: a page index
  // left over from a longer previous list could point past the end of a shorter new one.
  useEffect(() => {
    setPage(0);
  }, [visible]);

  // Keep the selection on a row that is actually in the list, so the detail pane and the list can
  // never disagree about what is selected after a filter change or a rescan.
  useEffect(() => {
    if (visible.length === 0) {
      setSelectedKey(null);
      return;
    }
    setSelectedKey((current) =>
      current && visible.some((result) => result.key === current) ? current : visible[0]!.key,
    );
  }, [visible]);

  const selected = useMemo(
    () => visible.find((result) => result.key === selectedKey) ?? null,
    [visible, selectedKey],
  );

  const profileNotConfigured = worldwideReport !== null && results.length > 0 && results.every((r) => r.profileScore === null);
  const sourceWarnings = worldwideReport?.discoverySources.filter((source) => source.status !== 'success') ?? [];
  const hasReport = worldwideReport !== null;
  const busy = hydrating || scanning;

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(undefined);
    setLoadError(undefined);
    try {
      setWorldwideReport(await window.vacancyRadar.runScan(filters.query));
      hasHydrated.current = true;
    } catch (error) {
      setScanError(describeError(error, 'scan failed'));
    } finally {
      setScanning(false);
    }
  }, [filters.query]);

  // "Search" commits the draft filters (so the list reflects exactly what the form currently
  // shows) and goes to get fresh data, whether or not a report already exists -- there is
  // deliberately no separate "just filter" vs. "rescan" action any more (the two used to be
  // different buttons, one of which did nothing once a report was loaded, which read as a dead
  // control rather than a real second action).
  const handleSearch = useCallback(() => {
    setAppliedFilters(filters);
    void runScan();
  }, [filters, runScan]);

  const handleFiltersChange = useCallback((patch: Partial<SearchFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  /** The filter bar's country selector: a plain, instant, client-side filter over whatever is
   * already loaded. */
  const handleLocationChange = useCallback((value: string) => {
    hasEditedLocationRef.current = true;
    setFilters((current) => ({ ...current, country: value }));
    setAppliedFilters((current) => ({ ...current, country: value }));
  }, []);

  // The one filter action that applies immediately, with no separate Search click: an explicit
  // reset is already a deliberate commitment, not a still-being-typed draft.
  const handleClearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setAppliedFilters(DEFAULT_FILTERS);
  }, []);

  const handleSelect = useCallback((result: SearchResult) => {
    setSelectedKey(result.key);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    const key = selected.key;
    setSaveStates((current) => ({ ...current, [key]: 'saving' }));
    setSaveErrors((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
    try {
      await window.workspace.createSavedJob(savedJobInputFor(selected));
      setSaveStates((current) => ({ ...current, [key]: 'saved' }));
      setSavedKeys((current) => new Set(current).add(key));
    } catch (error) {
      setSaveStates((current) => ({ ...current, [key]: 'idle' }));
      setSaveErrors((current) => ({ ...current, [key]: describeError(error, 'could not save this job') }));
    }
  }, [selected]);

  const handleGenerateLetter = useCallback(() => {
    if (!selected) return;
    onGenerateLetter?.(selectedVacancyFor(selected));
  }, [selected, onGenerateLetter]);

  const saveState: SaveState = selected
    ? (saveStates[selected.key] ?? (savedKeys.has(selected.key) ? 'saved' : 'idle'))
    : 'idle';
  const saveError = selected ? saveErrors[selected.key] : undefined;

  // The count of what is actually shown after filtering, not the raw size of the loaded report:
  // the latter isn't a number a user can do anything with here (there is no "browse everything"
  // view), so pairing it with the real, viewable count as "X of Y" read as a mismatch to explain
  // rather than useful context.
  const summary = hasReport
    ? `${visible.length} ${visible.length === 1 ? 'vacancy' : 'vacancies'}`
    : 'No report loaded';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SearchFilterBar
        onLocationChange={handleLocationChange}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        onSearch={handleSearch}
        onClear={handleClearFilters}
        sources={sources}
        employmentTypes={employmentTypes}
        busy={busy}
        salaryNote={SALARY_NOTE}
      />

      <div className="flex-none">
        {engineState === 'unavailable' && (
          <div className="alert alert-error alert-soft mt-3 text-sm" role="alert">
            <span>
              Vacancy engine unavailable: {engineError ?? 'unknown error'}. Stored reports may still
              be shown, but no new scan can run.
            </span>
            <button
              type="button"
              className="btn btn-outline btn-xs ml-auto flex-none"
              onClick={retryEngineCheck}
              disabled={checkingEngine}
            >
              {checkingEngine && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              Retry
            </button>
          </div>
        )}
        {scanning && (
          <div className="alert alert-info alert-soft mt-3 text-sm">
            <span className="loading loading-spinner loading-xs flex-none" aria-hidden="true" />
            Scanning live sources: this hits real external APIs and feeds, and can take anywhere
            from about ten seconds up to a couple of minutes. The app is not frozen.
          </div>
        )}
        {scanError && (
          <div className="alert alert-error alert-soft mt-3 text-sm" role="alert">
            <span>Scan failed: {scanError}</span>
            <button
              type="button"
              className="btn btn-outline btn-xs ml-auto flex-none"
              onClick={() => void runScan()}
              disabled={busy}
            >
              Retry
            </button>
          </div>
        )}
        {loadError && (
          <div className="alert alert-error alert-soft mt-3 text-sm" role="alert">
            <span>{loadError}</span>
            <button
              type="button"
              className="btn btn-outline btn-xs ml-auto flex-none"
              onClick={retryLoad}
              disabled={busy}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {hydrating && !hasReport ? (
        <>
          <div className="alert alert-info alert-soft mt-3 text-sm">
            <span className="loading loading-spinner loading-xs flex-none" aria-hidden="true" />
            Loading the latest report…
          </div>
          <SearchLoadingSkeleton />
        </>
      ) : scanning && !hasReport ? (
        <SearchLoadingSkeleton />
      ) : !hasReport ? (
        <EmptyState
          illustration={emptySearchIllustration}
          title="No search yet"
          description="No scan has been run yet, so there is nothing to filter. Run a scan to discover vacancies from public job feeds."
          action={
            <button className="btn btn-primary btn-sm" type="button" onClick={() => void runScan()} disabled={busy}>
              Run the first scan
            </button>
          }
        />
      ) : profileNotConfigured ? (
        // Distinct from "No search yet": a scan genuinely ran and found vacancies, but scoring
        // never ran because the candidate profile has no target roles or strongest skills. Showing
        // the normal results view here would render "0 of N vacancies" -- indistinguishable from a
        // real, exhaustive search that found nothing -- rather than the actionable truth.
        <EmptyState
          illustration={emptySearchIllustration}
          title="Your search profile isn't set up yet"
          description={`${results.length} vacancies were found, but none were scored: the search profile has no target roles or strongest skills configured, so there's nothing to match them against. Fill it in under Settings to see ranked matches.`}
        />
      ) : (
        // Dimmed, not hidden or disabled, while a rescan is in flight: the results/detail pane
        // still shows the last-known data (real, just about to be replaced), and staying
        // interactive lets someone keep reading/saving from it during a scan that can take up to a
        // couple of minutes, rather than locking the page for that whole time.
        <div
          className={`mt-3 flex min-h-0 flex-1 flex-col lg:flex-row ${scanning ? 'opacity-60 transition-opacity' : ''}`}
        >
          <SearchResultList
            results={pageItems}
            totalCount={results.length}
            selectedKey={selectedKey}
            onSelect={handleSelect}
            savedKeys={savedKeys}
            summary={summary}
            page={page}
            pageCount={pageCount}
            onPageChange={setPage}
          />

          {selected ? (
            <VacancyDetail
              result={selected}
              defaultCvName={defaultCvName}
              saveState={saveState}
              {...(saveError ? { saveError } : {})}
              onSave={() => void handleSave()}
              onGenerateLetter={handleGenerateLetter}
              assistantOpen={assistantForKey === selected.key}
              onToggleAssistant={() =>
                setAssistantForKey((current) => (current === selected.key ? null : selected.key))
              }
              assistant={<CvAssistant vacancy={toVacancyLead(selected)} />}
            />
          ) : (
            <div className="min-w-0 flex-1">
              <EmptyState
                title="Select a vacancy"
                description="Pick a vacancy from the list to see what this scan actually verified about it, save it, or compare it against your CV."
              />
            </div>
          )}
        </div>
      )}

      {/* A quiet status strip, not a page footer: always visible without scrolling (this row sits
          outside the scrollable results/detail area above), for diagnostic/provenance metadata
          that's useful on demand but not worth greeting every visit with above the results. */}
      {(sourceWarnings.length > 0 || worldwideReport) && (
        <div className="flex-none border-t border-base-300 px-1 pt-2">
          {sourceWarnings.length > 0 && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-xs gap-1.5 text-warning"
                onClick={() => setSourceWarningsOpen((open) => !open)}
                aria-expanded={sourceWarningsOpen}
              >
                <Info size={14} aria-hidden="true" />
                Source coverage warning ({sourceWarnings.length})
              </button>
              {sourceWarningsOpen && (
                <div className="alert alert-warning alert-soft mt-1.5 text-sm" role="status">
                  <div>
                    {sourceWarnings.map((source) => (
                      <span key={source.id} className="block">
                        {source.provider}: {source.error ?? source.status}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {worldwideReport && (
            <p className="px-2 pb-1.5 text-xs text-base-content/60">
              Run {worldwideReport.runId} · generated {new Date(worldwideReport.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
