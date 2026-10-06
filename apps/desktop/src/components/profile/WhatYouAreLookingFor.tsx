import { useEffect, useId, useState } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { ProfileEditDialog } from './ProfileEditDialog.js';
import { RoleQuickInput } from './RoleQuickInput.js';
import { summarizeProfile } from './profile-summary.js';

/** Loads the saved search profile; `reload` re-reads it after an edit. Null while loading or when
 * the profile cannot be read (the bridge is missing, or the file is unreadable). */
export function useSearchProfileSummary(refreshKey = 0) {
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [revision, setRevision] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!('vacancyRadar' in window)) {
      setFailed(true);
      return;
    }
    void window.vacancyRadar
      .getSearchProfile()
      .then((loaded) => {
        if (cancelled) return;
        setProfile(loaded);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, revision]);

  return { profile, failed, reload: () => setRevision((value) => value + 1), setProfile };
}

export interface WhatYouAreLookingForProps {
  /** Bump to re-read the profile, for example after a CV fill on the same page. */
  refreshKey?: number;
}

/**
 * The short summary of the search profile, shown next to the default CV: target roles, country and
 * top skills, each with where it came from when that was recorded (never guessed), and one Edit
 * button that opens the full form. With nothing set it asks the one question instead.
 */
export function WhatYouAreLookingFor({ refreshKey = 0 }: WhatYouAreLookingForProps) {
  const headingId = useId();
  const { profile, failed, reload, setProfile } = useSearchProfileSummary(refreshKey);
  const [editing, setEditing] = useState(false);

  if (!profile) {
    if (!failed) return null;
    return (
      <section aria-labelledby={headingId} className="mt-4 rounded-box border border-base-300 p-4">
        <h2 id={headingId} className="text-sm font-semibold">
          What you are looking for
        </h2>
        <p className="mt-1 text-sm text-base-content/60">Could not load this.</p>
      </section>
    );
  }

  const { rows, isEmpty } = summarizeProfile(profile);

  return (
    <section aria-labelledby={headingId} className="mt-4 rounded-box border border-base-300 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold">
          What you are looking for
        </h2>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          aria-label="Edit what you are looking for"
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
      </div>

      {isEmpty ? (
        <div className="mt-3">
          <RoleQuickInput onSaved={setProfile} />
        </div>
      ) : (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map((row) => (
            <div key={row.key} className="contents">
              <dt className="text-base-content/60">{row.label}</dt>
              <dd>
                {row.text ? (
                  <>
                    {row.text}
                    {row.source && <span className="ml-2 text-xs text-base-content/60">{row.source}</span>}
                  </>
                ) : (
                  <span className="text-base-content/60">Not set</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {editing && <ProfileEditDialog onClose={() => setEditing(false)} onChanged={reload} />}
    </section>
  );
}
