import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { WorkspaceCounts } from './window.js';
import runtimeUnavailableIllustration from '../assets/illustrations/runtime-unavailable.svg?no-inline';
import { ProviderPanel } from './components/ProviderPanel.js';
import { EventLog } from './components/EventLog.js';
import { SearchPage } from './components/search/index.js';
import { SavedJobsPage } from './components/saved/index.js';
import { ApplicationsPage } from './components/applications/index.js';
import { CvLibraryPage } from './components/cv-library/index.js';
import { LettersPage } from './components/letters/index.js';
import { SettingsPage } from './components/settings/index.js';
import {
  AppSidebar,
  EMPTY_COUNTS,
  EmptyState,
  WorkspaceHeader,
  headerCopy,
  isNavPage,
  type NavPage,
} from './components/shell/index.js';
import { applyDensity, applyTheme } from './theme.js';

type DaemonState = 'connecting' | 'ready' | 'unavailable';
type RunStatus = 'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

const DAEMON_CONNECT_TIMEOUT_MS = 20_000;

// Status styling for a run: monochrome by design. A session that finished is not "good" and a
// cancelled one is not "bad" — those are lifecycle states, not outcomes, so they are expressed
// through contrast and weight. The three real state hues in the token set (success/warning/error)
// are reserved for things that genuinely are good or bad; see DESIGN-TOKENS.md.
const RUN_STATUS_BADGE_CLASS: Record<RunStatus, string> = {
  idle: 'badge badge-ghost font-mono align-middle',
  starting: 'badge badge-outline font-mono align-middle',
  running: 'badge badge-outline font-mono align-middle',
  completed: 'badge badge-neutral font-mono align-middle',
  failed: 'badge badge-outline border-2 font-mono font-bold align-middle',
  cancelled: 'badge badge-ghost font-mono align-middle opacity-60',
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export function App() {
  const [nav, setNav] = useState<NavPage>('search');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [counts, setCounts] = useState<WorkspaceCounts>(EMPTY_COUNTS);

  const [daemonState, setDaemonState] = useState<DaemonState>('connecting');
  const [daemonError, setDaemonError] = useState<string>();

  const [providers, setProviders] = useState<ProviderStatus[]>();
  const [providersError, setProvidersError] = useState<string>();

  const [provider, setProvider] = useState<ProviderId>('claude');
  const [model, setModel] = useState<string>('');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [formError, setFormError] = useState<string>();

  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  // Mirrors `sessionId` so the onSessionEvent subscription (set up once, below) always filters
  // against the current session without needing to resubscribe — a stale closure here would
  // silently drop events for a session started after the initial subscription.
  const sessionIdRef = useRef<string>();
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

  useEffect(() => {
    if (daemonState !== 'ready') return;
    window.agentDock
      .listProviders()
      .then(setProviders)
      .catch((err: Error) => setProvidersError(err.message));
  }, [daemonState]);

  // One subscription for the whole component lifetime; events are filtered to the session this
  // render currently cares about. main.ts only ever streams one session at a time in this demo.
  useEffect(() => {
    return window.agentDock.onSessionEvent((eventSessionId, event) => {
      if (sessionIdRef.current !== eventSessionId) return;
      setEvents((prev) => [...prev, event]);
      if (event.type === 'session.completed') setRunStatus('completed');
      else if (event.type === 'session.failed') setRunStatus('failed');
      else if (event.type === 'session.cancelled') setRunStatus('cancelled');
    });
  }, []);

  const handleRun = useCallback(async () => {
    setFormError(undefined);

    if (!cwd.trim()) {
      setFormError('working directory is required');
      return;
    }
    if (!prompt.trim()) {
      setFormError('prompt is required');
      return;
    }

    setEvents([]);
    setRunStatus('starting');

    try {
      const session = await window.agentDock.createSession({
        provider,
        cwd,
        prompt,
        ...(model ? { model } : {}),
      });
      sessionIdRef.current = session.id;
      setSessionId(session.id);
      setRunStatus('running');
    } catch (err) {
      setRunStatus('failed');
      setFormError(err instanceof Error ? err.message : 'failed to start session');
    }
  }, [provider, model, cwd, prompt]);

  const handleCancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await window.agentDock.cancelSession(sessionId);
    } catch {
      // the session-event stream will still reflect the true terminal state
    }
  }, [sessionId]);

  const isRunning = runStatus === 'starting' || runStatus === 'running';
  const selectedProviderStatus = providers?.find((p) => p.id === provider);
  const canRun =
    daemonState === 'ready' &&
    !!selectedProviderStatus?.installed &&
    !isRunning &&
    cwd.trim().length > 0 &&
    prompt.trim().length > 0;

  const { title, subtitle } = headerCopy(nav, counts);

  return (
    <div className="flex h-screen overflow-hidden font-sans text-base text-base-content">
      <AppSidebar
        active={nav}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={handleToggleSidebar}
        counts={counts}
        runtimeLabel={PROVIDER_LABEL[provider]}
        runtimeReady={daemonState === 'ready'}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader
          title={title}
          subtitle={subtitle}
          runtimeLabel={PROVIDER_LABEL[provider]}
          runtimeState={daemonState}
        />

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
          {nav === 'settings' && <SettingsPage />}

          {nav === 'runtime' && (
            <div className="mx-auto max-w-3xl">
              {daemonState === 'unavailable' && (
                <EmptyState
                  illustration={runtimeUnavailableIllustration}
                  title="AI runtime unavailable"
                  description="The local runtime is not available. AI-assisted actions remain disabled until it starts."
                />
              )}
              {daemonState === 'ready' && (
                <>
                  <section>
                    <h2 className="text-lg font-semibold">Providers</h2>
                    {providersError && <div className="alert alert-error mt-3">{providersError}</div>}
                    {providers && <ProviderPanel providers={providers} />}
                  </section>

                  <section className="mt-8 border-t border-base-300 pt-5">
                    <h2 className="text-lg font-semibold">Run</h2>
                    <label className="mt-4 mb-4 block">
                      <span className="mb-1 block text-sm font-medium">Provider</span>
                      <select
                        className="select w-full"
                        value={provider}
                        onChange={(e) => {
                          setProvider(e.target.value as ProviderId);
                          setModel('');
                        }}
                        disabled={isRunning}
                      >
                        <option value="claude">Claude Code</option>
                        <option value="codex">Codex</option>
                      </select>
                    </label>

                    {!!selectedProviderStatus?.availableModels?.length && (
                      <label className="mb-4 block">
                        <span className="mb-1 block text-sm font-medium">Model</span>
                        <select className="select w-full" value={model} onChange={(e) => setModel(e.target.value)} disabled={isRunning}>
                          <option value="">Provider default</option>
                          {selectedProviderStatus.availableModels.map((id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    <label className="mb-4 block">
                      <span className="mb-1 block text-sm font-medium">Working directory</span>
                      <div className="flex items-center gap-2">
                        <input
                          className="input flex-1"
                          type="text"
                          value={cwd}
                          onChange={(e) => setCwd(e.target.value)}
                          placeholder="/path/to/project"
                          disabled={isRunning}
                        />
                        <button
                          className="btn"
                          type="button"
                          disabled={isRunning}
                          onClick={async () => {
                            const dir = await window.agentDock.selectDirectory();
                            if (dir) setCwd(dir);
                          }}
                        >
                          Browse
                        </button>
                      </div>
                    </label>

                    <label className="mb-4 block">
                      <span className="mb-1 block text-sm font-medium">Prompt</span>
                      <textarea
                        className="textarea w-full"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={4}
                        disabled={isRunning}
                      />
                    </label>

                    {formError && <div className="alert alert-error my-3">{formError}</div>}

                    <div className="mt-2 flex items-center gap-2">
                      <button className="btn btn-primary" type="button" onClick={handleRun} disabled={!canRun}>
                        Run
                      </button>
                      <button className="btn btn-outline" type="button" onClick={handleCancel} disabled={runStatus !== 'running'}>
                        Cancel
                      </button>
                    </div>
                  </section>

                  <section className="mt-8 border-t border-base-300 pt-5">
                    <h2 className="text-lg font-semibold">
                      Session status: <span className={RUN_STATUS_BADGE_CLASS[runStatus]}>{runStatus}</span>
                    </h2>
                    <EventLog events={events} />
                  </section>
                </>
              )}
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
