import type { CandidateProfile } from '../candidate/profile.js';
import { isCandidateProfileConfigured, loadCandidateProfile } from '../candidate/profile.js';
import type { Database } from '../db/client.js';
import { DETERMINISTIC_SCORING_VERSION, scoreVacancy } from '../filtering/index.js';
import {
  DrizzleDeterministicScoringRepository,
  type DeterministicScoreRecord,
  type DeterministicScoringRepository,
  type ScoreCacheVacancyIdentity,
} from './repository.js';

export type DeterministicScoringResult = {
  candidateProfileVersion: string;
  scoringVersion: string;
  /** False when the candidate profile has no target roles and no strongest skills configured. */
  profileConfigured: boolean;
  activeVacancies: number;
  cacheHits: number;
  computed: number;
  persisted: number;
  relevantComputed: number;
};

export type ScoreActiveVacanciesOptions = {
  scoredAt?: Date;
};

export type RunPersistedDeterministicScoringOptions = ScoreActiveVacanciesOptions & {
  profilePath?: string;
};

function cacheKey(identity: ScoreCacheVacancyIdentity): string {
  return `${identity.vacancyId}\u0000${identity.contentHash}`;
}

export async function scoreActiveVacancies(
  repository: DeterministicScoringRepository,
  profile: CandidateProfile,
  options: ScoreActiveVacanciesOptions = {},
): Promise<DeterministicScoringResult> {
  const activeVacancies = await repository.listActiveVacancies();

  if (!isCandidateProfileConfigured(profile)) {
    // No target roles, no strongest skills: every dimension of scoreVacancy would be scoring
    // against an absence rather than a real preference, producing a plausible-looking number that
    // means nothing. Skip scoring outright rather than caching a degenerate score for every
    // vacancy — the report layer surfaces `profileConfigured: false` and shows unscored results
    // instead of an empty "nothing matched" list.
    return {
      candidateProfileVersion: profile.profileVersion,
      scoringVersion: DETERMINISTIC_SCORING_VERSION,
      profileConfigured: false,
      activeVacancies: activeVacancies.length,
      cacheHits: 0,
      computed: 0,
      persisted: 0,
      relevantComputed: 0,
    };
  }

  const identities = activeVacancies.map((vacancy) => ({
    vacancyId: vacancy.id,
    contentHash: vacancy.contentHash,
  }));
  const cached = await repository.findCachedScoreIdentities({
    candidateProfileVersion: profile.profileVersion,
    scoringVersion: DETERMINISTIC_SCORING_VERSION,
    vacancies: identities,
  });
  const cachedKeys = new Set(cached.map(cacheKey));
  const scoredAt = options.scoredAt ?? new Date();
  const records: DeterministicScoreRecord[] = [];
  let relevantComputed = 0;

  for (const scorable of activeVacancies) {
    if (cachedKeys.has(cacheKey({ vacancyId: scorable.id, contentHash: scorable.contentHash }))) {
      continue;
    }
    const score = scoreVacancy(scorable.vacancy, profile);
    if (score.relevant) relevantComputed += 1;
    records.push({
      vacancyId: scorable.id,
      contentHash: scorable.contentHash,
      candidateProfileVersion: profile.profileVersion,
      scoringVersion: DETERMINISTIC_SCORING_VERSION,
      score,
      scoredAt,
    });
  }

  if (records.length > 0) await repository.upsertDeterministicScores(records);

  return {
    candidateProfileVersion: profile.profileVersion,
    scoringVersion: DETERMINISTIC_SCORING_VERSION,
    profileConfigured: true,
    activeVacancies: activeVacancies.length,
    cacheHits: activeVacancies.length - records.length,
    computed: records.length,
    persisted: records.length,
    relevantComputed,
  };
}

export async function runPersistedDeterministicScoring(
  database: Database,
  options: RunPersistedDeterministicScoringOptions = {},
): Promise<DeterministicScoringResult> {
  const profile =
    options.profilePath === undefined
      ? await loadCandidateProfile()
      : await loadCandidateProfile(options.profilePath);
  const repository = new DrizzleDeterministicScoringRepository(database);
  return scoreActiveVacancies(repository, profile, {
    ...(options.scoredAt === undefined ? {} : { scoredAt: options.scoredAt }),
  });
}
