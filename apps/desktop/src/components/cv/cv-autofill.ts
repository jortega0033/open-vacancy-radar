import { extractAiJsonPayload } from '../cv-library/cv-ai-parse.js';
import {
  NATIONALITY_MARKERS,
  canonicalCountry,
  canonicalLanguage,
  countrySpellings,
  foldLoose,
  foldText,
} from './cv-autofill-normalize.js';
import {
  GROUNDING_RULES,
  MAX_CV_PROMPT_CHARS,
  clampPromptText,
  fieldPromptText,
} from './prompts.js';

/**
 * CV autofill (#634): one extraction contract for everything the app reads off a CV to fill the
 * CV record and "What you are looking for". See `docs/adr-cv-autofill.md` for the design.
 *
 * This module is pure: one prompt, one parser, one grounding pass. It never talks to the AI tool
 * and never saves anything. The caller runs the prompt through the user's own CLI (the daemon
 * path every other AI feature uses) and decides what to write; the benchmark in
 * `test/cv-autofill/` scores exactly the parser and grounding pass below.
 *
 * Two fields stay out of this contract on purpose, whatever the model answers: excluded role
 * families and a minimum salary. A CV has no signal for either (see `search-profile-cv-bridge.ts`).
 * The parser reads every field by name, so a key the contract does not declare is never read.
 */

export const CV_AUTOFILL_FIELDS = [
  'candidateName',
  'currentRole',
  'location',
  'primaryCountry',
  'experienceYears',
  'languages',
  'strongestSkills',
  'additionalSkills',
  'targetRoles',
  'consideredRoles',
  'links',
  'summary',
  'workAuthorization',
] as const;

export type CvAutofillField = (typeof CV_AUTOFILL_FIELDS)[number];

export type CvAutofillConfidence = 'high' | 'low';

export interface CvAutofillValues {
  candidateName: string;
  currentRole: string;
  location: string;
  primaryCountry: string;
  experienceYears: number;
  languages: string[];
  strongestSkills: string[];
  additionalSkills: string[];
  targetRoles: string[];
  consideredRoles: string[];
  links: string[];
  summary: string;
  workAuthorization: string;
}

export interface CvAutofillEntry<K extends CvAutofillField> {
  value: CvAutofillValues[K];
  confidence: CvAutofillConfidence;
  /** A short excerpt of the CV behind the value, shown on demand in the review. Empty when the
   * model gave none or gave one that is not in the CV text. */
  evidence: string;
}

/** Only fields the CV actually supplied are present. An absent key means "the CV does not say". */
export type CvAutofillResult = { [K in CvAutofillField]?: CvAutofillEntry<K> };

type FieldKind = 'string' | 'number' | 'list';

const FIELD_KINDS: Record<CvAutofillField, FieldKind> = {
  candidateName: 'string',
  currentRole: 'string',
  location: 'string',
  primaryCountry: 'string',
  experienceYears: 'number',
  languages: 'list',
  strongestSkills: 'list',
  additionalSkills: 'list',
  targetRoles: 'list',
  consideredRoles: 'list',
  links: 'list',
  summary: 'string',
  workAuthorization: 'string',
};

export const CV_AUTOFILL_FIELD_DESCRIPTIONS: Record<CvAutofillField, string> = {
  candidateName: "the candidate's full name as the CV writes it.",
  currentRole:
    'the job title the candidate holds now, or the most recent one, as the CV words it. If the CV never states a title, use the title that best names the most recent work it describes and mark confidence "low".',
  location:
    'where the candidate is based now, as the CV states it (for example "Utrecht, Netherlands").',
  primaryCountry:
    'the country the candidate is based in now, as an English country name. Only from a stated current address, city or country. Leave it empty rather than infer it from a past employer, a nationality or a language.',
  experienceYears:
    'total years of professional experience as a whole number, counted from the earliest professional role to now or the latest end date. 0 when the CV gives no dates to count from.',
  languages:
    'spoken languages the CV names, as English language names without levels (for example ["English", "Dutch"]). Put the language the candidate works in day to day first.',
  strongestSkills:
    'up to 10 skills or tools the CV evidences most strongly: used in the most recent or longest roles, or named repeatedly. Short names only.',
  additionalSkills:
    'up to 20 further skills or tools the CV names that are not in strongestSkills.',
  targetRoles:
    'up to 5 job titles the candidate is suited for, worded as job postings word them, based only on roles the CV shows them doing. A stated career change or objective counts as evidence.',
  consideredRoles:
    'up to 5 adjacent job titles the candidate could also do, not already in targetRoles.',
  links:
    'LinkedIn, GitHub, portfolio or personal site addresses exactly as the CV writes them. No email addresses.',
  summary:
    "a 2 to 3 sentence neutral summary of the candidate's background, drawn only from the CV.",
  workAuthorization: 'work permit or visa status if the CV states it, otherwise "".',
};

