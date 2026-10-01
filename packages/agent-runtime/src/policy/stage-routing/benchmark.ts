/**
 * The fixture benchmark (issue #284, acceptance checks 4 and 5): compare candidate pairings on
 * cost and latency *against* quality, where quality is four things this app can actually check
 * mechanically rather than one thing a reviewer feels.
 *
 * The four measures, and why each is the one that matters here:
 *
 * - **factual consistency** -- did the answer contain the facts the fixture says are in the source,
 *   and none of the ones the fixture plants as inventions? This is the failure that costs a
 *   candidate an interview, and it is invisible to a reader who does not have the CV open.
 * - **required-project preservation** -- did the candidate's pinned projects survive (#274)? A
 *   tailored CV can read beautifully and have dropped the one project the posting was about.
 * - **form-map validity** -- did the field map parse against `fieldMapSchema`'s closed sets?
 * - **human corrections** -- how many edits a reviewer made afterwards. The only measure here that
 *   needs a person, and the only one that captures "technically correct, still not sendable".
 *
 * ## Nothing here claims anything it did not measure
 *
 * Every rate is a `Measured` carrying its own sample size, or `insufficient_evidence`. Cost
 * comparison returns `unavailable` unless *both* sides were measured on the same fixture set, and
 * the ranking function refuses outright below a minimum sample. `formatCostComparison` is the only
 * text-producing function in this package that could ever emit a percentage, and it structurally
 * cannot emit one from an unmeasured comparison -- there is no code path from `unavailable` to a
 * number. That is acceptance check 5, expressed as types rather than as a review convention.
 *
 * ## Fixtures only
 *
 * `BenchmarkObservation`s come from controlled fixtures (see `test/fixtures/`), never from a live
 * run over a real candidate's documents: CONTRIBUTING.md forbids a test that needs a real,
 * authenticated CLI, and #284 itself requires controlled fixtures and excludes candidate data from
 * any public discussion of this work.
 */
import { describeCandidate, sameCandidate, type CandidatePrice, type CandidateRef } from './candidates.js';
import { computeStageCost, type StageUsage } from './telemetry.js';
import type { GenerationStage } from './stages.js';

/** A rate that was measured, with the denominator it was measured over. */
export interface MeasuredRate {
  readonly kind: 'measured';
  /** 0..1. */
  readonly value: number;
  readonly sampleSize: number;
}

export type Rate = MeasuredRate | { readonly kind: 'insufficient_evidence'; readonly sampleSize: number } | { readonly kind: 'not_applicable' };

export interface BenchmarkFixtureCase {
  readonly id: string;
  readonly stage: GenerationStage;
  /** Facts the source genuinely contains; an answer that omits them is incomplete. */
  readonly expectedFacts: readonly string[];
  /** Facts the source does not contain. An answer containing one of these invented it. */
  readonly forbiddenFacts: readonly string[];
  /** Project names the candidate pinned, which a tailored answer must still contain (#274). */
  readonly requiredProjects: readonly string[];
}

export interface BenchmarkObservation {
  readonly caseId: string;
  readonly candidate: CandidateRef;
  readonly price: CandidatePrice;
  /** Facts the answer actually asserted, extracted by the fixture harness, not by a model. */
  readonly producedFacts: readonly string[];
  readonly preservedProjects: readonly string[];
  /** `not_applicable` for every stage that produces no field map. */
  readonly formMapValid: boolean | 'not_applicable';
  /** Edits a reviewer made to the answer before it was usable. */
  readonly humanCorrections: number;
  readonly latencyMs: number;
  readonly usage: StageUsage;
}

export interface BenchmarkCandidateSummary {
  readonly candidate: CandidateRef;
  readonly label: string;
  readonly cases: number;
  readonly factualConsistency: Rate;
  readonly requiredProjectPreservation: Rate;
  readonly formMapValidity: Rate;
  /** Mean corrections per case, or `insufficient_evidence` with the sample size that was available. */
  readonly humanCorrectionsPerCase: MeasuredRate | { readonly kind: 'insufficient_evidence'; readonly sampleSize: number };
  readonly medianLatencyMs: number | undefined;
  readonly totalCost: { readonly kind: 'measured'; readonly usd: number } | { readonly kind: 'unknown'; readonly reason: string };
}

export interface BenchmarkReport {
  readonly fixtureSet: string;
  readonly candidates: readonly BenchmarkCandidateSummary[];
}

/**
 * Below this many cases, a rate is reported as `insufficient_evidence` rather than as a number.
 *
 * Three is not a statistical claim -- it is a floor that stops a single lucky run from being quoted
 * as a finding. A rate over one case is a 0% or a 100%, and either one printed next to a model name
 * is a ranking nobody measured.
 */
