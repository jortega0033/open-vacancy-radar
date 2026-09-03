import type { SavedJobRecord } from '../../window.js';
import type { VacancyLead } from './types.js';

/**
 * Persisting a gap analysis onto the saved job it is about.
 *
 * The awkward part this module exists to solve is identity. `GapAnalysis` is handed a
 * `VacancyLead` -- a prompt-shaped subset of a search result (see `types.ts`) that deliberately
 * carries no database id and no discovery `key`. The saved job, if the user has saved this vacancy
 * at all, is a separate row in `workspace.db`. Nothing in the render tree connects the two, so the
 * connection is made here, from the fields a lead actually has.
 *
 * Matching is deliberately conservative, because the failure mode is writing one vacancy's analysis
 * onto a different job's row:
 *
 *  1. **Source URL.** `savedJobInputFor` (SearchPage.tsx) persists `sourceUrl` from the same
 *     `result.url` the lead carries, so for every job saved from a search this is an exact,
 *     unambiguous key.
 *  2. **Role + company + location**, for a job typed in by hand, which has no `sourceUrl` at all.
 *
 * A tier only matches when it matches *exactly one* row. Two saved jobs with the same role at the
 * same company in the same city are indistinguishable from here, and the honest answer in that case
 * is "I cannot tell which one you mean" -- the button stays disabled -- not a coin flip.
 */

/** Case- and whitespace-insensitive comparison, for the hand-typed fallback tier only. */
function same(a: string | null, b: string | null): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** The single saved job this lead is about, or null when there is no unambiguous answer. */
export function matchSavedJob(jobs: readonly SavedJobRecord[], vacancy: VacancyLead): SavedJobRecord | null {
  const url = vacancy.url.trim();
  if (url !== '') {
    const byUrl = jobs.filter((job) => job.sourceUrl != null && job.sourceUrl.trim() === url);
    if (byUrl.length === 1) return byUrl[0] ?? null;
    // More than one row already claims this exact URL: ambiguous, and falling through to the
    // weaker tier would only make the guess worse.
    if (byUrl.length > 1) return null;
  }

  const byFields = jobs.filter(
    (job) =>
      same(job.role, vacancy.title) && same(job.company, vacancy.company) && same(job.location, vacancy.location),
  );
  return byFields.length === 1 ? (byFields[0] ?? null) : null;
}

/**
 * Looks up the saved job for this lead through the existing `workspace:saved-jobs:list` channel.
 *
 * Resolves to null rather than throwing when the bridge is unavailable: this only decides whether
 * one optional button is enabled, and a CV assistant that fails to render because a lookup for a
 * button rejected would be a far worse bug than a button that stays disabled.
 */
export async function findSavedJobForVacancy(vacancy: VacancyLead): Promise<SavedJobRecord | null> {
  try {
    const jobs = await window.workspace.listSavedJobs();
    return matchSavedJob(jobs, vacancy);
  } catch {
    return null;
  }
}

/**
 * Writes the analysis onto the saved job through the existing `workspace:saved-jobs:update`
 * channel, validated by `parseSavedJobPatch`'s allow-list like every other saved-job write.
 *
 * Only `gapAnalysis` is sent. The companion `gapAnalysisAt` timestamp is derived in the main
 * process from its own clock (see `repository.ts`), so the renderer cannot date a stored analysis.
 */
export function saveGapAnalysis(savedJobId: string, analysis: string): Promise<SavedJobRecord> {
  return window.workspace.updateSavedJob(savedJobId, { gapAnalysis: analysis });
}
