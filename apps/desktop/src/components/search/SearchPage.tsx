import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Info } from '@phosphor-icons/react';
import type { GlobalRemoteReport, JobRadarReport } from '@open-vacancy-radar/vacancy-engine';
import emptySearchIllustration from '../../../assets/illustrations/empty-search.svg?no-inline';
import type { SavedJobInput } from '../../window.js';
import { CvAssistant, type VacancyLead } from '../cv/index.js';
import { EmptyState } from '../shell/index.js';
import { SearchFilterBar } from './SearchFilterBar.js';
import { SearchResultList } from './SearchResultList.js';
import { VacancyDetail, type SaveState } from './VacancyDetail.js';
import {
  DEFAULT_FILTERS,
  employmentOptions,
  filterResults,
  isWebUrl,
  marketLabel,
  sortResults,
  sourceOptions,
  toNetherlandsResults,
  toWorldwideResults,
  type SearchFilters,
  type SearchMarket,
  type SearchResult,
} from './results.js';

type EngineState = 'checking' | 'ready' | 'unavailable';

/** How many rows the results list shows per page. A loaded report can carry thousands of
 * vacancies (a worldwide scan easily clears 1000+), and rendering all of them at once with no
 * pagination is both a real DOM-size performance problem and a "where did the rest go" UX gap. */
const PAGE_SIZE = 25;

/**
 * One line per market about the money its report actually carries. Shown in the filter bar so the
 * absence of a salary on a Netherlands row reads as "this pipeline has no salary field", not as
 * "this employer pays nothing worth mentioning".
 */
const SALARY_NOTE: Record<SearchMarket, string> = {
  netherlands: 'No salary in the Netherlands report',
  worldwide: 'Salary shown only where advertised',
};

/**
 * `SearchResult` → `VacancyLead`, the shape the CV assistant's prompt builders take.
 *
 * The normalisation in `results.ts` already assembles this per market, because only it knows which
 * fields each pipeline genuinely carries. The Netherlands report contributes title/company/
 * location/url and nothing more, while a worldwide discovery row can also contribute employment
 * type and the advertised salary triple. Re-deriving that here would mean guessing at fields the
 * selected market may not have, so this function is a named seam over that decision rather than a
 * second, competing mapping. `description`/`requirements` stay absent for both markets: neither
 * pipeline stores the posting text, and the prompt builders say so to the model explicitly.
 */
export function toVacancyLead(result: SearchResult): VacancyLead {
  return result.lead;
}

/**
 * `SearchResult` → the `savedJobs` row input.
 *
 * `verification` stores the label the search page itself showed, so a worldwide row is saved as
 * "Not available for this market" rather than as an empty (and later re-readable as "unverified")
 * cell. `matchPercent` takes the Netherlands pipeline's deterministic relevance score (a real
 * 0-100 figure against the engine's configured candidate profile) and stays null for worldwide,
 * which computes no score. It is not a comparison against any CV in the library; the only real CV
 * comparison in this app is the on-demand gap analysis.
 */
export function savedJobInputFor(result: SearchResult): SavedJobInput {
  return {
    role: result.title,
    company: result.company,
    market: result.market,
    location: result.location ?? '',
    vacancyKey: result.key,
    salary: result.salary,
    arrangement: result.arrangement,
    verification: result.verification.label,
    matchPercent: result.profileScore,
    // The renderer refuses to link a non-http(s) URL, so it must not persist one either.
    sourceUrl: isWebUrl(result.url) ? result.url : null,
    status: 'considering',
  };
}

/**
 * Switching market keeps what the user typed and drops everything else: the source list, the
 * employment types and the market-only chips are all derived from one pipeline's data, so carrying
 * them across would silently filter the new market's results on a value it never produces.
 */
