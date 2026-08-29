import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { ProviderPanel } from './components/ProviderPanel.js';
import { EventLog } from './components/EventLog.js';
import { VacancyLeadsPanel } from './components/vacancies/index.js';
import { CvAssistant } from './components/cv/index.js';

type DaemonState = 'connecting' | 'ready' | 'unavailable';
type RunStatus = 'idle' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

const DAEMON_CONNECT_TIMEOUT_MS = 20_000;

// Monochrome status styling: state is conveyed via contrast/weight/borders, never hue
// (see DESIGN-TOKENS.md). Solid black = terminal success, heavy outline = failure,
// reduced opacity = muted/inactive.
const RUN_STATUS_BADGE_CLASS: Record<RunStatus, string> = {
  idle: 'badge badge-ghost font-mono align-middle',
  starting: 'badge badge-outline font-mono align-middle',
  running: 'badge badge-outline font-mono align-middle',
  completed: 'badge badge-neutral font-mono align-middle',
  failed: 'badge badge-outline border-2 font-mono font-bold align-middle',
  cancelled: 'badge badge-ghost font-mono align-middle opacity-60',
};

export function App() {
  const [daemonState, setDaemonState] = useState<DaemonState>('connecting');
  const [daemonError, setDaemonError] = useState<string>();

  const [selectedVacancy, setSelectedVacancy] = useState<DiscoveryVacancyAudit | null>(null);

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

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 font-sans text-base text-base-content">
      <h1 className="text-2xl font-bold tracking-tight">OpenVacancyRadar</h1>
      <p className="mt-1 text-sm text-base-content/60">Deterministic vacancy leads, plus CLI-authenticated AI assistance — no API key required</p>

      <section className="mt-8 border-t border-base-300 pt-5">
        <VacancyLeadsPanel onSelectVacancy={setSelectedVacancy} selectedVacancyKey={selectedVacancy?.key} />
      </section>

      <section className="mt-8 border-t border-base-300 pt-5">
        {selectedVacancy ? (
          <CvAssistant vacancy={selectedVacancy} />
        ) : (
          <div className="rounded-box border border-base-300 p-6 text-center text-sm text-base-content/60">
            Pick "Use for AI" on a vacancy above to run gap analysis or generate a cover letter for it.
          </div>
        )}
      </section>

      {daemonState === 'connecting' && <div className="alert alert-info mt-6">Connecting to local daemon…</div>}
      {daemonState === 'unavailable' && (
        <div className="alert alert-error mt-6">Daemon unavailable: {daemonError ?? 'unknown error'}</div>
      )}

      {daemonState === 'ready' && (
        <>
          <section className="mt-8 border-t border-base-300 pt-5">
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
  );
}
