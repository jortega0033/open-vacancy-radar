import { useState } from 'react';
import type { BlindApplyEnableResult } from '../../../electron/blind-apply-types.js';
import { useBlindApply } from '../applications/use-blind-apply.js';
import { SettingsRow, SettingsSection } from './controls.js';

const REFUSAL_COPY: Record<Extract<BlindApplyEnableResult, { ok: false }>['reason'], string> = {
  declined: '',
  no_cv: 'Add a CV first.',
  no_profile: 'Set up what you are looking for (at least one target role) first.',
  no_role_family: 'There is no role family to confirm.',
};

/**
 * Turns Blind Apply on or off (#722). "Turn on" only asks the app to show its own confirmation; the
 * filters, CV and wording in that confirmation are chosen and shown by the app, never by this page.
 * There is no number, limit or schedule to set, because there is none.
 */
export function BlindApplySection({ disabled }: { disabled?: boolean }) {
  const { status, refresh } = useBlindApply();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  if (!status) return null;

  async function enable(): Promise<void> {
    setBusy(true);
    setMessage('');
    const result = await window.blindApply.enable().catch(() => ({ ok: false as const, reason: 'declined' as const }));
    setBusy(false);
    if (!result.ok) setMessage(REFUSAL_COPY[result.reason]);
    await refresh();
  }

  async function stop(): Promise<void> {
    setBusy(true);
    await window.blindApply.stop().catch(() => undefined);
    setBusy(false);
    await refresh();
  }

  const supported =
    status.supported.real.length > 0
      ? `Sends to: ${status.supported.real.join(', ')}.`
      : 'Supported now: none (test form only). Everything else stays "Apply yourself".';

  return (
    <SettingsSection title="Blind Apply">
      <SettingsRow
        label="Apply to frontend roles without reviewing each one"
        description={
          <>
            Once you confirm it, matching roles are checked, prepared from your CV and profile, and sent without asking about each one. It
            never invents an answer, ticks a consent box, or passes a bot check or sign-in, and it skips closed roles and ones you already
            applied to. There is no daily limit. {supported}
          </>
        }
      >
        {status.active ? (
          <button type="button" className="btn btn-sm btn-error" onClick={() => void stop()} disabled={busy}>
            Stop Blind Apply
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-outline" onClick={() => void enable()} disabled={busy || disabled}>
            Turn on…
          </button>
        )}
      </SettingsRow>
      {status.authorization && (
        <div className="py-2 text-xs text-base-content/70" role="status">
          On since {new Date(status.authorization.createdAt).toLocaleString()}
          {status.authorization.cvName ? `, using ${status.authorization.cvName}` : ''}.
          {status.authorization.filters.length > 0 && <> Filters: {status.authorization.filters.join('; ')}.</>}
        </div>
      )}
      {message && (
        <p role="alert" className="py-2 text-sm text-error">
          {message}
        </p>
      )}
    </SettingsSection>
  );
}
