import { X } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { PROVIDER_LABEL } from '../provider-labels.js';
import { CvUploadAction } from './cv-library/CvUploadAction.js';
import { FillProfileFromCvDrawer } from './settings/FillProfileFromCv.js';
import { useAtsRoster } from './settings/useAtsRoster.js';

export interface WelcomeModalProps {
  /**
   * Fired on every way out of this modal: "Skip for now", "Done", the close button and the
   * backdrop. Deliberately one callback rather than several, so the caller has exactly one place to
   * persist `welcomeSeen: true` and cannot mark it on one path and forget another.
   */
  onClose: () => void;
  /** The profile-load failure's "Open Settings": the caller closes the modal and opens Settings on the search profile. */
  onOpenSettings: () => void;
  /** The AI runtime item's "Open AI runtime": the caller closes the modal and opens that page. */
  onOpenRuntime: () => void;
}

type CvStep = 'invite' | 'loading-profile' | 'fill-profile';

type RuntimeCheck =
  | { kind: 'checking' }
  | { kind: 'ready'; provider: ProviderId }
  | { kind: 'not-installed'; provider: ProviderId }
  | { kind: 'not-authenticated'; provider: ProviderId }
  | { kind: 'unreachable' };

/** Live read of the default provider's status, re-run on demand and whenever the AI helper reports
 * ready (it is usually still starting when this modal first opens). */
