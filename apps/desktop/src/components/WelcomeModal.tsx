import { X } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { PROVIDER_LABEL } from '../provider-labels.js';
import { Dialog } from './shell/Dialog.js';
import { CvUploadAction } from './cv-library/CvUploadAction.js';
import { FillProfileFromCvDrawer } from './settings/FillProfileFromCv.js';
import { useAiReadiness } from '../use-ai-readiness.js';

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
  /** Opened on purpose from Settings ("Finish setup"), not as the first-run welcome. Same checklist,
   * different heading and exit wording; skips are never remembered and nothing is persisted. */
  reopened?: boolean;
}

/** Live read of the CV count. Fresh on every mount, so a reopened checklist never tells someone
 * with a CV to add one. `unavailable` is shown as such rather than guessed. */
function useCvCheck() {
  const [state, setState] = useState<'checking' | 'unavailable' | 'has-cv' | 'no-cv'>('checking');
  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getCounts()
      .then((counts) => {
        if (!cancelled) setState(counts.cvDocuments > 0 ? 'has-cv' : 'no-cv');
      })
      .catch(() => {
        if (!cancelled) setState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

type CvStep = 'invite' | 'loading-profile' | 'fill-profile';

interface ChecklistItemProps {
  title: string;
  /** Short state word shown at the right: "Done", "To do", "Optional"... Never colour alone. */
  status: string;
  done?: boolean;
  detail: ReactNode;
  children?: ReactNode;
}

/** No per-item Skip (#764): the footer's one exit covers every item, so the dialog never shows
 * several competing ways out. */
function ChecklistItem({ title, status, done, detail, children }: ChecklistItemProps) {
  return (
    <li className="border-b border-base-300 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="mt-0.5 text-xs text-base-content/70">{detail}</div>
        </div>
        <span className={`badge badge-sm shrink-0 ${done ? 'badge-success badge-soft' : 'badge-outline'}`}>{status}</span>
      </div>
      {children && <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>}
    </li>
  );
}

/**
 * First-launch checklist: one step, a CV, plus the AI tool's live status as an optional extra.
 *
 * Skippable by design: one footer exit ("Skip for now"), the close button, Esc and the backdrop all
 * dismiss it. The CV upload is `CvUploadAction` with `saveOnPick` (#764): picking a file saves it
 * straight to the library -- the same `createCvDocument` the CV Library page uses -- with no extra
 * "Save to CV library" confirm. It then hands off into `FillProfileFromCvDrawer` with `autoStart`,
 * the same reviewed fill Settings offers, still gated on the user pressing Save. That Save is the
 * one confirm: it closes Welcome and, with a target role saved, lands on Search. Cancel or X in the
 * drawer returns here, since the CV is already in the library. Without a working AI tool the
 * drawer never starts a read (#767) and offers setup, manual entry or skip instead.
 * The company list is not a step: it downloads on its own at first launch (`useAutoCompanyList`).
 *
 * Completed work is never repeated: the CV item reads as done once saved.
 */
export function WelcomeModal({ onClose, onOpenSettings, onOpenRuntime, reopened = false }: WelcomeModalProps) {
  const [step, setStep] = useState<CvStep>('invite');
  const [cvSaved, setCvSaved] = useState(false);
  const [profile, setProfile] = useState<CandidateProfile>();
  const [profileError, setProfileError] = useState<string>();

  const cvCheck = useCvCheck();
  const { readiness: check, recheck: recheckRuntime } = useAiReadiness();

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
        setProfileError('CV saved. Could not fill in what you are looking for automatically. You can do it in Settings.');
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
        // The same live status the checklist shows, so a tool it calls missing is never run (#767).
        aiReadiness={check}
        onOpenRuntime={onOpenRuntime}
        // The CV is saved by now, so skipping the details or saving them both finish Welcome (#764).
        onSkip={onClose}
        onSaved={onClose}
      />
    );
  }

  const cvDone = cvSaved || cvCheck === 'has-cv';
  const runtimeDone = check.kind === 'ready';
  const title = reopened ? 'Finish setup' : 'Welcome to Open Vacancy Radar';
  const busy = step === 'loading-profile';

  const runtimeDetail = (() => {
    switch (check.kind) {
      case 'checking':
        return 'Checking…';
      case 'ready':
        return `${PROVIDER_LABEL[check.provider]} is ready.`;
      case 'not-installed':
        return `${PROVIDER_LABEL[check.provider]} is not installed yet.`;
      case 'not-authenticated':
        return `${PROVIDER_LABEL[check.provider]} needs you to sign in.`;
      case 'unverified':
        return `Could not confirm you are signed in to ${PROVIDER_LABEL[check.provider]}.`;
      case 'unreachable':
        return 'Still starting. Check again in a moment.';
    }
  })();

  return (
    <Dialog aria-label={title} boxClassName="p-0" closeDisabled={busy} onClose={onClose}>
      <div>
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 px-5 py-4">
          <p className="text-sm">
            {reopened
              ? 'Pick up where you left off.'
              : 'Add your CV to get started. You can also skip this and come back later.'}
          </p>

          <ul className="mt-2" aria-label="Setup checklist">
            <ChecklistItem
              title="Add a CV"
              status={
                cvDone ? 'Done' : cvCheck === 'checking' ? 'Checking' : cvCheck === 'unavailable' ? 'Unknown' : 'To do'
              }
              done={cvDone}
              detail={
                cvDone
                  ? 'CV saved to your library.'
                  : cvCheck === 'unavailable'
                  ? 'Could not check. You can still add one.'
                  : 'Used to rank jobs for you and fill in what you are looking for. Stays on this computer.'
              }
            >
              {!cvDone && (
                <CvUploadAction
                  saveOnPick
                  fillSearchProfile={false}
                  onSaved={() => {
                    setCvSaved(true);
                    setProfileError(undefined);
                    setStep('loading-profile');
                  }}
                />
              )}
              {busy && (
                <p className="w-full text-xs text-base-content/60" role="status">
                  <span className="loading loading-spinner loading-xs" aria-hidden="true" /> CV saved. Filling in what you are
                  looking for...
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

            {!runtimeDone && (
            <ChecklistItem
              title="Connect your AI tool"
              status={check.kind === 'checking' ? 'Checking' : 'Optional'}
              detail={runtimeDetail}
            >
              {!runtimeDone && (
                <>
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => void recheckRuntime()} disabled={check.kind === 'checking'}>
                    Check again
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenRuntime}>
                    Set up
                  </button>
                </>
              )}
            </ChecklistItem>
            )}
          </ul>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-base-300 px-5 py-3.5">
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={busy}>
            {reopened ? 'Close' : cvDone ? 'Done' : 'Skip for now'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