export const MINIMUM_BENCHMARK_SAMPLE = 3;

function rate(passes: number, sampleSize: number): Rate {
  if (sampleSize === 0) return { kind: 'not_applicable' };
  if (sampleSize < MINIMUM_BENCHMARK_SAMPLE) return { kind: 'insufficient_evidence', sampleSize };
  return { kind: 'measured', value: passes / sampleSize, sampleSize };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  const low = sorted[middle - 1];
  const high = sorted[middle];
  return low === undefined || high === undefined ? undefined : (low + high) / 2;
}

function containsAll(haystack: readonly string[], needles: readonly string[]): boolean {
  const present = new Set(haystack.map((entry) => entry.trim().toLowerCase()));
  return needles.every((needle) => present.has(needle.trim().toLowerCase()));
}

function containsNone(haystack: readonly string[], needles: readonly string[]): boolean {
  const present = new Set(haystack.map((entry) => entry.trim().toLowerCase()));
  return needles.every((needle) => !present.has(needle.trim().toLowerCase()));
}

/**
 * Rolls a set of fixture observations up per candidate pairing.
 *
 * An observation whose `caseId` names no fixture is dropped rather than counted, and dropped
 * silently only in the sense that it lowers a sample size a reader can see: a benchmark that
 * accepted rows describing cases it has no ground truth for would be reporting on nothing.
 */
export function summarizeBenchmark(
  fixtureSet: string,
  cases: readonly BenchmarkFixtureCase[],
  observations: readonly BenchmarkObservation[],
): BenchmarkReport {
  const caseById = new Map(cases.map((entry) => [entry.id, entry] as const));
  const byCandidate: { candidate: CandidateRef; rows: BenchmarkObservation[] }[] = [];

  for (const observation of observations) {
    if (!caseById.has(observation.caseId)) continue;
    const bucket = byCandidate.find((entry) => sameCandidate(entry.candidate, observation.candidate));
    if (bucket) bucket.rows.push(observation);
    else byCandidate.push({ candidate: observation.candidate, rows: [observation] });
  }

  const candidates = byCandidate.map(({ candidate, rows }) => {
    let factual = 0;
    let preserved = 0;
    let formMapCases = 0;
    let formMapValid = 0;
    let corrections = 0;
    let costUsd = 0;
    let costUnknownReason: string | undefined;
    const latencies: number[] = [];

    for (const row of rows) {
      const fixture = caseById.get(row.caseId);
      /* c8 ignore next */
      if (!fixture) continue;
      if (
        containsAll(row.producedFacts, fixture.expectedFacts) &&
        containsNone(row.producedFacts, fixture.forbiddenFacts)
      ) {
        factual += 1;
      }
      if (containsAll(row.preservedProjects, fixture.requiredProjects)) preserved += 1;
      if (row.formMapValid !== 'not_applicable') {
        formMapCases += 1;
        if (row.formMapValid) formMapValid += 1;
      }
      corrections += row.humanCorrections;
      latencies.push(row.latencyMs);

      const cost = computeStageCost(row.price, row.usage);
      if (cost.kind === 'measured') costUsd += cost.usd;
      else costUnknownReason ??= cost.reason;
    }

    const sampleSize = rows.length;
    return {
      candidate,
      label: describeCandidate(candidate),
      cases: sampleSize,
      factualConsistency: rate(factual, sampleSize),
      requiredProjectPreservation: rate(preserved, sampleSize),
      formMapValidity: rate(formMapValid, formMapCases),
      humanCorrectionsPerCase:
        sampleSize >= MINIMUM_BENCHMARK_SAMPLE
          ? ({ kind: 'measured', value: corrections / sampleSize, sampleSize } as const)
          : ({ kind: 'insufficient_evidence', sampleSize } as const),
      medianLatencyMs: median(latencies),
      // One unpriced row makes the whole total unknown. A partial sum presented as a total is the
      // exact shape of an understated cost, and understated cost is how an unmeasured saving gets
      // published.
      totalCost:
        costUnknownReason === undefined
          ? ({ kind: 'measured', usd: costUsd } as const)
          : ({ kind: 'unknown', reason: costUnknownReason } as const),
    } satisfies BenchmarkCandidateSummary;
  });

  return { fixtureSet, candidates };
}

