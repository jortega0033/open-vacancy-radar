import { and, eq, gte, notInArray, sql } from 'drizzle-orm';

import { withTransaction, type Database } from '../db/client.js';
import { vacancies, vacancySnapshots } from '../db/schema.js';
import { normalizedVacancySchema, type NormalizedVacancy } from '../domain/models.js';
import {
  canonicalizeVacancyUrl,
  createVacancyContentHash,
  createVacancyRevisionHash,
  VACANCY_HASH_VERSION,
  VACANCY_REVISION_VERSION,
} from './hash.js';

export type PersistVacanciesInput = {
  companyId: string;
  careerSourceId: string;
  vacancies: NormalizedVacancy[];
  complete: boolean;
  observedAt?: Date;
  deactivateAfterCompleteMisses?: number;
};

export type PersistVacanciesResult = {
  discovered: number;
  created: number;
  changed: number;
  unchanged: number;
  invalid: number;
  inactive: number;
  completeAccepted: boolean;
  feedAnomaly: { baselineActive: number; observed: number } | null;
};

const FEED_ANOMALY_MINIMUM_BASELINE = 20;
const FEED_ANOMALY_MINIMUM_RETAINED_RATIO = 0.5;

function snapshotPayload(vacancy: NormalizedVacancy): Record<string, unknown> {
  return {
    ...vacancy,
    postedAt: vacancy.postedAt?.toISOString() ?? null,
  };
}

export async function persistVacancyScan(
  database: Database,
  input: PersistVacanciesInput,
): Promise<PersistVacanciesResult> {
  const observedAt = input.observedAt ?? new Date();
  const deactivateAfterCompleteMisses = input.deactivateAfterCompleteMisses ?? 2;
  if (deactivateAfterCompleteMisses < 1) throw new Error('deactivateAfterCompleteMisses must be positive');

  const uniqueByExternalId = new Map<string, NormalizedVacancy>();
  let invalid = 0;
  for (const candidate of input.vacancies) {
    const parsed = normalizedVacancySchema.safeParse(candidate);
    if (!parsed.success) {
      invalid += 1;
      continue;
    }
    uniqueByExternalId.set(parsed.data.externalId, parsed.data);
  }
  let created = 0;
  let changed = 0;
  let unchanged = 0;
  let inactive = 0;
  let completeAccepted = false;
  let feedAnomaly: PersistVacanciesResult['feedAnomaly'] = null;

  await withTransaction(database, async (transaction) => {
    const [baselineRow] = await transaction
      .select({ count: sql<number>`count(*)` })
      .from(vacancies)
      .where(and(eq(vacancies.careerSourceId, input.careerSourceId), eq(vacancies.active, true)));
    const baselineActive = baselineRow?.count ?? 0;
    if (
      input.complete &&
      invalid === 0 &&
      baselineActive >= FEED_ANOMALY_MINIMUM_BASELINE &&
      uniqueByExternalId.size < Math.ceil(baselineActive * FEED_ANOMALY_MINIMUM_RETAINED_RATIO)
    ) {
      feedAnomaly = { baselineActive, observed: uniqueByExternalId.size };
    }
    completeAccepted = input.complete && invalid === 0 && feedAnomaly === null;

    for (const vacancy of uniqueByExternalId.values()) {
      const contentHash = createVacancyContentHash(vacancy);
      const [existing] = await transaction
        .select({
          id: vacancies.id,
          contentHash: vacancies.contentHash,
          postedAt: vacancies.postedAt,
        })
        .from(vacancies)
        .where(
          and(
            eq(vacancies.careerSourceId, input.careerSourceId),
            eq(vacancies.externalId, vacancy.externalId),
          ),
        )
        .limit(1);

      const canonicalUrl = canonicalizeVacancyUrl(vacancy.url);
      const commonValues = {
        title: vacancy.title,
        location: vacancy.location,
        description: vacancy.description,
        url: canonicalUrl,
        employmentType: vacancy.employmentType,
        remote: vacancy.remote,
        workplaceMode: vacancy.workplaceMode,
        postedAt: vacancy.postedAt,
        lastSeenAt: observedAt,
        contentHash,
        hashVersion: VACANCY_HASH_VERSION,
        active: true,
        missingCompleteScans: 0,
      };

      let vacancyId: string;
      const postedAtChanged =
        (existing?.postedAt?.getTime() ?? null) !== (vacancy.postedAt?.getTime() ?? null);
      if (!existing) {
        const [inserted] = await transaction
          .insert(vacancies)
          .values({
            companyId: input.companyId,
            careerSourceId: input.careerSourceId,
            externalId: vacancy.externalId,
            firstSeenAt: observedAt,
            ...commonValues,
          })
          .returning({ id: vacancies.id });
        if (!inserted) throw new Error('Vacancy insert did not return an id');
        vacancyId = inserted.id;
        created += 1;
      } else {
        vacancyId = existing.id;
        await transaction.update(vacancies).set(commonValues).where(eq(vacancies.id, existing.id));
        if (existing.contentHash === contentHash && !postedAtChanged) unchanged += 1;
        else changed += 1;
      }

      if (existing?.contentHash !== contentHash || postedAtChanged) {
        await transaction
          .insert(vacancySnapshots)
          .values({
            vacancyId,
            contentHash: createVacancyRevisionHash(vacancy),
            hashVersion: VACANCY_REVISION_VERSION,
            payload: snapshotPayload({ ...vacancy, url: canonicalUrl }),
            observedAt,
          })
          .onConflictDoNothing();
      }
    }

    if (completeAccepted) {
      const seenIds = [...uniqueByExternalId.keys()];
      const sourceCondition = eq(vacancies.careerSourceId, input.careerSourceId);
      const missingCondition =
        seenIds.length === 0
          ? sourceCondition
          : and(sourceCondition, notInArray(vacancies.externalId, seenIds));
      await transaction
        .update(vacancies)
        .set({ missingCompleteScans: sql`${vacancies.missingCompleteScans} + 1` })
        .where(and(missingCondition, eq(vacancies.active, true)));
      const deactivated = await transaction
        .update(vacancies)
        .set({ active: false })
        .where(
          and(
            sourceCondition,
            eq(vacancies.active, true),
            gte(vacancies.missingCompleteScans, deactivateAfterCompleteMisses),
          ),
        )
        .returning({ id: vacancies.id });
      inactive = deactivated.length;
    }
  });

  return {
    discovered: uniqueByExternalId.size,
    created,
    changed,
    unchanged,
    invalid,
    inactive,
    completeAccepted,
    feedAnomaly,
  };
}
