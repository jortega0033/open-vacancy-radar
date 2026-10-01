/**
 * Input validation for the `vacancy:save-search-profile` IPC channel.
 *
 * Same trust boundary and the same three rules as `workspace/validate.ts`: allow-list every field
 * by name (never spread the raw payload onto the profile that gets written to disk), bound every
 * string and array, and never echo the value that failed back in an error message.
 *
 * Pure (no filesystem, no Electron), so it is unit-testable on its own.
 */

import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';

export const CANDIDATE_PROFILE_LIMITS = {
  /** candidateName / currentRole / location / a single skill or role entry */
  shortField: 200,
  /** strongestSkills / additionalSkills / targetRoles / consideredRoles / excludedRoleFamilies */
  listEntries: 50,
  experienceYearsMax: 80,
  minimumMonthlyBaseEurMax: 1_000_000,
} as const;

export class VacancyProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VacancyProfileInputError';
  }
}

function fail(message: string): never {
  throw new VacancyProfileInputError(message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail(`"${field}" must be a string`);
  if (value.length > max) fail(`"${field}" must be at most ${max} characters`);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`"${field}" must be a boolean`);
  return value;
}

function nonNegativeInt(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`"${field}" must be an integer`);
  if (value < 0 || value > max) fail(`"${field}" must be between 0 and ${max}`);
  return value;
}

function nonNegativeNumber(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`"${field}" must be a number`);
  if (value < 0 || value > max) fail(`"${field}" must be between 0 and ${max}`);
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`"${field}" must be an array of strings`);
  if (value.length > CANDIDATE_PROFILE_LIMITS.listEntries) {
    fail(`"${field}" must have at most ${CANDIDATE_PROFILE_LIMITS.listEntries} entries`);
  }
  return value.map((entry, index) => str(entry, `${field}[${index}]`, CANDIDATE_PROFILE_LIMITS.shortField));
}

/**
 * Copies `key` from `source` onto `target` only when the caller actually supplied it. `undefined`
 * means "leave this field alone", matching every patch verb in `workspace/validate.ts`.
 */
function patch<T, K extends keyof T & string>(
  source: Record<string, unknown>,
  target: Partial<T>,
  key: K,
  parse: (value: unknown) => T[K],
): void {
  if (!(key in source) || source[key] === undefined) return;
  target[key] = parse(source[key]) as Partial<T>[K];
}

export type CandidateProfileConstraintsPatch = Partial<CandidateProfile['constraints']>;
export type CandidateProfilePatch = Partial<Omit<CandidateProfile, 'profileVersion' | 'constraints'>> & {
  constraints?: CandidateProfileConstraintsPatch;
};

function parseConstraintsPatch(value: unknown): CandidateProfileConstraintsPatch {
  const input = asRecord(value, '"constraints"');
  const out: CandidateProfileConstraintsPatch = {};
  patch(input, out, 'professionalLanguage', (v) => str(v, 'constraints.professionalLanguage', CANDIDATE_PROFILE_LIMITS.shortField));
  patch(input, out, 'dutchRequired', (v) => bool(v, 'constraints.dutchRequired'));
  patch(input, out, 'primaryCountry', (v) => str(v, 'constraints.primaryCountry', CANDIDATE_PROFILE_LIMITS.shortField));
  patch(input, out, 'allowRemoteEuSupportingNetherlands', (v) => bool(v, 'constraints.allowRemoteEuSupportingNetherlands'));
  patch(input, out, 'minimumMonthlyBaseEur', (v) =>
    nonNegativeNumber(v, 'constraints.minimumMonthlyBaseEur', CANDIDATE_PROFILE_LIMITS.minimumMonthlyBaseEurMax),
  );
  return out;
}

/** `profileVersion` is deliberately NOT patchable here: the caller (main.ts) stamps a fresh one
 * on every save so the deterministic-scoring cache is correctly invalidated. */
export function parseCandidateProfilePatch(value: unknown): CandidateProfilePatch {
  const input = asRecord(value, '"patch"');
  const out: CandidateProfilePatch = {};
  patch(input, out, 'candidateName', (v) => str(v, 'candidateName', CANDIDATE_PROFILE_LIMITS.shortField));
  patch(input, out, 'currentRole', (v) => str(v, 'currentRole', CANDIDATE_PROFILE_LIMITS.shortField));
  patch(input, out, 'location', (v) => str(v, 'location', CANDIDATE_PROFILE_LIMITS.shortField));
  patch(input, out, 'experienceYears', (v) =>
    nonNegativeInt(v, 'experienceYears', CANDIDATE_PROFILE_LIMITS.experienceYearsMax),
  );
  patch(input, out, 'strongestSkills', (v) => stringList(v, 'strongestSkills'));
  patch(input, out, 'additionalSkills', (v) => stringList(v, 'additionalSkills'));
  patch(input, out, 'targetRoles', (v) => stringList(v, 'targetRoles'));
  patch(input, out, 'consideredRoles', (v) => stringList(v, 'consideredRoles'));
  patch(input, out, 'excludedRoleFamilies', (v) => stringList(v, 'excludedRoleFamilies'));
  patch(input, out, 'constraints', (v) => parseConstraintsPatch(v));
  return out;
}
