/**
 * The two text primitives shared by the deterministic scorer (`filtering/relevance.ts`) and the
 * work-eligibility evidence extractor (`eligibility/language.ts`). They live here rather than in
 * either of those modules because the scorer now consults the eligibility extractor, so leaving
 * them in `relevance.ts` would have made the two files import each other.
 */

const NAMED_ENTITY: Record<string, string> = {
  nbsp: ' ',
  '#160': ' ',
  amp: '&',
  quot: '"',
  '#34': '"',
  '#39': "'",
  apos: "'",
};

const NAMED_ENTITY_PATTERN = new RegExp(`&(${Object.keys(NAMED_ENTITY).join('|')});`, 'gi');

/**
 * Decodes the handful of HTML entities job-description markup actually uses, in one pass. The
 * previous version ran a separate `.replace(/&amp;/gi, '&')` before the `&quot;`/`&#39;` passes, so
 * a source string containing an already-escaped entity — `&amp;quot;`, literally the text `&quot;`
 * on the page — got decoded twice: once to `&quot;` by the `&amp;` pass, then again to `"` by the
 * pass after it, same as CodeQL's `js/double-escaping` finding on this function. Matching the whole
 * `&name;`/`&#nn;` token in one alternation and replacing each match exactly once removes the
 * possibility structurally: `String.replace` with `/g` never rescans text it just inserted.
 * `NAMED_ENTITY_PATTERN` is derived from `NAMED_ENTITY`'s own keys so the two can't drift apart.
 */
export function plainText(value: string): string {
  return value
    .replace(/<(?:br|\/p|\/li|\/h[1-6]|\/div)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(NAMED_ENTITY_PATTERN, (match, entity: string) => NAMED_ENTITY[entity.toLowerCase()] ?? match)
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function normalizeForMatching(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[–—]/g, '-')
    .replace(/[’]/g, "'")
    .toLowerCase();
}
