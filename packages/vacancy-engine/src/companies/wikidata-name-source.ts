import { z } from 'zod';

import type { AtsHttpClient } from '../ats/http.js';
import { requireSuccessfulResponse } from '../ats/http.js';
import { compareWebsite, normalizeKvk, normalizeWebsiteUrl } from './wikidata-domain-source.js';

/**
 * Best-effort, name-keyed counterpart to `wikidata-domain-source.ts`'s exact-KVK SPARQL lookup
 * (see issue #117). Every structured domain source in this package (`wikidata-domain-source.ts`,
 * `ted-domain-source.ts`, `tenderned-domain-source.ts`) is keyed on a KVK number the caller already
 * knows from `indSponsors`; this module exists for the opposite case -- a worldwide vacancy's
 * free-text company name, with no KVK and nothing pre-known -- so it has none of that discipline's
 * certainty going in. Two hard consequences follow throughout this file:
 *
 * 1. It reports at most a candidate for the caller to cross-check against `indSponsors` (see
 *    `worldwide-sponsor-match.ts`), never a resolved sponsor by itself.
 * 2. Disambiguation has to be *stronger* than the KVK-keyed path's `hosts.size !== 1` rule, because
 *    a company name (unlike a KVK number) is not a unique key: the same trade name can belong to
 *    more than one real Wikidata entity, and Wikidata's own relevance search can rank the wrong
 *    entity first (see the issue's Philips spot-check). Both the name-to-entity step and the
 *    entity's own KVK/website claims are disambiguated below, not just the latter.
 */

export const WIKIDATA_API_ENDPOINT = 'https://www.wikidata.org/w/api.php';
export const WIKIDATA_NAME_SEARCH_QUERY_VERSION = 'wikidata-name-search-v1';

const KVK_PROPERTY = 'P3220';
const WEBSITE_PROPERTY = 'P856';

const searchMatchSchema = z.object({ text: z.string().min(1) }).loose();
const searchResultSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  match: searchMatchSchema.optional(),
}).loose();
const searchResponseSchema = z.object({
  search: z.array(searchResultSchema),
}).loose();

const claimSnakSchema = z.object({
  snaktype: z.string(),
  datavalue: z.object({ value: z.string().min(1) }).loose().optional(),
}).loose();
const claimStatementSchema = z.object({
  mainsnak: claimSnakSchema,
  rank: z.enum(['preferred', 'normal', 'deprecated']).optional(),
}).loose();
const entityClaimsSchema = z.object({
  claims: z.record(z.string(), z.array(claimStatementSchema)).optional(),
}).loose();
const claimsResponseSchema = z.object({
  entities: z.record(z.string(), entityClaimsSchema),
}).loose();

export type WikidataNameSearchOutcome =
  | { status: 'match'; itemId: string }
  | { status: 'not_found'; reasonCode: 'no_exact_name_match' }
  | { status: 'ambiguous'; reasonCode: 'multiple_entities_matched_name'; itemIds: string[] };

export type WikidataNameMatchOutcome =
  | { status: 'match'; itemId: string; kvkNumber: string; officialUrl: string }
  | {
      status: 'not_found';
      reasonCode: 'no_exact_name_match' | 'missing_kvk_claim' | 'missing_website_claim';
    }
  | {
      status: 'ambiguous';
      reasonCode: 'multiple_entities_matched_name' | 'duplicate_kvk_claims' | 'multiple_official_hosts';
    };

/** Whole-word-adjacent equality is not enough here (unlike `normalizeCountry`'s substring match):
 * a name search needs to know the candidate *is* the company searched for, not merely mentions it. */
