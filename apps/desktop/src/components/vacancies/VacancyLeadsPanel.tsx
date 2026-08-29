import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiscoveryVacancyAudit, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { RoleSearchBox } from './RoleSearchBox.js';
import { VacancyList } from './VacancyList.js';

type EngineState = 'checking' | 'ready' | 'unavailable';
type ScanState = 'idle' | 'scanning' | 'failed';

export interface VacancyLeadsPanelProps {
  /** Optional: when provided, each card gets a "Use for AI" button that reports the picked
   * vacancy up to a parent (e.g. to feed the CV assistant's gap-analysis/cover-letter features). */
  onSelectVacancy?: (vacancy: DiscoveryVacancyAudit) => void;
  /** The `key` of the currently-selected vacancy, if any, so its card can render as selected. */
  selectedVacancyKey?: string;
}

/**
 * Top-level "Vacancy Leads" screen. Owns the whole lifecycle against the `window.vacancyRadar`
 * bridge: engine readiness, hydrating the last report on mount (without forcing a fresh scan),
 * running a new scan on demand, and a client-side title filter over whatever report is loaded.
 */
export function VacancyLeadsPanel({ onSelectVacancy, selectedVacancyKey }: VacancyLeadsPanelProps = {}) {
  const [engineState, setEngineState] = useState<EngineState>('checking');
  const [engineError, setEngineError] = useState<string>();

  const [report, setReport] = useState<GlobalRemoteReport | null>(null);
  const [loadError, setLoadError] = useState<string>();

  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanError, setScanError] = useState<string>();

  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      try {
        const status = await window.vacancyRadar.getStatus();
        if (cancelled) return;
        if (!status.ready) {
          setEngineState('unavailable');
          setEngineError(status.error ?? 'vacancy engine is not ready');
          return;
        }
        setEngineState('ready');

        const existing = await window.vacancyRadar.getReport();
        if (cancelled) return;
        setReport(existing);
      } catch (err) {
        if (cancelled) return;
        setEngineState('unavailable');
        setEngineError(err instanceof Error ? err.message : 'failed to reach the vacancy engine');
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRunScan = useCallback(async () => {
    setScanState('scanning');
    setScanError(undefined);
    setLoadError(undefined);
    try {
      const fresh = await window.vacancyRadar.runScan();
      setReport(fresh);
      setScanState('idle');
    } catch (err) {
      setScanState('failed');
      setScanError(err instanceof Error ? err.message : 'scan failed');
    }
  }, []);

  const vacancies = report?.discoveryAudit ?? [];
  const filteredVacancies = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return vacancies;
    return vacancies.filter((vacancy) => vacancy.title.toLowerCase().includes(needle));
  }, [vacancies, query]);

  const isScanning = scanState === 'scanning';

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Vacancy leads</h2>
          {report && (
            <p className="mt-1 text-sm text-base-content/60">
              {vacancies.length} discovered · run {report.runId} · generated{' '}
              {new Date(report.generatedAt).toLocaleString()}
            </p>
          )}
        </div>
        <button
          className="btn btn-primary"
          type="button"
          onClick={handleRunScan}
          disabled={engineState !== 'ready' || isScanning}
        >
          {isScanning ? 'Scanning…' : 'Run scan'}
        </button>
      </div>

      {engineState === 'checking' && (
        <div className="alert alert-info mt-4">Checking vacancy engine status…</div>
      )}
      {engineState === 'unavailable' && (
        <div className="alert alert-error mt-4">Vacancy engine unavailable: {engineError ?? 'unknown error'}</div>
      )}

      {isScanning && (
        <div className="alert alert-info mt-4">
          Scanning live job sources — this hits real external APIs and feeds, and can take
          anywhere from about ten seconds up to a couple of minutes. The app is not frozen.
        </div>
      )}
      {scanState === 'failed' && (
        <div className="alert alert-error mt-4">Scan failed: {scanError ?? 'unknown error'}</div>
      )}
      {loadError && <div className="alert alert-error mt-4">{loadError}</div>}

      {engineState === 'ready' && !report && !isScanning && (
        <div className="rounded-box mt-4 border border-base-300 p-6 text-center text-sm text-base-content/60">
          No scan has been run yet in this session. Use "Run scan" above to discover vacancies.
        </div>
      )}

      {report && (
        <div className="mt-4">
          <RoleSearchBox value={query} onChange={setQuery} disabled={isScanning} />
          <VacancyList
            vacancies={filteredVacancies}
            hasUnfilteredResults={vacancies.length > 0}
            onSelect={onSelectVacancy}
            selectedKey={selectedVacancyKey}
          />
        </div>
      )}
    </div>
  );
}
