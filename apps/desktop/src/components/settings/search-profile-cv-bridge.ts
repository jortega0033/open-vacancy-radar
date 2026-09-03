import type { CandidateProfilePatch } from '../../../electron/vacancy-profile-validate.js';
import { extractAiJsonPayload } from '../cv-library/cv-ai-parse.js';
import type { SearchProfileCvField } from '../cv/profile-bridge-prompts.js';

/**
 * Response parsing and patch construction for "Fill from CV" (issue #137).
 *
 * This module is the ticket's whole risk mitigation, so it is worth being explicit about where the
 * guarantee actually lives.
 *
 * The claim is: no matter what the model says, this feature can only ever write `currentRole`,
 * `experienceYears`, `location`, `strongestSkills`, `additionalSkills` and
 * `constraints.professionalLanguage`. It can never write `targetRoles`, `consideredRoles`,
 * `excludedRoleFamilies`, `constraints.primaryCountry` or `constraints.minimumMonthlyBaseEur`,
 * which are forward-looking preferences a CV cannot honestly state (see the header of
 * `components/cv/profile-bridge-prompts.ts`, and issues #56/#64).
 *
 * That claim rests on two structural properties, not on the prompt's wording:
 *
 * 1. `toPartialSearchProfileCvFields` never spreads the model's object. It reads six named keys off
 *    it and builds its own result. An unexpected key in the response is not rejected, logged or
 *    sanitized: it is simply never read, so there is no code path along which it exists.
 * 2. `toSearchProfilePatch` builds the IPC payload as one object literal with six literal keys,
 *    from a fully-typed `SearchProfileCvFields` value that has no room for anything else. It takes
 *    the *reviewed* fields (what the user confirmed in the drawer), not the raw response, so even a
 *    parser bug could not route an unreviewed value into it.
 *
 * `electron/vacancy-profile-validate.ts` allow-lists the payload again in main, and `main.ts`'s
 * handler merges the patch onto the profile on disk rather than replacing it, so every field this
 * feature does not name survives a save untouched -- but be precise about what that second layer
 * actually buys here: `vacancy:save-search-profile` is the same channel `SearchProfileSection`'s
 * manual "Target roles"/"Considered roles"/country/salary-floor inputs already save through, so
 * `parseCandidateProfilePatch` legitimately ALLOWS `targetRoles`, `consideredRoles`,
 * `excludedRoleFamilies`, `constraints.primaryCountry` and `constraints.minimumMonthlyBaseEur` --
 * those are real, expected fields on that channel for the manual path. It cannot reject them for a
 * CV-sourced patch specifically without a way to tell the two callers apart, which does not exist
 * today. So the exclusion guarantee this ticket exists for rests entirely on the two properties
 * above, in this one file, not on a second independent backstop. See
 * `search-profile-cv-bridge.test.ts`'s "main-process allow-list does not itself reject an excluded
 * field" test, which documents this precisely rather than assuming it.
 *
 * A hand-built allow-list rather than a Zod `.strict()` object because that is this codebase's
 * established idiom for exactly this job on both sides of the IPC boundary (see
 * `vacancy-profile-validate.ts`, `workspace/validate.ts`, `cv-library/cv-ai-parse.ts`), and because
 * the renderer bundle carries no schema library. The structural guarantee is the same one
 * `.strict()` would give: the output object's key set is written out in source and cannot be
 * widened by input.
 */

/**
 * Mirrors `CANDIDATE_PROFILE_LIMITS` in `electron/vacancy-profile-validate.ts`, which is the
 * authority: main re-validates every patch against it and rejects an over-long value regardless of
 * what happens here. Duplicated rather than imported because that module is main-process
 * validation code, and this app keeps renderer imports of `electron/` type-only outside the one
 * module built to be shared by both (`workspace/cv-profile-schema.ts`). A unit test pins these
 * numbers against the real ones so the two cannot drift apart silently.
 */
export const SEARCH_PROFILE_CV_LIMITS = {
  /** currentRole / location / professionalLanguage / one skill entry */
  shortField: 200,
  /** strongestSkills / additionalSkills */
  listEntries: 50,
  experienceYearsMax: 80,
} as const;

/** Exactly the six fields this feature is allowed to touch, in the profile's own vocabulary.
 * `professionalLanguage` is flat here and nested under `constraints` in the patch: the model is
 * asked for a flat object, and `toSearchProfilePatch` does the one bit of reshaping. */
export interface SearchProfileCvFields {
  currentRole: string;
  experienceYears: number;
  location: string;
  professionalLanguage: string;
  strongestSkills: string[];
  additionalSkills: string[];
}

/** The five profile fields this path must never write. Exported for the tests that assert it, and
 * so the claim is stated once as data rather than only in prose. */
export const SEARCH_PROFILE_CV_FORBIDDEN_FIELDS = [
  'targetRoles',
  'consideredRoles',
  'excludedRoleFamilies',
  'primaryCountry',
  'minimumMonthlyBaseEur',
] as const;

