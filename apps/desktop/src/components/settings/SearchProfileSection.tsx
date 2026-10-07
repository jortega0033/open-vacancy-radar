import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import type { CandidateProfilePatch } from '../../../electron/vacancy-profile-validate.js';
import { skillsToText, textToSkills } from '../cv-library/cv-profile.js';
import { SettingsRow, SettingsSubheading } from './controls.js';
import { FillProfileFromCv } from './FillProfileFromCv.js';

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Local editable copy of the profile's free-text fields, kept as strings so a half-typed number
 * or an in-progress comma list never gets clobbered by a re-render before the field is committed. */
interface Draft {
  candidateName: string;
  currentRole: string;
  location: string;
  experienceYears: string;
  strongestSkills: string;
  additionalSkills: string;
  targetRoles: string;
  consideredRoles: string;
  excludedRoleFamilies: string;
  professionalLanguage: string;
  primaryCountry: string;
}

function toDraft(profile: CandidateProfile): Draft {
  return {
    candidateName: profile.candidateName,
    currentRole: profile.currentRole,
    location: profile.location,
    experienceYears: String(profile.experienceYears),
    strongestSkills: skillsToText(profile.strongestSkills),
    additionalSkills: skillsToText(profile.additionalSkills),
    targetRoles: skillsToText(profile.targetRoles),
    consideredRoles: skillsToText(profile.consideredRoles),
    excludedRoleFamilies: skillsToText(profile.excludedRoleFamilies),
    professionalLanguage: profile.constraints.professionalLanguage,
    primaryCountry: profile.constraints.primaryCountry,
  };
}

export interface SearchProfileSectionProps {
  disabled?: boolean;
  /** Reports a candidate-profile save upward so the host (the edit dialog) can show it through its
   * one status line, instead of this form rendering a second, independent one. */
  onSaved: () => void;
  onSaveError: (message: string, details?: string) => void;
  /** Lands on the target roles field once the profile has loaded (the form loads after it mounts). */
  focusOnLoad?: boolean;
}

/**
 * The search profile form behind "What you are looking for" (#635): the two fields that decide
 * ranking, target roles and country, come first, and everything else sits under a collapsed
 * "More options". Every field commits on blur (text/number/list fields), through the narrow
 * `vacancyRadar.saveSearchProfile` IPC bridge rather than any direct file access, and records the
 * field as added by the user.
 *
 * There is deliberately no default target role, country, or salary floor prefilled anywhere here:
 * a fresh profile ships empty (see `config/candidate-profile-v1.json`), and this form only ever
 * writes back what the user actually typed.
 */
