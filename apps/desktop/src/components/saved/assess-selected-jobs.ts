import {
  BATCH_LIMITS,
  describeBatchOutcome,
  type BatchTally,
  type CommitAssessmentInput,
  type CommitAssessmentResult,
  type PrepareAssessmentResult,
} from '../../../electron/application-brief.js';
import type { CvSourceDocument } from '../../window.js';
import type { AgentPromptResult } from '../cv/run-agent-prompt.js';
import { buildRequirementMappingPrompt } from '../cv/prompts.js';
import { mergeRequirementMappings } from '../cv/requirement-mapping-merge.js';
import { parseRequirementMappingResponse } from '../cv/requirement-mapping-response.js';
import type { CvDocument } from '../cv/types.js';

/**
 * The explicit "Assess selected jobs" action (#688), as a plain async function so every limit and every
 * outcome is testable without a screen.
 *
 * It REUSES the existing grounded assessment end to end: the same requirement-mapping prompt, the same
 * response parser (quotes must be found in the posting) and the same merge as the Search assistant, and
 * it saves through the main process, which re-checks that the posting text, the reviewed CV and the case
 * are still the ones the pass started from (`commitAssessment`) and refuses the result if not.
 *
 * Hard limits (`BATCH_LIMITS`): at most 5 jobs, ONE at a time, at most 2 requests per job, each request
 * stopped after 4 minutes, and no new job started after 15 minutes. A job is refused before any request
 * when it cannot be assessed (no CV, unreviewed CV, no posting text, already up to date). Cancelling stops
 * the live request and leaves every job that had not finished exactly as it was. Nothing here rescans,
 * applies a suggestion, or starts by itself.
 */

export type BatchJobState =
  | 'waiting'
  | 'running'
  | 'assessed'
  | 'partial'
  | 'unassessed'
  | 'failed'
  | 'cancelled'
  | 'discarded';

export interface BatchJob {
  savedJobId: string;
  label: string;
  state: BatchJobState;
  /** Plain-English detail for the state; empty while waiting. */
  detail: string;
  /** Model requests started for this job. */
  requests: number;
}

export interface BatchSnapshot {
  phase: 'running' | 'finished';
  jobs: BatchJob[];
  /** Model requests started so far across the whole action. */
  requests: number;
  cancelled: boolean;
  tally: BatchTally;
  /** The honest one-line outcome; null while running. */
  summary: string | null;
}

