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
function keepTypedFilters(filters: SearchFilters): SearchFilters {
  return { ...DEFAULT_FILTERS, query: filters.query, location: filters.location };
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
 * Filtering (role/keyword, location, chips) is entirely client-side over the loaded report and
 * applies live as those fields change: narrowing a search must never itself trigger a scan. The
 * one "Search" button is the single, always-the-same action for going and getting fresh data,
 * whether or not a report is already loaded -- there is deliberately no second "just filter" vs.
 * "rescan" button, which used to be confusing (one of the two did nothing once a report existed).
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

  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        if (!hasSwitchedMarketRef.current) setMarket(settings.defaultMarket);
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

  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_FILTERS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [assistantForKey, setAssistantForKey] = useState<string | null>(null);
  // Collapsed by default: which sources came back partial/incomplete is useful detail, not
  // something worth greeting every search with a wall of amber text for.
  const [sourceWarningsOpen, setSourceWarningsOpen] = useState(false);

  const [savedKeys, setSavedKeys] = useState<ReadonlySet<string>>(new Set());
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [defaultCvName, setDefaultCvName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
  }, [market, marketResolved]);

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

  const visible = useMemo(() => filterResults(results, filters), [results, filters]);

  const sources = useMemo(() => sourceOptions(results), [results]);
  const employmentTypes = useMemo(() => employmentOptions(results), [results]);

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

  // Filters (role/keyword, location, chips) already apply live to whatever report is loaded, with
  // no button needed for that. "Search" only ever means one thing: go get fresh data, whether or
  // not a report already exists -- there is deliberately no separate "just filter" vs. "rescan"
  // action any more (the two used to be different buttons, one of which did nothing once a report
  // was loaded, which read as a dead control rather than a real second action).
  const handleSearch = useCallback(() => {
    void runScan();
  }, [runScan]);

  const handleMarketChange = useCallback((next: SearchMarket) => {
    hasSwitchedMarketRef.current = true;
    setMarketResolved(true);
    setMarket(next);
    setFilters(keepTypedFilters);
    setSelectedKey(null);
    setAssistantForKey(null);
    setScanError(undefined);
  }, []);

  const handleFiltersChange = useCallback((patch: Partial<SearchFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const handleClearFilters = useCallback(() => setFilters(DEFAULT_FILTERS), []);

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

  const summary = hasReport
    ? `${visible.length} of ${results.length} vacancies · ${marketLabel(market)}`
    : `No ${marketLabel(market)} report loaded`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SearchFilterBar
        market={market}
        onMarketChange={handleMarketChange}
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
            Vacancy engine unavailable: {engineError ?? 'unknown error'}. Stored reports may still be
            shown, but no new scan can run.
          </div>
        )}
        {scanning && (
          <div className="alert alert-info mt-3 text-sm">
            Scanning live {marketLabel(market)} sources: this hits real external APIs and feeds, and
            can take anywhere from about ten seconds up to a couple of minutes. The app is not frozen.
          </div>
        )}
        {scanError && (
          <div className="alert alert-error alert-soft mt-3 text-sm" role="alert">
            Scan failed: {scanError}
          </div>
        )}
        {loadError && (
          <div className="alert alert-error alert-soft mt-3 text-sm" role="alert">
            {loadError}
          </div>
        )}
        {sourceWarnings.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              className="btn btn-ghost btn-xs gap-1.5 text-warning"
              onClick={() => setSourceWarningsOpen((open) => !open)}
              aria-expanded={sourceWarningsOpen}
            >
              <Info size={14} aria-hidden="true" />
              Source coverage warning ({sourceWarnings.length})
            </button>
          </div>
        )}
        {sourceWarnings.length > 0 && sourceWarningsOpen && (
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
        {report && (
          <p className="mt-2 text-xs text-base-content/60">
            Run {report.runId} · generated {new Date(report.generatedAt).toLocaleString()}
          </p>
        )}
      </div>

      {hydrating && !hasReport ? (
        <div className="alert alert-info mt-3 text-sm">Loading the latest {marketLabel(market)} report…</div>
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
        <div className="mt-3 flex min-h-0 flex-1 flex-col lg:flex-row">
          <SearchResultList
            results={visible}
            totalCount={results.length}
            selectedKey={selectedKey}
            onSelect={handleSelect}
            savedKeys={savedKeys}
            summary={summary}
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
    </div>
  );
}
