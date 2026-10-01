import type { CvSourceDocument } from '../../../electron/workspace/cv-source-schema.js';
import { CV_PROFILE_LIMITS } from '../../../electron/workspace/cv-profile-schema.js';
import type { CvProfile } from '../../window.js';

/**
 * Derives the `CvProfile` summary fields from an already-extracted structured source CV, so the
 * drawer does not pay for a second independent LLM extraction over text a model has already read.
 *
 * The reason this is worth doing at all: `buildSourceCvPrompt` reads the whole CV into records
 * (employers, titles, date ranges, contact details), and `buildCvParsePrompt` reads the same raw
 * text again to answer a strictly smaller question. Once the first answer exists and a person has
 * it in front of them, most of the second one is arithmetic over data the candidate can already
 * see and correct, not a judgement call: asking a model for it again buys a second JSON shape, a
 * second chance to come back unparseable, and a second wait, for the same three facts.
 *
 * What this module deliberately does *not* do is guess. Every field it cannot read straight out of
 * the source record is simply absent from the returned partial, and `coversCvProfileCore` below is
 * what the call site uses to decide whether the derivation is good enough to stand in for the LLM
 * pass at all. A silently wrong "8 years" is a worse outcome than the AI call this replaces, since
 * a wrong number looks exactly like a right one; an absent field is visibly absent.
 *
 * Which of the seven fields can honestly be derived, and why the rest cannot:
 *
 * - `title`: the most recent employment entry's title, falling back to the CV's own headline title
 *   on the contact block. This is what "current or most recent job title" means, read off records
 *   the candidate has already reviewed.
 * - `years`: the union of the employment entries' date ranges (see `experienceMonths`).
 * - `location`: `contact.location`. The source shape carries a location only on the contact block,
 *   never per role, so this is the CV's stated location and nothing is inferred from employers.
 * - `summary`: `source.summary`, which is the CV's own summary section preserved verbatim. Copying
 *   the candidate's confirmed words is not an approximation of the AI pass's neutral paraphrase, it
 *   is a stricter version of it. Absent when the CV has no summary section, because writing one
 *   would be exactly the invention this module refuses.
 * - `languages`, `skills`, `auth`: not derivable. `CV_SOURCE_JSON_SHAPE` has no field for spoken
 *   languages or work authorization at all, and its only skill-like data is `projects[].technologies`,
 *   which is per-project tooling rather than the CV's own skills section. Deriving any of the three
 *   would mean inventing or silently narrowing, so they stay on the LLM path.
 */

/**
 * The fields the deterministic path has to produce before it may replace the AI pass. Title and
 * years are the two the AI pass exists for; location and summary are copies of fields the candidate
 * has already confirmed, so their absence means the CV genuinely does not state them and a second
 * model run would have found nothing either.
 */
export const DERIVED_CV_PROFILE_CORE_FIELDS = ['title', 'years'] as const;

/**
 * Whether a derivation is complete enough to stand in for the "Parse with AI" call.
 *
 * Deliberately strict: a source CV whose dates this module cannot read (an unsupported month
 * spelling, a role with no dates at all) yields no `years`, and the caller then runs the LLM pass
 * exactly as it does today. That keeps the change strictly non-regressive -- the worst case is the
 * behaviour users already have, never a blank field where an answer used to appear.
 */
export function coversCvProfileCore(derived: Partial<CvProfile>): boolean {
  return DERIVED_CV_PROFILE_CORE_FIELDS.every((key) => (derived[key] ?? '').length > 0);
}

/**
 * English month names, full and abbreviated. Anything else (a localized CV, a format this list does
 * not cover) makes the range unparseable, which by the rule above hands the whole derivation back
 * to the LLM pass rather than producing a number from a date nobody actually read.
 */
const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** How a CV writes "this role has not ended". */
const OPEN_ENDED_MARKERS = new Set(['present', 'current', 'currently', 'now', 'today', 'ongoing', 'to date']);

/** Earliest year a CV date may name. A typo like "1019" or "2109" must not silently become decades
 * of experience, so anything outside a plausible working lifetime is treated as unreadable. */
