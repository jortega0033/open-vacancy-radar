import { describe, expect, it } from 'vitest';
import {
  MINIMUM_BENCHMARK_SAMPLE,
  compareCost,
  formatCostComparison,
  rankByFactualConsistency,
  summarizeBenchmark,
  type BenchmarkCandidateSummary,
} from '../src/index.js';
import {
  BENCHMARK_CASES,
  BENCHMARK_OBSERVATIONS,
  CAPABLE_MODEL,
  FIELD_MAP_CASES,
  FIELD_MAP_OBSERVATIONS,
  FIXTURE_SET,
  SMALL_MODEL,
  UNPRICED_MODEL,
  UNPRICED_OBSERVATIONS,
} from './fixtures/stage-benchmark.js';

function summaryFor(report: { candidates: readonly BenchmarkCandidateSummary[] }, label: string): BenchmarkCandidateSummary {
  const found = report.candidates.find((entry) => entry.label === label);
  if (!found) throw new Error(`no summary for ${label}`);
  return found;
}

/**
 * **Acceptance check 4 of issue #284**: a fixture benchmark comparing cost and latency against
 * factual consistency, required-project preservation, form-map validity and human corrections.
 */
describe('summarizeBenchmark (acceptance check 4)', () => {
  const report = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, BENCHMARK_OBSERVATIONS);
  const fieldMapReport = summarizeBenchmark(FIXTURE_SET, FIELD_MAP_CASES, FIELD_MAP_OBSERVATIONS);

  it('reports all four quality measures alongside cost and latency for each pairing', () => {
    const small = summaryFor(report, 'codex/fixture-small');
    expect(small).toMatchObject({
      cases: 3,
      factualConsistency: { kind: 'measured', sampleSize: 3 },
      requiredProjectPreservation: { kind: 'measured', sampleSize: 3 },
      humanCorrectionsPerCase: { kind: 'measured', sampleSize: 3 },
      totalCost: { kind: 'measured' },
    });
    expect(small.medianLatencyMs).toBe(4_000);
  });

  it('counts an invented fact as a factual-consistency failure, not merely a style issue', () => {
    // The small model's `tailor-01` row asserts a certification the fixture says is not in the
    // source. Two of its three cases are clean, so 2/3 -- and the finding is visible rather than
    // averaged into a single quality score.
    expect(summaryFor(report, 'codex/fixture-small').factualConsistency).toEqual({
      kind: 'measured',
      value: 2 / 3,
      sampleSize: 3,
    });
    expect(summaryFor(report, 'claude/fixture-capable').factualConsistency).toEqual({
      kind: 'measured',
      value: 1,
      sampleSize: 3,
    });
  });

  it('measures required-project preservation separately, because a fluent answer can still drop a pin', () => {
    // `tailor-02` requires two pinned projects and the small model's answer kept one. Factual
    // consistency alone would have scored that row as fine (#274's whole point).
    expect(summaryFor(report, 'codex/fixture-small').requiredProjectPreservation).toEqual({
      kind: 'measured',
      value: 2 / 3,
      sampleSize: 3,
    });
  });

  it('scores form-map validity only over the rows where a form map existed', () => {
    expect(summaryFor(fieldMapReport, 'claude/fixture-capable').formMapValidity).toEqual({
      kind: 'measured',
      value: 2 / 3,
      sampleSize: 3,
    });
    // The tailoring run produces no form map at all, so the measure is `not_applicable` rather than
    // a 0% that would read as three failures nobody observed.
    expect(summaryFor(report, 'codex/fixture-small').formMapValidity).toEqual({ kind: 'not_applicable' });
  });

  it('reports a single-case measure as insufficient evidence rather than as a 0% or a 100%', () => {
    const oneCase = summarizeBenchmark(FIXTURE_SET, FIELD_MAP_CASES, FIELD_MAP_OBSERVATIONS.slice(0, 1));
    expect(summaryFor(oneCase, 'claude/fixture-capable').formMapValidity).toEqual({
      kind: 'insufficient_evidence',
      sampleSize: 1,
    });
  });

  it('counts the human corrections a reviewer actually made', () => {
    expect(summaryFor(report, 'codex/fixture-small').humanCorrectionsPerCase).toEqual({
      kind: 'measured',
      value: 2,
      sampleSize: 3,
    });
  });

  it('ignores an observation for a case it has no ground truth for', () => {
    const withStray = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, [
      ...BENCHMARK_OBSERVATIONS,
      { ...BENCHMARK_OBSERVATIONS[0]!, caseId: 'a-case-nobody-defined' },
    ]);
    expect(summaryFor(withStray, 'codex/fixture-small').cases).toBe(3);
  });
});

/**
 * **Acceptance check 5 of issue #284**: no savings percentage or quality ranking is claimed without
 * measured evidence, and unavailable price/usage data stays labelled unknown.
 */
