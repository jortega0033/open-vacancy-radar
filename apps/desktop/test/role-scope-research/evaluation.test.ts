// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { comparator, currentScore, formatEvaluation, runEvaluation } from './evaluate.js';
import { CORPUS, PROFILES } from './fixtures.js';

/**
 * #694 evaluation, reproducible and checked in.
 *
 * Regenerate (from apps/desktop) after an INTENDED change:
 *   OVR_EVAL_OUT=../../docs/research/role-scope/694-evaluation.json pnpm exec vitest run test/role-scope-research/evaluation.test.ts
 * This test fails when a fresh run differs from the committed file. A change to the production evaluator, sort,
 * plan compiler, shared filter or eligibility assessor that changes any output will fail it on purpose: the
 * committed evidence must describe the code it was generated from.
 *
 * Latency is measured here but never committed (wall-clock time is not deterministic):
 *   OVR_LATENCY_OUT=<path>.json pnpm exec vitest run test/role-scope-research/evaluation.test.ts
 *
 * What this is NOT: human-labelled data, a sample of the job market, live source coverage, a model benchmark,
 * or any claim about applications, interviews, hiring or time saved.
 */

const here = dirname(fileURLToPath(import.meta.url));
const committedPath = join(here, '..', '..', '..', '..', 'docs', 'research', 'role-scope', '694-evaluation.json');
const lf = (text: string) => text.replace(/\r\n/gu, '\n');

describe('#694 role-scope evaluation', () => {
  it('formats losslessly: the committed form parses back to the same value', () => {
    const value = runEvaluation();
    expect(JSON.parse(formatEvaluation(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it('is deterministic: two runs produce identical bytes', () => {
    expect(JSON.stringify(runEvaluation())).toBe(JSON.stringify(runEvaluation()));
  });

  it('matches the committed docs/research/role-scope/694-evaluation.json byte for byte', () => {
    const fresh = formatEvaluation(runEvaluation());
    const out = process.env.OVR_EVAL_OUT;
    if (out) writeFileSync(out, fresh, 'utf8');
    expect(lf(readFileSync(committedPath, 'utf8'))).toBe(fresh);
  });

  it('calls no network, model or provider, and records the calls it did make', () => {
    const result = runEvaluation();
    expect(result.usage.networkCalls).toBe(0);
    expect(result.usage.modelCalls).toBe(0);
    expect(result.usage.currentEvaluatorCalls).toBeGreaterThan(0);
    expect(result.usage.comparatorCalls).toBeGreaterThan(0);
    expect(result.pins.model).toBe('none');
  });

  it('measures per-call latency for both evaluators under the same envelope (not committed)', () => {
    const repetitions = 20;
    const profiles = [PROFILES.frontend, PROFILES.backend_research];
    const time = (call: (item: (typeof CORPUS)[number], profile: (typeof profiles)[number]) => unknown) => {
      const samples: number[] = [];
      for (let r = 0; r < repetitions; r += 1) {
        const start = performance.now();
        for (const profile of profiles) for (const item of CORPUS) call(item, profile);
        samples.push((performance.now() - start) / (CORPUS.length * profiles.length));
      }
      samples.sort((a, b) => a - b);
      return { medianMsPerCall: samples[Math.floor(samples.length / 2)]!, maxMsPerCall: samples[samples.length - 1]!, callsPerSample: CORPUS.length * profiles.length, samples: repetitions };
    };
    const current = time(currentScore);
    const optionB = time(comparator);
    for (const value of [current.medianMsPerCall, optionB.medianMsPerCall]) expect(Number.isFinite(value)).toBe(true);
    const out = process.env.OVR_LATENCY_OUT;
    if (out) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            measuredAt: new Date().toISOString(),
            machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version },
            note: 'In-process wall-clock per call, after module load, under vitest. Indicative only; not committed.',
            currentEvaluator: current,
            optionB,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
  });
});