const EARLIEST_PLAUSIBLE_YEAR = 1940;

/** One inclusive span of calendar months, counted as `year * 12 + monthIndex` so two spans can be
 * compared and merged with plain integer arithmetic. */
export interface MonthSpan {
  start: number;
  end: number;
}

function monthNumber(year: number, month: number): number {
  return year * 12 + month;
}

function currentMonthNumber(now: Date): number {
  return monthNumber(now.getFullYear(), now.getMonth());
}

/**
 * Reads one end of a date range. `side` decides how a bare year is read: a CV writing "2019 - 2022"
 * means the whole of both years, which is also how a person (and the AI pass this replaces) reads
 * it. The error that convention can introduce is bounded by eleven months at each end and is
 * absorbed by the floor-rounding in `formatYears`.
 */
function parseEndpoint(raw: string, side: 'start' | 'end', now: Date): number | undefined {
  const text = raw
    .toLowerCase()
    .replace(/[.,]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length === 0) return undefined;
  if (side === 'end' && OPEN_ENDED_MARKERS.has(text)) return currentMonthNumber(now);

  const inRange = (year: number) => year >= EARLIEST_PLAUSIBLE_YEAR && year <= now.getFullYear() + 1;

  // "March 2019" / "Mar 2019"
  const named = /^([a-z]+) (\d{4})$/u.exec(text);
  if (named) {
    const month = MONTH_NAMES[named[1]!];
    const year = Number(named[2]);
    return month !== undefined && inRange(year) ? monthNumber(year, month) : undefined;
  }

  // "03/2019", "3-2019"
  const monthFirst = /^(\d{1,2})[/-](\d{4})$/u.exec(text);
  if (monthFirst) {
    const month = Number(monthFirst[1]);
    const year = Number(monthFirst[2]);
    return month >= 1 && month <= 12 && inRange(year) ? monthNumber(year, month - 1) : undefined;
  }

  // "2019-03", "2019/3"
  const yearFirst = /^(\d{4})[/-](\d{1,2})$/u.exec(text);
  if (yearFirst) {
    const year = Number(yearFirst[1]);
    const month = Number(yearFirst[2]);
    return month >= 1 && month <= 12 && inRange(year) ? monthNumber(year, month - 1) : undefined;
  }

  // A bare year: the whole of it, per this function's header.
  const bareYear = /^(\d{4})$/u.exec(text);
  if (bareYear) {
    const year = Number(bareYear[1]);
    return inRange(year) ? monthNumber(year, side === 'start' ? 0 : 11) : undefined;
  }

  return undefined;
}

/**
 * Range separators, tried in order of how unambiguous they are. A spaced hyphen is safe to split on
 * anywhere; a bare hyphen is not, because "03-2019" is itself a date, so it is only tried last and
 * only when it yields exactly two halves that both parse.
 */
const RANGE_SEPARATORS: readonly RegExp[] = [
  /\s+(?:-|–|—|to|until|through)\s+/iu,
  /\s*[–—]\s*/u,
  /-/u,
];

/**
 * Turns one free-text `dates` string into a span of months, or `undefined` when it cannot be read
 * with certainty. `CvSourceExperienceEntry.dates` is free text on purpose (see `cv-source-schema.ts`):
 * this function is the one place that accepts the cost of that, and it is written to fail rather
 * than to cope.
 *
 * A span that ends in the future (a contract whose stated end date has not arrived) is clamped to
 * the current month: months nobody has worked yet are not experience.
 */
export function parseCvDateSpan(dates: string, now: Date = new Date()): MonthSpan | undefined {
  const text = dates.trim();
  if (text.length === 0) return undefined;

  for (const separator of RANGE_SEPARATORS) {
    const parts = text.split(separator);
    if (parts.length !== 2) continue;
    const start = parseEndpoint(parts[0]!, 'start', now);
    const end = parseEndpoint(parts[1]!, 'end', now);
    if (start === undefined || end === undefined) continue;
    const clampedEnd = Math.min(end, currentMonthNumber(now));
    if (clampedEnd < start) return undefined;
    return { start, end: clampedEnd };
  }
  return undefined;
}