export function SearchProfileSection({ disabled, onSaved, onSaveError, focusOnLoad }: SearchProfileSectionProps) {
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string>();

  const saveSeq = useRef(0);
  const targetRolesRef = useRef<HTMLTextAreaElement>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusOnLoad || focusedRef.current || !draft) return;
    focusedRef.current = true;
    targetRolesRef.current?.focus();
  }, [focusOnLoad, draft]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.vacancyRadar.getSearchProfile();
        if (cancelled) return;
        setProfile(loaded);
        setDraft(toDraft(loaded));
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load the search profile'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = useCallback(
    (patch: CandidateProfilePatch, edited: keyof Draft) => {
      const seq = ++saveSeq.current;
      void (async () => {
        try {
          const saved = await window.vacancyRadar.saveSearchProfile({ ...patch, fieldSources: { [edited]: 'user' } });
          if (seq !== saveSeq.current) return;
          setProfile(saved);
          setDraft(toDraft(saved));
          onSaved();
        } catch (err) {
          if (seq !== saveSeq.current) return;
          if (profile) {
            setProfile(profile);
            setDraft(toDraft(profile));
          }
          onSaveError('Could not save your search profile.', ...(err instanceof Error && err.message ? [err.message] : []));
        }
      })();
    },
    [profile, onSaved, onSaveError],
  );

  /**
   * The "Fill from CV" drawer's save. Same IPC, same allow-list, same merge-onto-disk semantics as
   * every other field on this form: `vacancy:save-search-profile` takes a *patch*, so the nine
   * fields that drawer sends (including target roles, considered roles and country) are the only
   * ones that change; excluded role families and the salary floor survive untouched, since a CV has
   * no signal for either.
   *
   * Awaited rather than fire-and-forget like `commit` above, because the drawer needs the outcome:
   * it stays open and shows the failure inline instead of closing on a save that did not land. The
   * error is deliberately not also routed to `onSaveError`, or one failure would report itself
   * twice, once in the drawer and once in the host's status line.
   */
  const applyFromCv = useCallback(
    async (patch: CandidateProfilePatch) => {
      const seq = ++saveSeq.current;
      const saved = await window.vacancyRadar.saveSearchProfile(patch);
      // Guarding onSaved too, not just the state update: a newer save (manual or another CV fill)
      // that lands first has already reported its own success, and firing this one too would surface
      // a stray, misleading confirmation for a save this response no longer reflects.
      if (seq !== saveSeq.current) return;
      setProfile(saved);
      setDraft(toDraft(saved));
      onSaved();
    },
    [onSaved],
  );

  if (loadError) {
    return <div className="alert alert-error alert-soft mt-2 text-sm">{loadError}</div>;
  }

  if (!profile || !draft) {
    return <div className="alert alert-info mt-2 text-sm">Loading search profile…</div>;
  }

  // Mirrors isCandidateProfileConfigured in packages/vacancy-engine/src/candidate/profile.ts:
  // duplicated rather than imported, because importing a value (not just a type) from that
  // package here would pull the whole Node-only engine (fs, node:crypto, drizzle-orm) into the
  // Vite-bundled renderer build.
  const unconfigured = profile.targetRoles.length === 0 && profile.strongestSkills.length === 0;

  const field = <K extends keyof Draft>(key: K) => ({
    value: draft[key],
    onChange: (event: { currentTarget: { value: string } }) => setDraft({ ...draft, [key]: event.currentTarget.value }),
  });

  const commitText = (key: keyof Omit<Draft, 'experienceYears'>, current: string) => {
    const next = draft[key].trim();
    if (next === current) return;
    if (key === 'strongestSkills' || key === 'additionalSkills' || key === 'targetRoles' || key === 'consideredRoles' || key === 'excludedRoleFamilies') {
      commit({ [key]: textToSkills(next) }, key);
    } else if (key === 'professionalLanguage' || key === 'primaryCountry') {
      commit({ constraints: { [key]: next } }, key);
    } else {
      commit({ [key]: next }, key);
    }
  };

  const commitExperienceYears = () => {
    const parsed = Number.parseInt(draft.experienceYears, 10);
    const next = Number.isFinite(parsed) && parsed >= 0 ? parsed : profile.experienceYears;
    setDraft({ ...draft, experienceYears: String(next) });
    if (next !== profile.experienceYears) commit({ experienceYears: next }, 'experienceYears');
  };

  return (
    <div>
      <p className="mt-1 text-sm text-base-content/60">Used to rank jobs for you. Leave a field empty to ignore it.</p>

      {unconfigured && (
        <div className="alert alert-warning alert-soft mt-2 text-sm">
          Add a target role or a skill to see ranked matches.
        </div>
      )}

      <SettingsRow
        label="Target roles"
        description="Comma-separated. Used to score matching vacancies."
        htmlFor="profile-target-roles"
      >
        <textarea
          id="profile-target-roles"
          ref={targetRolesRef}
          rows={2}
          className="textarea textarea-sm w-full max-w-md"
          {...field('targetRoles')}
          onBlur={() => commitText('targetRoles', skillsToText(profile.targetRoles))}
        />
      </SettingsRow>
      <SettingsRow
        label="Country"
        description="Where you are based now. Used only for the work-eligibility check."
        htmlFor="profile-primary-country"
      >
        <input
          id="profile-primary-country"
          type="text"
          className="input input-sm w-64"
          {...field('primaryCountry')}
          onBlur={() => commitText('primaryCountry', profile.constraints.primaryCountry)}
        />
      </SettingsRow>

      <details className="mt-4 border-t border-base-300 pt-2">
        <summary className="cursor-pointer py-1 text-sm font-medium">More options</summary>
        <SettingsRow label="Fill from CV" description="Fills in your profile from a CV for you to review.">
          <FillProfileFromCv profile={profile} disabled={disabled} onApply={applyFromCv} />
        </SettingsRow>
        <SettingsSubheading>Role matching</SettingsSubheading>
        <SettingsRow
          label="Strongest skills"
          description="Comma-separated. Used to score matching vacancies."
          htmlFor="profile-strongest-skills"
        >
          <textarea
            id="profile-strongest-skills"
            rows={2}
            className="textarea textarea-sm w-full max-w-md"
            {...field('strongestSkills')}
            onBlur={() => commitText('strongestSkills', skillsToText(profile.strongestSkills))}
          />
        </SettingsRow>
        <SettingsRow label="Additional skills" description="Comma-separated." htmlFor="profile-additional-skills">
          <textarea
            id="profile-additional-skills"
            rows={2}
            className="textarea textarea-sm w-full max-w-md"
            {...field('additionalSkills')}
            onBlur={() => commitText('additionalSkills', skillsToText(profile.additionalSkills))}
          />
        </SettingsRow>
        <SettingsRow label="Considered roles" description="Comma-separated." htmlFor="profile-considered-roles">
          <textarea
            id="profile-considered-roles"
            rows={2}
            className="textarea textarea-sm w-full max-w-md"
            {...field('consideredRoles')}
            onBlur={() => commitText('consideredRoles', skillsToText(profile.consideredRoles))}
          />
        </SettingsRow>
        <SettingsRow
          label="Excluded role families"
          description="Comma-separated. Roles to never surface."
          htmlFor="profile-excluded-role-families"
        >
          <textarea
            id="profile-excluded-role-families"
            rows={2}
            className="textarea textarea-sm w-full max-w-md"
            {...field('excludedRoleFamilies')}
            onBlur={() => commitText('excludedRoleFamilies', skillsToText(profile.excludedRoleFamilies))}
          />
        </SettingsRow>
        <SettingsSubheading>About you</SettingsSubheading>
        <SettingsRow label="Name" htmlFor="profile-candidate-name">
          <input
            id="profile-candidate-name"
            type="text"
            className="input input-sm w-64"
            {...field('candidateName')}
            onBlur={() => commitText('candidateName', profile.candidateName)}
          />
        </SettingsRow>
        <SettingsRow label="Current role" htmlFor="profile-current-role">
          <input
            id="profile-current-role"
            type="text"
            className="input input-sm w-64"
            {...field('currentRole')}
            onBlur={() => commitText('currentRole', profile.currentRole)}
          />
        </SettingsRow>
        <SettingsRow label="Location" htmlFor="profile-location">
          <input
            id="profile-location"
            type="text"
            className="input input-sm w-64"
            {...field('location')}
            onBlur={() => commitText('location', profile.location)}
          />
        </SettingsRow>
        <SettingsRow label="Years of experience" htmlFor="profile-experience-years">
          <input
            id="profile-experience-years"
            type="number"
            min={0}
            className="input input-sm w-24"
            {...field('experienceYears')}
            onBlur={commitExperienceYears}
          />
        </SettingsRow>
        <SettingsRow label="Professional language" htmlFor="profile-professional-language">
          <input
            id="profile-professional-language"
            type="text"
            className="input input-sm w-64"
            {...field('professionalLanguage')}
            onBlur={() => commitText('professionalLanguage', profile.constraints.professionalLanguage)}
          />
        </SettingsRow>
      </details>
    </div>
  );
}
