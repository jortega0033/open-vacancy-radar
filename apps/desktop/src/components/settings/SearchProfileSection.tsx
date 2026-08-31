import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { skillsToText, textToSkills } from '../cv-library/cv-profile.js';
import { SettingsRow, SettingsSection, SettingsSubheading, ToggleSwitch } from './controls.js';

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
  minimumMonthlyBaseEur: string;
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
    minimumMonthlyBaseEur: String(profile.constraints.minimumMonthlyBaseEur),
  };
}

export interface SearchProfileSectionProps {
  /** `app_settings.sponsor_only_default`: owned by `SettingsPage`, not the candidate profile IPC
   * this section otherwise talks to, but it is Netherlands-only, so it lives here, not in the
   * market-agnostic "Search defaults" section. */
  sponsorOnlyDefault: boolean;
  onChangeSponsorOnlyDefault: (next: boolean) => void;
  /** `app_settings.ind_verification_enabled`: same story as `sponsorOnlyDefault` above. This used
   * to sit in its own "Market integrations" section, which was really just this section's
   * verification concern split out under a near-duplicate "Netherlands-only, doesn't apply to
   * worldwide" disclaimer. */
  indVerificationEnabled: boolean;
  onChangeIndVerificationEnabled: (next: boolean) => void;
  /** `settings.defaultMarket === 'netherlands'`: the two toggles above only matter once Netherlands
   * is genuinely in play, and showing them regardless of the default search location just adds
   * clutter for a user whose default location default is elsewhere. Netherlands stays fully
   * reachable from the Search page either way; this only affects what Settings surfaces here. */
  showIndOptions: boolean;
  disabled?: boolean;
  /** Reports a candidate-profile save result upward so `SettingsPage` can show it through its one
   * toast instance, instead of this section rendering a second, independent one: two autosaving
   * forms on the same tab each popping their own toast in the same corner can overlap. */
  onSaved: () => void;
  onSaveError: (message: string) => void;
}

/**
 * Lets a user actually edit the Netherlands pipeline's candidate profile from the app, instead of
 * hand-editing `config/candidate-profile-v1.json`. Every field commits on blur (text/number/list
 * fields) or immediately (toggles), the same autosave convention as the rest of the Settings page,
 * through the narrow `vacancyRadar.saveSearchProfile` IPC bridge rather than any direct file access.
 *
 * There is deliberately no default target role, country, or salary floor prefilled anywhere here:
 * a fresh profile ships empty (see `config/candidate-profile-v1.json`), and this section only ever
 * writes back what the user actually typed.
 */
