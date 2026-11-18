import type { CandidateProfile } from '../candidate/profile.js';
import { normalizeForMatching, plainText } from '../text/plain.js';

/**
 * Mandatory-versus-preferred language extraction for a job description (issue #280).
 *
 * Two properties this has to have, and that `test/eligibility/language.test.ts` pins:
 *
 * 1. "Fluent German is required" and "German is a plus" are different facts. Only the first one is
 *    ever allowed to gate anything; the second is recorded and ignored by every gate.
 * 2. The requirement is found wherever it is written. A language requirement is routinely the last
 *    bullet of a long posting, under a heading nobody reads, so this walks every line of the whole
 *    description rather than sniffing an opening paragraph.
 *
 * Nothing here reads a country, and nothing ranks one language above another: the vocabulary below
 * is alphabetical detection data, and the only language that can ever gate a vacancy is one the
 * candidate configured for themselves.
 */

export type LanguageObligation = 'mandatory' | 'preferred';

export type LanguageRequirement = {
  /** Canonical name from `LANGUAGE_TERMS`, so "Nederlands" and "Dutch" compare equal. */
  language: string;
  obligation: LanguageObligation;
  /** The sentence or bullet the obligation was read from, so a reader can check the call. */
  quote: string;
};

/**
 * Detection vocabulary, alphabetical. Aliases cover the endonyms and regional names that postings
 * actually use ("Nederlands", "Mandarin", "Bahasa Indonesia"). Extending this list is additive:
 * a language absent from it is simply never detected, which leaves a vacancy reviewable rather
 * than wrongly gated.
 */
const LANGUAGE_TERMS: readonly { language: string; alternatives: string }[] = [
  { language: 'Arabic', alternatives: 'arabic' },
  { language: 'Bengali', alternatives: 'bengali' },
  { language: 'Bulgarian', alternatives: 'bulgarian' },
  { language: 'Catalan', alternatives: 'catalan' },
  { language: 'Chinese', alternatives: 'chinese|mandarin|cantonese|putonghua' },
  { language: 'Croatian', alternatives: 'croatian|hrvatski' },
  { language: 'Czech', alternatives: 'czech|cestina' },
  { language: 'Danish', alternatives: 'danish|dansk' },
  { language: 'Dutch', alternatives: 'dutch|nederlands|flemish|vlaams' },
  { language: 'English', alternatives: 'english' },
  { language: 'Estonian', alternatives: 'estonian|eesti' },
  { language: 'Finnish', alternatives: 'finnish|suomi' },
  { language: 'French', alternatives: 'french|francais' },
  { language: 'German', alternatives: 'german|deutsch' },
  { language: 'Greek', alternatives: 'greek' },
  { language: 'Hebrew', alternatives: 'hebrew|ivrit' },
  { language: 'Hindi', alternatives: 'hindi' },
  { language: 'Hungarian', alternatives: 'hungarian|magyar' },
  { language: 'Indonesian', alternatives: 'indonesian|bahasa indonesia' },
  { language: 'Italian', alternatives: 'italian|italiano' },
  { language: 'Japanese', alternatives: 'japanese|nihongo' },
  { language: 'Korean', alternatives: 'korean|hangul' },
  { language: 'Latvian', alternatives: 'latvian|latviesu' },
  { language: 'Lithuanian', alternatives: 'lithuanian|lietuviu' },
  { language: 'Malay', alternatives: 'malay|bahasa melayu' },
  { language: 'Norwegian', alternatives: 'norwegian|norsk' },
  { language: 'Polish', alternatives: 'polish|polski' },
  { language: 'Portuguese', alternatives: 'portuguese|portugues' },
  { language: 'Romanian', alternatives: 'romanian|romana' },
  { language: 'Russian', alternatives: 'russian' },
  { language: 'Serbian', alternatives: 'serbian|srpski' },
  { language: 'Slovak', alternatives: 'slovak|slovencina' },
  { language: 'Slovenian', alternatives: 'slovenian|slovene' },
  { language: 'Spanish', alternatives: 'spanish|espanol|castilian' },
  { language: 'Swedish', alternatives: 'swedish|svenska' },
  { language: 'Tagalog', alternatives: 'tagalog|filipino' },
  { language: 'Thai', alternatives: 'thai' },
  { language: 'Turkish', alternatives: 'turkish|turkce' },
  { language: 'Ukrainian', alternatives: 'ukrainian' },
  { language: 'Urdu', alternatives: 'urdu' },
  { language: 'Vietnamese', alternatives: 'vietnamese|tieng viet' },
];

const LANGUAGE_PATTERNS: readonly { language: string; pattern: RegExp }[] = LANGUAGE_TERMS.map(
  ({ language, alternatives }) => ({
    language,
    pattern: new RegExp(`(?:^|[^a-z])(?:${alternatives})(?:$|[^a-z])`, 'u'),
  }),
);

/**
 * Checked before the mandatory markers, so "Dutch is a big plus" is never read as mandatory just
 * because "is a" also appears in "is a must". An explicit negation ("Dutch is not required") lands
 * here too: the posting went out of its way to say the language does not gate anything.
 */
