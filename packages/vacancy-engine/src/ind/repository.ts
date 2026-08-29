import { and, count, desc, eq, gte, isNotNull, notInArray } from 'drizzle-orm';

import { withTransaction, type Database } from '../db/client.js';
import { indSponsorSnapshots, indSponsors } from '../db/schema.js';
import type { OfficialSponsorSnapshot } from './source.js';

export type SponsorSyncResult = {
  sourceRows: number;
  uniqueSponsors: number;
  duplicatesIgnored: number;
};

const UPSERT_BATCH_SIZE = 500;
const MINIMUM_PLAUSIBLE_SPONSOR_COUNT = 10_000;

export type UsableSponsorBaseline = {
  sourceRows: number;
  uniqueSponsors: number;
  duplicatesIgnored: number;
  sourceLastUpdated: Date;
  membershipHash: string;
  retrievedAt: Date;
};

export async function findUsableSponsorBaseline(
  database: Database,
  maximumAgeDays: number,
  now = new Date(),
): Promise<UsableSponsorBaseline | null> {
  if (!Number.isInteger(maximumAgeDays) || maximumAgeDays < 1) {
    throw new RangeError('Sponsor baseline maximum age must be a positive integer');
  }
  const cutoff = new Date(now.getTime() - maximumAgeDays * 86_400_000);
  const [[snapshot], [activeCountRow]] = await Promise.all([
    database
      .select({
        sourceRows: indSponsorSnapshots.rawRowCount,
        uniqueSponsors: indSponsorSnapshots.uniqueSponsorCount,
        duplicatesIgnored: indSponsorSnapshots.duplicateRowCount,
        sourceLastUpdated: indSponsorSnapshots.sourceLastUpdated,
        membershipHash: indSponsorSnapshots.membershipHash,
        retrievedAt: indSponsorSnapshots.retrievedAt,
      })
      .from(indSponsorSnapshots)
      .where(
        and(
          eq(indSponsorSnapshots.accepted, true),
          gte(indSponsorSnapshots.retrievedAt, cutoff),
        ),
      )
      .orderBy(desc(indSponsorSnapshots.retrievedAt))
      .limit(1),
    database
      .select({ count: count() })
      .from(indSponsors)
      .where(eq(indSponsors.active, true)),
  ]);
  if (
    snapshot === undefined ||
    snapshot.uniqueSponsors < MINIMUM_PLAUSIBLE_SPONSOR_COUNT ||
    activeCountRow?.count !== snapshot.uniqueSponsors
  ) {
    return null;
  }
  return snapshot;
}

export type SponsorSnapshotTransition = {
  sourceLastUpdated: Date | null;
  uniqueSponsorCount: number;
  membershipHash: string | null;
};

function formatSourceDate(value: Date | null): string {
  return value === null ? 'unknown' : value.toISOString().slice(0, 10);
}

export function validateSponsorSnapshotTransition(
  previous: SponsorSnapshotTransition | null,
  next: SponsorSnapshotTransition,
): string | null {
  if (next.uniqueSponsorCount < MINIMUM_PLAUSIBLE_SPONSOR_COUNT) {
    return (
      `implausible_sponsor_count: received ${next.uniqueSponsorCount}; ` +
      `minimum is ${MINIMUM_PLAUSIBLE_SPONSOR_COUNT}`
    );
  }

  if (previous === null) return null;

  if (
    previous.sourceLastUpdated !== null &&
    next.sourceLastUpdated !== null &&
    next.sourceLastUpdated.getTime() < previous.sourceLastUpdated.getTime()
  ) {
    return (
      `source_date_regression: previous ${formatSourceDate(previous.sourceLastUpdated)}; ` +
      `received ${formatSourceDate(next.sourceLastUpdated)}`
    );
  }

  const sponsorCountDrop = previous.uniqueSponsorCount - next.uniqueSponsorCount;
  if (
    previous.uniqueSponsorCount >= MINIMUM_PLAUSIBLE_SPONSOR_COUNT &&
    sponsorCountDrop > 0 &&
    sponsorCountDrop * 10 >= previous.uniqueSponsorCount
  ) {
    return (
      `sponsor_count_drop: previous ${previous.uniqueSponsorCount}; received ${next.uniqueSponsorCount}; ` +
      'drop is at least 10%'
    );
  }

  if (
    previous.sourceLastUpdated !== null &&
    next.sourceLastUpdated !== null &&
    next.sourceLastUpdated.getTime() === previous.sourceLastUpdated.getTime() &&
    previous.membershipHash !== null &&
    next.membershipHash !== null &&
    next.membershipHash !== previous.membershipHash
  ) {
    return (
      `same_date_membership_change: source date ${formatSourceDate(next.sourceLastUpdated)}; ` +
      'membership hash changed'
    );
  }

  return null;
}

