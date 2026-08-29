import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const candidateProfileSchema = z.object({
  profileVersion: z.string().min(1),
  candidateName: z.string().min(1),
  currentRole: z.string().min(1),
  location: z.string().min(1),
  experienceYears: z.number().int().positive(),
  strongestSkills: z.array(z.string()).min(1),
  additionalSkills: z.array(z.string()),
  targetRoles: z.array(z.string()).min(1),
  consideredRoles: z.array(z.string()),
  excludedRoleFamilies: z.array(z.string()).min(1),
  constraints: z.object({
    professionalLanguage: z.string().min(1),
    dutchRequired: z.boolean(),
    primaryCountry: z.string().min(1),
    allowRemoteEuSupportingNetherlands: z.boolean(),
    minimumMonthlyBaseEur: z.number().positive(),
  }),
});
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

export async function loadCandidateProfile(
  filePath = path.resolve(process.cwd(), 'config/candidate-profile-v1.json'),
): Promise<CandidateProfile> {
  const content = await readFile(filePath, 'utf8');
  return candidateProfileSchema.parse(JSON.parse(content));
}
