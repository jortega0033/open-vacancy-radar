import type { BenchmarkFixtureCase, BenchmarkObservation, CandidateRef } from '../../src/index.js';
import { priced } from '../support/stage-candidates.js';

/**
 * A controlled fixture corpus for the stage benchmark (issue #284, acceptance check 4).
 *
 * Entirely invented: a fictional candidate, fictional employers, a fictional posting. That is a
 * requirement rather than a convenience -- CONTRIBUTING.md forbids a test that depends on a real
 * authenticated CLI or spends API credit, and #284 itself excludes candidate data, CV contents and
 * private paths from any public artifact of this work. Nothing here was produced by a model: the
 * "produced facts" columns are hand-written stand-ins for what a harness would extract from a real
 * answer, which is what lets the summary functions be tested for arithmetic and for honesty without
 * a provider being installed.
 */
export const FIXTURE_SET = 'stage-routing-benchmark-v1';

export const SMALL_MODEL: CandidateRef = { providerId: 'codex', model: 'fixture-small' };
export const CAPABLE_MODEL: CandidateRef = { providerId: 'claude', model: 'fixture-capable' };
/** A pairing whose provider publishes no per-token price, which is the common real case for a
 * CLI billed against a subscription rather than an API key. */
export const UNPRICED_MODEL: CandidateRef = { providerId: 'claude', model: 'fixture-unpriced' };

export const BENCHMARK_CASES: readonly BenchmarkFixtureCase[] = Object.freeze([
  Object.freeze({
    id: 'tailor-01',
    stage: 'cv_tailoring' as const,
    expectedFacts: Object.freeze(['six years of node', 'led the billing migration']),
    forbiddenFacts: Object.freeze(['kubernetes certification']),
    requiredProjects: Object.freeze(['Ledger Rewrite']),
  }),
  Object.freeze({
    id: 'tailor-02',
    stage: 'cv_tailoring' as const,
    expectedFacts: Object.freeze(['postgres at scale']),
    forbiddenFacts: Object.freeze(['phd in statistics']),
    requiredProjects: Object.freeze(['Ledger Rewrite', 'Warehouse Sync']),
  }),
  Object.freeze({
    id: 'tailor-03',
    stage: 'cv_tailoring' as const,
    expectedFacts: Object.freeze(['ran the on-call rotation']),
    forbiddenFacts: Object.freeze(['managed a team of forty']),
    requiredProjects: Object.freeze(['Warehouse Sync']),
  }),
]);

/**
 * The field-map stage is benchmarked as its own set, never merged into the tailoring one.
 *
 * Mixing them would average a measure that applies (form-map validity) with three that do not, and
 * would let rows with empty fact lists inflate another stage's factual-consistency rate simply by
 * having nothing to get wrong. A benchmark run compares pairings *within one stage*; comparing
 * across stages answers no question anyone has.
 */
export const FIELD_MAP_CASES: readonly BenchmarkFixtureCase[] = Object.freeze([
  Object.freeze({
    id: 'fieldmap-01',
    stage: 'application_field_map' as const,
    expectedFacts: Object.freeze([]),
    forbiddenFacts: Object.freeze([]),
    requiredProjects: Object.freeze([]),
  }),
  Object.freeze({
    id: 'fieldmap-02',
    stage: 'application_field_map' as const,
    expectedFacts: Object.freeze([]),
    forbiddenFacts: Object.freeze([]),
    requiredProjects: Object.freeze([]),
  }),
  Object.freeze({
    id: 'fieldmap-03',
    stage: 'application_field_map' as const,
    expectedFacts: Object.freeze([]),
    forbiddenFacts: Object.freeze([]),
    requiredProjects: Object.freeze([]),
  }),
]);

/**
 * Three tailoring cases per pairing, so both clear `MINIMUM_BENCHMARK_SAMPLE` and a comparison is
 * actually permitted. The small model's rows are deliberately the ones that drop a pinned project
 * and invent a certification -- which is the finding this benchmark exists to surface, and exactly
 * the finding that a cost-only comparison would have hidden.
 */