function useRuntimeCheck() {
  const [check, setCheck] = useState<RuntimeCheck>({ kind: 'checking' });
  const mounted = useRef(true);

  const run = useCallback(async () => {
    setCheck({ kind: 'checking' });
    try {
      const settings = await window.workspace.getSettings().catch(() => undefined);
      const provider = settings?.defaultProvider ?? 'claude';
      const providers = await window.agentDock.listProviders();
      const status = providers.find((p) => p.id === provider);
      let next: RuntimeCheck;
      if (!status?.installed) next = { kind: 'not-installed', provider };
      else if (status.authenticated !== 'authenticated') next = { kind: 'not-authenticated', provider };
      else next = { kind: 'ready', provider };
      if (mounted.current) setCheck(next);
    } catch {
      if (mounted.current) setCheck({ kind: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void run();
    const unsubscribe = window.agentDock.onDaemonStatus((status) => {
      if (status.state === 'ready') void run();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [run]);

  return { check, run };
}

interface ChecklistItemProps {
  title: string;
  /** Short state word shown at the right: "Done", "To do", "Skipped"... Never colour alone. */
  status: string;
  done?: boolean;
  detail: ReactNode;
  skipLabel: string;
  onSkip?: () => void;
  children?: ReactNode;
}

function ChecklistItem({ title, status, done, detail, skipLabel, onSkip, children }: ChecklistItemProps) {
  return (
    <li className="border-b border-base-300 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-base-content/70">{detail}</div>
        </div>
        <span className={`badge badge-sm shrink-0 ${done ? 'badge-success badge-soft' : 'badge-outline'}`}>{status}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {children}
        {onSkip && (
          <button type="button" className="btn btn-ghost btn-xs" aria-label={skipLabel} onClick={onSkip}>
            Skip
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * First-launch checklist: a CV, a working AI runtime, and the company list that five providers need.
 * Each item reads its own live status and can be done or skipped on its own; none gates another.
 *
 * Skippable by design: "Skip for now", the close button and the backdrop all dismiss it. The CV
 * upload is `CvUploadAction` unchanged -- the same pick (`window.cv.selectAndRead`) and persist
 * (`SaveCvToLibrary` -> `createCvDocument`) pair the CV Library page's own button uses. A successful
 * upload hands off into `FillProfileFromCvDrawer` with `autoStart` (the same reviewed, AI-assisted
 * fill Settings offers, still gated on the user pressing Save); closing that drawer, saved or not,
 * returns here, since the CV is already in the library either way. The company list reuses
 * `useAtsRoster`, so Settings and this modal share one download path and one status.
 *
 * Completed work is never repeated: the CV item reads as done once saved, and the company list reads
 * its status from the saved import, so reopening this modal does not offer the download again.
 */
export function WelcomeModal({ onClose, onOpenSettings, onOpenRuntime }: WelcomeModalProps) {
  const [step, setStep] = useState<CvStep>('invite');
  const [cvSaved, setCvSaved] = useState(false);
  const [profile, setProfile] = useState<CandidateProfile>();
  const [profileError, setProfileError] = useState<string>();
  const [skipped, setSkipped] = useState({ cv: false, runtime: false, roster: false });
  const [rosterError, setRosterError] = useState<string>();

  const { check, run: recheckRuntime } = useRuntimeCheck();
  const clearRosterError = useCallback(() => setRosterError(undefined), []);
  const roster = useAtsRoster({ onRefreshed: clearRosterError, onRefreshError: setRosterError });

  const skip = (key: keyof typeof skipped) => setSkipped((current) => ({ ...current, [key]: true }));

  useEffect(() => {
    if (step !== 'loading-profile') return;
    let cancelled = false;
    void window.vacancyRadar
      .getSearchProfile()
      .then((loaded) => {
        if (!cancelled) {
          setProfile(loaded);
          setStep('fill-profile');
        }
      })
      .catch(() => {
        if (cancelled) return;
        // The CV is already saved by this point. Stay open and say so: closing here unmounted the
        // message before anyone could read it.
        setProfileError('Your CV is saved. The search profile could not be filled automatically. You can fill it in Settings.');
        setStep('invite');
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  if (step === 'fill-profile' && profile) {
    return (
      <FillProfileFromCvDrawer
        profile={profile}
        onApply={async (patch) => void (await window.vacancyRadar.saveSearchProfile(patch))}
        onClose={() => setStep('invite')}
        autoStart
      />
    );
  }

  const cvDone = cvSaved;
  const runtimeDone = check.kind === 'ready';
  const rosterDone = roster.loaded && roster.status !== null;
  const allAddressed =
    (cvDone || skipped.cv) && (runtimeDone || skipped.runtime) && (rosterDone || skipped.roster);
  const busy = step === 'loading-profile';

  const runtimeDetail = (() => {
    switch (check.kind) {
      case 'checking':
        return 'Checking…';
      case 'ready':
        return `${PROVIDER_LABEL[check.provider]}: ready`;
      case 'not-installed':
        return `${PROVIDER_LABEL[check.provider]} is not installed on this computer.`;
      case 'not-authenticated':
        return `${PROVIDER_LABEL[check.provider]} is installed but not signed in.`;
      case 'unreachable':
        return 'The AI helper has not responded yet. It may still be starting.';
    }
  })();

  return (
    <div
      className="modal modal-open"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Open Vacancy Radar"
    >
      <div className="modal-box p-0">
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">Welcome to Open Vacancy Radar</h2>
          <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 px-5 py-4">
          <p className="text-sm">
            Three things get the app working well. Do them in any order, or skip them and come back
            later.
          </p>

          <ul className="mt-2" aria-label="Setup checklist">
            <ChecklistItem
              title="Add a CV"
              status={cvDone ? 'Done' : skipped.cv ? 'Skipped' : 'To do'}
              done={cvDone}
              detail={
                cvDone
                  ? 'CV saved to your library.'
                  : 'With a CV in your library, results are scored against your experience and your search profile can be filled from it. Only the extracted text is stored, on this machine.'
              }
              skipLabel="Skip adding a CV"
              {...(!cvDone && !skipped.cv && !busy ? { onSkip: () => skip('cv') } : {})}
            >
              {!cvDone && (
                <CvUploadAction
                  onSaved={() => {
                    setCvSaved(true);
                    setProfileError(undefined);
                    setStep('loading-profile');
                  }}
                />
              )}
              {busy && (
                <p className="w-full text-xs text-base-content/60" role="status">
                  <span className="loading loading-spinner loading-xs" aria-hidden="true" /> Saved. Reading your CV to
                  fill in your search profile next...
                </p>
              )}
              {profileError && (
                <div className="alert alert-warning alert-soft w-full items-start text-xs" role="alert">
                  <div>
                    <p>{profileError}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className="btn btn-xs" onClick={() => { setProfileError(undefined); setStep('loading-profile'); }}>
                        Try again
                      </button>
                      <button type="button" className="btn btn-xs btn-outline" onClick={onOpenSettings}>
                        Open Settings
                      </button>
                      <button type="button" className="btn btn-xs btn-ghost" onClick={() => setProfileError(undefined)}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </ChecklistItem>

            <ChecklistItem
              title="Check the AI runtime"
              status={runtimeDone ? 'Ready' : skipped.runtime ? 'Skipped' : check.kind === 'checking' ? 'Checking' : 'To do'}
              done={runtimeDone}
              detail={runtimeDetail}
              skipLabel="Skip checking the AI runtime"
              {...(!runtimeDone && !skipped.runtime ? { onSkip: () => skip('runtime') } : {})}
            >
              {!runtimeDone && (
                <>
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => void recheckRuntime()} disabled={check.kind === 'checking'}>
                    Check again
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenRuntime}>
                    Open AI runtime
                  </button>
                </>
              )}
            </ChecklistItem>

            <ChecklistItem
              title="Download the company list"
              status={rosterDone ? 'Done' : skipped.roster ? 'Skipped' : 'To do'}
              done={rosterDone}
              detail={
                !roster.loaded
                  ? 'Checking…'
                  : roster.status
                  ? `${roster.status.totalEntries.toLocaleString()} companies across Greenhouse, Lever, Ashby, Recruitee and Personio.`
                  : 'Greenhouse, Lever, Ashby, Recruitee and Personio searches find no companies until this list is downloaded once.'
              }
              skipLabel="Skip downloading the company list"
              {...(!rosterDone && !skipped.roster && !roster.refreshing ? { onSkip: () => skip('roster') } : {})}
            >
              {!rosterDone && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={roster.refreshing || !roster.loaded}
                  onClick={() => {
                    setRosterError(undefined);
                    roster.refresh();
                  }}
                >
                  {roster.refreshing ? 'Downloading…' : rosterError ? 'Try download again' : 'Download company list'}
                </button>
              )}
              {(rosterError ?? roster.loadError) && !roster.refreshing && (
                <p className="w-full text-xs text-error" role="alert">
                  {rosterError ?? roster.loadError}
                </p>
              )}
            </ChecklistItem>
          </ul>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-base-300 px-5 py-3.5">
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={busy}>
            {allAddressed ? 'Done' : 'Skip for now'}
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} disabled={busy} />
    </div>
  );
}