export interface AssessDeps {
  prepare(savedJobId: string): Promise<PrepareAssessmentResult>;
  commit(input: CommitAssessmentInput): Promise<CommitAssessmentResult>;
  /** The CV the plan names, as the prompt builder reads it. Null when it is gone. */
  loadCv(cvId: string): Promise<{ cv: CvDocument; source: CvSourceDocument | null } | null>;
  /** Runs ONE model request. The only AI call in this module. */
  runPrompt(prompt: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<AgentPromptResult>;
  now(): number;
  onUpdate(snapshot: BatchSnapshot): void;
}

function tallyOf(jobs: readonly BatchJob[]): BatchTally {
  const count = (state: BatchJobState): number => jobs.filter((job) => job.state === state).length;
  return {
    total: jobs.length,
    assessed: count('assessed'),
    partial: count('partial'),
    unassessed: count('unassessed'),
    failed: count('failed'),
    // A job still waiting or running when the action ends was not finished either.
    cancelled: count('cancelled') + count('waiting') + count('running'),
    discarded: count('discarded'),
  };
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const BATCH_MAX_REQUESTS = BATCH_LIMITS.maxJobs * BATCH_LIMITS.passesPerJob;

export async function runAssessSelectedJobs(
  selection: readonly { id: string; label: string }[],
  deps: AssessDeps,
  signal: AbortSignal,
): Promise<BatchSnapshot> {
  const startedAt = deps.now();
  const jobs: BatchJob[] = selection.map((job) => ({ savedJobId: job.id, label: job.label, state: 'waiting', detail: '', requests: 0 }));
  let requests = 0;
  let cancelled = false;

  const snapshot = (phase: BatchSnapshot['phase']): BatchSnapshot => {
    const tally = tallyOf(jobs);
    return {
      phase,
      jobs: jobs.map((job) => ({ ...job })),
      requests,
      cancelled,
      tally,
      summary: phase === 'finished' ? describeBatchOutcome(tally, cancelled) : null,
    };
  };
  const publish = (): void => deps.onUpdate(snapshot('running'));
  const stopAll = (reason: string): void => {
    for (const job of jobs) {
      if (job.state === 'waiting' || job.state === 'running') {
        job.state = 'cancelled';
        job.detail = reason;
      }
    }
  };

  // The cap is enforced HERE as well as in the page: more than the limit starts nothing.
  if (jobs.length === 0 || jobs.length > BATCH_LIMITS.maxJobs) {
    for (const job of jobs) {
      job.state = 'unassessed';
      job.detail = `You can assess up to ${BATCH_LIMITS.maxJobs} jobs at a time. Nothing was sent.`;
    }
    const final = snapshot('finished');
    deps.onUpdate(final);
    return final;
  }

  publish();
  for (const job of jobs) {
    if (signal.aborted) {
      cancelled = true;
      stopAll('You stopped the assessment before this job started.');
      break;
    }
    if (deps.now() - startedAt >= BATCH_LIMITS.totalTimeoutMs) {
      cancelled = true;
      stopAll(`The ${Math.round(BATCH_LIMITS.totalTimeoutMs / 60_000)}-minute limit was reached before this job started.`);
      break;
    }
    job.state = 'running';
    job.detail = 'Checking whether this job can be assessed…';
    publish();

    const prepared = await deps.prepare(job.savedJobId);
    if (!prepared.ok) {
      job.state = 'unassessed';
      job.detail = `${prepared.message} Nothing was sent.`;
      publish();
      continue;
    }
    const { plan } = prepared;
    const loaded = await deps.loadCv(plan.cvId);
    if (!loaded) {
      job.state = 'unassessed';
      job.detail = 'Your CV could not be read. Nothing was sent.';
      publish();
      continue;
    }

    const lead = {
      title: plan.lead.title,
      company: plan.lead.company,
      location: plan.lead.location,
      url: plan.lead.url,
      description: plan.lead.description,
      jdOrigin: 'found' as const,
    };
    let merged = [...plan.existing];
    let passes = 0;
    let hasMore = true;
    let failure: { kind: 'failed' | 'cancelled' | 'timeout'; error: string } | null = null;

    while (hasMore && passes < BATCH_LIMITS.passesPerJob) {
      if (signal.aborted) {
        failure = { kind: 'cancelled', error: 'cancelled' };
        break;
      }
      if (deps.now() - startedAt >= BATCH_LIMITS.totalTimeoutMs && passes > 0) {
        failure = { kind: 'timeout', error: 'The time limit was reached.' };
        break;
      }
      job.detail = `Reading the posting against your CV (request ${passes + 1} of up to ${BATCH_LIMITS.passesPerJob})…`;
      publish();
      const prompt = buildRequirementMappingPrompt(
        loaded.cv,
        lead,
        loaded.source,
        undefined,
        merged.map((requirement) => requirement.text),
      );
      passes += 1;
      requests += 1;
      job.requests = passes;
      const result = await deps.runPrompt(prompt, { signal, timeoutMs: BATCH_LIMITS.requestTimeoutMs });
      if (!result.ok) {
        failure = { kind: result.reason === 'failed' ? 'failed' : result.reason, error: result.error };
        break;
      }
      try {
        const batch = parseRequirementMappingResponse(result.text, plan.lead.description);
        const next = mergeRequirementMappings(merged, batch.accepted);
        const grew = next.length > merged.length;
        merged = next;
        // More is owed only while the model says so AND the last pass still added something.
        hasMore = batch.hasMore && grew;
      } catch {
        failure = { kind: 'failed', error: 'The answer could not be read into requirements.' };
        break;
      }
    }

    if (failure?.kind === 'cancelled') {
      cancelled = true;
      job.state = 'cancelled';
      job.detail = 'You stopped the assessment while this job was being read. Nothing was saved for it.';
      stopAll('You stopped the assessment before this job started.');
      publish();
      break;
    }
    // Work from an earlier request of THIS job is kept (as a partial read); a job that read nothing is failed.
    const readSomething = merged.length > plan.existing.length;
    if (failure && !readSomething) {
      job.state = 'failed';
      job.detail = `${clip(failure.error)} Nothing was saved for this job, and anything saved before is unchanged.`;
      publish();
      continue;
    }

    const complete = !failure && !hasMore;
    const committed = await deps.commit({
      savedJobId: job.savedJobId,
      fence: plan.fence,
      requirements: merged,
      requirementCoverage: { status: complete ? 'complete' : 'partial', batches: passes },
    });
    if (!committed.ok) {
      job.state = committed.code === 'stale' ? 'discarded' : 'failed';
      job.detail = `${committed.message}`;
    } else if (complete) {
      job.state = 'assessed';
      job.detail = 'Read end to end and saved.';
    } else {
      job.state = 'partial';
      job.detail = failure
        ? `Saved what was read before a request failed (${clip(failure.error, 120)}). Part of the posting is still unread.`
        : `Saved, but only part of the posting was read (the limit is ${BATCH_LIMITS.passesPerJob} requests per job).`;
    }
    publish();
  }

  const final = snapshot('finished');
  deps.onUpdate(final);
  return final;
}
