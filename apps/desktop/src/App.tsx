import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type { WorkspaceCounts } from './window.js';
import { PROVIDER_LABEL } from './provider-labels.js';
import { SearchPage } from './components/search/index.js';
import { SavedJobsPage } from './components/saved/index.js';
import { ApplicationsPage } from './components/applications/index.js';
import { CvLibraryPage } from './components/cv-library/index.js';
import { LettersPage } from './components/letters/index.js';
import { RuntimePage } from './components/runtime/index.js';
import { SettingsPage } from './components/settings/index.js';
import { AgentWorkspacePage } from './components/agent-workspace/index.js';
import {
  AppSidebar,
  EMPTY_COUNTS,
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
  const [counts, setCounts] = useState<WorkspaceCounts>(EMPTY_COUNTS);

  const [daemonState, setDaemonState] = useState<DaemonState>('connecting');
  const [daemonError, setDaemonError] = useState<string>();

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
      } catch {
        // defaults already applied by useState
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCounts = useCallback(async () => {
    try {
      const fresh = await window.workspace.getCounts();
      setCounts(fresh);
    } catch {
      // badges stay at zero; not worth an error banner over the whole app
    }
  }, []);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  const handleNavigate = useCallback((page: NavPage) => {
    hasNavigatedRef.current = true;
    setNav(page);
    // Fire and forget: remembering the page is a convenience, and a write failure must not block
    // (or fail) the navigation the user just asked for.
    void window.workspace?.updateSettings({ lastOpenedPage: page }).catch(() => {});
    // Cheap re-sync for the sidebar's badge counts: whichever page the user is leaving may have
    // just changed saved jobs/applications/letters, and there's no per-page mutation callback for
    // three of the five pages, so refreshing on every navigation is simpler than wiring one to each.
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
    });

    const timeout = setTimeout(() => {
      setDaemonState((current) => (current === 'connecting' ? 'unavailable' : current));
      setDaemonError((current) => current ?? 'timed out waiting for the local daemon to start');
    }, DAEMON_CONNECT_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      unsubscribeStatus();
    };
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

        <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {/* Daemon state is app-wide, so its banner lives outside the page switch: whichever
              destination you are on, "the CLI runtime is not running" is worth knowing. */}
          {daemonState === 'connecting' && <div className="alert alert-info mb-5">Connecting to local daemon…</div>}
          {daemonState === 'unavailable' && (
            <div className="alert alert-error alert-soft mb-5">Daemon unavailable: {daemonError ?? 'unknown error'}</div>
          )}

          {nav === 'search' && <SearchPage />}
          {nav === 'saved' && <SavedJobsPage />}
          {nav === 'applications' && <ApplicationsPage />}
          {nav === 'cv' && <CvLibraryPage />}
          {nav === 'letters' && <LettersPage onLettersChanged={refreshCounts} />}
          {nav === 'settings' && <SettingsPage onNavigateToRuntime={() => handleNavigate('runtime')} />}

          {/* ADI-07. Mounted only while it is the active page, which is what makes the hook's
              unmount cleanup meaningful: leaving the page detaches every live relay in main rather
              than leaving SSE streams open behind a screen nobody is looking at. */}
          {nav === 'agent-workspace' && <AgentWorkspacePage defaultProvider={defaultProvider} />}

          {nav === 'runtime' && (
            <RuntimePage
              daemonState={daemonState}
              {...(daemonError ? { daemonError } : {})}
              onDefaultProviderChanged={setDefaultProvider}
            />
          )}
        </main>
      </div>
    </div>
  );
}
