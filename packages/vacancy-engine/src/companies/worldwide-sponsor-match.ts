import type { AtsHttpClient } from '../ats/http.js';
import type { Database } from '../db/client.js';
import { normalizeCountry } from '../geo/countries.js';
import { findWikidataCompanyByName } from './wikidata-name-source.js';
import { findActiveSponsorByKvk } from './worldwide-sponsor-repository.js';

/**
 * Best-effort worldwide counterpart to the Netherlands pipeline's IND sponsor verification (issue
 * #117). Deliberately standalone -- not wired into `discovery-promotion.ts`, which discovers ATS
 * career boards for sponsors *already* confirmed and solves a different problem. This never claims
 * `recognised_sponsor`: the caller (see `results.ts`'s `worldwideVerification`) reports a match from
 * here as `possible_sponsor_match` at most, since this path has none of the curated pipeline's
 * evidence-chain rigor.
 */
export type WorldwideSponsorMatch = {
  legalName: string;
  kvkNumber: string;
};

/**
 * The location gate `resolveWorldwideSponsorMatch` applies below, exposed on its own so a caller
 * enriching a whole scan's worth of rows can tell "this row could produce a lookup" from "this row
 * can only ever be `null`" *before* paying for one. `applyWorldwideSponsorMatches` needs exactly
 * that to group the eligible rows by employer and bound how many distinct lookups a scan performs;
 * without it, the only way to find out a row was ineligible was to call the resolver and have it
 * return `null` after the fact, which is why the enrichment pass used to walk all ~21k discovery
 * rows one by one instead of the few hundred employers that can actually resolve to anything.
 */
export function isWorldwideSponsorMatchEligible(location: string): boolean {
  return normalizeCountry(location) === 'Netherlands';
}

/**
 * The network half on its own: an employer name to the one KVK number Wikidata unambiguously
 * attributes to it, or `null` for every other outcome (no exact name match, ambiguous name,
 * no/duplicate KVK claim). Split out from the composition below because it is the only expensive,
 * cacheable part -- Wikidata rate-limits anonymous clients hard, so a scan that has already
 * resolved a name must never spend a request resolving it again (see
 * `worldwide-sponsor-lookup-cache.ts`). `null` is a genuine answer worth remembering, not a
 * failure: it means Wikidata was asked and had nothing unambiguous to say.
 */
export async function resolveWorldwideSponsorKvk(
  http: AtsHttpClient,
  companyName: string,
): Promise<string | null> {
  const outcome = await findWikidataCompanyByName(http, companyName);
  return outcome.status === 'match' ? outcome.kvkNumber : null;
}

/**
 * The local half: a KVK number to an active IND-recognised sponsor, or `null`. Deliberately never
 * cached alongside the Wikidata answer -- the register is re-synced independently, and a company
 * gaining or losing recognition must show up on the very next scan.
 */
export async function sponsorMatchForKvk(
  database: Database,
  kvkNumber: string | null,
): Promise<WorldwideSponsorMatch | null> {
  if (kvkNumber === null) return null;
  const sponsor = await findActiveSponsorByKvk(database, kvkNumber);
  return sponsor === null ? null : { legalName: sponsor.legalName, kvkNumber };
}

/**
 * Resolves a worldwide vacancy's employer against the IND register on a best-effort basis, or
 * `null` for "no claim" -- covering both "never attempted" (not a Netherlands-located vacancy) and
 * "attempted and found nothing/ambiguous". Unlike the Netherlands pipeline, which distinguishes
 * "not run" from "run, found nothing" (see `netherlandsVerification`'s `sponsor_unresolved` vs.
 * `VERIFICATION_DISABLED`), a single `null` is honest for both cases here: this check has no
 * user-facing toggle and no meaningful distinction to report between "we didn't check because this
 * isn't the Netherlands" and "we checked and could not confidently resolve an employer" -- both are
 * exactly the same claim, "nothing to show", and `WORLDWIDE_VERIFICATION`'s existing wording already
 * covers that ground for every non-match row regardless of which reason produced it.
 *
 * Only ever runs the Wikidata lookup for a vacancy whose `location` normalizes to "Netherlands" --
 * every other vacancy returns `null` without any network request, both to bound cost and because a
 * KVK/IND cross-check is meaningless for an employer outside this scheme's jurisdiction.
 */
export async function resolveWorldwideSponsorMatch(params: {
  http: AtsHttpClient;
  database: Database;
  companyName: string;
  location: string;
}): Promise<WorldwideSponsorMatch | null> {
  if (!isWorldwideSponsorMatchEligible(params.location)) return null;
  return sponsorMatchForKvk(
    params.database,
    await resolveWorldwideSponsorKvk(params.http, params.companyName),
  );
}
