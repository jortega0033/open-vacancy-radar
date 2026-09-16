import { useEffect, useState } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { CvUploadAction } from './cv-library/CvUploadAction.js';
import { FillProfileFromCvDrawer } from './settings/FillProfileFromCv.js';
import { describeError } from './cv/useAgentRun.js';

export interface WelcomeModalProps {
  /**
   * Fired on every way out of this modal, however far the user got: skip, close, backdrop, or
   * finishing (or cancelling out of) the "Fill from CV" step that follows a successful upload.
   * Deliberately one callback rather than several, so the caller has exactly one place to persist
   * `welcomeSeen: true` and cannot mark it on one path and forget another.
   */
  onClose: () => void;
}

/**
 * First-launch nudge toward the app's actual on-ramp: a CV in the library, which is what the
 * search profile and match scoring both read from.
 *
 * Skippable by design (see the ticket's non-goals): it is highly recommended, not required, so the
 * close button, the backdrop and "Skip for now" all dismiss it without uploading anything. The
 * upload itself is `CvUploadAction` unchanged -- the same pick (`window.cv.selectAndRead`) and
 * persist (`SaveCvToLibrary` -> `createCvDocument`) pair the CV Library page's own button uses,
 * rather than a second implementation of the same flow that could drift from it.
 *
 * A successful upload does not just close the modal: the whole point of asking for a CV here is to
 * get the search profile filled in too, not just a document sitting unused in the library. So this
 * hands off straight into `FillProfileFromCvDrawer` with `autoStart`, the exact same reviewed,
 * AI-assisted fill Settings already offers -- reused rather than re-implemented, and still gated on
 * the user reviewing and pressing Save before anything is written to their profile. Closing that
 * step, saved or not, finishes the welcome flow either way: the CV is already in the library at
 * that point regardless of what happens to the profile fill.
 */
export function WelcomeModal({ onClose }: WelcomeModalProps) {
  const [step, setStep] = useState<'invite' | 'loading-profile' | 'fill-profile'>('invite');
  const [profile, setProfile] = useState<CandidateProfile>();
  const [profileError, setProfileError] = useState<string>();

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
      .catch((err) => {
        if (cancelled) return;
        // The CV is already saved by this point; a profile-load failure here should not strand the
        // user mid-onboarding with no way out, just skip straight to done.
        setProfileError(describeError(err, 'could not load your search profile'));
        onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [step, onClose]);

  if (step === 'fill-profile' && profile) {
    return (
      <FillProfileFromCvDrawer profile={profile} onApply={async (patch) => void (await window.vacancyRadar.saveSearchProfile(patch))} onClose={onClose} autoStart />
    );
  }

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
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-3 px-5 py-4">
          <p className="text-sm">
            Upload a CV to get started. With one in your library, search results are scored against
            your experience and your search profile can be filled in from it instead of typed out by
            hand.
          </p>
          <p className="text-xs text-base-content/60">
            Only the extracted text is stored, in the workspace database on this machine. You can
            skip this and add a CV later from the CV Library page.
          </p>
          {profileError && (
            <p className="text-sm text-error" role="alert">
              {profileError}
            </p>
          )}
          {step === 'loading-profile' && (
            <p className="text-xs text-base-content/60" role="status">
              <span className="loading loading-spinner loading-xs" aria-hidden="true" /> Saved. Reading
              your CV to fill in your search profile next...
            </p>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-base-300 px-5 py-3.5">
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={step === 'loading-profile'}>
            Skip for now
          </button>
          {step === 'invite' && <CvUploadAction onSaved={() => setStep('loading-profile')} />}
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} disabled={step === 'loading-profile'} />
    </div>
  );
}