/** Single-line profile fields: whitespace is collapsed the same way `prompts.ts` flattens untrusted
 * single-line vacancy fields, so a model answer containing newlines cannot turn one profile field
 * into something that renders as several. */
function shortString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flattened = value.replace(/\s+/gu, ' ').trim().slice(0, SEARCH_PROFILE_CV_LIMITS.shortField).trim();
  return flattened.length > 0 ? flattened : undefined;
}

function skillList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skills: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const skill = shortString(entry);
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push(skill);
    if (skills.length >= SEARCH_PROFILE_CV_LIMITS.listEntries) break;
  }
  return skills.length > 0 ? skills : undefined;
}

/**
 * `experienceYears` is an integer in the profile schema, and the prompt asks for `0` when the CV
 * has too few dates to count from. `0` is therefore read as "the model had nothing", not as a
 * candidate with zero years: the caller falls back to whatever the profile already holds, which is
 * also `0` for a fresh profile. A string ("8", "8 years") is accepted because coding-agent CLIs
 * quote numbers often enough that rejecting it would just be a worse extraction for no gain.
 */
function experienceYears(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const rounded = Math.round(parsed);
  if (rounded <= 0) return undefined;
  return Math.min(rounded, SEARCH_PROFILE_CV_LIMITS.experienceYearsMax);
}

/**
 * One reader per field the prompt asks for. Typed as a total `Record` over
 * `SearchProfileCvField` (the same `const` list `profile-bridge-prompts.ts` renders the prompt's
 * JSON shape from) so the prompt and the parser cannot drift: adding a field to the prompt without
 * teaching this module to read it, or vice versa, fails to compile.
 */
const READERS: { [K in SearchProfileCvField]: (value: unknown) => SearchProfileCvFields[K] | undefined } = {
  currentRole: shortString,
  experienceYears,
  location: shortString,
  professionalLanguage: shortString,
  strongestSkills: skillList,
  additionalSkills: skillList,
};

/**
 * Coerces the model's parsed JSON into whichever of the six fields came back usable, dropping
 * everything else rather than throwing: a wrong type on one field should not cost the user the
 * other five, since the result only ever prefills a form they review before saving.
 *
 * Note what this cannot do. Each field is read by name from the response; the response's own key
 * set is never enumerated, spread, or copied. A response of
 * `{"currentRole": "...", "targetRoles": ["CEO"], "constraints": {"primaryCountry": "NL"}}` yields
 * `{currentRole: "..."}` and nothing else. `targetRoles` is not stripped; it is never looked at.
 */
export function toPartialSearchProfileCvFields(value: unknown): Partial<SearchProfileCvFields> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const fields: Partial<SearchProfileCvFields> = {};

  const currentRole = READERS.currentRole(record.currentRole);
  if (currentRole !== undefined) fields.currentRole = currentRole;
  const years = READERS.experienceYears(record.experienceYears);
  if (years !== undefined) fields.experienceYears = years;
  const location = READERS.location(record.location);
  if (location !== undefined) fields.location = location;
  const professionalLanguage = READERS.professionalLanguage(record.professionalLanguage);
  if (professionalLanguage !== undefined) fields.professionalLanguage = professionalLanguage;
  const strongestSkills = READERS.strongestSkills(record.strongestSkills);
  if (strongestSkills !== undefined) fields.strongestSkills = strongestSkills;
  const additionalSkills = READERS.additionalSkills(record.additionalSkills);
  if (additionalSkills !== undefined) fields.additionalSkills = additionalSkills;

  return fields;
}

/**
 * Parses one "Fill from CV" response end to end. Throws a user-facing message on anything that is
 * not recoverable JSON; the drawer surfaces that and leaves the profile untouched, exactly as
 * `parseCvAiResponse` does for the CV library.
 */
export function parseSearchProfileCvResponse(raw: string): Partial<SearchProfileCvFields> {
  let value: unknown;
  try {
    value = JSON.parse(extractAiJsonPayload(raw));
  } catch {
    throw new Error('the AI response was not valid JSON: try again or fill the fields in manually');
  }
  return toPartialSearchProfileCvFields(value);
}

/**
 * Builds the `vacancy:save-search-profile` payload from the fields the user reviewed.
 *
 * Every key is written out literally. This function is the reason the feature cannot touch an
 * excluded field: there is no spread, no computed key, and no path by which `targetRoles` or
 * `constraints.primaryCountry` could appear in the returned object. `constraints` carries
 * `professionalLanguage` and nothing else, and main merges it onto the profile's existing
 * constraints, so `primaryCountry`, `dutchRequired`, `minimumMonthlyBaseEur` and
 * `allowRemoteEuSupportingNetherlands` all survive the save unchanged.
 */
export function toSearchProfilePatch(fields: SearchProfileCvFields): CandidateProfilePatch {
  return {
    currentRole: fields.currentRole,
    experienceYears: fields.experienceYears,
    location: fields.location,
    strongestSkills: fields.strongestSkills,
    additionalSkills: fields.additionalSkills,
    constraints: { professionalLanguage: fields.professionalLanguage },
  };
}
