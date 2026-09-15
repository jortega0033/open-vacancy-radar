import {
  GROUNDING_RULES,
  MAX_CV_PROMPT_CHARS,
  clampPromptText,
  fieldPromptText,
} from './prompts.js';

/**
 * "Fill from CV" (issue #137, widened by the same ticket's follow-up at the user's explicit
 * request): the prompt that bridges one CV from the library into the search profile
 * (`SearchProfileSection`).
 *
 * A separate module from `prompts.ts` on purpose, and deliberately narrow.
 *
 * `buildCvParsePrompt` in `prompts.ts` already does the same *kind* of work (free CV text in, one
 * JSON object out, reviewed by the user before anything is saved) for a different target, the CV
 * library's own `cvDocuments.profile`. This one targets the search profile, which is a different
 * animal: only some of its fields are statements of fact about the candidate's past.
 *
 * Two fields stay permanently excluded no matter how this list changes:
 * `excludedRoleFamilies` and `constraints.minimumMonthlyBaseEur`. Not because filling them per-user
 * would ship a biased default (the no-shipped-default-bias rule this project follows -- see
 * `config/candidate-profile-v1.json` shipping every such field empty, issues #56/#64 -- is about
 * what every fresh install gets, not about what one user's own review-gated action can write to
 * their own profile) but because a CV genuinely carries no signal for either: nothing on a resume
 * states which role families its author refuses to do, and a past salary is not a stated future
 * floor. Asking a model to fill those in would not be reading the CV, it would be inventing an
 * answer and presenting it as read from one.
 *
 * `targetRoles`, `consideredRoles` and `constraints.primaryCountry` moved the other way: a CV's own
 * job history is a reasonable, defensible signal for what roles its author is suited for and has
 * been doing, and its stated current location is a reasonable signal for the country they are based
 * in -- both are still run past the same editable review panel before anything saves, exactly like
 * every other field here, so a thin or wrong guess costs a glance, not corrupted profile data.
 *
 * So this prompt asks for exactly the fields named below and no others. The wording says so, but
 * the wording is not the control: `search-profile-cv-bridge.ts` reads exactly these keys off the
 * response and builds the IPC patch from an explicit object literal, so a response that names an
 * excluded field cannot reach the profile whatever it says. Treat the paragraph in the prompt as a
 * way to get a better answer, not as the thing that makes an unwanted one harmless.
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
  'targetRoles',
  'consideredRoles',
  'primaryCountry',
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
  targetRoles: 'string[]',
  consideredRoles: 'string[]',
  primaryCountry: 'string',
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
  targetRoles:
    'up to 5 job titles the candidate is well suited for based on their most recent and longest-held roles, worded the way job postings would (for example "Frontend Engineer", not "someone who builds UIs"). Base this only on roles the CV actually shows them doing, never on aspiration the CV does not evidence.',
  consideredRoles:
    'up to 5 further, adjacent job titles the candidate could reasonably also do based on the CV, that did not make the list above. No duplicates of it.',
  primaryCountry:
    'the single country the candidate is currently based in, only when the CV states it directly or through an unambiguous current address or city (for example "Netherlands"). Use the country name, not an abbreviation or a city alone. Leave it empty rather than infer a country from a past employer, a nationality, or a language mentioned on the CV: this feeds a real eligibility check, so a wrong guess costs more than a blank.',
};

/** Named here so the prompt can list them, and so the paragraph below can never quietly disagree
 * with the set `search-profile-cv-bridge.ts` refuses to write. These two stay excluded regardless
 * of what `SEARCH_PROFILE_CV_FIELDS` grows to, because a CV has no signal for either -- see this
 * module's own doc comment. */
export const SEARCH_PROFILE_CV_EXCLUDED_FIELDS = ['excludedRoleFamilies', 'minimumMonthlyBaseEur'] as const;

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
 * Reads one CV and returns the search-profile fields a CV can honestly state or reasonably imply.
 * The answer is never saved directly: `FillProfileFromCv` shows it to the user in an editable
 * review panel first, so a thin or wrong extraction costs a glance, not corrupted profile data.
 */
export function buildSearchProfileFromCvPrompt(fileName: string, text: string): string {
  return `You extract structured fields from one candidate's CV text. Read the CV below and reply with a single JSON object only: no Markdown code fence, no commentary before or after it.

${GROUNDING_RULES}
Never invent a value: if a field is not stated or cannot be inferred from the CV text, use an empty string (""), an empty array ([]) or 0 for it, do not guess.

Reply with exactly this JSON shape (all keys required, using the empty values above where unknown):
${JSON_SHAPE}

${FIELD_BULLETS}

"targetRoles" and "consideredRoles" must be grounded in roles this CV actually shows the candidate doing, never in aspiration or a role the CV gives no evidence for. "primaryCountry" must come from a stated location, never from a past employer's country, a nationality, or a language: leave it empty rather than guess. Do not add any other key. In particular, do not state which role families this candidate wants excluded, or any salary expectation (${EXCLUDED_KEYS_SENTENCE}): a CV has no signal for either, so naming one would be inventing an answer, not reading one. Those stay the candidate's own choices to type in, and any such key in your answer is discarded before anything is saved.

=== CANDIDATE CV (${fieldPromptText(fileName)}) ===
${clampPromptText(text, MAX_CV_PROMPT_CHARS)}`;
}
