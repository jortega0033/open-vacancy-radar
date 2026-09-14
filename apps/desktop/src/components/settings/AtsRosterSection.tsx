import { useCallback, useEffect, useState } from 'react';
import type { AtsRosterImportResult, AtsRosterStatus } from '@open-vacancy-radar/vacancy-engine';
import { SettingsRow, SettingsSection } from './controls.js';

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function formatImportedAt(importedAt: string): string {
  const parsed = new Date(importedAt);
  if (Number.isNaN(parsed.getTime())) return importedAt;
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export interface AtsRosterSectionProps {
  disabled?: boolean;
  /** Reports a successful refresh upward so `SettingsPage` can show it through its one shared
   * toast instance, the same reason `SearchProfileSection` reports through `onSaved` rather than
   * rendering a second toast of its own. */
  onRefreshed: (result: AtsRosterImportResult) => void;
  onRefreshError: (message: string) => void;
}

/**
 * The missing trigger for issue #251/#264's ATS-roster scan: `runAtsRosterDiscovery` reads a
 * roster file that, until this section existed, only the CLI-only `ats-roster:import` command ever
 * wrote -- so a real user's vacancy scan always found zero Greenhouse/Lever/Ashby/Recruitee/Personio
 * companies. This is a manual, clearly-labeled action rather than an automatic background fetch:
 * the import step itself is documented as "re-runnable on a deliberate refresh cadence, not a live
 * fetch at scan time" (see `pipeline/ats-roster-import.ts`), and it reaches a third-party origin
 * directly rather than one of the app's own vacancy sources, so it gets the same "the user asks for
 * it, and sees an honest status" treatment as the rest of this page's data-management actions
 * instead of a new always-on timer.
 */
export function AtsRosterSection({ disabled, onRefreshed, onRefreshError }: AtsRosterSectionProps) {
  const [status, setStatus] = useState<AtsRosterStatus>(null);
  const [loadError, setLoadError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.vacancyRadar.getAtsRosterStatus();
        if (!cancelled) setStatus(loaded);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load the company roster status'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setLoadError(undefined);
    void (async () => {
      try {
        const result = await window.vacancyRadar.refreshAtsRoster();
        setStatus({
          importedAt: result.importedAt,
          totalEntries: result.totalEntries,
          sourceCounts: Object.fromEntries(
            result.providers.map((provider) => [provider.provider, provider.importedCount]),
          ),
        });
        onRefreshed(result);
      } catch (err) {
        onRefreshError(describeError(err, 'could not refresh the company roster'));
      } finally {
        setRefreshing(false);
      }
    })();
  }, [onRefreshed, onRefreshError]);

  const description = loadError
    ? loadError
    : status
      ? `Last refreshed ${formatImportedAt(status.importedAt)} · ${status.totalEntries.toLocaleString()} companies across Greenhouse, Lever, Ashby, Recruitee and Personio.`
      : 'Not yet imported. Vacancy scans will find zero companies on these five providers until this runs at least once.';

  return (
    <SettingsSection title="Company roster">
      <SettingsRow
        label="Greenhouse / Lever / Ashby / Recruitee / Personio companies"
        description={description}
      >
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={disabled || refreshing}
          onClick={refresh}
        >
          {refreshing ? 'Refreshing…' : 'Refresh company roster'}
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}
