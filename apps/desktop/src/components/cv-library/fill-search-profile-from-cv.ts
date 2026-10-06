import type { CandidateProfilePatch } from '../../../electron/vacancy-profile-validate.js';
import type { CvDocumentRecord } from '../../window.js';

export const SEARCH_PROFILE_FILLED_STATUS = 'Search profile filled from the default CV';

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Copies target role, skills and the other basics from a CV into the search profile, but only into
 * fields that are still empty: a value the user already set is never overwritten. Resolves true
 * when something was saved. Callers decide which CV counts (the default one) and show failures.
 */
export async function fillEmptySearchProfileFieldsFromCv(doc: CvDocumentRecord): Promise<boolean> {
  if (!('vacancyRadar' in window)) return false;
  const profile = await window.vacancyRadar.getSearchProfile();
  const patch: CandidateProfilePatch = {};

  const title = nonEmpty(doc.profile.title);
  const targetRole = nonEmpty(doc.targetRole) ?? title;
  const years = Number.parseInt(doc.profile.years.trim(), 10);
  const language = doc.profile.languages
    .split(',')
    .map((entry) => entry.trim())
    .find(Boolean);
  const skills = unique(doc.profile.skills);

  if (!profile.currentRole && title) patch.currentRole = title;
  if (!profile.location && nonEmpty(doc.profile.location)) patch.location = doc.profile.location.trim();
  if (profile.experienceYears === 0 && Number.isFinite(years) && years > 0) patch.experienceYears = years;
  if (!profile.constraints.professionalLanguage && language) {
    patch.constraints = { professionalLanguage: language };
  }
  if (profile.strongestSkills.length === 0 && skills.length > 0) {
    patch.strongestSkills = skills.slice(0, 10);
  }
  if (profile.targetRoles.length === 0 && targetRole) {
    patch.targetRoles = [targetRole];
  }

  if (Object.keys(patch).length === 0) return false;
  await window.vacancyRadar.saveSearchProfile(patch);
  return true;
}

export interface SearchProfileFillOutcome {
  filled: boolean;
  /** Set when the fill failed; the CV itself was already saved, so this is never fatal. */
  error?: string;
}

/** Same as `fillEmptySearchProfileFieldsFromCv`, but a failure becomes a message instead of a throw. */
export async function tryFillSearchProfileFromCv(doc: CvDocumentRecord): Promise<SearchProfileFillOutcome> {
  try {
    return { filled: await fillEmptySearchProfileFieldsFromCv(doc) };
  } catch (err) {
    return { filled: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
