// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_LIMITS } from '../electron/application-brief.js';
import { commitAssessment, getBrief, prepareAssessment } from '../electron/application-brief-service.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import type { AgentPromptResult } from '../src/components/cv/run-agent-prompt.js';
import { BATCH_MAX_REQUESTS, runAssessSelectedJobs, type AssessDeps, type BatchSnapshot } from '../src/components/saved/assess-selected-jobs.js';
import * as fx from './application-brief-fixtures.js';
import { SOURCE, T0, scanRow } from './application-brief-fixtures.js';

/**
 * #688 "Assess selected jobs". The runner, the real prompt builder and parser, the real IPC-level
 * `prepareAssessment` / `commitAssessment` and the migrated SQLite store are all real; ONLY the model
 * request is scripted. Every employer, posting and requirement is synthetic.
 */

const JOBS = [1, 2, 3, 4, 5, 6].map((n) => ({
  key: `gh:200${n}`,
  url: `https://job-boards.greenhouse.io/northwind/jobs/200${n}`,
  jd: `Northwind Freight is hiring role ${n}. You have ${n}+ years of TypeScript experience. Experience with Kubernetes is required for role ${n}.`,
  quote: `You have ${n}+ years of TypeScript experience.`,
  quote2: `Experience with Kubernetes is required for role ${n}.`,
}));

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let world: fx.BriefWorld;
let cvId: string;
let clock: number;

const briefDeps = () => fx.makeDeps(db, world);

function requirementsJson(items: { text: string; quote: string; evidenceClass?: string; anchor?: string }[], hasMore = false): AgentPromptResult {
  return {
    ok: true,
    text: JSON.stringify({
      requirements: items.map((item) => ({
        text: item.text,
        jdAnchor: item.quote,
        classification: 'required',
        evidenceClass: item.evidenceClass ?? 'direct',
        anchorParentId: item.evidenceClass === 'unsupported' ? '' : (item.anchor ?? 'experience-1'),
      })),
      hasMore,
    }),
  };
}

function setup(count: number): { id: string; label: string }[] {
  const rows: DiscoveryVacancyAudit[] = JOBS.slice(0, count).map((job) => scanRow({ key: job.key, url: job.url, title: `Platform Engineer ${job.key.slice(-1)}`, description: job.jd }));
  fx.setScan(world, rows, '2026-10-19T08:00:00.000Z');
  return rows.map((row) => {
    const saved = workspace.createSavedJob(db, { role: row.title, company: row.company, location: row.location, vacancyKey: row.key, sourceUrl: row.url, status: 'considering' });
    return { id: saved.id, label: `${row.title} at ${row.company}` };
  });
}

interface Harness {
  deps: AssessDeps;
  prompts: string[];
  updates: BatchSnapshot[];
  maxInFlight: () => number;
  runPrompt: ReturnType<typeof vi.fn>;
}

function harness(script: (call: number, prompt: string, signal: AbortSignal) => Promise<AgentPromptResult>): Harness {
  const prompts: string[] = [];
  const updates: BatchSnapshot[] = [];
  let inFlight = 0;
  let max = 0;
  const runPrompt = vi.fn(async (prompt: string, options: { signal: AbortSignal; timeoutMs: number }) => {
    expect(options.timeoutMs).toBe(BATCH_LIMITS.requestTimeoutMs);
    prompts.push(prompt);
    inFlight += 1;
    max = Math.max(max, inFlight);
    try {
      return await script(prompts.length, prompt, options.signal);
    } finally {
      inFlight -= 1;
    }
  });
  const deps: AssessDeps = {
    prepare: (id) => prepareAssessment(briefDeps(), id),
    commit: (input) => commitAssessment(briefDeps(), input),
    async loadCv(id) {
      const record = workspace.getCvDocument(db, id);
      return { cv: { fileName: record.name, text: record.text }, source: record.source };
    },
    runPrompt,
    now: () => clock,
    onUpdate: (snapshot) => updates.push(snapshot),
  };
  return { deps, prompts, updates, maxInFlight: () => max, runPrompt };
}

