import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { indSponsors, sponsorDiscovery } from '../db/schema.js';

export const MAX_DOMAIN_SEARCH_BATCH_SIZE = 1_000;

export type DomainSearchSponsor = {
  sponsorId: string;
  legalName: string;
  kvkNumber: string;
  attemptCount: number;
};

export type DomainSearchAttempt = {
  sponsorId: string;
  outcome: 'candidate_high' | 'candidate_manual' | 'not_found' | 'blocked' | 'error';
  reason: string;
  resultUrl: string | null;
  httpStatus: number | null;
  attemptedAt: Date;
  nextCheckAt: Date | null;
};

export async function listDueDomainSearchSponsors(
  database: Database,
  limit: number,
  now = new Date(),
): Promise<DomainSearchSponsor[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DOMAIN_SEARCH_BATCH_SIZE) {
    throw new RangeError(`Domain-search batch limit must be from 1 through ${MAX_DOMAIN_SEARCH_BATCH_SIZE}`);
  }
  const rows = await database
    .select({
      sponsorId: sponsorDiscovery.sponsorId,
      legalName: indSponsors.legalName,
      kvkNumber: indSponsors.kvkNumber,
      attemptCount: sponsorDiscovery.attemptCount,
    })
    .from(sponsorDiscovery)
    .innerJoin(indSponsors, and(
      eq(indSponsors.id, sponsorDiscovery.sponsorId),
      eq(indSponsors.active, true),
    ))
    .where(and(
      eq(sponsorDiscovery.status, 'needs_domain'),
      isNotNull(indSponsors.kvkNumber),
      or(isNull(sponsorDiscovery.nextCheckAt), lte(sponsorDiscovery.nextCheckAt, now)),
    ))
    .orderBy(asc(sponsorDiscovery.attemptCount), asc(sponsorDiscovery.sponsorId))
    .limit(limit);

  return rows.flatMap((row) => row.kvkNumber === null ? [] : [{ ...row, kvkNumber: row.kvkNumber }]);
}

export async function persistDomainSearchAttempt(
  database: Database,
  attempt: DomainSearchAttempt,
): Promise<void> {
  await database
    .update(sponsorDiscovery)
    .set({
      evidence: {
        kind: 'brave_domain_search',
        outcome: attempt.outcome,
        resultUrl: attempt.resultUrl,
        attemptedAt: attempt.attemptedAt.toISOString(),
      },
      attemptCount: sql`${sponsorDiscovery.attemptCount} + 1`,
      lastAttemptAt: attempt.attemptedAt,
      nextCheckAt: attempt.nextCheckAt,
      lastHttpStatus: attempt.httpStatus,
      diagnostic: attempt.reason.slice(0, 4_000),
      updatedAt: attempt.attemptedAt,
    })
    .where(and(
      eq(sponsorDiscovery.sponsorId, attempt.sponsorId),
      eq(sponsorDiscovery.status, 'needs_domain'),
    ));
}