export async function syncOfficialSponsors(
  database: Database,
  snapshot: OfficialSponsorSnapshot,
  retrievedAt = new Date(),
): Promise<SponsorSyncResult> {
  const outcome = await withTransaction(database, async (transaction) => {
    const [latestAcceptedSnapshot] = await transaction
      .select({
        sourceLastUpdated: indSponsorSnapshots.sourceLastUpdated,
        uniqueSponsorCount: indSponsorSnapshots.uniqueSponsorCount,
        membershipHash: indSponsorSnapshots.membershipHash,
      })
      .from(indSponsorSnapshots)
      .where(eq(indSponsorSnapshots.accepted, true))
      .orderBy(desc(indSponsorSnapshots.retrievedAt))
      .limit(1);

    let previous: SponsorSnapshotTransition | null = latestAcceptedSnapshot ?? null;
    if (previous === null) {
      const [activeCountResult] = await transaction
        .select({ activeCount: count() })
        .from(indSponsors)
        .where(eq(indSponsors.active, true));
      const [existingSource] = await transaction
        .select({ sourceLastUpdated: indSponsors.sourceLastUpdated })
        .from(indSponsors)
        .where(and(eq(indSponsors.active, true), isNotNull(indSponsors.sourceLastUpdated)))
        .orderBy(desc(indSponsors.sourceLastUpdated))
        .limit(1);
      const activeCount = activeCountResult?.activeCount ?? 0;
      if (activeCount > 0) {
        previous = {
          sourceLastUpdated: existingSource?.sourceLastUpdated ?? null,
          uniqueSponsorCount: activeCount,
          membershipHash: null,
        };
      }
    }

    const rejectionReason = validateSponsorSnapshotTransition(previous, {
      sourceLastUpdated: snapshot.sourceLastUpdated,
      uniqueSponsorCount: snapshot.records.length,
      membershipHash: snapshot.membershipHash,
    });

    await transaction.insert(indSponsorSnapshots).values({
      sourceUrl: snapshot.sourceUrl,
      sourceLastUpdated: snapshot.sourceLastUpdated,
      retrievedAt,
      rawRowCount: snapshot.rawRowCount,
      uniqueSponsorCount: snapshot.records.length,
      duplicateRowCount: snapshot.duplicateRowCount,
      membershipHash: snapshot.membershipHash,
      accepted: rejectionReason === null,
      rejectionReason,
    });

    if (rejectionReason !== null) return { rejectionReason };

    for (let index = 0; index < snapshot.records.length; index += UPSERT_BATCH_SIZE) {
      const batch = snapshot.records.slice(index, index + UPSERT_BATCH_SIZE);
      await transaction
        .insert(indSponsors)
        .values(
          batch.map((record) => ({
            sourceIdentityKey: record.sourceIdentityKey,
            legalName: record.legalName,
            normalizedName: record.normalizedName,
            searchName: record.searchName,
            kvkNumber: record.kvkNumber,
            sourceUrl: snapshot.sourceUrl,
            sourceRetrievedAt: retrievedAt,
            sourceLastUpdated: snapshot.sourceLastUpdated,
            lastSeenAt: retrievedAt,
            active: true,
          })),
        )
        .onConflictDoUpdate({
          target: indSponsors.sourceIdentityKey,
          set: {
            sourceUrl: snapshot.sourceUrl,
            sourceRetrievedAt: retrievedAt,
            sourceLastUpdated: snapshot.sourceLastUpdated,
            lastSeenAt: retrievedAt,
            active: true,
          },
        });
    }

    const keys = snapshot.records.map((record) => record.sourceIdentityKey);
    await transaction
      .update(indSponsors)
      .set({ active: false })
      .where(notInArray(indSponsors.sourceIdentityKey, keys));

    const [activeCountResult] = await transaction
      .select({ activeCount: count() })
      .from(indSponsors)
      .where(eq(indSponsors.active, true));
    const activeCount = activeCountResult?.activeCount ?? 0;
    if (activeCount !== snapshot.records.length) {
      throw new Error(
        `Sponsor sync verification failed: expected ${snapshot.records.length} active rows, found ${activeCount}`,
      );
    }

    return { rejectionReason: null };
  });

  if (outcome.rejectionReason !== null) {
    throw new Error(`Refusing to sync unsafe official sponsor snapshot: ${outcome.rejectionReason}`);
  }

  return {
    sourceRows: snapshot.rawRowCount,
    uniqueSponsors: snapshot.records.length,
    duplicatesIgnored: snapshot.duplicateRowCount,
  };
}