const noAbort = () => new AbortController().signal;
const happy = (call: number): Promise<AgentPromptResult> => {
  const job = JOBS[Math.ceil(call / 1) - 1]!;
  return Promise.resolve(requirementsJson([{ text: 'TypeScript', quote: job.quote }, { text: 'Kubernetes', quote: job.quote2, evidenceClass: 'unsupported' }]));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-assess-test-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  world = fx.makeWorld();
  clock = T0.getTime();
  cvId = workspace.createCvDocument(db, { name: 'Main CV', kind: 'manual', text: 'Jamie Rivera.', profile: { title: 'Senior Engineer' }, source: SOURCE, isDefault: true }).id;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const overlayCount = () => workspace.listCvEvidenceOverlays(db, cvId).length;

describe('assess selected jobs: limits', () => {
  it('assesses a small selection one job at a time, with real grounded saves and a full-success summary only when all are assessed', async () => {
    const jobs = setup(3);
    const h = harness(happy);
    const result = await runAssessSelectedJobs(jobs, h.deps, noAbort());

    expect(result.jobs.map((job) => job.state)).toEqual(['assessed', 'assessed', 'assessed']);
    expect(result.summary).toBe('Finished: 3 of 3 assessed.');
    expect(result.requests).toBe(3);
    expect(h.maxInFlight()).toBe(1); // concurrency is one
    expect(overlayCount()).toBe(3);
    // The saved result reads back through the brief as a current, grounded assessment.
    const brief = await getBrief(briefDeps(), { savedJobId: jobs[0]!.id });
    expect(brief.assessment.state).toBe('current');
    expect(brief.assessment.summary?.gaps.map((gap) => gap.text)).toEqual(['Kubernetes']);
    // The prompt carried the posting and the reviewed CV, and the model was asked to quote the posting.
    expect(h.prompts[0]).toContain('Northwind Freight is hiring role 1.');
    expect(h.prompts[0]).toContain('Redwood Software');
  });

  it('refuses more than the cap before any request, and never partially runs the first few', async () => {
    const jobs = setup(6);
    const h = harness(happy);
    const prepare = vi.spyOn(h.deps, 'prepare');
    const result = await runAssessSelectedJobs(jobs, h.deps, noAbort());
    expect(h.runPrompt).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(result.jobs.every((job) => job.state === 'unassessed' && job.detail.includes('up to 5 jobs'))).toBe(true);
    expect(result.summary).toBe('Finished with gaps: 0 of 6 assessed, 6 could not be assessed.');
    expect(overlayCount()).toBe(0);
    expect(BATCH_MAX_REQUESTS).toBe(10);
  });

  it('skips jobs that cannot be assessed WITHOUT any request, and says why', async () => {
    const jobs = setup(2);
    const manual = workspace.createSavedJob(db, { role: 'Solo Role', company: 'Harbor Systems', location: 'Lisbon', sourceUrl: 'https://jobs.example/listing/solo-role-9', status: 'considering' });
    const h = harness(happy);
    // Job 1 was assessed before and is up to date.
    await runAssessSelectedJobs([jobs[0]!], harness(happy).deps, noAbort());
    const result = await runAssessSelectedJobs([jobs[0]!, { id: manual.id, label: 'Solo Role at Harbor Systems' }, jobs[1]!], h.deps, noAbort());
    expect(result.jobs.map((job) => job.state)).toEqual(['unassessed', 'unassessed', 'assessed']);
    expect(result.jobs[0]!.detail).toContain('already has an up-to-date assessment');
    expect(result.jobs[1]!.detail).toContain('No job description');
    expect(result.jobs[0]!.detail).toContain('Nothing was sent');
    expect(h.runPrompt).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain('1 of 3 assessed');
    expect(result.summary).toContain('2 could not be assessed');
  });

  it('stops starting new jobs once the total time limit is reached, and does not call it finished', async () => {
    const jobs = setup(3);
    const h = harness(async (call) => {
      clock += BATCH_LIMITS.totalTimeoutMs; // the first request "takes" the whole budget
      return happy(call);
    });
    const result = await runAssessSelectedJobs(jobs, h.deps, noAbort());
    expect(result.jobs.map((job) => job.state)).toEqual(['assessed', 'cancelled', 'cancelled']);
    expect(result.jobs[1]!.detail).toContain('15-minute limit');
    expect(result.summary).toBe('Stopped: 1 of 3 assessed, 2 not finished.');
    expect(h.runPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('assess selected jobs: cancel, failure and partial truth', () => {
  it('cancelling mid-run stops the live request, keeps finished jobs, leaves the rest untouched and says so', async () => {
    const jobs = setup(3);
    const controller = new AbortController();
    const h = harness(async (call, _prompt, signal) => {
      if (call === 2) {
        queueMicrotask(() => controller.abort());
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { ok: false, reason: 'cancelled', error: 'cancelled' };
      }
      return happy(call);
    });
    const result = await runAssessSelectedJobs(jobs, h.deps, controller.signal);
    expect(result.jobs.map((job) => job.state)).toEqual(['assessed', 'cancelled', 'cancelled']);
    expect(result.jobs[1]!.detail).toContain('Nothing was saved for it');
    expect(result.cancelled).toBe(true);
    expect(result.summary).toBe('Stopped: 1 of 3 assessed, 2 not finished.');
    expect(overlayCount()).toBe(1); // only job 1 was saved; the interrupted job wrote nothing
    expect(h.runPrompt).toHaveBeenCalledTimes(2);
  });

  it('an aborted signal before the start sends nothing at all', async () => {
    const jobs = setup(2);
    const controller = new AbortController();
    controller.abort();
    const h = harness(happy);
    const result = await runAssessSelectedJobs(jobs, h.deps, controller.signal);
    expect(h.runPrompt).not.toHaveBeenCalled();
    expect(result.summary).toBe('Stopped: 0 of 2 assessed, 2 not finished.');
  });

  it('a failed job keeps earlier work byte-identical, the batch carries on, and the summary is not "Finished"', async () => {
    const jobs = setup(3);
    // Job 2 already has an earlier partial read (same CV, same posting) that must survive its failed continuation.
    // (An assessment read against an earlier CV is refused before any request instead; see application-brief.test.ts.)
    const job2 = JOBS[1]!;
    const partialRead = harness(async (call) =>
      call === 1
        ? requirementsJson([{ text: 'TypeScript', quote: job2.quote }], true)
        : requirementsJson([{ text: 'Kubernetes', quote: job2.quote2, evidenceClass: 'unsupported' }], true),
    );
    await runAssessSelectedJobs([jobs[1]!], partialRead.deps, noAbort());
    expect((await getBrief(briefDeps(), { savedJobId: jobs[1]!.id })).assessment.state).toBe('partial');
    const before = JSON.stringify(workspace.listCvEvidenceOverlays(db, cvId).map((overlay) => [overlay.id, overlay.caseRevision, overlay.requirements]));

    const h = harness(async (call) => (call === 1 ? { ok: false, reason: 'failed', error: 'provider rate limit reached' } : happy(call + 1)));
    const result = await runAssessSelectedJobs([jobs[1]!, jobs[0]!, jobs[2]!], h.deps, noAbort());
    expect(result.jobs.map((job) => job.state)).toEqual(['failed', 'assessed', 'assessed']);
    expect(result.jobs[0]!.detail).toContain('provider rate limit reached');
    expect(result.jobs[0]!.detail).toContain('Nothing was saved for this job, and anything saved before is unchanged');
    expect(result.summary).toBe('Finished with gaps: 2 of 3 assessed, 1 failed.');
    const after = JSON.stringify(
      workspace.listCvEvidenceOverlays(db, cvId).filter((overlay) => overlay.vacancyKey.includes('2002')).map((overlay) => [overlay.id, overlay.caseRevision, overlay.requirements]),
    );
    expect(after).toBe(JSON.stringify(JSON.parse(before)));
  });

  it('an unreadable answer is a failure, not a saved empty assessment', async () => {
    const jobs = setup(1);
    const h = harness(async () => ({ ok: true, text: 'Sure! Here is my opinion.' }));
    const result = await runAssessSelectedJobs(jobs, h.deps, noAbort());
    expect(result.jobs[0]).toMatchObject({ state: 'failed' });
    expect(result.jobs[0]!.detail).toContain('could not be read into requirements');
    expect(overlayCount()).toBe(0);
  });

  it('reads at most the per-job request cap, continues with what is already listed, and labels the result partial', async () => {
    const jobs = setup(1);
    const job = JOBS[0]!;
    const h = harness(async (call) =>
      call === 1
        ? requirementsJson([{ text: 'TypeScript', quote: job.quote }], true)
        : requirementsJson([{ text: 'Kubernetes', quote: job.quote2, evidenceClass: 'unsupported' }], true),
    );
    const result = await runAssessSelectedJobs(jobs, h.deps, noAbort());
    expect(h.runPrompt).toHaveBeenCalledTimes(BATCH_LIMITS.passesPerJob);
    expect(h.prompts[1]).toContain('TypeScript'); // the second request is told what was already found
    expect(result.jobs[0]).toMatchObject({ state: 'partial', requests: 2 });
    expect(result.jobs[0]!.detail).toContain('only part of the posting was read');
    expect(result.summary).toBe('Finished with gaps: 0 of 1 assessed, 1 only partly read.');
    const brief = await getBrief(briefDeps(), { savedJobId: jobs[0]!.id });
    expect(brief.assessment.state).toBe('partial');
  });

  it('keeps what an earlier request read when a later one fails, as a partial result', async () => {
    const jobs = setup(1);
    const job = JOBS[0]!;
    const h = harness(async (call) =>
      call === 1 ? requirementsJson([{ text: 'TypeScript', quote: job.quote }], true) : { ok: false, reason: 'failed', error: 'network dropped' },
    );
    const result = await runAssessSelectedJobs(jobs, h.deps, noAbort());
    expect(result.jobs[0]).toMatchObject({ state: 'partial' });
    expect(result.jobs[0]!.detail).toContain('Saved what was read before a request failed');
    expect(result.summary).toContain('1 only partly read');
    expect((await getBrief(briefDeps(), { savedJobId: jobs[0]!.id })).assessment.state).toBe('partial');
  });
});

describe('assess selected jobs: version fencing', () => {
  it('discards a result whose posting changed while the model was working: nothing is written and the others carry on', async () => {
    const jobs = setup(2);
    const h = harness(async (call) => {
      if (call === 1) {
        // The next scan lands while job 1 is being read, with a changed posting.
        fx.setScan(
          world,
          [scanRow({ key: JOBS[0]!.key, url: JOBS[0]!.url, title: 'Platform Engineer 1', description: `${JOBS[0]!.jd} You will also own the on-call rota.` }), world.rows.get(JOBS[1]!.key)!],
          '2026-10-22T08:00:00.000Z',
        );
        await getBrief(briefDeps(), { savedJobId: jobs[0]!.id }); // the page refreshes the brief meanwhile
      }
      return happy(call);
    });
    const result = await runAssessSelectedJobs(jobs, h.deps, noAbort());
    expect(result.jobs[0]).toMatchObject({ state: 'discarded' });
    expect(result.jobs[0]!.detail).toContain('discarded');
    expect(result.jobs[1]).toMatchObject({ state: 'assessed' });
    expect(result.summary).toBe('Finished with gaps: 1 of 2 assessed, 1 result discarded because the inputs changed.');
    expect(workspace.listCvEvidenceOverlays(db, cvId).map((overlay) => overlay.vacancyKey)).toEqual([expect.stringContaining('2002')]);
  });

  it('discards a result when the reviewed CV changed meanwhile', async () => {
    const jobs = setup(1);
    const h = harness(async (call) => {
      workspace.updateCvDocument(db, cvId, { source: { ...SOURCE, summary: 'Edited while the model was running.' } });
      return happy(call);
    });
    const result = await runAssessSelectedJobs(jobs, h.deps, noAbort());
    expect(result.jobs[0]!.state).toBe('discarded');
    expect(overlayCount()).toBe(0);
  });
});
