import { useEffect, useRef, useState } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import type { CandidateProfilePatch } from '../../../electron/vacancy-profile-validate.js';
import type { CvDocumentRecord } from '../../window.js';
import { buildSearchProfileFromCvPrompt } from '../cv/profile-bridge-prompts.js';
import { describeError, useAgentRun } from '../cv/useAgentRun.js';
import { skillsToText, textToSkills } from '../cv-library/cv-profile.js';
import {
  SEARCH_PROFILE_CV_LIMITS,
  parseSearchProfileCvResponse,
  toSearchProfilePatch,
  type SearchProfileCvFields,
} from './search-profile-cv-bridge.js';

/**
 * "Fill from CV" (issue #137): prefill the search profile's identity and skills fields from a CV
 * already in the library, instead of retyping what the CV already says.
 *
 * Two components rather than one, for a reason that matters beyond tidiness: the drawer calls
 * `useAgentRun`, which subscribes to `window.agentDock.onSessionEvent` in a mount effect, and reads
 * the CV library over `window.workspace`. `SearchProfileSection` renders on the Settings page in
 * contexts that install neither bridge. Keeping all of that inside a component that only mounts
 * once the user actually opens the drawer means the button costs nothing until it is pressed.
 *
 * The review step is not a formality. Nothing here writes to the profile until the user has seen
 * the six extracted values in editable inputs and pressed Save, matching the CV library's
 * "Parse with AI" drawer: the same "an over-eager guess costs a glance, not your data" contract.
 *
 * What this deliberately does not offer: target roles, considered roles, excluded role families,
 * primary country and minimum salary. See `search-profile-cv-bridge.ts` for why, and for the
 * structural reason a model answer naming them cannot reach the profile anyway.
 */

interface ReviewForm {
  currentRole: string;
  experienceYears: string;
  location: string;
  professionalLanguage: string;
  strongestSkills: string;
  additionalSkills: string;
}

/** Seeds the review form from the extraction, falling back per field to what the profile already
 * holds. This is what keeps a thin extraction from being destructive: a field the model had nothing
 * for shows (and saves) the user's existing value rather than blanking it. */
function toReviewForm(extracted: Partial<SearchProfileCvFields>, profile: CandidateProfile): ReviewForm {
  return {
    currentRole: extracted.currentRole ?? profile.currentRole,
    experienceYears: String(extracted.experienceYears ?? profile.experienceYears),
    location: extracted.location ?? profile.location,
    professionalLanguage: extracted.professionalLanguage ?? profile.constraints.professionalLanguage,
    strongestSkills: skillsToText(extracted.strongestSkills ?? profile.strongestSkills),
    additionalSkills: skillsToText(extracted.additionalSkills ?? profile.additionalSkills),
  };
}

/** The profile schema stores whole years; the review input is free text so a half-typed number is
 * never clobbered mid-edit. Anything unusable falls back to the profile's current value rather than
 * saving a 0 the user did not choose. */
function reviewedExperienceYears(text: string, fallback: number): number {
  const parsed = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, SEARCH_PROFILE_CV_LIMITS.experienceYearsMax);
}

export interface FillProfileFromCvProps {
  /** The profile as currently saved: the per-field fallback for anything the CV does not state. */
  profile: CandidateProfile;
  disabled?: boolean;
  /** Saves the six-field patch through the section's own `vacancy:save-search-profile` call.
   * Rejecting shows the message inline in the drawer; resolving closes it. */
  onApply: (patch: CandidateProfilePatch) => Promise<void>;
}

