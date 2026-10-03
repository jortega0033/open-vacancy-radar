import type { AtsRosterImportResult } from '@open-vacancy-radar/vacancy-engine';
import { SettingsRow, SettingsSection } from './controls.js';
import { useAtsRoster } from './useAtsRoster.js';

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
  onRefreshError: (message: string, details?: string) => void;
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
  const { status, loadError, refreshing, refresh } = useAtsRoster({ onRefreshed, onRefreshError });

  const description = loadError
    ? loadError
    : status
      ? `Updated ${formatImportedAt(status.importedAt)}, ${status.totalEntries.toLocaleString()} companies.`
      : 'Download the company list once so searches can find these companies.';

  return (
    <SettingsSection title="Company list">
      <SettingsRow
        label="Companies to search"
        description={description}
      >
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={disabled || refreshing}
          onClick={refresh}
        >
          {refreshing ? 'Updating…' : 'Update company list'}
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}
