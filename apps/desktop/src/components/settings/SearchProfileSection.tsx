import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import type { CandidateProfilePatch } from '../../../electron/vacancy-profile-validate.js';
import { skillsToText, textToSkills } from '../cv-library/cv-profile.js';
import { SettingsRow, SettingsSection, SettingsSubheading } from './controls.js';
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
  };
}

export interface SearchProfileSectionProps {
  disabled?: boolean;
  /** Reports a candidate-profile save result upward so `SettingsPage` can show it through its one
   * toast instance, instead of this section rendering a second, independent one: two autosaving
   * forms on the same tab each popping their own toast in the same corner can overlap. */
  onSaved: () => void;
  onSaveError: (message: string) => void;
}

/**
 * Lets a user edit the candidate profile the worldwide pipeline's deterministic scoring matches
 * every result against, instead of hand-editing `config/candidate-profile-v1.json`. Every field
 * commits on blur (text/number/list fields), the same autosave convention as the rest of the
 * Settings page, through the narrow `vacancyRadar.saveSearchProfile` IPC bridge rather than any
 * direct file access.
 *
 * There is deliberately no default target role, country, or salary floor prefilled anywhere here:
 * a fresh profile ships empty (see `config/candidate-profile-v1.json`), and this section only ever
 * writes back what the user actually typed.
 */
export function SearchProfileSection({ disabled, onSaved, onSaveError }: SearchProfileSectionProps) {
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string>();

  const saveSeq = useRef(0);

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
    (patch: Parameters<typeof window.vacancyRadar.saveSearchProfile>[0]) => {
      const seq = ++saveSeq.current;
      void (async () => {
        try {
          const saved = await window.vacancyRadar.saveSearchProfile(patch);
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
          onSaveError(describeError(err, 'could not save the search profile'));
        }
      })();
    },
    [profile, onSaved, onSaveError],
  );

  /**
   * The "Fill from CV" drawer's save. Same IPC, same allow-list, same merge-onto-disk semantics as
   * every other field on this form: `vacancy:save-search-profile` takes a *patch*, so the six
   * fields that drawer sends are the only six that change and everything else in the profile
   * (target roles, primary country, salary floor) survives untouched.
   *
   * Awaited rather than fire-and-forget like `commit` above, because the drawer needs the outcome:
   * it stays open and shows the failure inline instead of closing on a save that did not land. The
   * error is deliberately not also routed to `onSaveError`, or one failure would report itself
   * twice, once in the drawer and once in the page's toast.
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
    return (
      <SettingsSection title="Search profile">
        <div className="alert alert-error alert-soft mt-2 text-sm">{loadError}</div>
      </SettingsSection>
    );
  }

  if (!profile || !draft) {
    return (
      <SettingsSection title="Search profile">
        <div className="alert alert-info alert-soft mt-2 text-sm">Loading search profile…</div>
      </SettingsSection>
    );
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
      commit({ [key]: textToSkills(next) });
    } else if (key === 'professionalLanguage') {
      commit({ constraints: { [key]: next } });
    } else {
      commit({ [key]: next });
    }
  };

  const commitExperienceYears = () => {
    const parsed = Number.parseInt(draft.experienceYears, 10);
    const next = Number.isFinite(parsed) && parsed >= 0 ? parsed : profile.experienceYears;
    setDraft({ ...draft, experienceYears: String(next) });
    if (next !== profile.experienceYears) commit({ experienceYears: next });
  };

  return (
    <SettingsSection title="Search profile">
      <p className="mt-1 text-sm text-base-content/60">
        The worldwide pipeline scores every result's deterministic match percentage against this
        profile. Leave a field empty to skip that dimension entirely, rather than scoring against a
        made-up default.
      </p>

      {unconfigured && (
        <div className="alert alert-warning alert-soft mt-2 text-sm">
          No target roles or strongest skills are set yet, so search results are not scored against
          anything. Fill in at least one of the two below to see ranked matches.
        </div>
      )}

      <SettingsSubheading>Identity</SettingsSubheading>
      <SettingsRow
        label="Fill from CV"
        description="Reads a CV from your library and prefills current role, years, location, professional language and skills for you to review. Target roles, considered roles, excluded role families and country are never filled in from a CV."
      >
        <FillProfileFromCv profile={profile} disabled={disabled} onApply={applyFromCv} />
      </SettingsRow>
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
      <SettingsRow
        label="Target roles"
        description="Comma-separated. Used to score matching vacancies."
        htmlFor="profile-target-roles"
      >
        <textarea
          id="profile-target-roles"
          rows={2}
          className="textarea textarea-sm w-full max-w-md"
          {...field('targetRoles')}
          onBlur={() => commitText('targetRoles', skillsToText(profile.targetRoles))}
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
    </SettingsSection>
  );
}
