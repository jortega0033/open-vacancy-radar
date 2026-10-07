import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type { ApplicationAttemptRecord, WorkspaceCounts } from './window.js';
import { PROVIDER_LABEL } from './provider-labels.js';
import { SearchPage, createSearchSessionState } from './components/search/index.js';
import { SavedJobsPage } from './components/saved/index.js';
import { ApplicationsPage } from './components/applications/index.js';
import { CvLibraryPage } from './components/cv-library/index.js';
import { LettersPage, type SelectedVacancy } from './components/letters/index.js';
import { RuntimePage } from './components/runtime/index.js';
import { SettingsPage, type SettingsFocusSection, type SettingsTab } from './components/settings/index.js';
import { AgentWorkspacePage } from './components/agent-workspace/index.js';
import { useAutoCompanyList } from './components/settings/useAutoCompanyList.js';
import { WelcomeModal } from './components/WelcomeModal.js';
import { SupportPromptProvider } from './components/support/index.js';
import {
  AI_HELPER_NOTICE_PAGES,
  AiHelperNotice,
  AppSidebar,
  Dialog,
  LiveAnnouncerProvider,
  ScheduledSendBanner,
  WorkspaceHeader,
  headerCopy,
  isNavPage,
  type CancelScheduledOutcome,
  type NavPage,
  type RuntimeState,
} from './components/shell/index.js';
import { applyDensity, applyTheme } from './theme.js';
import { activeProviderLimit, useProviderLimits, useProviderOverride } from './provider-limits.js';
import { publishEngineHealth, useEngineHealth } from './engine-health.js';

type DaemonState = 'connecting' | 'ready' | 'unavailable';

const DAEMON_CONNECT_TIMEOUT_MS = 20_000;
/** How often the shell re-reads the sidebar counts so pipeline-driven changes show without navigating. */
const COUNTS_REFRESH_MS = 5_000;
/** How often the shell re-reads the job search engine's health (#477). */
const ENGINE_HEALTH_REFRESH_MS = 20_000;
/** Below this window width the sidebar is the 64px rail unless the person pinned it open (#451). */
const SIDEBAR_RAIL_BELOW_PX = 1100;

