import { useCallback, useEffect, useRef, useState } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import type { CandidateProfilePatch } from '../../../electron/vacancy-profile-validate.js';
import {
  EXCLUDED_COMPANY_LIMITS,
  normalizeDomainAlias,
} from '@open-vacancy-radar/vacancy-engine/excluded-companies';
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
  /** #736: one row per excluded company; domains stay one comma-separated string while being typed. */
  excludedCompanies: ExcludedCompanyDraft[];
}

interface ExcludedCompanyDraft {
  name: string;
  domains: string;
}

/** The fields that record a `fieldSources` origin (#635). Excluded companies never come from a CV. */
type SourcedField = Exclude<keyof Draft, 'excludedCompanies'>;

function excludedCompaniesToDraft(profile: CandidateProfile): ExcludedCompanyDraft[] {
  return (profile.excludedCompanies ?? []).map((company) => ({ name: company.name, domains: company.domains.join(', ') }));
}

/**
 * The list as the validator will store it: domains normalised and de-duplicated the same way, so comparing
 * it with the saved profile does not see "Acme.com" vs "acme.com" as an edit and save again on every blur.
 */
function comparableExcludedCompanies(companies: NonNullable<CandidateProfile['excludedCompanies']>): string {
  return JSON.stringify(
    companies.map((company) => ({
      name: company.name.trim(),
      domains: [...new Set(company.domains.map((domain) => normalizeDomainAlias(domain) ?? domain.trim()))],
    })),
  );
}

/** Rows with an empty name are not entries yet and are left out; domains split on commas like the lists above. */
function excludedCompaniesFromDraft(rows: readonly ExcludedCompanyDraft[]): NonNullable<CandidateProfile['excludedCompanies']> {
  return rows
    .map((row) => ({ name: row.name.trim(), domains: textToSkills(row.domains) }))
    .filter((row) => row.name.length > 0);
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
    excludedCompanies: excludedCompaniesToDraft(profile),
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
        if (!cancelled) setLoadError(describeError(err, 'could not load what you are looking for'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = useCallback(
    (patch: CandidateProfilePatch, edited: SourcedField | null) => {
      const seq = ++saveSeq.current;
      void (async () => {
        try {
          const saved = await window.vacancyRadar.saveSearchProfile(
            edited ? { ...patch, fieldSources: { [edited]: 'user' } } : patch,
          );
          if (seq !== saveSeq.current) return;
          setProfile(saved);
          // Excluded-company rows are only replaced by the saved copy when this save was theirs and nothing
          // was typed into them since it was sent; then the person sees what is stored (normalised domains).
          // Otherwise -- another field's save, or more typing in flight -- the rows being edited stay as typed.
          setDraft((current) => {
            const next = toDraft(saved);
            if (!current) return next;
            const sent = patch.excludedCompanies;
            const untouched =
              sent !== undefined && JSON.stringify(excludedCompaniesFromDraft(current.excludedCompanies)) === JSON.stringify(sent);
            return untouched && current.excludedCompanies.length === sent.length ? next : { ...next, excludedCompanies: current.excludedCompanies };
          });
          onSaved();
        } catch (err) {
          if (seq !== saveSeq.current) return;
          if (profile) {
            setProfile(profile);
            // Keep the excluded-company rows as typed, so a refused domain can be corrected rather than retyped.
            setDraft((current) => ({ ...toDraft(profile), excludedCompanies: current?.excludedCompanies ?? toDraft(profile).excludedCompanies }));
          }
          onSaveError('Could not save what you are looking for.', ...(err instanceof Error && err.message ? [err.message] : []));
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
    return <div className="alert alert-info mt-2 text-sm">Loading what you are looking for…</div>;
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

  const commitText = (key: Exclude<SourcedField, 'experienceYears'>, current: string) => {
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

  // #736: excluded companies commit as one list, on blur of any of their inputs or on Remove.
  const commitExcludedCompanies = (rows: readonly ExcludedCompanyDraft[]) => {
    const next = excludedCompaniesFromDraft(rows);
    if (comparableExcludedCompanies(next) === comparableExcludedCompanies(profile.excludedCompanies ?? [])) return;
    commit({ excludedCompanies: next }, null);
  };
  const updateExcludedCompany = (index: number, change: Partial<ExcludedCompanyDraft>) => {
    setDraft({
      ...draft,
      excludedCompanies: draft.excludedCompanies.map((row, i) => (i === index ? { ...row, ...change } : row)),
    });
  };
  const addExcludedCompany = () => {
    setDraft({ ...draft, excludedCompanies: [...draft.excludedCompanies, { name: '', domains: '' }] });
  };
  const removeExcludedCompany = (index: number) => {
    const rows = draft.excludedCompanies.filter((_, i) => i !== index);
    setDraft({ ...draft, excludedCompanies: rows });
    commitExcludedCompanies(rows);
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
        <SettingsRow label="Fill from CV" description="Fills this in from a CV for you to review.">
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
        <SettingsSubheading>Companies to skip</SettingsSubheading>
        <SettingsRow
          label="Excluded companies"
          description="Hidden in Search and skipped by Blind Apply. Matching ignores case and legal suffixes such as BV, Inc. or GmbH. Domains are optional: up to 5 company domains such as acme.com, comma-separated. Job-board and ATS links are refused."
        >
          <div className="flex w-full max-w-md flex-col gap-2" data-testid="excluded-companies">
            {draft.excludedCompanies.map((row, index) => (
              // Rows have no stable id; position is the identity until saved, so index is the key here.
              <div key={index} className="flex items-start gap-2">
                <input
                  type="text"
                  className="input input-sm min-w-0 flex-1"
                  aria-label={`Excluded company ${index + 1} name`}
                  placeholder="Company name"
                  value={row.name}
                  onChange={(event) => updateExcludedCompany(index, { name: event.currentTarget.value })}
                  onBlur={() => commitExcludedCompanies(draft.excludedCompanies)}
                />
                <input
                  type="text"
                  className="input input-sm min-w-0 flex-1"
                  aria-label={`Excluded company ${index + 1} domains`}
                  placeholder="acme.com"
                  value={row.domains}
                  onChange={(event) => updateExcludedCompany(index, { domains: event.currentTarget.value })}
                  onBlur={() => commitExcludedCompanies(draft.excludedCompanies)}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Remove excluded company ${index + 1}`}
                  disabled={disabled}
                  onClick={() => removeExcludedCompany(index)}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-outline btn-sm self-start"
              disabled={disabled || draft.excludedCompanies.length >= EXCLUDED_COMPANY_LIMITS.entries}
              onClick={addExcludedCompany}
            >
              Add company
            </button>
            {draft.excludedCompanies.length >= EXCLUDED_COMPANY_LIMITS.entries && (
              <p className="text-xs text-base-content/60">You can exclude up to {EXCLUDED_COMPANY_LIMITS.entries} companies.</p>
            )}
          </div>
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