export function SearchProfileSection({
  sponsorOnlyDefault,
  onChangeSponsorOnlyDefault,
  indVerificationEnabled,
  onChangeIndVerificationEnabled,
  showIndOptions,
  disabled,
  onSaved,
  onSaveError,
}: SearchProfileSectionProps) {
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
          // Reverts `profile` too, not just `draft`: `commitToggle` below updates `profile`
          // optimistically before this call resolves, so on failure both must roll back together
          // or a failed toggle save leaves the switch showing the unsaved value indefinitely.
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

  const commitToggle = useCallback(
    (patch: { dutchRequired: boolean } | { allowRemoteEuSupportingNetherlands: boolean }) => {
      if (!profile) return;
      setProfile({ ...profile, constraints: { ...profile.constraints, ...patch } });
      commit({ constraints: patch });
    },
    [profile, commit],
  );

  // Neither row depends on the candidate-profile fetch below (both are `app_settings` fields), so
  // they render (when shown at all) in every branch rather than waiting on `profile`/`draft` to
  // resolve. Gated on `showIndOptions`: see that prop's doc comment.
  const verificationRows = showIndOptions && (
    <>
      <SettingsSubheading>Search behavior</SettingsSubheading>
      <SettingsRow
        label="Recognised sponsors only by default"
        description="Netherlands searches start with the IND recognised-sponsor filter switched on."
      >
        <ToggleSwitch
          label="Recognised sponsors only by default"
          checked={sponsorOnlyDefault}
          disabled={disabled}
          onChange={onChangeSponsorOnlyDefault}
        />
      </SettingsRow>
      <SettingsRow
        label="IND recognised sponsor verification"
        description="Source: IND Public Register · checks employers of Netherlands vacancies."
      >
        <ToggleSwitch
          label="IND recognised sponsor verification"
          checked={indVerificationEnabled}
          disabled={disabled}
          onChange={onChangeIndVerificationEnabled}
        />
      </SettingsRow>
      <p className="ovr-row border-b border-base-300 text-xs text-base-content/60">
        Recruitee, Greenhouse, Teamtailor, SmartRecruiters, Lever and mapped company career sites
        feed the Netherlands pipeline. No market-specific employer verification is configured for
        Germany, Belgium, France, the United Kingdom or the United States; vacancy search, CV
        matching, letters and application tracking still work for those markets.
      </p>
    </>
  );

  if (loadError) {
    return (
      <SettingsSection title="Netherlands search profile">
        {verificationRows}
        <div className="alert alert-error alert-soft mt-2 text-sm">{loadError}</div>
      </SettingsSection>
    );
  }

  if (!profile || !draft) {
    return (
      <SettingsSection title="Netherlands search profile">
        {verificationRows}
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

  const commitText = (key: keyof Omit<Draft, 'experienceYears' | 'minimumMonthlyBaseEur'>, current: string) => {
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

  const commitMinimumMonthlyBaseEur = () => {
    const parsed = Number.parseFloat(draft.minimumMonthlyBaseEur);
    const next = Number.isFinite(parsed) && parsed >= 0 ? parsed : profile.constraints.minimumMonthlyBaseEur;
    setDraft({ ...draft, minimumMonthlyBaseEur: String(next) });
    if (next !== profile.constraints.minimumMonthlyBaseEur) commit({ constraints: { minimumMonthlyBaseEur: next } });
  };

  return (
    <SettingsSection title="Netherlands search profile">
      <p className="mt-1 text-sm text-base-content/60">
        Only the Netherlands (IND sponsor) pipeline scores results against a candidate profile.
        The worldwide pipeline has no equivalent, so nothing here affects it.
      </p>

      {verificationRows}

      {unconfigured && (
        <div className="alert alert-warning alert-soft mt-2 text-sm">
          No target roles or strongest skills are set yet, so Netherlands search results are not
          scored against anything. Fill in at least one of the two below to see ranked matches.
        </div>
      )}

      <SettingsSubheading>Identity</SettingsSubheading>
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

      <SettingsSubheading>Constraints</SettingsSubheading>
      <SettingsRow
        label="Minimum monthly base (EUR)"
        description="Leave at 0 for no salary floor."
        htmlFor="profile-minimum-monthly-base-eur"
      >
        <input
          id="profile-minimum-monthly-base-eur"
          type="number"
          min={0}
          className="input input-sm w-32"
          {...field('minimumMonthlyBaseEur')}
          onBlur={commitMinimumMonthlyBaseEur}
        />
      </SettingsRow>
      <SettingsRow
        label="I can take Dutch-required roles"
        description="When off, vacancies that require Dutch score as a poor match. Turn this on only if you're comfortable working in Dutch."
      >
        <ToggleSwitch
          label="I can take Dutch-required roles"
          checked={profile.constraints.dutchRequired}
          onChange={(dutchRequired) => commitToggle({ dutchRequired })}
        />
      </SettingsRow>
      <SettingsRow
        label="Allow remote EU supporting Netherlands"
        description="Include EU-remote roles that support the Netherlands market."
      >
        <ToggleSwitch
          label="Allow remote EU supporting Netherlands"
          checked={profile.constraints.allowRemoteEuSupportingNetherlands}
          onChange={(allowRemoteEuSupportingNetherlands) => commitToggle({ allowRemoteEuSupportingNetherlands })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
