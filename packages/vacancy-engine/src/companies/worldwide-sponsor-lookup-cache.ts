import { inArray } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { worldwideSponsorLookups } from '../db/schema.js';

/**
 * Persistence for the worldwide sponsor check's Wikidata half (see the `worldwideSponsorLookups`
 * table's own comment for why the shared `httpCache` cannot do this job). Kept as its own thin
 * repository module, separate from the Wikidata parsing and from the pipeline pass that uses it,
 * for the same reason `worldwide-sponsor-repository.ts` is separate: the logic stays unit-testable
 * against fixtures without a database.
 */

/**
 * How long a resolved employer stays usable. A Wikidata KVK (P3220) claim for an established
 * company changes on the order of never, and the *sponsorship* half of the answer -- the part that
 * genuinely moves -- is re-read from `ind_sponsors` on every scan regardless, so a long window
 * costs no freshness. It buys the thing that actually matters: a scan that has already paid for an
 * employer never pays again, which is what lets a rate-limited public API be covered at all.
 */
export const WORLDWIDE_SPONSOR_LOOKUP_MAX_AGE_DAYS = 30;

const MILLISECONDS_PER_DAY = 86_400_000;

export type WorldwideSponsorLookupRecord = {
  /** Null means Wikidata was asked and resolved no unambiguous KVK -- a real, reusable answer. */
  kvkNumber: string | null;
};

/**
 * Reads whatever is already known about these employers, in one query rather than one per
 * employer. Rows older than the freshness window are treated as absent, so they are re-resolved
 * (budget permitting) instead of silently ageing forever.
 */
export async function readWorldwideSponsorLookups(
  database: Database,
  companyKeys: readonly string[],
  now: Date = new Date(),
  maxAgeDays: number = WORLDWIDE_SPONSOR_LOOKUP_MAX_AGE_DAYS,
): Promise<Map<string, WorldwideSponsorLookupRecord>> {
  const known = new Map<string, WorldwideSponsorLookupRecord>();
  if (companyKeys.length === 0) return known;
  const freshSince = now.getTime() - maxAgeDays * MILLISECONDS_PER_DAY;
  // SQLite caps a statement's bound parameters (999 by default), and the caller's key list is
  // bounded by the per-scan employer cap rather than by anything this module controls, so the
  // read is chunked rather than assuming it fits.
  const chunkSize = 500;
  for (let offset = 0; offset < companyKeys.length; offset += chunkSize) {
    const chunk = companyKeys.slice(offset, offset + chunkSize);
    const rows = await database
      .select({
        companyKey: worldwideSponsorLookups.companyKey,
        kvkNumber: worldwideSponsorLookups.kvkNumber,
        resolvedAt: worldwideSponsorLookups.resolvedAt,
      })
      .from(worldwideSponsorLookups)
      .where(inArray(worldwideSponsorLookups.companyKey, [...chunk]));
    for (const row of rows) {
      if (row.resolvedAt.getTime() < freshSince) continue;
      known.set(row.companyKey, { kvkNumber: row.kvkNumber });
    }
  }
  return known;
}

/** Records one employer's resolved Wikidata answer, replacing any earlier (possibly stale) one. */
export async function writeWorldwideSponsorLookup(
  database: Database,
  entry: { companyKey: string; companyName: string; kvkNumber: string | null },
  now: Date = new Date(),
): Promise<void> {
  await database
    .insert(worldwideSponsorLookups)
    .values({ ...entry, resolvedAt: now })
    .onConflictDoUpdate({
      target: worldwideSponsorLookups.companyKey,
      set: { companyName: entry.companyName, kvkNumber: entry.kvkNumber, resolvedAt: now },
    });
}
