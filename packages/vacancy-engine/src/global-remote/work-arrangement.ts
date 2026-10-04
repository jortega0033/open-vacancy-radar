import { normalizeCountry } from '../geo/countries.js';

/**
 * Best-effort on-site / hybrid / remote detection over a vacancy's own title, location and
 * description text (issue #565a). It is a hint, never a guarantee: it only reads wording, the
 * wording can be wrong or boilerplate, and anything ambiguous returns `unknown`. It carries no
 * role or country bias and is pure, so it can run on stored reports that predate it.
 */
export type WorkArrangement = 'onsite' | 'hybrid' | 'remote' | 'unknown';

export interface WorkArrangementDetection {
  arrangement: WorkArrangement;
  /** The short piece of source text the call rests on, or null for `unknown`. */
  evidence: string | null;
}

export interface WorkArrangementInput {
  title?: string | null;
  location?: string | null;
  description?: string | null;
}

const UNKNOWN: WorkArrangementDetection = { arrangement: 'unknown', evidence: null };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const NUM = String.raw`(?:[1-5]|one|two|three|four|five)`;
const NUM_RANGE = String.raw`(${NUM}(?:\s*(?:-|to|or)\s*${NUM})?)`;
const OFFICE = String.raw`(?:office|on-?site|in[- ]person|headquarters|hq|campus|studio|hub)`;
const OFFICE_RE = new RegExp(OFFICE, 'iu');

function toDays(raw: string): number {
  const parts = raw.toLowerCase().match(/[1-5]|one|two|three|four|five/gu) ?? [];
  const values = parts.map((part) => NUMBER_WORDS[part] ?? Number(part));
  return values.length === 0 ? 0 : Math.max(...values);
}

/** A sentence that says the job is remote-first or has no office cancels office wording inside it. */
const REMOTE_FIRST =
  /(?:fully|100%|completely|entirely|totally)\s+remote|remote[- ](?:first|only)|\bno (?:physical )?(?:office|commute)|work from anywhere|distributed (?:team|company)|office[- ]?less|\boptional\b|\bvoluntary\b|once an? (?:year|quarter|month)|(?:once|twice) (?:per|a|every) (?:year|quarter|month)|\bannual(?:ly)? (?:meet|retreat|offsite|visit)|\boccasional(?:ly)?\b/iu;

const NEGATED_PREFIX = /\b(?:no|not|non|never|without|isn'?t|aren'?t)\s*[- ]?(?:an?\s+|the\s+)?$/iu;
const NEGATED_SUFFIX = /^\s*(?:is|are)?\s*(?:not\b|n't\b|never\b)/iu;

const ONSITE_NOT_WORK =
  /^[\s-]*(?:interview|interviews|visit|visits|event|events|meeting|meetings|offsite|retreat|team ?building|training)/iu;

const HYBRID_NOT_WORK =
  /^[\s-]*(?:cloud|clouds|app|apps|application|applications|mobile|infrastructure|environment|environments|search|model|models|vehicle|vehicles|car|cars|data|ai|events?|encryption|storage|analytics|deployments?|stack|solution|solutions|architecture|networks?)\b/iu;

const REGION_ONLY =
  /^(?:an?\s+|the\s+)?(?:u\.?s\.?a?\.?|united states|uk|u\.k\.|united kingdom|eu|e\.u\.|europe|european union|emea|latam|apac|north america|south america|americas|asia|africa|oceania|[a-z]+ time ?zone|cet|est|pst|gmt|utc|cst|mst|country|same country)\b/iu;

function clean(text: string): string {
  return text
    // `[^<>]`, not `[^>]`: a run of "<" with no ">" stays linear instead of polynomial.
    .replace(/<[^<>]*>/gu, ' ')
    .replace(/[\u00a0\u2009\u202f]/gu, ' ')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[ \t]+/gu, ' ');
}