describe('cost comparison refuses to produce a number it did not measure (acceptance check 5)', () => {
  const report = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, [
    ...BENCHMARK_OBSERVATIONS,
    ...UNPRICED_OBSERVATIONS,
  ]);

  it('leaves a pairing with no published price labelled unknown rather than assuming a rate', () => {
    expect(summaryFor(report, 'claude/fixture-unpriced').totalCost).toEqual({
      kind: 'unknown',
      reason: 'price_unknown',
    });
  });

  it('refuses the comparison outright when either side is unpriced', () => {
    const comparison = compareCost(
      summaryFor(report, 'codex/fixture-small'),
      summaryFor(report, 'claude/fixture-unpriced'),
    );
    expect(comparison).toEqual({ kind: 'unavailable', reason: 'cost_unknown' });
    expect(formatCostComparison(comparison)).not.toMatch(/%/);
  });

  it('refuses when the two pairings were not measured over the same cases', () => {
    const uneven = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, [
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === SMALL_MODEL),
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === CAPABLE_MODEL).slice(0, 2),
    ]);
    const comparison = compareCost(
      summaryFor(uneven, 'codex/fixture-small'),
      summaryFor(uneven, 'claude/fixture-capable'),
    );
    expect(comparison).toEqual({ kind: 'unavailable', reason: 'unequal_fixture_coverage' });
    expect(formatCostComparison(comparison)).not.toMatch(/%/);
  });

  it('refuses below the minimum sample, even when both sides are fully priced', () => {
    const tooFew = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, [
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === SMALL_MODEL).slice(0, 2),
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === CAPABLE_MODEL).slice(0, 2),
    ]);
    const comparison = compareCost(
      summaryFor(tooFew, 'codex/fixture-small'),
      summaryFor(tooFew, 'claude/fixture-capable'),
    );
    expect(comparison).toEqual({ kind: 'unavailable', reason: 'insufficient_evidence' });
    expect(formatCostComparison(comparison)).toContain(`fewer than ${MINIMUM_BENCHMARK_SAMPLE}`);
  });

  it('states a percentage only from a measured comparison, and says what it was measured over', () => {
    const priced = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, BENCHMARK_OBSERVATIONS);
    const comparison = compareCost(
      summaryFor(priced, 'codex/fixture-small'),
      summaryFor(priced, 'claude/fixture-capable'),
    );
    expect(comparison.kind).toBe('measured');
    if (comparison.kind !== 'measured') throw new Error('unreachable');
    expect(comparison.cheaper).toEqual(SMALL_MODEL);
    expect(comparison.sampleSize).toBe(3);
    expect(formatCostComparison(comparison)).toMatch(/^codex\/fixture-small cost \d+\.\d% less over 3 measured fixture cases$/);
  });

  it('never counts an unpriced row into a total, so no total can silently understate a cost', () => {
    const mixed = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, [
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === SMALL_MODEL).slice(0, 2),
      {
        ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === SMALL_MODEL)[2]!,
        price: { kind: 'unknown', reason: 'not_configured' },
      },
    ]);
    expect(summaryFor(mixed, 'codex/fixture-small').totalCost).toEqual({ kind: 'unknown', reason: 'price_unknown' });
  });
});

describe('quality ranking refuses without evidence (acceptance check 5)', () => {
  it('refuses a ranking when the candidates were measured over different numbers of cases', () => {
    const report = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, [
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === SMALL_MODEL),
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === CAPABLE_MODEL).slice(0, 2),
    ]);
    expect(rankByFactualConsistency(report).kind).toBe('insufficient_evidence');
  });

  it('refuses a ranking below the minimum sample', () => {
    const report = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, [
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === SMALL_MODEL).slice(0, 2),
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === CAPABLE_MODEL).slice(0, 2),
    ]);
    const ranking = rankByFactualConsistency(report);
    expect(ranking.kind).toBe('insufficient_evidence');
    if (ranking.kind !== 'insufficient_evidence') throw new Error('unreachable');
    expect(ranking.reason).toContain(`${MINIMUM_BENCHMARK_SAMPLE}`);
  });

  it('refuses a ranking of one candidate against nothing', () => {
    const report = summarizeBenchmark(
      FIXTURE_SET,
      BENCHMARK_CASES,
      BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === SMALL_MODEL),
    );
    expect(rankByFactualConsistency(report).kind).toBe('insufficient_evidence');
  });

  it('ranks only when every candidate cleared the same measured sample', () => {
    const report = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, BENCHMARK_OBSERVATIONS);
    const ranking = rankByFactualConsistency(report);
    expect(ranking.kind).toBe('ranked');
    if (ranking.kind !== 'ranked') throw new Error('unreachable');
    expect(ranking.order.map((entry) => entry.label)).toEqual(['claude/fixture-capable', 'codex/fixture-small']);
    expect(ranking.sampleSize).toBe(3);
  });

  it('places the cheaper pairing behind the more accurate one: cost is not quality', () => {
    const report = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, BENCHMARK_OBSERVATIONS);
    const ranking = rankByFactualConsistency(report);
    if (ranking.kind !== 'ranked') throw new Error('unreachable');
    const comparison = compareCost(
      summaryFor(report, 'codex/fixture-small'),
      summaryFor(report, 'claude/fixture-capable'),
    );
    if (comparison.kind !== 'measured') throw new Error('unreachable');
    // The cheapest pairing is also the least factually consistent one here, which is precisely the
    // trade this benchmark exists to make visible instead of letting a router assume it away.
    expect(comparison.cheaper).toEqual(SMALL_MODEL);
    expect(ranking.order[0]?.candidate).toEqual(CAPABLE_MODEL);
  });

  it('does not rank a pairing whose price is unknown any differently: price is not an input to it', () => {
    const report = summarizeBenchmark(FIXTURE_SET, BENCHMARK_CASES, [
      ...BENCHMARK_OBSERVATIONS.filter((row) => row.candidate === SMALL_MODEL),
      ...UNPRICED_OBSERVATIONS,
    ]);
    const ranking = rankByFactualConsistency(report);
    if (ranking.kind !== 'ranked') throw new Error('unreachable');
    expect(ranking.order[0]?.candidate).toEqual(UNPRICED_MODEL);
  });
});
