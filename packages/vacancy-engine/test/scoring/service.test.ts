import { describe, expect, it, vi } from 'vitest';

import type { CandidateProfile } from '../../src/candidate/profile.js';
import type { Database } from '../../src/db/client.js';
import { DETERMINISTIC_SCORING_VERSION } from '../../src/filtering/index.js';
import {
  DrizzleDeterministicScoringRepository,
  type CachedScoreIdentity,
  type CachedScoreLookup,
  type DeterministicScoreRecord,
  type DeterministicScoringRepository,
  runPersistedDeterministicScoring,
  type ScorableVacancy,
  scoreActiveVacancies,
} from '../../src/scoring/index.js';

const profile: CandidateProfile = {
  profileVersion: 'candidate-profile-v1',
  candidateName: 'Jake Ortega',
  currentRole: 'Senior Frontend Engineer',
  location: 'Netherlands',
  experienceYears: 10,
  strongestSkills: ['Angular', 'TypeScript', 'React', 'design systems'],
  additionalSkills: ['Node.js', 'NestJS'],
  targetRoles: ['Senior Frontend Engineer', 'Frontend Engineer'],
  consideredRoles: ['Product Engineer', 'Software Engineer'],
  excludedRoleFamilies: ['backend-only', 'management-only', 'QA-only'],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: true,
    minimumMonthlyBaseEur: 6_000,
  },
};

function scorable(
  id: string,
  contentHash: string,
  title: string,
  description: string,
): ScorableVacancy {
  return {
    id,
    contentHash,
    vacancy: {
      externalId: `external-${id}`,
      title,
      description: `${description}\nCompensation: €6,500 gross per month.`,
      location: 'Amsterdam, Netherlands',
      remote: false,
      workplaceMode: 'onsite',
      url: `https://jobs.example.test/${id}`,
      postedAt: null,
      employmentType: 'Full-time',
      source: 'test-source',
    },
  };
}

function persistedKey(record: {
  vacancyId: string;
  contentHash: string;
  candidateProfileVersion: string;
  scoringVersion: string;
}): string {
  return [
    record.vacancyId,
    record.contentHash,
    record.candidateProfileVersion,
    record.scoringVersion,
  ].join('\u0000');
}

class MemoryScoringRepository implements DeterministicScoringRepository {
  public activeVacancies: ScorableVacancy[];
  public readonly writes: DeterministicScoreRecord[][] = [];
  readonly #cache = new Map<string, CachedScoreIdentity>();

  public constructor(activeVacancies: ScorableVacancy[]) {
    this.activeVacancies = activeVacancies;
  }

  public listActiveVacancies(): Promise<readonly ScorableVacancy[]> {
    return Promise.resolve(this.activeVacancies);
  }

  public findCachedScoreIdentities(input: CachedScoreLookup): Promise<readonly CachedScoreIdentity[]> {
    return Promise.resolve(
      input.vacancies.flatMap((vacancy) => {
        const key = persistedKey({
          ...vacancy,
          candidateProfileVersion: input.candidateProfileVersion,
          scoringVersion: input.scoringVersion,
        });
        const cached = this.#cache.get(key);
        return cached === undefined ? [] : [cached];
      }),
    );
  }

  public upsertDeterministicScores(records: readonly DeterministicScoreRecord[]): Promise<void> {
    this.writes.push([...records]);
    for (const record of records) {
      this.#cache.set(persistedKey(record), {
        vacancyId: record.vacancyId,
        contentHash: record.contentHash,
      });
    }
    return Promise.resolve();
  }

  public seedCachedIdentity(input: {
    vacancyId: string;
    contentHash: string;
    candidateProfileVersion: string;
    scoringVersion: string;
  }): void {
    this.#cache.set(persistedKey(input), {
      vacancyId: input.vacancyId,
      contentHash: input.contentHash,
    });
  }
}