export type CostComparison =
  | {
      readonly kind: 'measured';
      readonly cheaper: CandidateRef;
      readonly cheaperUsd: number;
      readonly dearerUsd: number;
      /** 0..1, the fraction of the dearer total that the cheaper one saves, over `sampleSize` cases. */
      readonly savingsFraction: number;
      readonly sampleSize: number;
    }
  | { readonly kind: 'unavailable'; readonly reason: 'cost_unknown' | 'unequal_fixture_coverage' | 'insufficient_evidence' };

/**
 * Compares two summaries' costs, and refuses in three separate ways.
 *
 * `unequal_fixture_coverage` is the subtle one and the reason this is not a subtraction: two totals
 * over different numbers of cases are not comparable, and dividing them into per-case averages to
 * make them comparable would paper over the fact that the two candidates were not asked the same
 * questions. A saving quoted from mismatched coverage is the most plausible-looking wrong number
 * this package could produce, so it is refused rather than normalized.
 */
export function compareCost(a: BenchmarkCandidateSummary, b: BenchmarkCandidateSummary): CostComparison {
  if (a.totalCost.kind !== 'measured' || b.totalCost.kind !== 'measured') {
    return { kind: 'unavailable', reason: 'cost_unknown' };
  }
  if (a.cases !== b.cases) return { kind: 'unavailable', reason: 'unequal_fixture_coverage' };
  if (a.cases < MINIMUM_BENCHMARK_SAMPLE) return { kind: 'unavailable', reason: 'insufficient_evidence' };

  const [cheap, dear] = a.totalCost.usd <= b.totalCost.usd ? [a, b] : [b, a];
  const cheaperUsd = cheap.totalCost.kind === 'measured' ? cheap.totalCost.usd : 0;
  const dearerUsd = dear.totalCost.kind === 'measured' ? dear.totalCost.usd : 0;
  return {
    kind: 'measured',
    cheaper: cheap.candidate,
    cheaperUsd,
    dearerUsd,
    savingsFraction: dearerUsd === 0 ? 0 : (dearerUsd - cheaperUsd) / dearerUsd,
    sampleSize: a.cases,
  };
}

/**
 * The only function in this package that may print a percentage, and it can only do so from a
 * `measured` comparison -- there is no branch that turns `unavailable` into a number, a range, or
 * an "up to". The unavailable text names the reason and stops.
 */
export function formatCostComparison(comparison: CostComparison): string {
  if (comparison.kind === 'unavailable') {
    switch (comparison.reason) {
      case 'cost_unknown':
        return 'cost comparison unavailable: price or usage data is unknown for at least one candidate';
      case 'unequal_fixture_coverage':
        return 'cost comparison unavailable: the candidates were not measured over the same fixture cases';
      default:
        return `cost comparison unavailable: fewer than ${MINIMUM_BENCHMARK_SAMPLE} measured cases`;
    }
  }
  const percent = (comparison.savingsFraction * 100).toFixed(1);
  return `${describeCandidate(comparison.cheaper)} cost ${percent}% less over ${comparison.sampleSize} measured fixture cases`;
}

export type QualityRanking =
  | { readonly kind: 'ranked'; readonly order: readonly BenchmarkCandidateSummary[]; readonly sampleSize: number }
  | { readonly kind: 'insufficient_evidence'; readonly reason: string };

/**
 * Orders candidates by measured factual consistency, and refuses unless *every* candidate cleared
 * the minimum sample over an identical number of cases.
 *
 * A ranking is the single most quotable thing this package produces, so it has the strictest
 * precondition in it. There is deliberately no partial ranking of the candidates that do qualify:
 * a list of two out of four reads as a complete ordering to anyone who did not read the caveat.
 */
export function rankByFactualConsistency(report: BenchmarkReport): QualityRanking {
  if (report.candidates.length < 2) {
    return { kind: 'insufficient_evidence', reason: 'a ranking needs at least two measured candidates' };
  }
  const sampleSizes = new Set(report.candidates.map((entry) => entry.cases));
  if (sampleSizes.size !== 1) {
    return { kind: 'insufficient_evidence', reason: 'the candidates were not measured over the same number of cases' };
  }
  const measured = report.candidates.every((entry) => entry.factualConsistency.kind === 'measured');
  if (!measured) {
    return { kind: 'insufficient_evidence', reason: `every candidate needs at least ${MINIMUM_BENCHMARK_SAMPLE} measured cases` };
  }
  const order = [...report.candidates].sort((a, b) => scoreOf(b) - scoreOf(a));
  return { kind: 'ranked', order, sampleSize: report.candidates[0]?.cases ?? 0 };
}

function scoreOf(summary: BenchmarkCandidateSummary): number {
  return summary.factualConsistency.kind === 'measured' ? summary.factualConsistency.value : -1;
}
