import {
  GROUNDING_RULES,
  MAX_CV_PROMPT_CHARS,
  clampPromptText,
  fieldPromptText,
} from './prompts.js';

/**
 * "Fill from CV" (issue #137): the prompt that bridges one CV from the library into the
 * Netherlands search profile (`SearchProfileSection`).
 *
 * A separate module from `prompts.ts` on purpose, and deliberately narrow.
 *
 * `buildCvParsePrompt` in `prompts.ts` already does the same *kind* of work (free CV text in, one
 * JSON object out, reviewed by the user before anything is saved) for a different target, the CV
 * library's own `cvDocuments.profile`. This one targets the search profile, which is a different
 * animal: only some of its fields are statements of fact about the candidate's past. The rest
 * (`targetRoles`, `consideredRoles`, `excludedRoleFamilies`, `constraints.primaryCountry`,
 * `constraints.minimumMonthlyBaseEur`) are forward-looking preferences, and a CV is a record of
 * what someone has already done, not a statement of what they want next. Asking a model to fill
 * those in is asking it to guess, and a guess written into the profile silently steers every
 * subsequent scored search: exactly the implicit bias the project's shipped-defaults precedent
 * (`config/candidate-profile-v1.json` shipping those fields empty, issues #56/#64) exists to keep
 * out, reintroduced per-user instead of as a default.
 *
 * So this prompt asks for six fields and no others. The wording below says so, but the wording is
 * not the control: `search-profile-cv-bridge.ts` reads exactly these six keys off the response and
 * builds the IPC patch from an explicit object literal, so a response that names an excluded field
 * cannot reach the profile whatever it says. Treat the paragraph in the prompt as a way to get a
 * better answer, not as the thing that makes an unwanted one harmless.
 *
 * The bounded-input / no-tool-use / no-invention properties documented at the top of `prompts.ts`
 * all still apply: `GROUNDING_RULES` and the clamp helpers are imported from there rather than
 * restated, so this prompt can never drift into a laxer version of the same discipline.
 */
export const SEARCH_PROFILE_CV_FIELDS = [
  'currentRole',
  'experienceYears',
  'location',
  'professionalLanguage',
  'strongestSkills',
  'additionalSkills',
] as const;

export type SearchProfileCvField = (typeof SEARCH_PROFILE_CV_FIELDS)[number];

/** The JSON type the model is told to emit for each field, rendered into the shape line below. */
const FIELD_JSON_TYPES: Record<SearchProfileCvField, string> = {
  currentRole: 'string',
  experienceYears: 'number',
  location: 'string',
  professionalLanguage: 'string',
  strongestSkills: 'string[]',
  additionalSkills: 'string[]',
};

export const SEARCH_PROFILE_CV_FIELD_DESCRIPTIONS: Record<SearchProfileCvField, string> = {
  currentRole:
    'the job title the candidate holds now, or the most recent one if they are not currently employed, exactly as the CV words it.',
  experienceYears:
    'total years of professional experience as a whole number, counted from the earliest professional role on the CV. Use 0 if the CV does not give enough dates to count.',
  location: 'where the candidate is based now, as the CV states it (for example "Amsterdam, Netherlands").',
  professionalLanguage:
    'the single language this candidate actually works in day to day, judged from the CV (for example "English"). One language, not a list, and not a proficiency level.',
  strongestSkills:
    'up to 10 skills or technologies this CV evidences most strongly: named repeatedly, used in the most recent or longest roles, or central to the work described. Short names only ("TypeScript", not "5 years of TypeScript in production").',
  additionalSkills:
    'up to 20 further skills or technologies the CV mentions that did not make the list above. No duplicates of it.',
};

/** Named here so the prompt can list them, and so the paragraph below can never quietly disagree
 * with the set `search-profile-cv-bridge.ts` refuses to write. */
export const SEARCH_PROFILE_CV_EXCLUDED_FIELDS = [
  'targetRoles',
  'consideredRoles',
  'excludedRoleFamilies',
  'primaryCountry',
  'minimumMonthlyBaseEur',
] as const;

/** `{"currentRole": string, ..., "strongestSkills": string[], ...}`, built once at module load from
 * the field list above (which is static), matching the `CV_PROFILE_JSON_SHAPE` pattern in
 * `prompts.ts`: the shape the model is shown cannot describe a field this module does not declare,
 * or omit one it does. */
const JSON_SHAPE = `{${SEARCH_PROFILE_CV_FIELDS.map(
  (key) => `"${key}": ${FIELD_JSON_TYPES[key]}`,
).join(', ')}}`;

const FIELD_BULLETS = SEARCH_PROFILE_CV_FIELDS.map(
  (key) => `- "${key}": ${SEARCH_PROFILE_CV_FIELD_DESCRIPTIONS[key]}`,
).join('\n');

const EXCLUDED_KEYS_SENTENCE = SEARCH_PROFILE_CV_EXCLUDED_FIELDS.map((key) => `"${key}"`).join(', ');

/**
 * Reads one CV and returns the six search-profile fields a CV can honestly state. The answer is
 * never saved directly: `FillProfileFromCv` shows it to the user in an editable review panel first,
 * so a thin or wrong extraction costs a glance, not corrupted profile data.
 */
export function buildSearchProfileFromCvPrompt(fileName: string, text: string): string {
  return `You extract structured fields from one candidate's CV text. Read the CV below and reply with a single JSON object only: no Markdown code fence, no commentary before or after it.

${GROUNDING_RULES}
Never invent a value: if a field is not stated or cannot be inferred from the CV text, use an empty string (""), an empty array ([]) or 0 for it, do not guess.

Reply with exactly this JSON shape (all keys required, using the empty values above where unknown):
${JSON_SHAPE}

${FIELD_BULLETS}

Report only what this CV states about the candidate's past and present. Do not add any other key. In particular, do not state which roles this candidate is targeting, which roles they would consider, which role families they want excluded, which country they want to work in, or any salary expectation (${EXCLUDED_KEYS_SENTENCE}). A CV records what someone has done, not what they want next: those are the candidate's own choices to type in, and any such key in your answer is discarded before anything is saved.

=== CANDIDATE CV (${fieldPromptText(fileName)}) ===
${clampPromptText(text, MAX_CV_PROMPT_CHARS)}`;
}