describe('persisted deterministic scoring service', () => {
  it('scores, persists, and then skips unchanged vacancies without another write', async () => {
    const repository = new MemoryScoringRepository([
      scorable(
        'angular',
        'hash-angular-v1',
        'Software Engineer',
        'Build Angular and TypeScript UI for our frontend web application and design system.',
      ),
      scorable(
        'backend',
        'hash-backend-v1',
        'Java Backend Developer',
        'Build Java and Spring Boot backend microservices.',
      ),
    ]);
    const scoredAt = new Date('2026-08-28T10:00:00.000Z');

    const first = await scoreActiveVacancies(repository, profile, { scoredAt });
    expect(first).toEqual({
      candidateProfileVersion: profile.profileVersion,
      scoringVersion: DETERMINISTIC_SCORING_VERSION,
      activeVacancies: 2,
      cacheHits: 0,
      computed: 2,
      persisted: 2,
      relevantComputed: 1,
    });
    expect(repository.writes).toHaveLength(1);
    expect(repository.writes[0]).toHaveLength(2);
    expect(repository.writes[0]?.[0]).toMatchObject({
      vacancyId: 'angular',
      contentHash: 'hash-angular-v1',
      candidateProfileVersion: profile.profileVersion,
      scoringVersion: DETERMINISTIC_SCORING_VERSION,
      scoredAt,
    });
    expect(repository.writes[0]?.[0]?.score.relevant).toBe(true);
    expect(repository.writes[0]?.[1]).toMatchObject({ vacancyId: 'backend' });
    expect(repository.writes[0]?.[1]?.score.relevant).toBe(false);

    const second = await scoreActiveVacancies(repository, profile, { scoredAt });
    expect(second).toMatchObject({ activeVacancies: 2, cacheHits: 2, computed: 0, persisted: 0 });
    expect(repository.writes).toHaveLength(1);
  });

  it('recomputes only the vacancy whose content hash changed', async () => {
    const angular = scorable(
      'angular',
      'hash-angular-v1',
      'Software Engineer',
      'Build Angular and TypeScript UI for our frontend web application and design system.',
    );
    const react = scorable(
      'react',
      'hash-react-v1',
      'Product Engineer',
      'Build React and TypeScript frontend UI for our web application.',
    );
    const repository = new MemoryScoringRepository([angular, react]);
    await scoreActiveVacancies(repository, profile);

    repository.activeVacancies = [
      { ...angular, contentHash: 'hash-angular-v2' },
      react,
    ];
    const result = await scoreActiveVacancies(repository, profile);

    expect(result).toMatchObject({ activeVacancies: 2, cacheHits: 1, computed: 1, persisted: 1 });
    expect(repository.writes).toHaveLength(2);
    expect(repository.writes[1]).toEqual([
      expect.objectContaining({ vacancyId: 'angular', contentHash: 'hash-angular-v2' }),
    ]);
  });

  it('uses profile version as part of the cache identity', async () => {
    const repository = new MemoryScoringRepository([
      scorable(
        'angular',
        'same-content',
        'Angular Developer',
        'Build Angular and TypeScript frontend web applications.',
      ),
    ]);
    await scoreActiveVacancies(repository, profile);

    const nextProfile = { ...profile, profileVersion: 'candidate-profile-v2' };
    const result = await scoreActiveVacancies(repository, nextProfile);

    expect(result).toMatchObject({ cacheHits: 0, computed: 1, persisted: 1 });
    expect(repository.writes[1]?.[0]).toMatchObject({
      candidateProfileVersion: 'candidate-profile-v2',
      scoringVersion: DETERMINISTIC_SCORING_VERSION,
    });
  });

  it('recomputes when only an older algorithm version is cached', async () => {
    const candidate = scorable(
      'angular',
      'same-content',
      'Angular Developer',
      'Build Angular and TypeScript frontend web applications.',
    );
    const repository = new MemoryScoringRepository([candidate]);
    repository.seedCachedIdentity({
      vacancyId: candidate.id,
      contentHash: candidate.contentHash,
      candidateProfileVersion: profile.profileVersion,
      scoringVersion: 'deterministic-relevance-v2',
    });

    const result = await scoreActiveVacancies(repository, profile);

    expect(result).toMatchObject({ cacheHits: 0, computed: 1, persisted: 1 });
    expect(repository.writes[0]?.[0]?.scoringVersion).toBe(DETERMINISTIC_SCORING_VERSION);
  });

  it('loads the default project profile through the CLI-ready database entry point', async () => {
    const orderBy = vi.fn(() => Promise.resolve([]));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const insert = vi.fn();
    const database = { select, insert } as unknown as Database;

    const result = await runPersistedDeterministicScoring(database);

    expect(result).toEqual({
      candidateProfileVersion: 'candidate-profile-v3',
      scoringVersion: DETERMINISTIC_SCORING_VERSION,
      activeVacancies: 0,
      cacheHits: 0,
      computed: 0,
      persisted: 0,
      relevantComputed: 0,
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('Drizzle deterministic scoring repository', () => {
  it('maps active database rows into normalized vacancies', async () => {
    const postedAt = new Date('2026-08-20T12:00:00.000Z');
    const orderBy = vi.fn(() =>
      Promise.resolve([
        {
          id: 'vacancy-id',
          contentHash: 'content-hash',
          careerSourceId: 'career-source-id',
          externalId: 'external-id',
          title: 'Frontend Engineer',
          description: 'Build Angular applications.',
          location: 'Utrecht, Netherlands',
          remote: true,
          workplaceMode: 'remote',
          url: 'https://jobs.example.test/frontend',
          postedAt,
          employmentType: 'Full-time',
        },
      ]),
    );
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const database = { select } as unknown as Database;

    const repository = new DrizzleDeterministicScoringRepository(database);
    await expect(repository.listActiveVacancies()).resolves.toEqual([
      {
        id: 'vacancy-id',
        contentHash: 'content-hash',
        vacancy: {
          externalId: 'external-id',
          title: 'Frontend Engineer',
          description: 'Build Angular applications.',
          location: 'Utrecht, Netherlands',
          remote: true,
          workplaceMode: 'remote',
          url: 'https://jobs.example.test/frontend',
          postedAt,
          employmentType: 'Full-time',
          source: 'career-source-id',
        },
      },
    ]);
    expect(where).toHaveBeenCalledTimes(1);
    expect(orderBy).toHaveBeenCalledTimes(1);
  });

  it('does no database work for empty cache lookups or writes', async () => {
    const select = vi.fn();
    const insert = vi.fn();
    const repository = new DrizzleDeterministicScoringRepository({ select, insert } as unknown as Database);

    await expect(
      repository.findCachedScoreIdentities({
        candidateProfileVersion: profile.profileVersion,
        scoringVersion: DETERMINISTIC_SCORING_VERSION,
        vacancies: [],
      }),
    ).resolves.toEqual([]);
    await repository.upsertDeterministicScores([]);

    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('persists only deterministic fields and preserves semantic fields on conflict', async () => {
    type ConflictInput = { target: unknown[]; set: Record<string, unknown> };
    let insertedValues: unknown;
    let conflictInput: ConflictInput | undefined;
    const onConflictDoUpdate = vi.fn((input: ConflictInput) => {
      conflictInput = input;
      return Promise.resolve();
    });
    const values = vi.fn((input: unknown) => {
      insertedValues = input;
      return { onConflictDoUpdate };
    });
    const insert = vi.fn(() => ({ values }));
    const repository = new DrizzleDeterministicScoringRepository({ insert } as unknown as Database);
    const score = repositoryScoreFixture();

    await repository.upsertDeterministicScores([
      {
        vacancyId: 'vacancy-id',
        contentHash: 'content-hash',
        candidateProfileVersion: profile.profileVersion,
        scoringVersion: DETERMINISTIC_SCORING_VERSION,
        score,
        scoredAt: new Date('2026-08-28T10:00:00.000Z'),
      },
    ]);

    expect(insertedValues).toEqual([
      expect.objectContaining({
        deterministicScore: score.deterministicScore,
        finalScore: score.deterministicScore,
        technicalFit: score.technicalFit,
        contentHash: 'content-hash',
      }),
    ]);
    const insertedRow = (insertedValues as Record<string, unknown>[])[0];
    expect(insertedRow).not.toHaveProperty('semanticScore');
    expect(insertedRow).not.toHaveProperty('semanticConfigVersion');

    expect(conflictInput).toBeDefined();
    expect(conflictInput?.target).toHaveLength(4);
    expect(conflictInput?.set).not.toHaveProperty('semanticScore');
    expect(conflictInput?.set).not.toHaveProperty('semanticConfigVersion');
  });
});

function repositoryScoreFixture(): DeterministicScoreRecord['score'] {
  return {
    relevant: true,
    deterministicScore: 91,
    technicalFit: 95,
    roleFit: 90,
    seniorityFit: 90,
    languageFit: 100,
    locationFit: 100,
    dutchRequired: false,
    dutchPreferred: false,
    languageEvidence: [],
    primaryFit: 'Frontend / UI engineering',
    matchingSkills: ['Angular', 'TypeScript'],
    gaps: [],
    reasons: ['Strong deterministic match'],
  };
}