const JSON_TYPES: Record<FieldKind, string> = {
  string: 'string',
  number: 'number',
  list: 'string[]',
};

const JSON_SHAPE = `{${CV_AUTOFILL_FIELDS.map(
  (key) =>
    `"${key}": {"value": ${JSON_TYPES[FIELD_KINDS[key]]}, "confidence": "high" | "low", "evidence": string}`,
).join(', ')}}`;

const FIELD_BULLETS = CV_AUTOFILL_FIELDS.map(
  (key) => `- "${key}": ${CV_AUTOFILL_FIELD_DESCRIPTIONS[key]}`,
).join('\n');

/**
 * The one prompt that replaces `buildCvParsePrompt` (CV record) and
 * `buildSearchProfileFromCvPrompt` (search profile). Untrusted CV text is clamped exactly as the
 * two prompts it replaces clamp it.
 */
export function buildCvAutofillPrompt(fileName: string, text: string): string {
  return `You extract structured fields from one candidate's CV text. Read the CV below and reply with a single JSON object only: no Markdown code fence, no commentary before or after it.

${GROUNDING_RULES}
The CV may be in any language, may come from a two-column layout flattened to text, or from a scan with OCR errors. Read it as a person would; reply with field values in the CV's own wording, except country and language names, which are in English.
Never invent a value: when the CV does not state a field, use "" or [] or 0 as its value and leave evidence empty.
For every field, "confidence" is "high" when the CV states the value directly and "low" when you had to infer it or the text is unclear. "evidence" is a short exact quote (at most 120 characters) copied from the CV that supports the value.
Do not add any other key. Do not state excluded role families or any salary: a CV has no signal for either.

Reply with exactly this JSON shape (all keys required):
${JSON_SHAPE}

${FIELD_BULLETS}

=== CANDIDATE CV (${fieldPromptText(fileName)}) ===
${clampPromptText(text, MAX_CV_PROMPT_CHARS)}`;
}

/** Mirrors the save-time limits of the two records this feeds (`SEARCH_PROFILE_CV_LIMITS`,
 * `CV_PROFILE_LIMITS`): the tighter of the two per field. */
export const CV_AUTOFILL_LIMITS = {
  shortField: 200,
  summary: 2000,
  evidence: 240,
  listEntries: 50,
  experienceYearsMax: 80,
} as const;

const LIST_CAPS: Partial<Record<CvAutofillField, number>> = {
  strongestSkills: 10,
  additionalSkills: 20,
  targetRoles: 5,
  consideredRoles: 5,
  languages: 10,
  links: 10,
};

function flatString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flattened = value.replace(/\s+/gu, ' ').trim().slice(0, limit).trim();
  return flattened.length > 0 ? flattened : undefined;
}

function list(value: unknown, cap: number): string[] | undefined {
  const raw =
    typeof value === 'string' ? value.split(/[,;]/u) : Array.isArray(value) ? value : undefined;
  if (!raw) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = flatString(entry, CV_AUTOFILL_LIMITS.shortField);
    if (!item) continue;
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out.length > 0 ? out : undefined;
}

function years(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.round(parsed);
  if (rounded <= 0) return undefined;
  return Math.min(rounded, CV_AUTOFILL_LIMITS.experienceYearsMax);
}

function readValue(
  key: CvAutofillField,
  value: unknown,
): CvAutofillValues[CvAutofillField] | undefined {
  switch (FIELD_KINDS[key]) {
    case 'number':
      return years(value);
    case 'list': {
      const items = list(value, LIST_CAPS[key] ?? CV_AUTOFILL_LIMITS.listEntries);
      if (key !== 'languages' || !items) return items;
      return list(items.map(canonicalLanguage), LIST_CAPS.languages!);
    }
    case 'string': {
      const text = flatString(
        value,
        key === 'summary' ? CV_AUTOFILL_LIMITS.summary : CV_AUTOFILL_LIMITS.shortField,
      );
      return key === 'primaryCountry' && text ? canonicalCountry(text) : text;
    }
  }
}

/** Folds case, accents, punctuation and whitespace so an evidence quote survives OCR spacing and a
 * model that tidies quotes or dashes. */
export const foldForMatch = foldText;

