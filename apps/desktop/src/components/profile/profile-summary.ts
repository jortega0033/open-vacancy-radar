import type { CandidateProfile, ProfileFieldSource } from '@open-vacancy-radar/vacancy-engine';

/** How many skills the summary names before it stops. The full list lives in the edit form. */
export const SUMMARY_SKILL_LIMIT = 5;

/** The label for a recorded origin. No record means no label: it is never guessed. */
export function sourceLabel(source: ProfileFieldSource | undefined): string | null {
  if (source === 'cv') return 'From your CV';
  if (source === 'user') return 'Added by you';
  return null;
}

export interface SummaryRow {
  key: 'targetRoles' | 'primaryCountry' | 'strongestSkills';
  label: string;
  /** Empty when the field is not set. */
  text: string;
  source: string | null;
}

function clean(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function summarizeProfile(profile: CandidateProfile): { rows: SummaryRow[]; isEmpty: boolean } {
  const roles = clean(profile.targetRoles);
  const skills = clean(profile.strongestSkills);
  const country = profile.constraints.primaryCountry.trim();
  const rows: SummaryRow[] = [
    { key: 'targetRoles', label: 'Roles', text: roles.join(', '), source: roles.length ? sourceLabel(profile.fieldSources?.targetRoles) : null },
    { key: 'primaryCountry', label: 'Country', text: country, source: country ? sourceLabel(profile.fieldSources?.primaryCountry) : null },
    {
      key: 'strongestSkills',
      label: 'Top skills',
      text: skills.slice(0, SUMMARY_SKILL_LIMIT).join(', '),
      source: skills.length ? sourceLabel(profile.fieldSources?.strongestSkills) : null,
    },
  ];
  return { rows, isEmpty: roles.length === 0 && skills.length === 0 };
}

/** What results are ranked for, in one short phrase: roles (or skills when there is no role) and country. */
export function rankingText(profile: CandidateProfile): string {
  const roles = clean(profile.targetRoles).slice(0, 3);
  const what = roles.length > 0 ? roles : clean(profile.strongestSkills).slice(0, 3);
  const country = profile.constraints.primaryCountry.trim();
  return [...what, ...(country ? [country] : [])].join(', ');
}