export function App() {
  const companyList = useAutoCompanyList();
  const [nav, setNav] = useState<NavPage>('search');
  const [previousNav, setPreviousNav] = useState<NavPage>();
  const lastNavRef = useRef<NavPage>(nav);
  useEffect(() => {
    if (lastNavRef.current === nav) return;
    setPreviousNav(lastNavRef.current);
    lastNavRef.current = nav;
  }, [nav]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // The person chose "Expanded" as the sidebar's starting state: that is a pin, so a narrow window
  // does not take it away. Everyone else gets the rail at narrow widths and an overlay on demand.
  const [sidebarPinnedOpen, setSidebarPinnedOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const railForced = windowWidth < SIDEBAR_RAIL_BELOW_PX && !sidebarPinnedOpen;
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    // Widening the window, or pinning the sidebar, leaves nothing for the overlay to cover.
    if (!railForced) setSidebarOverlayOpen(false);
  }, [railForced]);
  // `undefined` until the first successful fetch (issue #178): rendering a zeroed WorkspaceCounts
  // here made "not loaded yet" and "genuinely zero" the same badge/subtitle, indistinguishably.
  const [counts, setCounts] = useState<WorkspaceCounts | undefined>(undefined);
  /** Ready attempts with an automatic send scheduled, soonest first (#445). */
  const [scheduledSends, setScheduledSends] = useState<ApplicationAttemptRecord[]>([]);

  // The one piece of cross-page state this shell carries: a vacancy handed off from the Search
  // page's "Generate Letter" action, waiting to be picked up by the Letters page. Cleared as soon
  // as `LettersPage` reports it consumed (see `handleVacancyConsumed`) and, defensively, on every
  // ordinary sidebar navigation (see `handleNavigate`) -- so a later, unrelated visit to Letters
  // never replays a stale handoff.
  const [pendingVacancy, setPendingVacancy] = useState<SelectedVacancy | null>(null);
  // Where Settings should open when something other than the sidebar sent the user there ("Fill
  // search profile", the first-launch checklist). Held here, not in SettingsPage, so it survives
  // that page remounting; a plain sidebar visit clears it in `handleNavigate`.
  const [settingsTarget, setSettingsTarget] = useState<{ tab: SettingsTab; focusSection?: SettingsFocusSection }>();
  // Bumped on every jump to a Settings target so an already-mounted Settings page remounts onto it.
  const [settingsTargetKey, setSettingsTargetKey] = useState(0);
  const [searchSession, setSearchSession] = useState(createSearchSessionState);
  const [applicationAttemptToOpen, setApplicationAttemptToOpen] = useState<string | null>(null);
  const [letterReturnAttemptId, setLetterReturnAttemptId] = useState<string | null>(null);

  // The first-launch CV nudge. Off until settings hydration proves both halves of the gate: the
  // flag has never been set, *and* the CV library is actually empty. Anything less would flash a
  // "welcome, upload a CV" modal at an upgrading user who has had one in the library for months.
  const [showWelcome, setShowWelcome] = useState(false);
  const [searchHandoff, setSearchHandoff] = useState<{ role: string; id: number } | null>(null);
  // "Finish setup" in Settings: the same checklist, opened on purpose. Never touches `welcomeSeen`.
  const [showSetup, setShowSetup] = useState(false);

  const [daemonState, setDaemonState] = useState<DaemonState>('connecting');
  const [daemonError, setDaemonError] = useState<string>();
  // "Try again" on the AI helper notice (#478). `retryFailed` outlives the restart so the notice can
  // say the last attempt did not work; it clears as soon as the helper reports ready.
  const [daemonRetrying, setDaemonRetrying] = useState(false);
  const [daemonRetryFailed, setDaemonRetryFailed] = useState(false);

  // The provider AI features (gap analysis, letters) currently run through: a persisted setting
  // (`app_settings.default_provider`), not runtime-only state. Kept here only because the sidebar
  // and header labels need it; RuntimePage owns the actual read/write of the setting and reports
  // changes back up via `onDefaultProviderChanged` so this label updates without a re-fetch.
  const [defaultProvider, setDefaultProvider] = useState<ProviderId>('claude');
  // Whether `defaultProvider`'s CLI is actually installed/authenticated, not just whether the
  // daemon sidecar is up: the daemon being ready says nothing about the CLI itself (see
  // `RuntimePage`, which already tracks this separately per-provider). Without this, the shell
  // status dot claimed "Ready" whenever the daemon started, even with no CLI installed at all.
  const [providerRuntimeState, setProviderRuntimeState] = useState<RuntimeState>('connecting');

  // Settings hydration is async, so the user can already have clicked a nav item by the time it
  // lands. Restoring the remembered start page at that point would yank them off the page they
  // deliberately opened, so hydration only ever sets the page if nothing else has.
  const hasNavigatedRef = useRef(false);

  // Hydrate shell state from the persisted settings row. Every failure mode here is non-fatal on
  // purpose: an unavailable workspace database should cost the user their remembered sidebar
  // state and nothing else, so the app still opens on the default page with the default theme.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const settings = await window.workspace.getSettings();
        if (cancelled) return;

        applyTheme(settings.theme);
        applyDensity(settings.density);
        setDefaultProvider(settings.defaultProvider);

        setSidebarPinnedOpen(settings.sidebarStart === 'expanded');
        if (settings.sidebarStart === 'expanded') setSidebarCollapsed(false);
        else if (settings.sidebarStart === 'collapsed') setSidebarCollapsed(true);
        else setSidebarCollapsed(settings.sidebarCollapsed);

        const start =
          settings.startPage === 'last_opened' ? settings.lastOpenedPage : settings.startPage;
        if (isNavPage(start) && !hasNavigatedRef.current) setNav(start);

        if (!settings.welcomeSeen) {
          // A count, not `listCvDocuments()`: this only needs to know whether the library is
          // empty, not fetch every CV's full extracted text/profile just to read `.length`.
          const counts = await window.workspace.getCounts();
          if (cancelled) return;
          // An existing user who already has a CV has nothing to be welcomed to: retire the flag
          // silently here so this check happens exactly once for them and the modal never renders.
          if (counts.cvDocuments > 0) void window.workspace.updateSettings({ welcomeSeen: true }).catch(() => {});
          else setShowWelcome(true);
        }
      } catch {
        // defaults already applied by useState
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The single exit from the welcome modal, whichever way the user took it (skip, close, backdrop,
  // or a CV they actually uploaded): closing it and marking it seen are the same act, so there is
  // no path that dismisses the modal without persisting the flag. Fire and forget, like every other
  // settings write in this shell -- a failed write costs the user one extra welcome, nothing more.
  const handleWelcomeClosed = useCallback(() => {
    setShowWelcome(false);
    void window.workspace.updateSettings({ welcomeSeen: true }).catch(() => {});
  }, []);

  // Done / close with a target role in the profile: land on Search with the role in the field and
  // focus on its button. Navigation only, never a scan. Skipped for the Settings and Runtime exits.
  const handleWelcomeDone = useCallback(() => {
    handleWelcomeClosed();
    void window.vacancyRadar
      .getSearchProfile()
      .then((profile) => {
        const role = profile?.targetRoles.map((r) => r.trim()).find(Boolean);
        if (!role) return;
        hasNavigatedRef.current = true;
        setNav('search');
        setSearchHandoff((current) => ({ role, id: (current?.id ?? 0) + 1 }));
      })
      .catch(() => {});
  }, [handleWelcomeClosed]);

  const refreshCounts = useCallback(async () => {
    try {
      const fresh = await window.workspace.getCounts();
      setCounts(fresh);
      // The banner's deadlines come from the persisted attempts, read whenever the count says there
      // are scheduled sends, so it is right at start-up and after a restart (#445).
      if ((fresh.scheduledSubmissions ?? 0) > 0) {
        const attempts = await window.workspace.listApplicationAttempts();
        setScheduledSends(
          attempts
            .filter((attempt) => attempt.checkpoint === 'ready' && attempt.scheduledAutomaticSubmitAt !== null)
            .sort((a, b) => Date.parse(a.scheduledAutomaticSubmitAt ?? '') - Date.parse(b.scheduledAutomaticSubmitAt ?? '')),
        );
      } else {
        setScheduledSends((current) => (current.length === 0 ? current : []));
      }
    } catch {
      // Leaves `counts` exactly as it was (undefined if never loaded, otherwise the last successful
      // fetch) rather than resetting to a fabricated zero -- not worth an error banner over the
      // whole app, but also not worth lying about a count that just hasn't refreshed.
    }
  }, []);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  // The pipeline changes counts on its own (an attempt starts, a submission lands) with no renderer
  // action to hang a refresh on, so the sidebar and page headers would otherwise stay stale until
  // the next navigation (#444). Cheap local read; paused while the window is hidden.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshCounts();
    }, COUNTS_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshCounts();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshCounts]);

  const handleNavigate = useCallback((page: NavPage) => {
    hasNavigatedRef.current = true;
    setNav(page);
    // Any nav through the sidebar is, by definition, not the "Generate Letter" handoff -- including
    // a manual click on Letters itself. Clearing unconditionally (not just when the destination is
    // 'letters') is what keeps a later, unrelated visit from replaying a stale handed-off vacancy.
    setPendingVacancy(null);
    setLetterReturnAttemptId(null);
    setSettingsTarget(undefined);
    if (page !== 'applications') setApplicationAttemptToOpen(null);
    // Fire and forget: remembering the page is a convenience, and a write failure must not block
    // (or fail) the navigation the user just asked for.
    void window.workspace?.updateSettings({ lastOpenedPage: page }).catch(() => {});
    // Cheap re-sync for the sidebar's badge counts: whichever page the user is leaving may have
    // just changed saved jobs/applications/letters, and there's no per-page mutation callback for
    // three of the five pages, so refreshing on every navigation is simpler than wiring one to each.
    void refreshCounts();
  }, [refreshCounts]);

  // "Fill search profile": Settings on the Search tab, with the profile's first field focused.
  // Set after `handleNavigate`, which clears any earlier target.
  const handleOpenSearchProfile = useCallback(() => {
    handleNavigate('settings');
    setSettingsTarget({ tab: 'search', focusSection: 'search-profile' });
    setSettingsTargetKey((key) => key + 1);
  }, [handleNavigate]);

  const handleGenerateApplicationLetter = useCallback((vacancy: SelectedVacancy, attemptId: string) => {
    hasNavigatedRef.current = true;
    setPendingVacancy(vacancy);
    setLetterReturnAttemptId(attemptId);
    setNav('letters');
    void window.workspace?.updateSettings({ lastOpenedPage: 'letters' }).catch(() => {});
    void refreshCounts();
  }, [refreshCounts]);

  // Passed to `LettersPage`: fired once it has captured its own copy of `pendingVacancy`, so this
  // state can be cleared immediately rather than waiting for the user to navigate elsewhere.
  const handleVacancyConsumed = useCallback(() => setPendingVacancy(null), []);

  // A letter saved while Letters was opened from an application review belongs to that application:
  // main links it, so the review lists it under Prepared documents when the person comes back.
  const handleLettersChanged = useCallback(() => {
    if (letterReturnAttemptId) {
      void window.applicationPipeline?.attachLetter(letterReturnAttemptId).catch(() => {});
    }
    void refreshCounts();
  }, [letterReturnAttemptId, refreshCounts]);

  const handleBackToVacancy = useCallback((vacancy: SelectedVacancy) => {
    hasNavigatedRef.current = true;
    if (letterReturnAttemptId) {
      setApplicationAttemptToOpen(letterReturnAttemptId);
      setLetterReturnAttemptId(null);
      setNav('applications');
      void window.workspace?.updateSettings({ lastOpenedPage: 'applications' }).catch(() => {});
      void refreshCounts();
      return;
    }
    setSearchSession((current) => ({ ...current, selectedKey: vacancy.key ?? current.selectedKey }));
    setNav('search');
    void window.workspace?.updateSettings({ lastOpenedPage: 'search' }).catch(() => {});
    void refreshCounts();
  }, [letterReturnAttemptId, refreshCounts]);

  const handleViewApplicationAttempt = useCallback((attemptId: string) => {
    hasNavigatedRef.current = true;
    setApplicationAttemptToOpen(attemptId);
    setNav('applications');
    void window.workspace?.updateSettings({ lastOpenedPage: 'applications' }).catch(() => {});
    void refreshCounts();
  }, [refreshCounts]);

  const handleCancelScheduledSend = useCallback(
    async (attempt: ApplicationAttemptRecord): Promise<CancelScheduledOutcome> => {
      try {
        await window.applicationExecutor.cancelScheduledAutomaticSubmission(attempt.id);
        // Confirmed against the stored attempt, not assumed: the cancel is a no-op once the
        // deadline has passed, and the person must be told what really happened.
        const fresh = await window.workspace.getApplicationAttempt(attempt.id);
        await refreshCounts();
        if (fresh.scheduledAutomaticSubmitAt === null && fresh.checkpoint === 'ready') return { status: 'cancelled' };
        return { status: 'too_late', checkpoint: fresh.checkpoint };
      } catch {
        void refreshCounts();
        return { status: 'failed' };
      }
    },
    [refreshCounts],
  );

  const handleToggleSidebar = useCallback(() => {
    if (railForced) {
      // The rail is not a saved preference, so toggling it opens the overlay and writes nothing.
      setSidebarOverlayOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((previous) => {
      const next = !previous;
      void window.workspace?.updateSettings({ sidebarCollapsed: next }).catch(() => {});
      return next;
    });
  }, [railForced]);

  useEffect(() => {
    let cancelled = false;

    window.agentDock.getDaemonStatus().then((status) => {
      if (cancelled) return;
      if (status.state === 'ready') setDaemonState('ready');
      else if (status.state === 'unavailable') {
        setDaemonState('unavailable');
        setDaemonError(status.error);
      }
    });

    const unsubscribeStatus = window.agentDock.onDaemonStatus((status) => {
      setDaemonState(status.state);
      setDaemonError(status.state === 'unavailable' ? status.error : undefined);
      if (status.state === 'ready') setDaemonRetryFailed(false);
    });

    const timeout = setTimeout(() => {
      setDaemonState((current) => (current === 'connecting' ? 'unavailable' : current));
      setDaemonError((current) => current ?? 'timed out waiting for the AI helper to start');
    }, DAEMON_CONNECT_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      unsubscribeStatus();
    };
  }, []);

  const handleRetryDaemon = useCallback(() => {
    setDaemonRetrying(true);
    setDaemonRetryFailed(false);
    window.agentDock
      .restartDaemon()
      .then((status) => {
        setDaemonState(status.state);
        if (status.state === 'unavailable') {
          setDaemonError(status.error);
          setDaemonRetryFailed(true);
        } else {
          setDaemonError(undefined);
        }
      })
      .catch((err: unknown) => {
        setDaemonState('unavailable');
        setDaemonError(err instanceof Error ? err.message : 'restart failed');
        setDaemonRetryFailed(true);
      })
      .finally(() => setDaemonRetrying(false));
  }, []);

  // Mirrors daemonState directly while the daemon itself isn't ready (there's nothing more
  // specific to say yet); once it is, checks the actual selected provider's real install/auth
  // status instead of assuming "daemon up" means "AI features work". Re-runs whenever the
  // provider changes (RuntimePage can change it without a page reload) so this doesn't go stale.
  useEffect(() => {
    if (daemonState !== 'ready') {
      setProviderRuntimeState(daemonState);
      return;
    }
    let cancelled = false;
    window.agentDock
      .listProviders()
      .then((providers) => {
        if (cancelled) return;
        const status = providers.find((p) => p.id === defaultProvider);
        if (!status?.installed) setProviderRuntimeState('not-installed');
        else if (status.authenticated !== 'authenticated') setProviderRuntimeState('not-authenticated');
        else setProviderRuntimeState('ready');
      })
      .catch(() => {
        if (!cancelled) setProviderRuntimeState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [daemonState, defaultProvider]);

  // The job search engine's live health, so the sidebar says so when scans cannot run even though
  // the AI runtime is fine (#477). Read at start-up, then every 20 s while the window is visible.
  const engineHealth = useEngineHealth();
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const status = await window.vacancyRadar.getStatus();
        if (!cancelled) publishEngineHealth(status);
      } catch {
        // No reading leaves the last one in place rather than inventing a failure.
      }
    };
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, ENGINE_HEALTH_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // A provider that answered "usage limit" is not ready, whatever its install and sign-in say (#461).
  const providerLimits = useProviderLimits();
  const providerInUse = useProviderOverride() ?? defaultProvider;
  const providerLimited = providerLimits.has(providerInUse) && activeProviderLimit(providerInUse) !== undefined;
  const shownRuntimeState: RuntimeState =
    providerRuntimeState === 'ready' && providerLimited ? 'limit-reached' : providerRuntimeState;

  const { title, subtitle } = headerCopy(nav, counts);

  return (
    <LiveAnnouncerProvider>
    <SupportPromptProvider page={nav} welcomeOpen={showWelcome}>
    <div className="flex h-screen overflow-clip font-sans text-base text-base-content">
      <AppSidebar
        active={nav}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed || railForced}
        onToggleCollapsed={handleToggleSidebar}
        counts={counts}
        runtimeLabel={PROVIDER_LABEL[providerInUse]}
        runtimeState={shownRuntimeState}
        engine={engineHealth}
      />

      {/* The full sidebar over the content at narrow widths, without taking width from it (#451).
          The rail stays in the layout; this is drawn above it and closes on Escape, on the dimmed
          area, or after choosing a page. */}
      {railForced && sidebarOverlayOpen && (
        <Dialog
          aria-label="Main navigation"
          placement="start"
          boxClassName="h-full max-h-none w-auto max-w-none rounded-none p-0"
          onClose={() => setSidebarOverlayOpen(false)}
        >
          <AppSidebar
            active={nav}
            onNavigate={(page) => {
              setSidebarOverlayOpen(false);
              handleNavigate(page);
            }}
            collapsed={false}
            onToggleCollapsed={() => setSidebarOverlayOpen(false)}
            counts={counts}
            runtimeLabel={PROVIDER_LABEL[providerInUse]}
            runtimeState={shownRuntimeState}
            engine={engineHealth}
          />
        </Dialog>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader title={title} subtitle={subtitle} />

        <ScheduledSendBanner
          attempts={scheduledSends}
          onReview={handleViewApplicationAttempt}
          onCancel={handleCancelScheduledSend}
        />

        <main
          className={`min-h-0 flex-1 ${nav === 'search' ? 'pb-2 pt-4' : 'py-6'} ${
            nav === 'search' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto px-6'
          }`}
        >
          {/* Helper state is app-wide, so its notice lives outside the page switch. The failure notice
              only shows where AI work happens (the sidebar status covers every page, and the AI
              Runtime page renders its own), so Applications and CV stay free of a red bar. */}
          <div className={nav === 'search' ? 'px-6' : undefined}>
            {daemonState === 'connecting' && !daemonRetrying && (
              <div className="alert alert-info mb-5">Starting the AI helper…</div>
            )}
            {(daemonState === 'unavailable' || daemonRetrying) && AI_HELPER_NOTICE_PAGES.includes(nav) && (
              <AiHelperNotice
                className="mb-5"
                {...(daemonError ? { error: daemonError } : {})}
                retrying={daemonRetrying}
                retryFailed={daemonRetryFailed}
                onRetry={handleRetryDaemon}
              />
            )}
          </div>

          {nav === 'search' && (
            <SearchPage
              onOpenSearchProfile={handleOpenSearchProfile}
              onSavedJobsChanged={refreshCounts}
              onViewApplicationAttempt={handleViewApplicationAttempt}
              session={searchSession}
              onSessionChange={setSearchSession}
              handoff={searchHandoff}
              companyList={companyList}
            />
          )}
          {nav === 'saved' && (
            <SavedJobsPage
              onSavedJobsChanged={refreshCounts}
              onViewApplicationAttempt={handleViewApplicationAttempt}
            />
          )}
          {nav === 'applications' && (
            <ApplicationsPage
              onApplicationsChanged={refreshCounts}
              focusAttemptId={applicationAttemptToOpen}
              onFocusAttemptConsumed={() => setApplicationAttemptToOpen(null)}
              onGenerateLetter={handleGenerateApplicationLetter}
              onGoToSavedJobs={() => handleNavigate('saved')}
            />
          )}
          {nav === 'cv' && <CvLibraryPage />}
          {nav === 'letters' && (
            <LettersPage
              vacancy={pendingVacancy}
              openOnGenerator={pendingVacancy !== null}
              onVacancyConsumed={handleVacancyConsumed}
              onLettersChanged={handleLettersChanged}
              onBackToVacancy={handleBackToVacancy}
              onOpenCvPage={() => handleNavigate('cv')}
            />
          )}
          {nav === 'settings' && (
            <SettingsPage
              key={settingsTargetKey}
              onNavigateToRuntime={() => handleNavigate('runtime')}
              onOpenSetup={() => setShowSetup(true)}
              onOpenCvPage={() => handleNavigate('cv')}
              currentPage={nav}
              {...(previousNav ? { previousPage: previousNav } : {})}
              {...(settingsTarget ? { initialTab: settingsTarget.tab } : {})}
              {...(settingsTarget?.focusSection ? { focusSection: settingsTarget.focusSection } : {})}
            />
          )}

          {/* ADI-07. Mounted only while it is the active page, which is what makes the hook's
              unmount cleanup meaningful: leaving the page detaches every live relay in main rather
              than leaving SSE streams open behind a screen nobody is looking at. */}
          {nav === 'agent-workspace' && <AgentWorkspacePage defaultProvider={defaultProvider} />}

          {nav === 'runtime' && (
            <RuntimePage
              daemonState={daemonState}
              {...(daemonError ? { daemonError } : {})}
              helperRetrying={daemonRetrying}
              helperRetryFailed={daemonRetryFailed}
              onRetryHelper={handleRetryDaemon}
              onDefaultProviderChanged={setDefaultProvider}
            />
          )}
        </main>
      </div>

      {/* Overlays whichever page happens to be showing, the way FillProfileFromCvDrawer overlays
          Settings: the gate above decides *whether* it appears, never which page it appears over. */}
      {showSetup && !showWelcome && (
        <WelcomeModal
          reopened
          onClose={() => setShowSetup(false)}
          onOpenSettings={() => {
            setShowSetup(false);
            handleOpenSearchProfile();
          }}
          onOpenRuntime={() => {
            setShowSetup(false);
            handleNavigate('runtime');
          }}
        />
      )}
      {showWelcome && (
        <WelcomeModal
          onClose={handleWelcomeDone}
          onOpenSettings={() => {
            handleWelcomeClosed();
            handleOpenSearchProfile();
          }}
          onOpenRuntime={() => {
            handleWelcomeClosed();
            handleNavigate('runtime');
          }}
        />
      )}
    </div>
    </SupportPromptProvider>
    </LiveAnnouncerProvider>
  );
}