const PREFERRED_MARKER =
  /\b(?:nice to have|nice-to-have|good to have|preferred|preferably|prefer|a plus|a big plus|a bonus|bonus points|desirable|advantageous|an advantage|beneficial|helpful|ideally|optional|welcome|appreciated|would be great|not (?:a )?(?:required|requirement|mandatory|necessary|needed)|no (?:requirement|need) for)\b/u;

const MANDATORY_MARKER =
  /\b(?:required|requirement|requirements|require|requires|mandatory|must|essential|necessary|need to|needs to|non-negotiable|only consider|proficiency|proficient|fluency|fluent|native|near-native|bilingual|business level|business-level|c1|c2|b2|working language|company language|business language|official language|we (?:work|communicate) in|all (?:communication|documentation|meetings) (?:is|are|happens|happen) in)\b/u;

/**
 * Heading context, so a bare "Dutch" bullet is read the way the posting's own layout reads it.
 * A marker inside the bullet itself always wins over the heading it sits under.
 */
const REQUIREMENT_HEADING =
  /^(?:requirements|what you(?:'|’)?ll need|what you will need|what you bring|must have|must[- ]haves|your skills|qualifications|who you are|what we(?:'|’)?re looking for|we are looking for)\s*:?$/u;

const PREFERENCE_HEADING =
  /^(?:nice to have|nice[- ]to[- ]haves|preferred(?: qualifications)?|bonus(?: points)?|good to have|desirable|pluses|extra credit)\s*:?$/u;

/**
 * Headings that end an inherited requirement/preference context without starting one of their own
 * (issue #713). Without this, a bare language mention under a later "About us" section inherits the
 * "mandatory" state from a Requirements list several screens above it, and an unclear sentence that
 * states no obligation at all is turned into an eligibility "no".
 *
 * This list is deliberately a closed vocabulary of the unrelated sections postings actually use,
 * not a general "short line without a full stop is a heading" rule. A heading absent from it simply
 * keeps today's behaviour, so extending the list can only ever remove invented requirements.
 */
