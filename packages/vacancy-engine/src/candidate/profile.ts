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
    professionalLanguage: z.string(),
    dutchRequired: z.boolean(),
    primaryCountry: z.string(),
    allowRemoteEuSupportingNetherlands: z.boolean(),
    minimumMonthlyBaseEur: z.number().nonnegative(),
  }),
});
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

export async function loadCandidateProfile(
  filePath = path.resolve(process.cwd(), 'config/candidate-profile-v1.json'),
): Promise<CandidateProfile> {
  const content = await readFile(filePath, 'utf8');
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
