import type { VacancyLead } from './types.js';

/**
 * A stable identity string for one `VacancyLead`, so per-vacancy state (#419's evidence overlay,
 * today; anything else keyed by "this vacancy" later) has something to key on. `VacancyLead`
 * itself deliberately carries no database id or discovery `key` (see `gap-analysis-store.ts`'s own
 * header comment on the same absence) -- this is not that lookup. `matchSavedJob` answers "which
 * existing saved-job row is this", which can be genuinely ambiguous; this answers "what string
 * identifies this vacancy object", which cannot be, because it never has to match anything else.
 *
 * The source URL wins whenever one exists: it is exactly what a real posting resolves to, and two
 * leads with the same URL are the same vacancy by construction. Only a hand-entered vacancy with no
 * URL falls back to a normalized role/company/location composite -- the same three fields
 * `matchSavedJob`'s weaker tier already trusts, normalized the same way (case- and
 * whitespace-insensitive) so two spellings of the same vacancy still key together.
 */
export function vacancyKeyFor(vacancy: VacancyLead): string {
  const url = vacancy.url.trim();
  if (url.length > 0) return `url:${url}`;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/gu, ' ');
  return `fields:${normalize(vacancy.title)}|${normalize(vacancy.company)}|${normalize(vacancy.location)}`;
}

/**
 * A stable key for a case with no `VacancyLead` behind it at all -- #421's MCP case contract, where
 * an external client may start a case from pasted JD text alone. Freshly minted per call, never
 * derived from the JD text itself: two cases started from identical JD text are still two distinct
 * cases the candidate may want to track separately, the same "app assigns ids, never derives them
 * from content" discipline `cv-evidence-schema.ts` already follows for `factId`/`variantId`. The
 * `manual:` prefix can never collide with `vacancyKeyFor`'s own `url:`/`fields:` prefixes.
 */
export function mintManualCaseKey(): string {
  return `manual:${crypto.randomUUID()}`;
}