function normalizeNameForComparison(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

/**
 * Selects the single Wikidata entity whose search result actually matched the queried company
 * name, not merely whatever `wbsearchentities` ranked first. `match.text` is the specific label or
 * alias that matched (Wikidata may match on an alias even when `label` differs), so it -- not the
 * display label -- is what gets compared against the query. This alone would already keep a
 * wrong-but-related top hit (e.g. "Philips Records" for the query "Philips") out of consideration
 * when its matched text differs from the query, which the KVK-keyed path never has to guard against
 * since a KVK number carries no relevance-ranking ambiguity to begin with.
 *
 * More than one entity with an equally exact matched name is ambiguous, not a guess at the "best"
 * one: two unrelated companies can share a trade name, and nothing here can tell them apart.
 */
export function selectWikidataNameMatch(payload: unknown, companyName: string): WikidataNameSearchOutcome {
  const parsed = searchResponseSchema.parse(payload);
  const needle = normalizeNameForComparison(companyName);
  const matchedItemIds: string[] = [];
  for (const result of parsed.search) {
    const matchedText = result.match?.text ?? result.label;
    if (matchedText !== undefined && normalizeNameForComparison(matchedText) === needle) {
      matchedItemIds.push(result.id);
    }
  }
  const uniqueItemIds = [...new Set(matchedItemIds)];
  if (uniqueItemIds.length === 0) return { status: 'not_found', reasonCode: 'no_exact_name_match' };
  if (uniqueItemIds.length > 1) {
    return { status: 'ambiguous', reasonCode: 'multiple_entities_matched_name', itemIds: uniqueItemIds.sort() };
  }
  return { status: 'match', itemId: uniqueItemIds[0]! };
}

function claimStringValues(
  entity: z.infer<typeof entityClaimsSchema> | undefined,
  property: string,
): string[] {
  const statements = entity?.claims?.[property] ?? [];
  const values: string[] = [];
  for (const statement of statements) {
    if (statement.rank === 'deprecated') continue;
    const value = statement.mainsnak.datavalue?.value;
    if (value !== undefined) values.push(value);
  }
  return values;
}

/**
 * Extracts P3220 (KVK) and P856 (website) from one already-selected entity's claims, applying the
 * same "single official host" ambiguity rule `resolveWikidataDomains` already enforces for the
 * KVK-keyed path (Heineken/Randstad-style multiple-country-site entities reject here exactly the
 * same way), plus an equivalent rule for the KVK claim itself: more than one distinct KVK number on
 * one entity is just as unresolvable as more than one official host.
 */
export function resolveWikidataNameClaims(payload: unknown, itemId: string): WikidataNameMatchOutcome {
  const parsed = claimsResponseSchema.parse(payload);
  const entity = parsed.entities[itemId];

  const kvkNumbers = [
    ...new Set(
      claimStringValues(entity, KVK_PROPERTY)
        .map((value) => normalizeKvk(value))
        .filter((value): value is string => value !== null),
    ),
  ];
  if (kvkNumbers.length === 0) return { status: 'not_found', reasonCode: 'missing_kvk_claim' };
  if (kvkNumbers.length > 1) return { status: 'ambiguous', reasonCode: 'duplicate_kvk_claims' };

  const websites = claimStringValues(entity, WEBSITE_PROPERTY)
    .map((value) => normalizeWebsiteUrl(value))
    .filter((value): value is { url: string; hostnameKey: string } => value !== null);
  if (websites.length === 0) return { status: 'not_found', reasonCode: 'missing_website_claim' };

  const hosts = new Set(websites.map((website) => website.hostnameKey));
  if (hosts.size !== 1) return { status: 'ambiguous', reasonCode: 'multiple_official_hosts' };

  const officialUrl = [...new Set(websites.map((website) => website.url))].sort(compareWebsite)[0];
  if (officialUrl === undefined) return { status: 'not_found', reasonCode: 'missing_website_claim' };

  return { status: 'match', itemId, kvkNumber: kvkNumbers[0]!, officialUrl };
}

export async function fetchWikidataNameSearch(http: AtsHttpClient, companyName: string): Promise<unknown> {
  const url = new URL(WIKIDATA_API_ENDPOINT);
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', companyName);
  url.searchParams.set('language', 'en');
  url.searchParams.set('type', 'item');
  url.searchParams.set('limit', '10');
  url.searchParams.set('format', 'json');
  const response = await http.get(url.toString(), { allowedOrigins: [new URL(WIKIDATA_API_ENDPOINT).origin] });
  requireSuccessfulResponse('wikidata_name_source', response);
  return JSON.parse(response.body) as unknown;
}

export async function fetchWikidataEntityClaims(http: AtsHttpClient, itemId: string): Promise<unknown> {
  const url = new URL(WIKIDATA_API_ENDPOINT);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', itemId);
  url.searchParams.set('props', 'claims');
  url.searchParams.set('format', 'json');
  const response = await http.get(url.toString(), { allowedOrigins: [new URL(WIKIDATA_API_ENDPOINT).origin] });
  requireSuccessfulResponse('wikidata_name_source', response);
  return JSON.parse(response.body) as unknown;
}

/**
 * The full name -> candidate resolution, chaining the two Wikidata API calls above. Stops after the
 * search step (no second request) as soon as the name step itself is not a clean single match, so
 * an ambiguous or absent name search never spends a second request pretending it might resolve.
 */
export async function findWikidataCompanyByName(
  http: AtsHttpClient,
  companyName: string,
): Promise<WikidataNameMatchOutcome> {
  const searchPayload = await fetchWikidataNameSearch(http, companyName);
  const selected = selectWikidataNameMatch(searchPayload, companyName);
  if (selected.status !== 'match') return selected;
  const claimsPayload = await fetchWikidataEntityClaims(http, selected.itemId);
  return resolveWikidataNameClaims(claimsPayload, selected.itemId);
}