function sentences(text: string): string[] {
  return clean(text)
    .split(/(?<=[.!?])\s+|\n+|\s\|\s|;\s/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const MAX_EVIDENCE = 140;

/** The sentence itself when short, otherwise a window of it around the match. */
function snippet(sentence: string, index: number): string {
  if (sentence.length <= MAX_EVIDENCE) return sentence;
  const start = Math.max(0, Math.min(index - 50, sentence.length - MAX_EVIDENCE));
  const end = Math.min(sentence.length, start + MAX_EVIDENCE);
  return `${start > 0 ? '...' : ''}${sentence.slice(start, end).trim()}${end < sentence.length ? '...' : ''}`;
}

interface Hit {
  arrangement: 'onsite' | 'hybrid';
  evidence: string;
}

function negated(sentence: string, index: number): boolean {
  return NEGATED_PREFIX.test(sentence.slice(Math.max(0, index - 16), index));
}

/** The first on-site or hybrid wording in one sentence, or null. Hybrid wins within a sentence. */
function scanSentence(sentence: string): Hit | null {
  if (REMOTE_FIRST.test(sentence)) return null;
  const hit = (arrangement: Hit['arrangement'], index: number): Hit => ({
    arrangement,
    evidence: snippet(sentence, index),
  });

  for (const match of sentence.matchAll(/\bhybrid\b/giu)) {
    const index = match.index ?? 0;
    if (negated(sentence, index) || NEGATED_SUFFIX.test(sentence.slice(index + match[0].length))) continue;
    if (HYBRID_NOT_WORK.test(sentence.slice(index + match[0].length))) continue;
    return hit('hybrid', index);
  }
  for (const match of sentence.matchAll(
    /\b(?:partly|partially|part)[- ]remote\b|\bsplit between (?:home|remote)[^.]{0,30}\boffice\b|\b(?:home|remote)\s*(?:and|\/|&)\s*(?:office|on-?site)\b/giu,
  )) {
    return hit('hybrid', match.index ?? 0);
  }

  // "three days per week in the office", "2-3 days a week on-site", "in-office 4 days".
  const dayPatterns = [
    new RegExp(String.raw`\b${NUM_RANGE}\s+days?\s+(?:a|per|each|every|/)\s*week\b`, 'giu'),
    new RegExp(String.raw`\b${NUM_RANGE}\s+days?\s+(?:in|at|from)\s+(?:the\s+|our\s+|an?\s+)?(?:[a-z]+\s+)?${OFFICE}`, 'giu'),
    new RegExp(String.raw`\b(?:in[- ]office|on-?site|office)\s+(?:for\s+)?${NUM_RANGE}\s+days?\b`, 'giu'),
  ];
  for (const pattern of dayPatterns) {
    for (const match of sentence.matchAll(pattern)) {
      const index = match.index ?? 0;
      const days = toDays(match[1] ?? '');
      if (days === 0) continue;
      const window = sentence.slice(Math.max(0, index - 70), index + match[0].length + 40);
      if (!OFFICE_RE.test(window)) continue;
      // The day count sits next to "remote" only, with no office word beside it.
      const near = sentence.slice(Math.max(0, index - 25), index + match[0].length + 25);
      if (/\bremote(?:ly)?\b|\bfrom home\b|\bwfh\b/iu.test(near) && !OFFICE_RE.test(near)) continue;
      return hit(days >= 5 ? 'onsite' : 'hybrid', index);
    }
  }

  const onsitePatterns: RegExp[] = [
    /\bon-?site\b/giu,
    /\bin[- ]office\b/giu,
    /\boffice[- ]based\b/giu,
    /\bwork(?:ing)? from (?:the|our|a|an)\s+(?:[a-z][\w'.-]*\s+){0,2}(?:office|hq|headquarters)\b/giu,
    /\b(?:required|expected|need(?:ed)?|must)\s+(?:to\s+)?(?:be|work)\s+(?:in|from|at)\s+(?:the|our)\s+(?:[A-Za-z]+\s+)?office\b/giu,
    /\b(?:office|on-?site) presence (?:is )?required\b/giu,
    /\bwithin (?:a )?commut(?:ing|able) distance\b/giu,
    /\b(?:must|will need to|need to|required to|willing to|able to|open to)\s+relocate\b/giu,
    /\brelocation (?:is )?(?:required|mandatory|necessary|expected)\b/giu,
  ];
  for (const pattern of onsitePatterns) {
    for (const match of sentence.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (negated(sentence, index)) continue;
      if (/^on-?site$/iu.test(match[0]) && ONSITE_NOT_WORK.test(sentence.slice(index + match[0].length))) continue;
      return hit('onsite', index);
    }
  }

  const located =
    /\b(?:must|need to|required to|have to)\s+(?:be\s+)?(?:located|based|living|residing|resident|live|reside)\s+(?:in|near|within|around)\s+(?:or near\s+)?([^,.;()]{2,40})/giu;
  for (const match of sentence.matchAll(located)) {
    const place = (match[1] ?? '').trim();
    if (REGION_ONLY.test(place) || normalizeCountry(place) !== null) continue;
    if (/\bremote/iu.test(sentence)) continue;
    return hit('onsite', match.index ?? 0);
  }
  return null;
}

/**
 * Every pattern in `scanSentence` needs one of these words, so text without any is skipped without
 * splitting or running the full set. Keeps a 20,000-row report fast to map.
 */
const TRIGGER = /hybrid|remote|office|on-?site|in[- ]person|headquarters|\bhq\b|campus|studio|\bhub\b|commut|relocat|locat|based|living|resid|\blive\b/iu;

function scanText(text: string | null | undefined): Hit | null {
  if (!text || !TRIGGER.test(text)) return null;
  let onsite: Hit | null = null;
  for (const sentence of sentences(text)) {
    if (!TRIGGER.test(sentence)) continue;
    const found = scanSentence(sentence);
    if (!found) continue;
    if (found.arrangement === 'hybrid') return found;
    onsite ??= found;
  }
  return onsite;
}

const REMOTE_LABEL = /\b(?:fully|100%|completely|entirely)\s+remote\b|\bremote[- ](?:first|only)\b|\bwork from anywhere\b|\bremote\b/iu;
const REMOTE_EXPLICIT = /\b(?:fully|100%|completely|entirely)\s+remote\b|\bremote[- ](?:first|only)\b|\bwork from anywhere\b/iu;

function remoteEvidence(text: string | null | undefined, pattern: RegExp): string | null {
  if (!text || !/remote|anywhere/iu.test(text)) return null;
  for (const sentence of sentences(text)) {
    const match = pattern.exec(sentence);
    if (match) return snippet(sentence, match.index);
  }
  return null;
}

/**
 * Decides from title, then location, then description. On-site or hybrid wording anywhere beats a
 * "remote" label (a listing tagged Remote that asks for office days is not remote). Remote is only
 * reported when title or location say so and nothing contradicts it; a description alone must be
 * explicit ("fully remote", "remote-first") to count. Everything else is `unknown`.
 */
export function detectWorkArrangement(input: WorkArrangementInput): WorkArrangementDetection {
  const found = scanText(input.title) ?? scanText(input.location) ?? scanText(input.description);
  if (found) return found;

  const labelled = remoteEvidence(input.title, REMOTE_LABEL) ?? remoteEvidence(input.location, REMOTE_LABEL);
  if (labelled) return { arrangement: 'remote', evidence: labelled };

  const described = remoteEvidence(input.description, REMOTE_EXPLICIT);
  if (described) return { arrangement: 'remote', evidence: described };
  return UNKNOWN;
}

/** True for a vacancy the "hide on-site and hybrid" filter drops. Unknown and remote stay. */
export function isOnsiteOrHybrid(arrangement: WorkArrangement | undefined): boolean {
  return arrangement === 'onsite' || arrangement === 'hybrid';
}
