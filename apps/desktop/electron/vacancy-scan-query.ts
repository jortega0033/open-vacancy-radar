import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';

export function requiredScanQuery(query: unknown): string {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) {
    throw new Error('Add a role or keyword before starting a new worldwide scan.');
  }
  return trimmed;
}

function firstNonBlank(values: readonly string[]): string | null {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function scheduledScanQueryFromProfile(profile: CandidateProfile): string | null {
  return firstNonBlank(profile.targetRoles) ?? firstNonBlank(profile.strongestSkills);
}
