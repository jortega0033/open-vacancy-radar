/**
 * Name tables for CV autofill (#634): how a CV may write a country or a language, mapped to the
 * one English name the profile stores. Used by the grounding pass in `cv-autofill.ts` and by the
 * benchmark scorer. Lookup tables only, not defaults: nothing here is ever written to a profile
 * unless the CV itself names it.
 */

/** Folds case, accents, punctuation and whitespace. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** `foldText`, plus the digit-for-letter swaps OCR makes most often (1/l, 0/o, 5/s). Applied to
 * both sides of a comparison, so a real number still matches itself. */
export function foldLoose(text: string): string {
  return foldText(text).replace(/1/gu, 'l').replace(/0/gu, 'o').replace(/5/gu, 's');
}

/** Canonical English country name to other ways a CV writes it (local names, common codes).
 * Two-letter codes that are also everyday words ("in", "it", "de", "es", "be") are left out. */
const COUNTRY_ALIASES: Record<string, readonly string[]> = {
  Netherlands: ['the netherlands', 'nederland', 'holland', 'nl', 'pays bas', 'niederlande'],
  Belgium: ['belgie', 'belgique', 'belgien'],
  Germany: ['deutschland', 'allemagne', 'alemania'],
  Spain: ['espana', 'espanya', 'espagne'],
  Mexico: ['mx'],
  Philippines: ['the philippines', 'pilipinas', 'ph'],
  'Czech Republic': ['czechia', 'cesko', 'ceska republika', 'cz'],
  Portugal: ['pt'],
  Ireland: ['eire', 'ie'],
  'United Kingdom': ['uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'],
  'United States': ['usa', 'us', 'united states of america', 'u s', 'u s a'],
  Canada: ['ca'],
  Poland: ['polska', 'pl'],
  Sweden: ['sverige', 'se'],
  France: ['fr'],
  Italy: ['italia'],
  Austria: ['osterreich'],
  Switzerland: ['schweiz', 'suisse', 'svizzera', 'ch'],
  Denmark: ['danmark', 'dk'],
  Norway: ['norge'],
  Finland: ['suomi'],
  Romania: ['ro'],
  India: [],
  Indonesia: [],
  Vietnam: ['viet nam'],
  Brazil: ['brasil'],
  Argentina: [],
  Colombia: [],
  Chile: [],
  Peru: [],
  Nigeria: [],
  Ghana: [],
  Kenya: [],
  'South Africa': [],
  Australia: ['au'],
  'New Zealand': ['nz'],
  Singapore: ['sg'],
  Malaysia: [],
  Japan: [],
  'United Arab Emirates': ['uae'],
};

const COUNTRY_LOOKUP = new Map<string, string>();
for (const [name, aliases] of Object.entries(COUNTRY_ALIASES)) {
  COUNTRY_LOOKUP.set(foldText(name), name);
  for (const alias of aliases) COUNTRY_LOOKUP.set(foldText(alias), name);
}

/** The canonical country name for a value, or the trimmed value itself when it is not in the table. */
export function canonicalCountry(value: string): string {
  return COUNTRY_LOOKUP.get(foldText(value)) ?? value.replace(/\s+/gu, ' ').trim();
}

/** Every folded spelling of one country, the canonical name included. */
export function countrySpellings(value: string): string[] {
  const canonical = canonicalCountry(value);
  const aliases = COUNTRY_ALIASES[canonical] ?? [];
  return [foldText(canonical), ...aliases.map(foldText), foldText(value)];
}

/** Words that mark a sentence as being about nationality or citizenship, not where someone lives. */
export const NATIONALITY_MARKERS = [
  'nationality',
  'nationaliteit',
  'nacionalidad',
  'staatsangehorigkeit',
  'nationalite',
  'citizen',
  'citizenship',
  'passport',
  'born in',
  'place of birth',
  'geboren',
  'nationalidade',
  'statni obcanstvi',
];

const LANGUAGE_ALIASES: Record<string, readonly string[]> = {
  English: ['engels', 'ingles', 'englisch', 'anglais', 'anglictina', 'angličtina', 'inglese'],
  Dutch: ['nederlands', 'neerlandais', 'niederlandisch', 'flemish', 'vlaams', 'holandes'],
  German: ['duits', 'deutsch', 'aleman', 'allemand', 'nemcina', 'tedesco'],
  French: ['frans', 'francais', 'frances', 'franzosisch', 'francouzstina'],
  Spanish: ['spaans', 'espanol', 'castellano', 'spanisch', 'espagnol', 'spanelstina'],
  Valencian: ['valenciano', 'valencia', 'catalan valencian'],
  Catalan: ['catala', 'catalan'],
  Portuguese: ['portugues', 'portugees', 'portugiesisch'],
  Italian: ['italiano', 'italiaans', 'italienisch'],
  Czech: ['cestina', 'tsjechisch', 'tschechisch'],
  Polish: ['polski', 'pools', 'polnisch'],
  Romanian: ['roemeens', 'romana', 'rumanisch'],
  Tagalog: ['filipino', 'pilipino', 'wikang filipino'],
  Cebuano: ['bisaya', 'binisaya', 'visayan'],
  Arabic: ['arabisch', 'arabe'],
  Turkish: ['turks', 'turkce'],
  Tamil: [],
  Hindi: [],
  Marathi: [],
  Irish: ['gaeilge', 'irish gaelic'],
  Swedish: ['svenska', 'zweeds'],
  Twi: ['akan'],
  Yoruba: [],
  Igbo: [],
};

const LANGUAGE_LOOKUP = new Map<string, string>();
for (const [name, aliases] of Object.entries(LANGUAGE_ALIASES)) {
  LANGUAGE_LOOKUP.set(foldText(name), name);
  for (const alias of aliases) LANGUAGE_LOOKUP.set(foldText(alias), name);
}

/** Strips a level ("(native)", "- C1", ": fluent") and maps a local name to its English name. */
export function canonicalLanguage(value: string): string {
  const bare = value
    .replace(/\(.*?\)/gu, ' ')
    .split(/\s[-:]\s|:/u)[0]!
    .replace(/\b(native|fluent|basic|good|[abc][12])\b/giu, ' ');
  return LANGUAGE_LOOKUP.get(foldText(bare)) ?? bare.replace(/\s+/gu, ' ').trim();
}
