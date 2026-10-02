import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type { WorkspaceCounts } from './window.js';
import { PROVIDER_LABEL } from './provider-labels.js';
import { SearchPage, createSearchSessionState } from './components/search/index.js';
import { SavedJobsPage } from './components/saved/index.js';
import { ApplicationsPage } from './components/applications/index.js';
import { CvLibraryPage } from './components/cv-library/index.js';
import { LettersPage, type SelectedVacancy } from './components/letters/index.js';
import { RuntimePage } from './components/runtime/index.js';
import { SettingsPage, type SettingsFocusSection, type SettingsTab } from './components/settings/index.js';
import { AgentWorkspacePage } from './components/agent-workspace/index.js';
import { WelcomeModal } from './components/WelcomeModal.js';
import {
  AI_HELPER_NOTICE_PAGES,
  AiHelperNotice,
  AppSidebar,
  WorkspaceHeader,
  headerCopy,
  isNavPage,
  type NavPage,
  type RuntimeState,
} from './components/shell/index.js';
import { applyDensity, applyTheme } from './theme.js';

type DaemonState = 'connecting' | 'ready' | 'unavailable';

const DAEMON_CONNECT_TIMEOUT_MS = 20_000;

export function App() {
  const [nav, setNav] = useState<NavPage>('search');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // `undefined` until the first successful fetch (issue #178): rendering a zeroed WorkspaceCounts
  // here made "not loaded yet" and "genuinely zero" the same badge/subtitle, indistinguishably.
  const [counts, setCounts] = useState<WorkspaceCounts | undefined>(undefined);

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
  const [searchSession, setSearchSession] = useState(createSearchSessionState);
  const [applicationAttemptToOpen, setApplicationAttemptToOpen] = useState<string | null>(null);
  const [letterReturnAttemptId, setLetterReturnAttemptId] = useState<string | null>(null);

  // The first-launch CV nudge. Off until settings hydration proves both halves of the gate: the
  // flag has never been set, *and* the CV library is actually empty. Anything less would flash a
  // "welcome, upload a CV" modal at an upgrading user who has had one in the library for months.
  const [showWelcome, setShowWelcome] = useState(false);

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

  const refreshCounts = useCallback(async () => {
    try {
      const fresh = await window.workspace.getCounts();
      setCounts(fresh);
    } catch {
      // Leaves `counts` exactly as it was (undefined if never loaded, otherwise the last successful
      // fetch) rather than resetting to a fabricated zero -- not worth an error banner over the
      // whole app, but also not worth lying about a count that just hasn't refreshed.
    }
  }, []);

  useEffect(() => {
    void refreshCounts();
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
  }, [handleNavigate]);

  // The Search page's "Generate Letter" action: distinct from `handleNavigate` because it needs to
  // set `pendingVacancy` *and* navigate in the same step, without that navigation's own
  // stale-handoff guard immediately wiping out the vacancy it just set.
  const handleGenerateLetter = useCallback((vacancy: SelectedVacancy) => {
    hasNavigatedRef.current = true;
    setPendingVacancy(vacancy);
    setLetterReturnAttemptId(null);
    setSearchSession((current) => ({ ...current, selectedKey: vacancy.key ?? current.selectedKey }));
    setNav('letters');
    void window.workspace?.updateSettings({ lastOpenedPage: 'letters' }).catch(() => {});
    void refreshCounts();
  }, [refreshCounts]);

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

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((previous) => {
      const next = !previous;
      void window.workspace?.updateSettings({ sidebarCollapsed: next }).catch(() => {});
      return next;
    });
  }, []);

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

  const { title, subtitle } = headerCopy(nav, counts);

  return (
    <div className="flex h-screen overflow-hidden font-sans text-base text-base-content">
      <AppSidebar
        active={nav}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={handleToggleSidebar}
        counts={counts}
        runtimeLabel={PROVIDER_LABEL[defaultProvider]}
        runtimeState={providerRuntimeState}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader title={title} subtitle={subtitle} />

        <main
          className={`min-h-0 flex-1 py-6 ${
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
              onGenerateLetter={handleGenerateLetter}
              onOpenSearchProfile={handleOpenSearchProfile}
              onSavedJobsChanged={refreshCounts}
              onViewApplicationAttempt={handleViewApplicationAttempt}
              session={searchSession}
              onSessionChange={setSearchSession}
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
            />
          )}
          {nav === 'cv' && <CvLibraryPage />}
          {nav === 'letters' && (
            <LettersPage
              vacancy={pendingVacancy}
              openOnGenerator={pendingVacancy !== null}
              onVacancyConsumed={handleVacancyConsumed}
              onLettersChanged={refreshCounts}
              onBackToVacancy={handleBackToVacancy}
            />
          )}
          {nav === 'settings' && (
            <SettingsPage
              onNavigateToRuntime={() => handleNavigate('runtime')}
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
      {showWelcome && (
        <WelcomeModal
          onClose={handleWelcomeClosed}
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
  );
}
