/**
 * Stage-aware model routing (issue #284).
 *
 * A thin policy layer over contracts that already exist: the provider capability declarations in
 * `packages/agent-runtime/src/providers/<id>/capabilities.ts`, the live model catalogs ADI-22a
 * added (`AgentProvider.fetchModelCatalog`), and ADI-03's `resolveModelSelection`. It rebuilds none
 * of them and loosens none of them.
 *
 * ## The boundary this package does not cross
 *
 * **Nothing here can authorize, approve or trigger an application submission.** That decision lives
 * entirely in `packages/application-executor` -- `resolveSubmitControl`'s deliberately conservative
 * single-candidate rule and the executor's own handoff path -- and this package has no dependency
 * on it in either direction (check `package.json` of both). This router only ever answers "which
 * model drafts or extracts", and its outputs (`StageRoutingDecision`, `StageRoutingRecord`) carry
 * no field any caller could mistake for consent to send something.
 *
 * That is a structural fact, not an intention: `stage-routing.submission-boundary.test.ts` fails
 * the build if a submit-shaped symbol ever appears in this directory, or if either package gains a
 * dependency on the other.
 */
export {
  GENERATION_STAGES,
  STAGE_CONTRACTS,
  STAGE_TIER_PREFERENCE,
  stageContract,
  type GenerationStage,
  type ModelTier,
  type StageContract,
  type StageWorkload,
  type TierEvidence,
} from './stages.js';
export {
  PRICE_NOT_CONFIGURED,
  PRICE_NOT_PUBLISHED,
  describeCandidate,
  sameCandidate,
  type CandidatePrice,
  type CandidateRef,
  type RoutingCandidate,
} from './candidates.js';
export {
  describeStageDecision,
  routeStage,
  type CandidateRejectionReason,
  type RejectedCandidate,
  type RoutedStage,
  type StageFallbackReason,
  type StageRoutingDecision,
  type StageRoutingRequest,
  type UnroutableStage,
} from './router.js';
export {
  DEFAULT_LEDGER_CAPACITY,
  StageRoutingLedger,
  USAGE_CAPABILITY_ABSENT,
  USAGE_NOT_REPORTED,
  computeStageCost,
  recordStageRun,
  type StageCost,
  type StageRoutingRecord,
  type StageRunFacts,
  type StageRunOutcome,
  type StageUsage,
  type StageUsageMetrics,
} from './telemetry.js';
export {
  planNextAttempt,
  type EscalationPlan,
  type EscalationState,
  type HandoffReason,
  type StageFailure,
  type StageFailureKind,
} from './escalation.js';
export {
  DEFAULT_STAGE_CACHE_CAPACITY,
  ValidatedStageResultCache,
  stageCacheKey,
  validatedStageResult,
  type StageCacheKeyParts,
  type ValidatedStageResult,
} from './cache.js';
export {
  MINIMUM_BENCHMARK_SAMPLE,
  compareCost,
  formatCostComparison,
  rankByFactualConsistency,
  summarizeBenchmark,
  type BenchmarkCandidateSummary,
  type BenchmarkFixtureCase,
  type BenchmarkObservation,
  type BenchmarkReport,
  type CostComparison,
  type MeasuredRate,
  type QualityRanking,
  type Rate,
} from './benchmark.js';
