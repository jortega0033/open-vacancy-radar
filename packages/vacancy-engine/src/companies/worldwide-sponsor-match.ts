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
  if (normalizeCountry(params.location) !== 'Netherlands') return null;

  const outcome = await findWikidataCompanyByName(params.http, params.companyName);
  if (outcome.status !== 'match') return null;

  const sponsor = await findActiveSponsorByKvk(params.database, outcome.kvkNumber);
  if (sponsor === null) return null;

  return { legalName: sponsor.legalName, kvkNumber: outcome.kvkNumber };
}