const SECTION_BREAK_HEADING =
  /^(?:about (?:us|the (?:company|team|role|job|position))|who we are|our (?:team|company|story|culture|mission|values)|benefits|benefits(?: and | & )perks|perks(?:(?: and | & )benefits)?|what we offer|we offer|compensation(?:(?: and | & )benefits)?|salary(?:(?: and | & )benefits)?|how to apply|application(?: process)?|apply(?: now)?|interview process|hiring process|equal opportunity(?: employer)?|diversity(?:(?: and | & )inclusion)?|location|about this role|the role|responsibilities|what you(?:'|’)?ll do|what you will do|your role|the job)\s*:?$/u;

/**
 * Markdown survives into many scraped descriptions. A heading written as "## About us",
 * "**Requirements**" or "- **Nice to have**" has to be read as the same heading as its plain-text
 * form, otherwise the heading rules above see "## about us" and match nothing: a requirements
 * context then leaks straight past a markdown "About us" into whatever follows it (issue #713).
 * Only the line's own markers are removed; the words are untouched.
 */
function stripMarkdownLineMarkers(rawLine: string): string {
  // A bullet `*` needs a following space, so the opening `**` of a bold heading is left alone.
  const unprefixed = rawLine.replace(/^\s*(?:#{1,6}\s*|[-•]\s*|\*\s+)+/u, '').trim();
  const line = /^#{1,6}\s/u.test(rawLine.trim()) ? unprefixed.replace(/\s+#+$/u, '') : unprefixed;
  return line.replace(/^(\*\*|__|\*|_)(.+)\1$/u, '$2').trim();
}

/**
 * True for a line whose own markers say "heading": "## About us", "**About us**", "__About us__".
 * A bullet is never one, whatever its emphasis: "- **Spanish**" under Requirements is a list item
 * in bold, and reading it as a section heading would drop the context for it and every bullet after.
 */
function isMarkedUpHeadingLine(rawLine: string): boolean {
  const line = rawLine.trim();
  if (/^#{1,6}\s/u.test(line)) return true;
  if (/^[-*•]\s/u.test(line)) return false;
  return /^(?:\*\*|__)(?:[^*_]|\*(?!\*)|_(?!_))+(?:\*\*|__)$/u.test(line);
}

type Sentence = {
  text: string;
  /** Whether the line this came from was marked up as a heading, whatever its wording. */
  markedUpHeading: boolean;
};

function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const rawLine of plainText(text).split('\n')) {
    const line = stripMarkdownLineMarkers(rawLine);
    if (line.length === 0) continue;
    const markedUpHeading = isMarkedUpHeadingLine(rawLine);
    for (const sentence of line.split(/(?<=[.!?;])\s+|\s+•\s+/u)) {
      const trimmed = sentence.trim();
      if (trimmed.length > 0) out.push({ text: trimmed, markedUpHeading });
    }
  }
  return out;
}

const MAXIMUM_QUOTE_LENGTH = 240;

function quoteOf(sentence: string): string {
  return sentence.length <= MAXIMUM_QUOTE_LENGTH
    ? sentence
    : `${sentence.slice(0, MAXIMUM_QUOTE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Every language obligation stated anywhere in `text`, in the order the posting states them.
 *
 * A language mentioned with neither an in-sentence marker nor a requirement/preference heading
 * above it produces nothing at all. That is the deliberate direction to fail in: inventing a
 * mandatory requirement out of an incidental mention would gate a vacancy on something nobody
 * asked for, while missing one leaves the vacancy exactly where it already was, reviewable.
 *
 * Known limitation (#713, corpus case L03): heading context still reaches an unclear sentence that
 * follows a requirements list directly, with no heading of any kind in between -- "Requirements /
 * ... / Our team speaks German and English day to day." is read as mandatory German. That is the
 * posting's own layout speaking, and narrowing it means dropping heading inheritance altogether,
 * which is the behaviour that reads a bare "- Spanish" bullet correctly. Left as is on purpose.
 */
export function detectLanguageRequirements(text: string | null | undefined): LanguageRequirement[] {
  if (!text) return [];
  const found = new Map<string, LanguageRequirement>();
  let heading: LanguageObligation | null = null;

  for (const { text: sentence, markedUpHeading } of sentencesOf(text)) {
    const normalized = normalizeForMatching(sentence);
    if (REQUIREMENT_HEADING.test(normalized)) {
      heading = 'mandatory';
      continue;
    }
    if (PREFERENCE_HEADING.test(normalized)) {
      heading = 'preferred';
      continue;
    }
    if (SECTION_BREAK_HEADING.test(normalized)) {
      // An unrelated section ends the previous heading's reach; it does not start a new one.
      heading = null;
      continue;
    }
    if (markedUpHeading) {
      // A heading whose wording is in no vocabulary ("## Our stack", "**Life at Acme**") ends the
      // reach too: its own markup says it starts a new section, which is a structural fact and not
      // the "short line without a full stop" guess #713 ruled out. No `continue`, so a heading that
      // states an obligation itself ("## Fluent German is required") is still read below.
      heading = null;
    }

    const languages = LANGUAGE_PATTERNS.filter(({ pattern }) => pattern.test(normalized)).map(
      ({ language }) => language,
    );
    if (languages.length === 0) continue;

    const obligation: LanguageObligation | null = PREFERRED_MARKER.test(normalized)
      ? 'preferred'
      : MANDATORY_MARKER.test(normalized)
        ? 'mandatory'
        : heading;
    if (obligation === null) continue;

    for (const language of languages) {
      const existing = found.get(language);
      // A language stated both ways keeps the stronger obligation: a posting that lists German
      // under "nice to have" and then says "German is required" three screens later requires it.
      if (existing === undefined || (existing.obligation === 'preferred' && obligation === 'mandatory')) {
        found.set(language, { language, obligation, quote: quoteOf(sentence) });
      }
    }
  }

  return [...found.values()];
}

/** The canonical name for a free-text language, or null when it is not in the vocabulary above. */
export function canonicalLanguageName(value: string): string | null {
  const normalized = normalizeForMatching(value).trim();
  if (normalized.length === 0) return null;
  return (
    LANGUAGE_PATTERNS.find(({ pattern }) => pattern.test(` ${normalized} `))?.language ?? null
  );
}

/**
 * Splits the candidate profile's single free-text `constraints.professionalLanguage` field into the
 * languages it names. The field has always been free text ("English", "English, Dutch",
 * "English / German"), and reading it as a list is the whole of the candidate-side configuration
 * this feature needs: no new profile field, and nothing is assumed when the field is left empty.
 */
export function parseCandidateLanguages(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[,;/&+]|\band\b/iu)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const canonical = canonicalLanguageName(trimmed) ?? trimmed;
    const identity = normalizeForMatching(canonical);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(canonical);
  }
  return out;
}

/** Empty for an unconfigured profile, which is what keeps every language gate inert by default. */
export function candidateWorkLanguages(profile: CandidateProfile): string[] {
  return parseCandidateLanguages(profile.constraints.professionalLanguage);
}

export function candidateCoversLanguage(
  candidateLanguages: readonly string[],
  language: string,
): boolean {
  const required = normalizeForMatching(canonicalLanguageName(language) ?? language).trim();
  return candidateLanguages.some((candidate) => {
    const held = normalizeForMatching(canonicalLanguageName(candidate) ?? candidate).trim();
    return held.length > 0 && held === required;
  });
}

/**
 * The mandatory requirements the candidate does not meet. Empty when the candidate configured no
 * language at all: an unconfigured profile cannot fail a language check, it can only leave it
 * unanswered, and every caller treats the empty result as "nothing to enforce".
 */
export function uncoveredMandatoryLanguages(
  requirements: readonly LanguageRequirement[],
  candidateLanguages: readonly string[],
): LanguageRequirement[] {
  if (candidateLanguages.length === 0) return [];
  return requirements.filter(
    (requirement) =>
      requirement.obligation === 'mandatory' &&
      !candidateCoversLanguage(candidateLanguages, requirement.language),
  );
}