/**
 * Reads the model's parsed JSON. Accepts both the contract shape (`{"value", "confidence",
 * "evidence"}` per field) and a bare value per field, because CLIs sometimes drop the wrapper; a
 * bare value has no stated confidence, so it is read as low.
 */
export function toCvAutofillResult(value: unknown): CvAutofillResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: Record<string, CvAutofillEntry<CvAutofillField>> = {};
  for (const key of CV_AUTOFILL_FIELDS) {
    const raw = record[key];
    const wrapped =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : undefined;
    const parsed = readValue(key, wrapped ? wrapped.value : raw);
    if (parsed === undefined) continue;
    const confidence: CvAutofillConfidence = wrapped?.confidence === 'high' ? 'high' : 'low';
    const evidence = flatString(wrapped?.evidence, CV_AUTOFILL_LIMITS.evidence) ?? '';
    result[key] = { value: parsed, confidence, evidence };
  }
  return result as CvAutofillResult;
}

/**
 * The deterministic check that runs after the model, so confidence does not rest on the model's
 * own say-so. Matching folds case, accents, punctuation and the usual OCR digit-for-letter swaps.
 * - Evidence must be found in the CV text. Evidence that is not there is cleared and the field
 *   drops to low confidence.
 * - A country is kept only when found evidence names it (or a local name for it), or when the
 *   evidence is the stated location itself (a city or address). Evidence about nationality or
 *   citizenship never counts, and a country with no such support is dropped, not kept as a guess:
 *   country feeds an eligibility check, so a blank costs less than a wrong value.
 * - Links must appear in the CV text; a link the model made up is dropped.
 */
export function groundCvAutofill(result: CvAutofillResult, cvText: string): CvAutofillResult {
  const haystack = ` ${foldLoose(cvText)} `;
  const inCv = (needle: string) => {
    const folded = foldLoose(needle);
    return folded.length > 0 && haystack.includes(` ${folded} `);
  };
  const out: Record<string, CvAutofillEntry<CvAutofillField>> = {};
  for (const key of CV_AUTOFILL_FIELDS) {
    const entry = result[key] as CvAutofillEntry<CvAutofillField> | undefined;
    if (!entry) continue;
    const grounded = entry.evidence !== '' && inCv(entry.evidence);
    let next: CvAutofillEntry<CvAutofillField> = grounded
      ? entry
      : { ...entry, evidence: '', confidence: 'low' };
    if (
      key === 'primaryCountry' &&
      !countrySupported(
        String(entry.value),
        grounded ? entry.evidence : '',
        result.location?.value,
        inCv,
      )
    ) {
      continue;
    }
    if (key === 'links') {
      const kept = (entry.value as string[]).filter((link) => inCv(link));
      if (kept.length === 0) continue;
      next = { ...next, value: kept };
    }
    out[key] = next;
  }
  return out as CvAutofillResult;
}

function containsPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}

function countrySupported(
  country: string,
  evidence: string,
  location: string | undefined,
  inCv: (needle: string) => boolean,
): boolean {
  const spellings = countrySpellings(country);
  const foldedEvidence = foldText(evidence);
  if (NATIONALITY_MARKERS.some((marker) => containsPhrase(foldedEvidence, foldText(marker))))
    return false;
  const foldedLocation = location && inCv(location) ? foldText(location) : '';
  // The location field itself names the country ("Utrecht, Nederland").
  if (spellings.some((name) => containsPhrase(foldedLocation, name))) return true;
  if (!foldedEvidence) return false;
  // The evidence names the country.
  if (spellings.some((name) => containsPhrase(foldedEvidence, name))) return true;
  // The evidence is the stated location (a city or an address), so the country is read from it.
  return (
    foldedLocation !== '' &&
    foldedLocation
      .split(' ')
      .some((token) => token.length > 2 && containsPhrase(foldedEvidence, token))
  );
}

/** Parses and grounds one response. Throws a user-facing message when it is not usable JSON. */
export function parseCvAutofillResponse(raw: string, cvText: string): CvAutofillResult {
  let value: unknown;
  try {
    value = JSON.parse(extractAiJsonPayload(raw));
  } catch {
    throw new Error('Could not read your CV this time. Try again or fill the fields yourself.');
  }
  return groundCvAutofill(toCvAutofillResult(value), cvText);
}

/** The plain values of a result, for callers and the benchmark that do not need confidence. */
export function cvAutofillValues(result: CvAutofillResult): Partial<CvAutofillValues> {
  const out: Record<string, unknown> = {};
  for (const key of CV_AUTOFILL_FIELDS) {
    const entry = result[key];
    if (entry) out[key] = entry.value;
  }
  return out as Partial<CvAutofillValues>;
}