export function FillProfileFromCv({ profile, disabled, onApply }: FillProfileFromCvProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-outline btn-sm" disabled={disabled} onClick={() => setOpen(true)}>
        Fill from CV
      </button>
      {open && (
        <FillProfileFromCvDrawer profile={profile} onApply={onApply} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export interface FillProfileFromCvDrawerProps {
  profile: CandidateProfile;
  onApply: (patch: CandidateProfilePatch) => Promise<void>;
  onClose: () => void;
}

export function FillProfileFromCvDrawer({ profile, onApply, onClose }: FillProfileFromCvDrawerProps) {
  const [documents, setDocuments] = useState<CvDocumentRecord[]>();
  const [listError, setListError] = useState<string>();
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<ReviewForm>();
  const [parseError, setParseError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  // `chunkSeparator: ''`: the response must be byte-exact JSON, not prose, so chunks are
  // concatenated raw rather than joined with the "\n\n" the prose AI features want. Same reasoning
  // as CvDrawer's parse run.
  const run = useAgentRun({ chunkSeparator: '' });
  const appliedRef = useRef(false);

  // Only CVs with extracted text can be read: a scanned PDF that produced nothing is listed nowhere
  // here rather than being offered and then failing with an empty answer.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await window.workspace.listCvDocuments();
        if (cancelled) return;
        const usable = all.filter((doc) => doc.text.trim().length > 0);
        setDocuments(usable);
        setSelectedId(usable.find((doc) => doc.isDefault)?.id ?? usable[0]?.id ?? '');
      } catch (err) {
        if (!cancelled) setListError(describeError(err, 'could not load your CV library'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Applies the answer to the review form exactly once per run, the moment it completes. Never
  // saved from here: the user still has to press Save below.
  useEffect(() => {
    if (run.status !== 'completed' || appliedRef.current) return;
    appliedRef.current = true;
    try {
      setForm(toReviewForm(parseSearchProfileCvResponse(run.text), profile));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'could not read the AI response');
    }
  }, [run.status, run.text, profile]);

  // Cancels an in-flight run if the drawer closes while it is still going, otherwise the daemon
  // session keeps running unobserved until it times out. A ref, not `run` in the dependency array:
  // `run` is a fresh object every render and this must fire only on real unmount.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    return () => {
      if (runRef.current.isBusy) void runRef.current.cancel();
    };
  }, []);

  const selected = documents?.find((doc) => doc.id === selectedId);
  const busy = run.isBusy || saving;

  function handleRead() {
    if (!selected) return;
    appliedRef.current = false;
    setParseError(undefined);
    setSaveError(undefined);
    setForm(undefined);
    void run.start(buildSearchProfileFromCvPrompt(selected.name, selected.text));
  }

  function set<K extends keyof ReviewForm>(key: K, value: string) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await onApply(
        toSearchProfilePatch({
          currentRole: form.currentRole.trim(),
          experienceYears: reviewedExperienceYears(form.experienceYears, profile.experienceYears),
          location: form.location.trim(),
          professionalLanguage: form.professionalLanguage.trim(),
          strongestSkills: textToSkills(form.strongestSkills),
          additionalSkills: textToSkills(form.additionalSkills),
        }),
      );
      onClose();
    } catch (err) {
      setSaveError(describeError(err, 'could not save the search profile'));
    } finally {
      setSaving(false);
    }
  }

  const runError = parseError ?? (run.status === 'failed' ? run.error : undefined);

  return (
    <div className="modal modal-open modal-end" role="dialog" aria-modal="true" aria-label="Fill search profile from CV">
      <div className="modal-box flex max-w-md flex-col rounded-none p-0">
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">Fill from CV</h2>
          <button
            type="button"
            aria-label="Close"
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onClose}
            disabled={busy}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto">
          <div className="flex-1 space-y-3 px-5 py-4">
            <p className="text-xs text-base-content/60">
              Reads one CV and fills in the fields it can state as fact. Target roles, considered
              roles, excluded role families, country and salary are never filled in from a CV: a CV
              says what you have done, not what you are looking for, so those stay yours to type.
            </p>

            {listError && (
              <p className="text-sm text-error" role="alert">
                {listError}
              </p>
            )}

            {documents && documents.length === 0 && !listError && (
              <p className="text-sm text-base-content/60">
                No CV in your library has any extracted text yet. Upload a CV on the CV Library page
                first.
              </p>
            )}

            {documents && documents.length > 0 && (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                    CV
                  </span>
                  <select
                    className="select w-full"
                    value={selectedId}
                    disabled={busy}
                    onChange={(event) => setSelectedId(event.currentTarget.value)}
                  >
                    {documents.map((doc) => (
                      <option key={doc.id} value={doc.id}>
                        {doc.name}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={handleRead}
                    disabled={busy || !selected}
                  >
                    {run.isBusy && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
                    Read CV
                  </button>
                  {run.isBusy && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run.cancel()}>
                      Stop
                    </button>
                  )}
                </div>
              </>
            )}

            {runError && (
              <p className="text-sm text-error" role="alert">
                {runError}
              </p>
            )}

            {form && (
              <>
                <p className="text-xs text-success" role="status">
                  Read from your CV: review and edit before saving.
                </p>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                    Current role
                  </span>
                  <input
                    className="input w-full"
                    value={form.currentRole}
                    disabled={saving}
                    onChange={(event) => set('currentRole', event.currentTarget.value)}
                  />
                </label>

                <div className="grid grid-cols-2 gap-2.5">
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                      Years of experience
                    </span>
                    <input
                      className="input w-full"
                      type="number"
                      min={0}
                      value={form.experienceYears}
                      disabled={saving}
                      onChange={(event) => set('experienceYears', event.currentTarget.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                      Location
                    </span>
                    <input
                      className="input w-full"
                      value={form.location}
                      disabled={saving}
                      onChange={(event) => set('location', event.currentTarget.value)}
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                    Professional language
                  </span>
                  <input
                    className="input w-full"
                    value={form.professionalLanguage}
                    disabled={saving}
                    onChange={(event) => set('professionalLanguage', event.currentTarget.value)}
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                    Strongest skills
                  </span>
                  <textarea
                    className="textarea w-full"
                    rows={2}
                    value={form.strongestSkills}
                    disabled={saving}
                    onChange={(event) => set('strongestSkills', event.currentTarget.value)}
                    placeholder="Comma-separated"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                    Additional skills
                  </span>
                  <textarea
                    className="textarea w-full"
                    rows={2}
                    value={form.additionalSkills}
                    disabled={saving}
                    onChange={(event) => set('additionalSkills', event.currentTarget.value)}
                    placeholder="Comma-separated"
                  />
                </label>
              </>
            )}

            {saveError && (
              <p className="text-sm text-error" role="alert">
                {saveError}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-base-300 px-5 py-3.5">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={!form || busy}>
              {saving && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              Save to profile
            </button>
          </div>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} disabled={busy} />
    </div>
  );
}
