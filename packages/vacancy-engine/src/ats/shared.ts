import * as cheerio from 'cheerio';
import { decodeHTML } from 'entities';

import type {
  CareerSourceDescriptor,
  NormalizedVacancy,
  NormalizedVacancyInput,
} from '../domain/models.js';
import { normalizedVacancySchema } from '../domain/models.js';
import { AtsResponseError } from './http.js';

export type PaginationOptions = {
  pageSize: number;
  maxPages: number;
};

export function requireBoardIdentifier(source: CareerSourceDescriptor, provider: string): string {
  const identifier = source.boardIdentifier?.trim();
  if (!identifier) throw new AtsResponseError(provider, 'boardIdentifier is required');
  return identifier;
}

export function requireRecord(value: unknown, provider: string, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AtsResponseError(provider, `${context} has an unknown response shape`);
  }
  return value as Record<string, unknown>;
}

export function parseJson(body: string, provider: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new AtsResponseError(provider, 'response is not valid JSON', null, { cause: error });
  }
}

/**
 * Decodes HTML/XML character entities (`&amp;`, `&#038;`, `&quot;`, ...) that arrive verbatim in a
 * raw string pulled out of external feed data. A `JSON.parse` (every ATS board API, and every
 * JSON-based `global-remote` discovery source) never does this on its own -- it only unescapes
 * JSON's own `\"`/`\\`/`\n` syntax, not HTML entities sitting inside a string value -- so a board
 * that HTML-escapes its `title`/`company_name` fields (real example: a Greenhouse/WordPress-style
 * source rendering `"J. J. Keller &#038; Associates, Inc."`) leaves that escape sequence in the
 * string forever unless something does this explicitly. A raw XML/RSS source doesn't have this gap
 * (`saxes` in `global-remote/workable-feed.ts` and cheerio's own XML-mode parsing already decode
 * standard entities as part of parsing), so this only needs calling where text is read out of
 * already-parsed JSON or attribute/text values, which is exactly what `optionalString` below and
 * `discovery-shared.ts`'s `stringValue` do for every source in this package.
 *
 * Deliberately not a full HTML/XML parse (contrast `decodeEscapedMarkup`/`htmlToText` above, which
 * intentionally re-parse markup): `decodeHTML` only replaces recognized `&name;` / `&#NNN;` /
 * `&#xHHH;` runs and leaves every other character -- including a literal `<` or `>` that isn't part
 * of a real entity -- untouched. Round-tripping arbitrary plain text through an HTML parser instead
 * (e.g. `cheerio.load`) would silently swallow a title that happens to contain an unescaped `<`
 * (a real risk: `cheerio.load('<div>C++ Developer <script>x</script></div>').text()` drops the tag
 * *and* its content), which is exactly the failure mode this avoids. The output stays plain text
 * with no markup semantics, so it is exactly as safe to render as the un-decoded string was.
 */
export function decodeFeedEntities(value: string): string {
  return decodeHTML(value);
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = decodeFeedEntities(value).trim();
  return normalized.length === 0 ? null : normalized;
}

export function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function parseBooleanText(value: string | null): boolean | null {
  if (value === null) return null;
  switch (value.trim().toLowerCase()) {
    case 'true':
    case 'yes':
    case '1':
      return true;
    case 'false':
    case 'no':
    case '0':
      return false;
    default:
      return null;
  }
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

/** Converts ATS HTML fragments to readable plain text while retaining paragraph/list boundaries. */
export function htmlToText(input: string): string {
  const $ = cheerio.load(`<body>${input}</body>`);
  $('br').replaceWith('\n');
  $('p,div,section,article,h1,h2,h3,h4,h5,h6,li,ul,ol,table,tr,blockquote').each((_index, element) => {
    $(element).prepend('\n').append('\n');
  });
  return $('body')
    .text()
    .normalize('NFKC')
    .replace(/[\u00a0\u2007\u202f]/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function decodeEscapedMarkup(input: string): string {
  if (!/&(?:lt|#0*60|#x0*3c);/iu.test(input)) return input;
  const $ = cheerio.load(`<body>${input}</body>`);
  return $('body').text();
}

export function httpUrl(value: unknown, baseUrl?: string): string | null {
  const raw = optionalString(value);
  if (raw === null) return null;
  try {
    const url = baseUrl === undefined ? new URL(raw) : new URL(raw, baseUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function joinNonEmpty(values: (string | null)[], separator = ', '): string | null {
  const unique = [...new Set(values.filter((value): value is string => value !== null && value.length > 0))];
  return unique.length === 0 ? null : unique.join(separator);
}

export function makeVacancy(candidate: NormalizedVacancyInput): NormalizedVacancy | null {
  const parsed = normalizedVacancySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function normalizedSource(provider: string): string {
  return provider;
}

export function validPaginationOptions(
  provider: string,
  options: Partial<PaginationOptions>,
  defaults: PaginationOptions,
  maximumPageSize: number,
): PaginationOptions {
  const pageSize = options.pageSize ?? defaults.pageSize;
  const maxPages = options.maxPages ?? defaults.maxPages;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maximumPageSize) {
    throw new AtsResponseError(provider, `pageSize must be between 1 and ${maximumPageSize}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new AtsResponseError(provider, 'maxPages must be a positive integer');
  }
  return { pageSize, maxPages };
}
