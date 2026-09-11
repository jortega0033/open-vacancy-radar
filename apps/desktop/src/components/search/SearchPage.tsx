import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Info } from '@phosphor-icons/react';
import type { ProviderId } from '@agent-dock/shared';
import type { CandidateProfile, DiscoveryVacancyAudit, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import emptySearchIllustration from '../../../assets/illustrations/empty-search.svg?no-inline';
import type { SavedJobInput } from '../../window.js';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { CvAssistant, type VacancyLead } from '../cv/index.js';
import { describeError } from '../cv/useAgentRun.js';
import type { SelectedVacancy } from '../letters/index.js';
import { EmptyState, ErrorBanner } from '../shell/index.js';
import { SearchFilterBar } from './SearchFilterBar.js';
import { SearchResultList } from './SearchResultList.js';
import { VacancyDetail, type SaveState } from './VacancyDetail.js';
import {
  DEFAULT_FILTERS,
  buildSearchResultIndex,
  employmentOptions,
  filterSearchResultIndex,
  isWebUrl,
  sortSearchResultIndex,
  sourceOptions,
  toPartialResults,
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
  onOpenSearchProfile?: () => void;
}

export function SearchPage({ onGenerateLetter, onOpenSearchProfile }: SearchPageProps = {}) {
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
  const [scanGuard, setScanGuard] = useState<string>();
  const [searchProfile, setSearchProfile] = useState<CandidateProfile | null>(null);
  const [searchProfileError, setSearchProfileError] = useState<string>();

  // Rows pushed by `vacancy:scan-progress` (issue #252) for the scan currently running, if any --
  // used only while no final report is loaded yet (see `results` below). Reset whenever this page
  // itself starts a fresh scan; otherwise left to accumulate for as long as the page stays mounted.
  // A page that (re)mounts mid-scan starts empty here and just waits for the next progress event or
  // the scan's own completion, rather than replaying rows a previous mount already saw -- see
  // `onScanProgress`'s own doc comment on `VacancyRadarBridge` for that trade-off.
  const [partialVacancies, setPartialVacancies] = useState<DiscoveryVacancyAudit[]>([]);

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
  // Which CLI the gap-analysis offer below actually runs through, so its copy names the real
  // provider instead of assuming Claude Code. A failure here just leaves that default in place.
  const [defaultProvider, setDefaultProvider] = useState<ProviderId>('claude');

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

  // Backs `waitForScanToFinish` below: true once this component has unmounted, checked before
  // every state update the poll loop makes so a page the user has since navigated away from never
  // writes into stale state. A ref, not a `useEffect` cleanup flag local to one effect, because
  // this same loop is started from two different places (mount, and a losing "already running"
  // collision in `runScan` below) and must not each own an independent, only-sometimes-cleaned-up
  // timer.
  const unmountedRef = useRef(false);
  useEffect(
    () => () => {
      unmountedRef.current = true;
    },
    [],
  );

  /**
   * Subscribes to `vacancy:scan-progress` for the lifetime of this mount (issue #252), accumulating
   * each source's freshly discovered rows into `partialVacancies` -- deduplicated on `key`, since a
   * source can in principle appear more than once across a run's own retries and the same vacancy
   * must not render twice. Always subscribed, not just while `scanning` is true: this is what lets a
   * page that (re)mounts onto a scan already in flight pick up the *rest* of that scan's progress
   * events as they arrive, rather than only its final completion via `waitForScanToFinish`'s poll
   * (rows from before this mount are not replayed -- see `partialVacancies`'s own doc comment).
   * Unsubscribing on unmount is what keeps a navigate-away-and-back cycle at exactly one live
   * listener rather than accumulating one per mount.
   */
  useEffect(() => {
    return window.vacancyRadar.onScanProgress((event) => {
      setPartialVacancies((current) => {
        const seen = new Set(current.map((vacancy) => vacancy.key));
        const additions = event.vacancies.filter((vacancy) => !seen.has(vacancy.key));
        return additions.length > 0 ? [...current, ...additions] : current;
      });
    });
  }, []);

  /**
   * Polls until a scan this page did not itself start (or lost the race to start) finishes, then
   * refreshes the report. Used both when this page mounts onto an already-running scan -- most
   * often its own, from before the user navigated to another page and back -- and when `runScan`
   * below loses a race against one. The scan itself runs entirely in the main process and outlives
   * this component's `scanning` state (which resets to `false` on every mount), so this is the
   * only way the page can ever stop looking idle/failed while a scan it knows nothing else about
   * is genuinely still running.
   */
  const waitForScanToFinish = useCallback(function poll() {
    void (async () => {
      try {
        const { scanning: stillScanning } = await window.vacancyRadar.getScanStatus();
        if (unmountedRef.current) return;
        if (stillScanning) {
          setTimeout(poll, 3000);
          return;
        }
        // Finished, successfully or not; either way `getReport()` reflects the true current
        // state, so pick that up rather than staying on whatever was loaded (or not) before.
        setScanning(false);
        const report = await window.vacancyRadar.getReport();
        if (unmountedRef.current) return;
        setWorldwideReport(report);
        hasHydrated.current = true;
        // The real, final report is now the source of truth (see `results` below); provisional
        // rows from this run have served their purpose and stop being retained.
        setPartialVacancies([]);
      } catch {
        // A failed status check just stops reattaching; it does not invent a scan failure for a
        // scan this page never itself started and has no error message for.
        if (!unmountedRef.current) setScanning(false);
      }
    })();
  }, []);

  // Reattaches to a scan already running when this page mounts (see `waitForScanToFinish` above).
  useEffect(() => {
    void (async () => {
      try {
        const { scanning: alreadyScanning } = await window.vacancyRadar.getScanStatus();
        if (unmountedRef.current || !alreadyScanning) return;
        setScanning(true);
        waitForScanToFinish();
      } catch {
        // No status available (e.g. engine not initialized yet): nothing to reattach to.
      }
    })();
  }, [waitForScanToFinish]);

  /**
   * #195: a background scan can finish entirely while this window is hidden (minimized to tray),
   * which the mount-time reattachment effect above does not cover -- that effect runs once, only
   * on mount, and only reattaches when a scan is *still* running; it does nothing for one that
   * already finished while hidden, so showing the window again would otherwise keep displaying a
   * stale report. On `visibilitychange` to `'visible'`, unconditionally re-fetch the report by
   * resetting `hasHydrated` and bumping `reloadTick` (re-running the hydration effect above), and
   * separately re-check scan status to re-arm the "Scanning..." banner if one is still running.
   * The two checks are independent, not one replacing the other: a finished scan's result and a
   * still-running scan's status are different questions.
   */
  useEffect(() => {
    function onVisibilityChange(): void {
      if (document.visibilityState !== 'visible') return;
      hasHydrated.current = false;
      setReloadTick((tick) => tick + 1);
      void (async () => {
        try {
          const { scanning: stillScanning } = await window.vacancyRadar.getScanStatus();
          if (unmountedRef.current || !stillScanning) return;
          setScanning(true);
          waitForScanToFinish();
        } catch {
          // No status available: nothing to reattach to.
        }
      })();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [waitForScanToFinish]);

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

  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (!cancelled) setDefaultProvider(settings.defaultProvider);
      })
      .catch(() => {
        // the card falls back to the Claude Code default
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.vacancyRadar
      .getSearchProfile()
      .then((loaded) => {
        if (!cancelled) {
          setSearchProfile(loaded);
          setSearchProfileError(undefined);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSearchProfile(null);
          setSearchProfileError(describeError(error, 'could not load the search profile'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // While no final report is loaded yet, fall back to whatever `vacancy:scan-progress` has pushed
  // so far (issue #252) -- honestly unscored, provisional rows shown sooner than the scan's own
  // promise resolves. The moment a real `GlobalRemoteReport` exists, it is the only source of truth
  // here: this never merges partial rows into a loaded report, so the final displayed list is
  // exactly what a non-streaming scan would have shown, byte-for-byte.
  const results = useMemo<SearchResult[]>(() => {
    if (worldwideReport) return toWorldwideResults(worldwideReport);
    if (partialVacancies.length > 0) return toPartialResults(partialVacancies);
    return [];
  }, [worldwideReport, partialVacancies]);

  const resultIndex = useMemo(() => buildSearchResultIndex(results), [results]);
  const visible = useMemo(
    () => sortSearchResultIndex(filterSearchResultIndex(resultIndex, appliedFilters)),
    [resultIndex, appliedFilters],
  );

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

  const reportHasOnlyUnscoredRows = worldwideReport !== null && results.length > 0 && results.every((r) => r.profileScore === null);
  const currentProfileConfigured =
    searchProfile !== null && (searchProfile.targetRoles.length > 0 || searchProfile.strongestSkills.length > 0);
  const currentProfileScanQuery =
    searchProfile?.targetRoles.find((role) => role.trim())?.trim() ??
    searchProfile?.strongestSkills.find((skill) => skill.trim())?.trim() ??
    '';
  const profileNotConfigured = reportHasOnlyUnscoredRows && searchProfile !== null && !currentProfileConfigured;
  const reportNeedsRescore = reportHasOnlyUnscoredRows && currentProfileConfigured;
  const profileScoringUnknown = reportHasOnlyUnscoredRows && searchProfileError;
  const sourceWarnings = worldwideReport?.discoverySources.filter((source) => source.status !== 'success') ?? [];
  const hasReport = worldwideReport !== null;
  const liveProgressCount = partialVacancies.length;
  // A scan is running and has pushed at least one row, but has not produced its final report yet:
  // `results` above is showing provisional, not-yet-scored rows rather than the empty/loading state.
  // Deliberately excludes `profileNotConfigured`'s check (which requires a real report): a
  // streaming row's null `profileScore` is expected and temporary, never "profile not configured".
  const isStreamingPartial = !hasReport && partialVacancies.length > 0;
  const busy = hydrating || scanning;

  const runScan = useCallback(async (queryOverride?: string) => {
    const query = (queryOverride ?? filters.query).trim();
    if (!query) {
      setScanning(false);
      setScanError(undefined);
      setScanGuard(
        'Add a role or keyword before starting a new worldwide scan. Country, source, date and employment filters narrow the report already loaded here; they do not reduce the upstream network scan yet.',
      );
      return;
    }
    setScanning(true);
    setScanError(undefined);
    setScanGuard(undefined);
    setLoadError(undefined);
    // A fresh scan this page itself starts has no partial rows yet -- clear whatever an earlier
    // run (or an earlier mount's now-gone accumulation) left behind, so a rescan's own progress
    // events build a clean list rather than mixing in a previous run's provisional rows.
    setPartialVacancies([]);
    try {
      setWorldwideReport(await window.vacancyRadar.runScan(query));
      hasHydrated.current = true;
      setScanning(false);
      setPartialVacancies([]);
    } catch (error) {
      const message = describeError(error, 'scan failed');
      // The reattachment effect above disables Search while a scan (including one from before
      // this page mounted) is already running, so this should be unreachable in normal use. It
      // survives as a safety net for a narrow race (e.g. a scan started by another process just
      // after the status check resolved): stays in the "scanning" state and waits for the real
      // scan to finish, rather than reporting this attempt's own rejection as "scan failed", which
      // would read as this attempt having broken something.
      if (message.includes('already running')) {
        waitForScanToFinish();
      } else {
        setScanning(false);
        setScanError(message);
      }
    }
  }, [filters.query, waitForScanToFinish]);

  const handleRescore = useCallback(() => {
    const query = currentProfileScanQuery;
    if (!query) return;
    const nextFilters = { ...filters, query };
    setFilters(nextFilters);
    setAppliedFilters(nextFilters);
    void runScan(query);
  }, [currentProfileScanQuery, filters, runScan]);

  // A deliberate upstream refresh: typing and dropdown changes filter the loaded report live, while
  // this action goes back to external sources and swaps the report only when the scan finishes.
  const handleSearch = useCallback(() => {
    setAppliedFilters(filters);
    void runScan();
  }, [filters, runScan]);

  const handleFiltersChange = useCallback((patch: Partial<SearchFilters>) => {
    if (typeof patch.query === 'string' && patch.query.trim()) setScanGuard(undefined);
    setFilters((current) => ({ ...current, ...patch }));
    setAppliedFilters((current) => ({ ...current, ...patch }));
  }, []);

  /** The filter bar's country selector: a plain, instant, client-side filter over whatever is
   * already loaded. Moving off "Netherlands" also clears `sponsorOnly`: that checkbox is hidden
   * for every other country (the engine never attempts the check outside Netherlands), so a
   * value left on here would silently keep narrowing the list with no visible control to undo it. */
  const handleLocationChange = useCallback((value: string) => {
    hasEditedLocationRef.current = true;
    const patch = value === 'Netherlands' ? { country: value } : { country: value, sponsorOnly: false };
    setFilters((current) => ({ ...current, ...patch }));
    setAppliedFilters((current) => ({ ...current, ...patch }));
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
  const summary =
    hasReport || isStreamingPartial
      ? `${visible.length} ${visible.length === 1 ? 'vacancy' : 'vacancies'}${isStreamingPartial ? ' so far' : ''}`
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
        hasReport={hasReport}
      />

      <div className="flex-none">
        {engineState === 'unavailable' && (
          <ErrorBanner
            className="mt-3"
            action={
              <button
                type="button"
                className="btn btn-outline btn-xs ml-auto flex-none"
                onClick={retryEngineCheck}
                disabled={checkingEngine}
              >
                {checkingEngine && <span className="loading loading-spinner loading-xs text-base-content" aria-hidden="true" />}
                Retry
              </button>
            }
          >
            Vacancy engine unavailable: {engineError ?? 'unknown error'}. Stored reports may still be
            shown, but no new scan can run.
          </ErrorBanner>
        )}
        {scanning && (
          <div className="alert alert-info mt-3 text-sm">
            <span className="loading loading-spinner loading-xs flex-none" aria-hidden="true" />
            {hasReport
              ? `Scanning live sources in the background. The list below is your saved report filtered locally${liveProgressCount > 0 ? `; ${liveProgressCount.toLocaleString()} live ${liveProgressCount === 1 ? 'vacancy has' : 'vacancies have'} arrived so far` : ''}. It will switch when the scan finishes.`
              : isStreamingPartial
              ? 'Scanning live sources: showing vacancies as each source finishes. Matching and sponsor checks fill in once the scan completes.'
              : 'Scanning live sources: this hits real external APIs and feeds, and can take anywhere from about ten seconds up to a couple of minutes. The app is not frozen.'}
          </div>
        )}
        {scanError && (
          <ErrorBanner
            className="mt-3"
            action={
              <button
                type="button"
                className="btn btn-outline btn-xs ml-auto flex-none"
                onClick={() => void runScan()}
                disabled={busy}
              >
                Retry
              </button>
            }
          >
            Scan failed: {scanError}
          </ErrorBanner>
        )}
        {scanGuard && (
          <div className="alert alert-warning alert-soft mt-3 flex items-center justify-between gap-3 text-sm" role="alert">
            <span>{scanGuard}</span>
            {hasReport && (
              <button
                type="button"
                className="btn btn-warning btn-sm"
                onClick={() => {
                  setAppliedFilters(filters);
                  setScanGuard(undefined);
                }}
              >
                Browse saved report
              </button>
            )}
          </div>
        )}
        {loadError && (
          <ErrorBanner
            className="mt-3"
            action={
              <button
                type="button"
                className="btn btn-outline btn-xs ml-auto flex-none"
                onClick={retryLoad}
                disabled={busy}
              >
                Retry
              </button>
            }
          >
            {loadError}
          </ErrorBanner>
        )}
      </div>

      {hydrating && !hasReport ? (
        <>
          <div className="alert alert-info mt-3 text-sm">
            <span className="loading loading-spinner loading-xs flex-none" aria-hidden="true" />
            Loading the latest report…
          </div>
          <SearchLoadingSkeleton />
        </>
      ) : scanning && !hasReport && !isStreamingPartial ? (
        // Nothing has come back from any source yet -- there is genuinely nothing to show, streamed
        // or otherwise, so this is still the plain loading state.
        <SearchLoadingSkeleton />
      ) : !hasReport && !isStreamingPartial ? (
        <EmptyState
          illustration={emptySearchIllustration}
          title="No search yet"
          description="No scan has been run yet, so there is nothing to filter. Run a scan to discover vacancies from public job feeds."
          action={
            <button className="btn btn-primary btn-sm" type="button" onClick={handleSearch} disabled={busy || !filters.query.trim()}>
              Run the first scan
            </button>
          }
        />
      ) : (
        // Dimmed, not hidden or disabled, while a rescan is in flight: the results/detail pane
        // still shows the last-known data (real, just about to be replaced), and staying
        // interactive lets someone keep reading/saving from it during a scan that can take up to a
        // couple of minutes, rather than locking the page for that whole time.
        <>
          {profileNotConfigured && (
            <div className="alert alert-warning alert-soft mt-3 flex items-center justify-between gap-3 text-sm" role="status">
              <span>
                {results.length.toLocaleString()} vacancies were found, but none were scored because
                the search profile has no target roles or strongest skills. You can still browse,
                save and filter these vacancies; fill the profile under Settings to rank future scans.
              </span>
              {onOpenSearchProfile && (
                <button type="button" className="btn btn-warning btn-sm" onClick={onOpenSearchProfile}>
                  Fill search profile
                </button>
              )}
            </div>
          )}
          {reportNeedsRescore && (
            <div className="alert alert-warning alert-soft mt-3 flex items-center justify-between gap-3 text-sm" role="status">
              <span>
                Search profile is saved, but this report was generated before it could be scored.
                Cached vacancies remain browseable; rescan to score them with the current profile.
              </span>
              <button type="button" className="btn btn-warning btn-sm" onClick={handleRescore} disabled={busy || !currentProfileScanQuery}>
                Rescan and score
              </button>
            </div>
          )}
          {profileScoringUnknown && (
            <div className="alert alert-warning alert-soft mt-3 text-sm" role="status">
              Cached vacancies are browseable, but the app could not check whether the current
              search profile can score this report: {searchProfileError}
            </div>
          )}
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
                providerLabel={PROVIDER_LABEL[defaultProvider]}
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
                  illustration={emptySearchIllustration}
                  title="Select a vacancy"
                  description="Pick a vacancy from the list to see what this scan actually verified about it, save it, or compare it against your CV."
                />
              </div>
            )}
          </div>
        </>
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
                        {discoveryProviderLabel(source.provider)}: {source.error ?? source.status}
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