/**
 * Total months of professional experience across the employment history.
 *
 * Overlapping spans are merged rather than added up: a contract held alongside a permanent role is
 * one period of a career, and summing the two would hand the candidate months they never lived.
 * Client engagements count the same as direct employment -- the distinction the source record keeps
 * between them is about who the work was delivered for, not whether it was work.
 *
 * Returns `undefined` unless *every* entry contributes a readable span. One role with no dates is
 * enough to make the total an undercount, and an undercount that looks like a fact is precisely the
 * failure mode this module must not have.
 */
export function experienceMonths(source: CvSourceDocument, now: Date = new Date()): number | undefined {
  if (source.experience.length === 0) return undefined;

  const spans: MonthSpan[] = [];
  for (const entry of source.experience) {
    const span = parseCvDateSpan(entry.dates, now);
    if (!span) return undefined;
    spans.push(span);
  }

  spans.sort((a, b) => a.start - b.start);
  let months = 0;
  let mergedStart = spans[0]!.start;
  let mergedEnd = spans[0]!.end;
  for (const span of spans.slice(1)) {
    if (span.start <= mergedEnd + 1) {
      mergedEnd = Math.max(mergedEnd, span.end);
      continue;
    }
    months += mergedEnd - mergedStart + 1;
    mergedStart = span.start;
    mergedEnd = span.end;
  }
  months += mergedEnd - mergedStart + 1;
  return months;
}

/**
 * The phrase that goes in the `years` field, matching the shape `CV_PROFILE_FIELD_DESCRIPTIONS`
 * asks the AI pass for ("5 years").
 *
 * Whole years, always rounded down. Rounding up would let the derivation overstate a candidate's
 * experience on their own profile, which is the one direction an error here must never go.
 */
function formatYears(months: number): string {
  const years = Math.floor(months / 12);
  if (years < 1) return 'less than 1 year';
  return years === 1 ? '1 year' : `${years} years`;
}

/** Single-line profile fields collapse whitespace the same way `search-profile-cv-bridge.ts` does,
 * so a value that wrapped across lines in the source CV cannot render as several lines in a
 * single-line input. */
function shortField(value: string): string | undefined {
  const text = value.replace(/\s+/gu, ' ').trim().slice(0, CV_PROFILE_LIMITS.shortField).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * The most recent role in the history: the one whose span ends latest, and failing that the first
 * entry, since CVs list employment in reverse-chronological order by convention. Ties keep the
 * earlier entry for the same reason -- two roles ending in the same month are already written
 * most-recent-first.
 */
function mostRecentTitle(source: CvSourceDocument, now: Date): string | undefined {
  let best: { end: number; title: string } | undefined;
  for (const entry of source.experience) {
    const span = parseCvDateSpan(entry.dates, now);
    if (!span) continue;
    if (!best || span.end > best.end) best = { end: span.end, title: entry.title };
  }
  const title = best?.title ?? source.experience[0]?.title ?? '';
  return shortField(title) ?? shortField(source.contact.title);
}

/**
 * Every `CvProfile` field this source CV supports, and only those. Absent keys mean "the source does
 * not say", never "empty": the caller merges this onto the form, so an absent key leaves whatever
 * the candidate already typed alone.
 *
 * `now` is injectable so the open-ended-role arithmetic ("Jan 2021 - Present") is testable against a
 * fixed date instead of drifting with the calendar.
 */
export function deriveCvProfileFromSource(source: CvSourceDocument, now: Date = new Date()): Partial<CvProfile> {
  const derived: Partial<CvProfile> = {};

  const title = mostRecentTitle(source, now);
  if (title) derived.title = title;

  const months = experienceMonths(source, now);
  if (months !== undefined) derived.years = formatYears(months);

  const location = shortField(source.contact.location);
  if (location) derived.location = location;

  const summary = source.summary.trim().slice(0, CV_PROFILE_LIMITS.summary).trim();
  if (summary.length > 0) derived.summary = summary;

  return derived;
}
