import type { CandidateProfile } from '../candidate/profile.js';
import {
  semanticScoreSchema,
  type NormalizedVacancy,
  type SemanticScore,
} from '../domain/models.js';

export type SemanticScoringRequest = {
  candidateProfile: CandidateProfile;
  vacancy: NormalizedVacancy;
};

/** Optional provider-neutral interface. V1 ships without a paid provider implementation. */
export type SemanticScorer = {
  readonly configVersion: string;
  score(request: SemanticScoringRequest): Promise<SemanticScore>;
};

export function parseSemanticScore(input: unknown): SemanticScore {
  return semanticScoreSchema.parse(input);
}