export const BENCHMARK_OBSERVATIONS: readonly BenchmarkObservation[] = Object.freeze([
  Object.freeze({
    caseId: 'tailor-01',
    candidate: SMALL_MODEL,
    price: priced(0.8, 4),
    producedFacts: Object.freeze(['six years of node', 'led the billing migration', 'kubernetes certification']),
    preservedProjects: Object.freeze(['Ledger Rewrite']),
    formMapValid: 'not_applicable' as const,
    humanCorrections: 3,
    latencyMs: 4_100,
    usage: { kind: 'reported' as const, metrics: { inputTokens: 18_000, outputTokens: 2_400 } },
  }),
  Object.freeze({
    caseId: 'tailor-02',
    candidate: SMALL_MODEL,
    price: priced(0.8, 4),
    producedFacts: Object.freeze(['postgres at scale']),
    preservedProjects: Object.freeze(['Ledger Rewrite']),
    formMapValid: 'not_applicable' as const,
    humanCorrections: 2,
    latencyMs: 3_900,
    usage: { kind: 'reported' as const, metrics: { inputTokens: 17_500, outputTokens: 2_100 } },
  }),
  Object.freeze({
    caseId: 'tailor-03',
    candidate: SMALL_MODEL,
    price: priced(0.8, 4),
    producedFacts: Object.freeze(['ran the on-call rotation']),
    preservedProjects: Object.freeze(['Warehouse Sync']),
    formMapValid: 'not_applicable' as const,
    humanCorrections: 1,
    latencyMs: 4_000,
    usage: { kind: 'reported' as const, metrics: { inputTokens: 16_800, outputTokens: 2_000 } },
  }),
  Object.freeze({
    caseId: 'tailor-01',
    candidate: CAPABLE_MODEL,
    price: priced(3, 15),
    producedFacts: Object.freeze(['six years of node', 'led the billing migration']),
    preservedProjects: Object.freeze(['Ledger Rewrite']),
    formMapValid: 'not_applicable' as const,
    humanCorrections: 0,
    latencyMs: 9_200,
    usage: { kind: 'reported' as const, metrics: { inputTokens: 18_000, outputTokens: 2_600 } },
  }),
  Object.freeze({
    caseId: 'tailor-02',
    candidate: CAPABLE_MODEL,
    price: priced(3, 15),
    producedFacts: Object.freeze(['postgres at scale']),
    preservedProjects: Object.freeze(['Ledger Rewrite', 'Warehouse Sync']),
    formMapValid: 'not_applicable' as const,
    humanCorrections: 1,
    latencyMs: 10_400,
    usage: { kind: 'reported' as const, metrics: { inputTokens: 17_500, outputTokens: 2_500 } },
  }),
  Object.freeze({
    caseId: 'tailor-03',
    candidate: CAPABLE_MODEL,
    price: priced(3, 15),
    producedFacts: Object.freeze(['ran the on-call rotation']),
    preservedProjects: Object.freeze(['Warehouse Sync']),
    formMapValid: 'not_applicable' as const,
    humanCorrections: 0,
    latencyMs: 8_800,
    usage: { kind: 'reported' as const, metrics: { inputTokens: 16_800, outputTokens: 2_300 } },
  }),
]);

/** The same three cases on a pairing whose price nobody published, for the "stays unknown" path. */
export const UNPRICED_OBSERVATIONS: readonly BenchmarkObservation[] = Object.freeze(
  BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === CAPABLE_MODEL).map((row) =>
    Object.freeze({
      ...row,
      candidate: UNPRICED_MODEL,
      price: { kind: 'unknown' as const, reason: 'not_published' as const },
    }),
  ),
);

/**
 * Field-map rows, where form-map validity is the measure that applies and the other three do not.
 * `fieldmap-02` is deliberately an invalid map: a stage whose fixture corpus only contains
 * successes measures nothing about the failure it was built to catch.
 */
export const FIELD_MAP_OBSERVATIONS: readonly BenchmarkObservation[] = Object.freeze(
  (
    [
      ['fieldmap-01', true, 5_100],
      ['fieldmap-02', false, 5_400],
      ['fieldmap-03', true, 4_900],
    ] as const
  ).map(([caseId, formMapValid, latencyMs]) =>
    Object.freeze({
      caseId,
      candidate: CAPABLE_MODEL,
      price: priced(3, 15),
      producedFacts: Object.freeze([]),
      preservedProjects: Object.freeze([]),
      formMapValid,
      humanCorrections: formMapValid ? 0 : 1,
      latencyMs,
      usage: { kind: 'reported' as const, metrics: { inputTokens: 9_000, outputTokens: 800 } },
    }),
  ),
);
