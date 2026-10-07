import { useCallback, useEffect, useState } from 'react';
import type { SourceScoutOutcome, SourceScoutStatus } from '../../../electron/source-scout-types.js';
import { SettingsRow, SettingsSection, ToggleSwitch } from './controls.js';

export interface SourceScoutSectionProps {
  /** The saved `autoSourceScoutEnabled` setting. */
  enabled: boolean;
  disabled?: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

const STATUS_POLL_MS = 5000;

function formatTime(iso: string | null): string {
  if (iso === null) return 'Not yet';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'Not yet';
  return parsed.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function describeOutcome(outcome: SourceScoutOutcome | null): string {
  if (outcome === null) return 'No runs yet.';
  const counters = outcome.counters;
  const numbers = counters
    ? ` ${plural(counters.attempted, 'company checked', 'companies checked')}, ${counters.newlyVerified.toLocaleString()} new, ${counters.empty.toLocaleString()} empty, ${counters.blocked.toLocaleString()} blocked, ${counters.failed.toLocaleString()} failed.`
    : '';
  switch (outcome.kind) {
    case 'completed':
      return `Finished.${numbers}`;
    case 'limit_reached':
      return `Stopped at the run limit.${numbers}`;
    case 'nothing_due':
      return 'Nothing to check yet.';
    case 'no_roster':
      return 'No company list yet. Update it under Company list.';
    case 'no_profile':
      return 'Skipped. Save a role or keyword first.';
    case 'busy':
      return 'Skipped. A search was running.';
    case 'cancelled':
      return `Stopped early.${numbers}`;
    case 'failed':
      return 'The last run failed. It will try again later.';
  }
}

/**
 * Opt-in background company discovery (#348). Runs only while the app is open or in the tray, which
 * the copy says plainly. Status is read from the main process; it never starts network work itself.
 */
export function SourceScoutSection({ enabled, disabled, onEnabledChange }: SourceScoutSectionProps) {
  const [status, setStatus] = useState<SourceScoutStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.vacancyRadar.getSourceScoutStatus());
    } catch {
      // Keep whatever is already shown; the next poll tries again.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, enabled]);

  const running = status?.running === true;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const runNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.vacancyRadar.runSourceScoutNow();
      if (!result.started) {
        setMessage(result.reason === 'running' ? 'Already running.' : 'Turn this on first.');
      }
    } catch {
      setMessage('Could not start the run.');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const togglePaused = async () => {
    if (!status) return;
    setBusy(true);
    setMessage(null);
    try {
      setStatus(await window.vacancyRadar.setSourceScoutPaused(!status.paused));
    } catch {
      setMessage('Could not change this.');
    } finally {
      setBusy(false);
    }
  };

  const noProfile = status !== null && !status.hasProfile;

  return (
    <SettingsSection title="Company discovery">
      <SettingsRow
        label="Look for new companies in the background"
        description="Runs only while Open Vacancy Radar is open or in the tray."
      >
        <ToggleSwitch
          label="Look for new companies in the background"
          checked={enabled}
          disabled={disabled}
          onChange={onEnabledChange}
        />
      </SettingsRow>
      {enabled && (
        <>
          {noProfile && (
            <SettingsRow label="Needs a role" description="Add a role or keyword under What you are looking for to start." />
          )}
          <SettingsRow
            label="Schedule"
            description={
              status === null
                ? 'Loading.'
                : `Last run: ${formatTime(status.lastRunAt)}. Next run: ${
                    status.paused ? 'Paused' : formatTime(status.nextRunAt)
                  }.`
            }
          >
            <span className="inline-flex gap-2">
              <button
                type="button"
                className="btn btn-sm btn-outline"
                disabled={disabled || busy || running || status === null || noProfile}
                onClick={() => void runNow()}
              >
                {running ? 'Running…' : 'Run now'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-outline"
                disabled={disabled || busy || status === null}
                onClick={() => void togglePaused()}
              >
                {status?.paused ? 'Resume' : 'Pause'}
              </button>
            </span>
          </SettingsRow>
          <SettingsRow label="Last result" description={message ?? describeOutcome(status?.lastOutcome ?? null)} />
        </>
      )}
    </SettingsSection>
  );
}
