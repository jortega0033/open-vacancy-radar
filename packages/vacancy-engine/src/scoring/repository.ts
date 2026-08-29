import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { vacancies, vacancyScores } from '../db/schema.js';
import type { DeterministicScore, NormalizedVacancy } from '../domain/models.js';

export type ScorableVacancy = {
  id: string;
  contentHash: string;
  vacancy: NormalizedVacancy;
};

export type ScoreCacheVacancyIdentity = {
  vacancyId: string;
  contentHash: string;
};

export type CachedScoreIdentity = ScoreCacheVacancyIdentity;

export type CachedScoreLookup = {
  candidateProfileVersion: string;
  scoringVersion: string;
  vacancies: readonly ScoreCacheVacancyIdentity[];
};

export type DeterministicScoreRecord = {
  vacancyId: string;
  contentHash: string;
  candidateProfileVersion: string;
  scoringVersion: string;
  score: DeterministicScore;
  scoredAt: Date;
};

export type DeterministicScoringRepository = {
  listActiveVacancies(): Promise<readonly ScorableVacancy[]>;
  findCachedScoreIdentities(input: CachedScoreLookup): Promise<readonly CachedScoreIdentity[]>;
  upsertDeterministicScores(records: readonly DeterministicScoreRecord[]): Promise<void>;
};

const CACHE_LOOKUP_BATCH_SIZE = 5_000;
const SCORE_WRITE_BATCH_SIZE = 250;

function batchesOf<T>(values: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    batches.push(values.slice(offset, offset + batchSize));
  }
  return batches;
}

export class DrizzleDeterministicScoringRepository implements DeterministicScoringRepository {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public async listActiveVacancies(): Promise<readonly ScorableVacancy[]> {
    const rows = await this.#database
      .select({
        id: vacancies.id,
        contentHash: vacancies.contentHash,
        careerSourceId: vacancies.careerSourceId,
        externalId: vacancies.externalId,
        title: vacancies.title,
        description: vacancies.description,
        location: vacancies.location,
        remote: vacancies.remote,
        workplaceMode: vacancies.workplaceMode,
        url: vacancies.url,
        postedAt: vacancies.postedAt,
        employmentType: vacancies.employmentType,
      })
      .from(vacancies)
      .where(eq(vacancies.active, true))
      .orderBy(asc(vacancies.id));

    return rows.map((row) => ({
      id: row.id,
      contentHash: row.contentHash,
      vacancy: {
        externalId: row.externalId,
        title: row.title,
        description: row.description,
        location: row.location,
        remote: row.remote,
        workplaceMode: row.workplaceMode,
        url: row.url,
        postedAt: row.postedAt,
        employmentType: row.employmentType,
        source: row.careerSourceId,
      },
    }));
  }

  public async findCachedScoreIdentities(
    input: CachedScoreLookup,
  ): Promise<readonly CachedScoreIdentity[]> {
    if (input.vacancies.length === 0) return [];

    const cached: CachedScoreIdentity[] = [];
    for (const batch of batchesOf(input.vacancies, CACHE_LOOKUP_BATCH_SIZE)) {
      const rows = await this.#database
        .select({
          vacancyId: vacancyScores.vacancyId,
          contentHash: vacancyScores.contentHash,
        })
        .from(vacancyScores)
        .where(
          and(
            eq(vacancyScores.candidateProfileVersion, input.candidateProfileVersion),
            eq(vacancyScores.scoringVersion, input.scoringVersion),
            inArray(
              vacancyScores.vacancyId,
              batch.map((vacancy) => vacancy.vacancyId),
            ),
            inArray(
              vacancyScores.contentHash,
              batch.map((vacancy) => vacancy.contentHash),
            ),
          ),
        );
      cached.push(...rows);
    }
    return cached;
  }

  public async upsertDeterministicScores(
    records: readonly DeterministicScoreRecord[],
  ): Promise<void> {
    for (const batch of batchesOf(records, SCORE_WRITE_BATCH_SIZE)) {
      const values: (typeof vacancyScores.$inferInsert)[] = batch.map((record) => ({
        vacancyId: record.vacancyId,
        candidateProfileVersion: record.candidateProfileVersion,
        scoringVersion: record.scoringVersion,
        deterministicScore: record.score.deterministicScore,
        finalScore: record.score.deterministicScore,
        technicalFit: record.score.technicalFit,
        roleFit: record.score.roleFit,
        seniorityFit: record.score.seniorityFit,
        languageFit: record.score.languageFit,
        locationFit: record.score.locationFit,
        dutchRequired: record.score.dutchRequired,
        dutchPreferred: record.score.dutchPreferred,
        languageEvidence: record.score.languageEvidence,
        primaryFit: record.score.primaryFit,
        matchingSkills: record.score.matchingSkills,
        gaps: record.score.gaps,
        reasons: record.score.reasons,
        contentHash: record.contentHash,
        scoredAt: record.scoredAt,
      }));

      await this.#database
        .insert(vacancyScores)
        .values(values)
        .onConflictDoUpdate({
          target: [
            vacancyScores.vacancyId,
            vacancyScores.contentHash,
            vacancyScores.candidateProfileVersion,
            vacancyScores.scoringVersion,
          ],
          set: {
            deterministicScore: sql`excluded.deterministic_score`,
            finalScore: sql`case when ${vacancyScores.semanticScore} is null then excluded.final_score else ${vacancyScores.finalScore} end`,
            technicalFit: sql`excluded.technical_fit`,
            roleFit: sql`excluded.role_fit`,
            seniorityFit: sql`excluded.seniority_fit`,
            languageFit: sql`excluded.language_fit`,
            locationFit: sql`excluded.location_fit`,
            dutchRequired: sql`excluded.dutch_required`,
            dutchPreferred: sql`excluded.dutch_preferred`,
            languageEvidence: sql`excluded.language_evidence`,
            primaryFit: sql`excluded.primary_fit`,
            matchingSkills: sql`excluded.matching_skills`,
            gaps: sql`excluded.gaps`,
            reasons: sql`excluded.reasons`,
            scoredAt: sql`excluded.scored_at`,
          },
        });
    }
  }
}
