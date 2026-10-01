import { and, eq } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { indSponsors } from '../db/schema.js';

/**
 * The one piece of database access this feature needs: given a KVK number a Wikidata name search
 * already resolved (see `wikidata-name-source.ts`), check it against the same `indSponsors` table
 * (and the same `active` discipline) the curated Netherlands pipeline itself reads from --
 * `worldwide-sponsor-match.ts` never invents a second notion of "recognised". Kept as its own thin
 * repository function, separate from the pure Wikidata parsing/disambiguation logic, so that logic
 * stays unit-testable with fixtures alone (see `discovery-repository.ts`'s
 * `matchTrustedDomainCandidates` for the same split in the existing KVK-keyed pipeline).
 */
export async function findActiveSponsorByKvk(
  database: Database,
  kvkNumber: string,
): Promise<{ legalName: string } | null> {
  const [sponsor] = await database
    .select({ legalName: indSponsors.legalName })
    .from(indSponsors)
    .where(and(eq(indSponsors.kvkNumber, kvkNumber), eq(indSponsors.active, true)))
    .limit(1);
  return sponsor ?? null;
}
