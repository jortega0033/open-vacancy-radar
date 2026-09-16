import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

/**
 * `.min(1)`/`.positive()` constraints were dropped deliberately: a profile the user hasn't
 * configured yet is a legitimate, expected state (a fresh install ships with every field empty,
 * not a plausible-looking placeholder — see `isCandidateProfileConfigured` below), and it must
 * parse successfully rather than throw so the scan pipeline can detect and handle that state
 * itself instead of crashing on load.
 */
export const candidateProfileSchema = z.object({
  profileVersion: z.string(),
  candidateName: z.string(),
  currentRole: z.string(),
  location: z.string(),
  experienceYears: z.number().int().nonnegative(),
  strongestSkills: z.array(z.string()),
  additionalSkills: z.array(z.string()),
  targetRoles: z.array(z.string()),
  consideredRoles: z.array(z.string()),
  excludedRoleFamilies: z.array(z.string()),
  constraints: z.object({
    /**
     * Free text, and read as a list: "English", "English, Dutch" and "English / German" all name
     * the languages the candidate can work in (see `parseCandidateLanguages`). It is the only
     * candidate-side input to the mandatory-language gate, so leaving it empty leaves that gate
     * inert rather than falling back to any default language.
     */
    professionalLanguage: z.string(),
    dutchRequired: z.boolean(),
    primaryCountry: z.string(),
    allowRemoteEuSupportingNetherlands: z.boolean(),
    minimumMonthlyBaseEur: z.number().nonnegative(),
    /**
     * The candidate's own answer to "would you relocate for a role?" (issue #280). Optional, and
     * absent means never answered, which stays `unknown` in the eligibility evidence rather than
     * defaulting to either answer.
     *
     * Deliberately separate from anything the employer offers: whether a candidate is willing to
     * move and whether an employer will fund or sponsor the move are different facts, and merging
     * them into one "relocation" flag is what this field exists to prevent.
     */
    relocationWilling: z.boolean().optional(),
  }),
});
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

/**
 * The unconfigured state itself, as a real value rather than an absence -- see
 * `isCandidateProfileConfigured` below, which already treats "no target roles, no strongest
 * skills" as this exact state regardless of where the rest of the profile came from. Every field
 * is the schema's own empty/zero value, never a placeholder that could read as a real answer.
 */
export const EMPTY_CANDIDATE_PROFILE: CandidateProfile = {
  profileVersion: 'unconfigured',
  candidateName: '',
  currentRole: '',
  location: '',
  experienceYears: 0,
  strongestSkills: [],
  additionalSkills: [],
  targetRoles: [],
  consideredRoles: [],
  excludedRoleFamilies: [],
  constraints: {
    professionalLanguage: '',
    dutchRequired: false,
    primaryCountry: '',
    allowRemoteEuSupportingNetherlands: false,
    minimumMonthlyBaseEur: 0,
  },
};

/**
 * A profile file that has never been saved (a fresh install, or a workspace where Settings >
 * Search profile has never been touched) reads as `EMPTY_CANDIDATE_PROFILE` rather than throwing.
 * Every real caller of this function already treats a load failure as "nothing configured yet"
 * (wrapping the call in its own try/catch to get there) -- this makes that the direct, honest
 * result for the one case that genuinely means that, instead of every caller having to separately
 * guess which errors mean "unconfigured" and which mean something worth surfacing. A malformed or
 * unreadable *existing* file (bad JSON, a permissions error, a schema mismatch) still throws: only
 * `ENOENT` -- "there is nothing here yet" -- gets this treatment.
 */
export async function loadCandidateProfile(
  filePath = path.resolve(process.cwd(), 'config/candidate-profile-v1.json'),
): Promise<CandidateProfile> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return EMPTY_CANDIDATE_PROFILE;
    throw err;
  }
  return candidateProfileSchema.parse(JSON.parse(content));
}

/**
 * A profile with no target roles and no strongest skills has nothing for deterministic scoring to
 * match against — every vacancy would score identically low, which looks like "nothing is
 * relevant" rather than "you haven't told us what you're looking for yet". Callers use this to
 * skip scoring entirely and surface an unconfigured-profile state instead of a false zero-match
 * result.
 */
export function isCandidateProfileConfigured(profile: CandidateProfile): boolean {
  return profile.targetRoles.length > 0 || profile.strongestSkills.length > 0;
}