function keepTypedFilters(filters: SearchFilters, nextMarket: SearchMarket): SearchFilters {
  return {
    ...DEFAULT_FILTERS,
    query: filters.query,
    // "City or region" free text is Netherlands-only now (see SearchFilterBar.tsx -- worldwide
    // uses the structured Country filter instead, and showing both was two controls doing the
    // same job). Carrying it into worldwide would leave an invisible filter active with no
    // control left on screen to see or clear it.
    location: nextMarket === 'netherlands' ? filters.location : '',
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
 * Top-level Search screen: one market selector over two genuinely different scan pipelines, a
 * client-side filter bar, a results list and a detail pane.
 *
 * The lifecycle rule is hydrate-then-optionally-scan, as on the Vacancy Leads panel it replaces:
 * opening the page (or switching market) reads whatever report that pipeline last produced and
 * never starts a network scan on its own. Scanning hits real external feeds and can take a couple
 * of minutes, so it is always something the user asked for.
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
export function SearchPage() {
  const [engineState, setEngineState] = useState<EngineState>('checking');
  const [engineError, setEngineError] = useState<string>();

  const [market, setMarket] = useState<SearchMarket>('worldwide');
  const [netherlandsReport, setNetherlandsReport] = useState<JobRadarReport | null>(null);
  const [worldwideReport, setWorldwideReport] = useState<GlobalRemoteReport | null>(null);
  // Markets whose stored report has already been read once. A pipeline that has never been run
  // legitimately answers `null`, so "did we ask?" cannot be inferred from the report state itself.
  const hydratedMarkets = useRef<Set<SearchMarket>>(new Set());
  // Settings hydration is async, so the user can already have switched tabs by the time it lands.
  // Restoring the persisted default at that point would yank them off the tab they deliberately
  // picked, so hydration only ever sets the market if the user hasn't touched the tabs yet.
  const hasSwitchedMarketRef = useRef(false);
  // `market` starts at a placeholder ('worldwide') until the persisted default loads; the report
  // hydration effect below must not read against that placeholder; otherwise a netherlands-default
  // user would briefly, needlessly hit the worldwide report read before flipping to the real one.
  const [marketResolved, setMarketResolved] = useState(false);

  // `filters` is the draft the form fields are bound to; `appliedFilters` is what actually drives
  // `visible` below. They only sync on an explicit Search (or Clear) -- see the class doc comment.
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<SearchFilters>(DEFAULT_FILTERS);

  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (cancelled || hasSwitchedMarketRef.current) return;
        setMarket(settings.defaultMarket);
        // Mirrors Settings' own unified "Default search location" selector: for worldwide, a
        // persisted country pre-fills the same country filter this page's own selector writes to,
        // so opening the page for the first time already reflects that choice.
        if (settings.defaultMarket === 'worldwide' && settings.defaultLocation) {
          const withCountry = { ...DEFAULT_FILTERS, country: settings.defaultLocation };
          setFilters(withCountry);
          setAppliedFilters(withCountry);
        }
      })
      .catch(() => {
        // default market ('worldwide', set above) already applies
      })
      .finally(() => {
        if (!cancelled) setMarketResolved(true);
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

  // Bumped by `retryLoad` to force the hydration effect below to re-run even though `market` and
  // `marketResolved` haven't changed: deleting from the `hydratedMarkets` ref alone doesn't, since
  // ref mutations don't trigger re-renders or re-run effects.
  const [reloadTick, setReloadTick] = useState(0);

  // Hydrate the market's last report. Both branches are `getReport`-style reads of stored output;
  // neither runs a scan, so opening the page costs nothing and shows what is already known. Waits
  // for `marketResolved` so it never reads against the placeholder market from before settings load.
  useEffect(() => {
    if (!marketResolved) return;

    if (hydratedMarkets.current.has(market)) {
      setHydrating(false);
      return;
    }

    let cancelled = false;
    setHydrating(true);
    setLoadError(undefined);

    void (async () => {
      try {
        if (market === 'netherlands') {
          const report = await window.vacancyRadar.getNetherlandsReport();
          if (cancelled) return;
          setNetherlandsReport(report);
        } else {
          const report = await window.vacancyRadar.getReport();
          if (cancelled) return;
          setWorldwideReport(report);
        }
        hydratedMarkets.current.add(market);
      } catch (error) {
        if (cancelled) return;
        setLoadError(describeError(error, `could not load the ${marketLabel(market)} report`));
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [market, marketResolved, reloadTick]);

  const retryLoad = useCallback(() => {
    hydratedMarkets.current.delete(market);
    setReloadTick((tick) => tick + 1);
  }, [market]);

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

  const results = useMemo<SearchResult[]>(() => {
    if (market === 'netherlands') {
      return netherlandsReport ? sortResults(toNetherlandsResults(netherlandsReport)) : [];
    }
    return worldwideReport ? sortResults(toWorldwideResults(worldwideReport)) : [];
  }, [market, netherlandsReport, worldwideReport]);

  const visible = useMemo(() => filterResults(results, appliedFilters), [results, appliedFilters]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageItems = useMemo(
    () => visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [visible, page],
  );

  const sources = useMemo(() => sourceOptions(results), [results]);
  const employmentTypes = useMemo(() => employmentOptions(results), [results]);

  // A new filtered set (a fresh search, a rescan, or a market switch) always starts back on page
  // one: a page index left over from a longer previous list could point past the end of a shorter
  // new one.
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

  const report = market === 'netherlands' ? netherlandsReport : worldwideReport;
  // Only the Netherlands pipeline scores against a candidate profile; the worldwide pipeline has
  // no such concept, so this is never true for it regardless of GlobalRemoteReport's own shape.
  const profileNotConfigured = market === 'netherlands' && netherlandsReport !== null && !netherlandsReport.profileConfigured;
  const sourceWarnings =
    market === 'worldwide'
      ? (worldwideReport?.discoverySources.filter((source) => source.status !== 'success') ?? [])
      : [];
  const hasReport = report !== null;
  const busy = hydrating || scanning;

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(undefined);
    setLoadError(undefined);
    try {
      if (market === 'netherlands') {
        setNetherlandsReport(await window.vacancyRadar.runNetherlandsScan());
      } else {
        setWorldwideReport(await window.vacancyRadar.runScan());
      }
      hydratedMarkets.current.add(market);
    } catch (error) {
      setScanError(describeError(error, 'scan failed'));
    } finally {
      setScanning(false);
    }
  }, [market]);

  // "Search" commits the draft filters (so the list reflects exactly what the form currently
  // shows) and goes to get fresh data, whether or not a report already exists -- there is
  // deliberately no separate "just filter" vs. "rescan" action any more (the two used to be
  // different buttons, one of which did nothing once a report was loaded, which read as a dead
  // control rather than a real second action).
  const handleSearch = useCallback(() => {
    setAppliedFilters(filters);
    void runScan();
  }, [filters, runScan]);

  /** `countryOverride`: set when a market switch is itself triggered by picking a specific
   * country out of `handleLocationChange` below (e.g. going straight from Netherlands to "United
   * States"), so that country lands as the new market's active filter instead of being reset to
   * "all" by `keepTypedFilters`. */
  const handleMarketChange = useCallback(
    (next: SearchMarket, countryOverride?: string) => {
      hasSwitchedMarketRef.current = true;
      setMarketResolved(true);
      setMarket(next);
      const carried = keepTypedFilters(filters, next);
      const withCountry = countryOverride === undefined ? carried : { ...carried, country: countryOverride };
      setFilters(withCountry);
      setAppliedFilters(withCountry);
      setSelectedKey(null);
      setAssistantForKey(null);
      setScanError(undefined);
    },
    [filters],
  );

  const handleFiltersChange = useCallback((patch: Partial<SearchFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  /**
   * The filter bar's single country/pipeline selector. "Netherlands" is the one value that means
   * something more than "filter the worldwide pipeline to this country": it switches the whole
   * pipeline to the IND-recognised-sponsor one, immediately (not staged behind Search), the same
   * way the old, now-removed Market selector worked -- picking a market/pipeline is a structural
   * choice, unlike the other filter chips that wait for an explicit Search click.
   */
  const handleLocationChange = useCallback(
    (value: string) => {
      // Marked here too, not only inside handleMarketChange below: staying on worldwide and just
      // changing which country is still a deliberate choice made through this control, and without
      // this the not-yet-resolved settings-hydration effect could still later overwrite it with the
      // persisted default market, clobbering a selection the user already made.
      hasSwitchedMarketRef.current = true;
      setMarketResolved(true);
      if (value === 'Netherlands') {
        handleMarketChange('netherlands');
        return;
      }
      if (market !== 'worldwide') {
        handleMarketChange('worldwide', value);
        return;
      }
      setFilters((current) => ({ ...current, country: value }));
      setAppliedFilters((current) => ({ ...current, country: value }));
    },
    [market, handleMarketChange],
  );

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

  const saveState: SaveState = selected
    ? (saveStates[selected.key] ?? (savedKeys.has(selected.key) ? 'saved' : 'idle'))
    : 'idle';
  const saveError = selected ? saveErrors[selected.key] : undefined;

  // The count of what is actually shown after filtering, not the raw size of the loaded report:
  // the latter isn't a number a user can do anything with here (there is no "browse everything"
  // view), so pairing it with the real, viewable count as "X of Y" read as a mismatch to explain
  // rather than useful context.
  const summary = hasReport
    ? `${visible.length} ${visible.length === 1 ? 'vacancy' : 'vacancies'} · ${marketLabel(market)}`
    : `No ${marketLabel(market)} report loaded`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SearchFilterBar
        market={market}
        onLocationChange={handleLocationChange}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        onSearch={handleSearch}
        onClear={handleClearFilters}
        sources={sources}
        employmentTypes={employmentTypes}
        busy={busy}
        salaryNote={SALARY_NOTE[market]}
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
            Scanning live {marketLabel(market)} sources: this hits real external APIs and feeds, and
            can take anywhere from about ten seconds up to a couple of minutes. The app is not frozen.
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
            Loading the latest {marketLabel(market)} report…
          </div>
          <SearchLoadingSkeleton />
        </>
      ) : scanning && !hasReport ? (
        <SearchLoadingSkeleton />
      ) : !hasReport ? (
        <EmptyState
          illustration={emptySearchIllustration}
          title="No search yet"
          description={`No ${marketLabel(market)} scan has been run yet, so there is nothing to filter. Run a scan to discover vacancies from this market's sources.`}
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
              sponsorSource={
                selected.market === 'netherlands' ? (netherlandsReport?.officialSponsorSource ?? null) : null
              }
              runId={report?.runId ?? null}
              defaultCvName={defaultCvName}
              saveState={saveState}
              {...(saveError ? { saveError } : {})}
              onSave={() => void handleSave()}
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
      {(sourceWarnings.length > 0 || report) && (
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
          {report && (
            <p className="px-2 pb-1.5 text-xs text-base-content/60">
              Run {report.runId} · generated {new Date(report.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
