import type {
  AiWebDiscoveryJoinResult,
  CandidateProfile,
  GlobalRemoteScanOptions,
  GlobalRemoteScanResult,
} from '@open-vacancy-radar/vacancy-engine';
import { deterministicScanCriteria, type VacancyRunIntent } from './vacancy-run-intent.js';
import type { AiWebDiscoveryOutcome, RunAiWebDiscoveryOptions } from './vacancy-web-discovery.js';

/**
 * Issue #684 -- the two branches of one scan run (the optional AI web search and the deterministic
 * sources), kept free of Electron and of the database so tests can drive them with fakes. Since
 * #685 the two run side by side inside the one exclusive scan instead of one after the other.
 *
 * Both branches take their search criteria from the one `VacancyRunIntent` passed in, which the
 * caller captured from the validated request before anything was read from disk. The saved profile
 * is loaded here only as background context for the AI branch; nothing below derives a criterion
 * from it, so editing it while the run is active cannot change this run.
 */

/** The logger methods this orchestration uses. */
export interface VacancyScanLogger {
  warn(object: object, message: string): void;
  info(object: object, message: string): void;
  debug(object: object, message: string): void;
}

export type AiWebSearchRunState = 'running' | 'done' | 'failed';

/** How long a finished, failed or stopped run waits for the AI branch to wind down before fencing it. */
export const AI_BRANCH_STOP_GRACE_MS = 5_000;

export interface VacancyScanBranchesDeps {
  loadProfile(): Promise<CandidateProfile>;
  /** An app-owned scratch directory for the one-shot AI session. */
  ensureAiWorkspace(): Promise<string>;
  runAiWebDiscovery(options: RunAiWebDiscoveryOptions): Promise<AiWebDiscoveryOutcome>;
  runGlobalRemoteScan(options: GlobalRemoteScanOptions): Promise<GlobalRemoteScanResult>;
  logger: VacancyScanLogger;
  signal: AbortSignal;
  /** Throws the caller's "scan cancelled" error; called when `signal` is aborted before the scan starts. */
  throwCancelled(): never;
  onAiState(state: AiWebSearchRunState): void;
  onProgress: NonNullable<GlobalRemoteScanOptions['onProgress']>;
  browseAllResultCap: number;
  /** Overrides `AI_BRANCH_STOP_GRACE_MS`; for tests. */
  aiStopGraceMs?: number;
}

/**
 * Runs the deterministic scan and, when the run asked for it, the AI web search alongside it, both
 * from `intent`, as one run (#685).
 *
 * Both branches start at once. The deterministic sources report progress as they finish, whatever
 * the AI step is doing; the engine waits for the AI step only where it merges the AI rows into the
 * one result (`GlobalRemoteScanOptions.joinAiWebDiscovery`), so those rows go through the same
 * de-duplication, scoring and enrichment as every other source and the run still builds and saves
 * exactly one report. There is one `runGlobalRemoteScan` call and no lock is taken here: this is all
 * work done under the caller's one exclusive scan.
 *
 * The AI branch never fails the run: `runAiWebDiscovery` never throws, a failure of the setup around
 * it (a malformed saved profile file, no writable scratch directory) is logged and the run merges no
 * AI input, and a failed or timed-out step is reported on its own source row while every
 * deterministic row is kept. A deterministic failure still fails the whole run, exactly as before
 * this change, and whatever the AI step found in that run is discarded.
 *
 * However the run ends (finished, failed, stopped), the AI branch is told to stop and is waited for,
 * up to `AI_BRANCH_STOP_GRACE_MS`, so its session does not outlive the exclusive scan. A branch that
 * does not wind down in time is fenced instead: nothing reads its result and its later state updates
 * are dropped, so it cannot touch this run's report or a later run.
 *
 * When AI search was not requested nothing here touches the AI dependencies, so the options for the
 * deterministic scan carry no AI fields at all.
 */
export async function runVacancyScanBranches(
  deps: VacancyScanBranchesDeps,
  intent: VacancyRunIntent,
): Promise<GlobalRemoteScanResult> {
  if (deps.signal.aborted) deps.throwCancelled();
  const deterministicOptions: GlobalRemoteScanOptions = {
    signal: deps.signal,
    ...deterministicScanCriteria(intent, deps.browseAllResultCap),
    onProgress: deps.onProgress,
  };
  if (!intent.aiWebDiscovery) return deps.runGlobalRemoteScan(deterministicOptions);

  // The AI branch's own stop: the scan's signal, or the run ending first for any other reason.
  const aiStop = new AbortController();
  const stopAi = () => aiStop.abort();
  deps.signal.addEventListener('abort', stopAi, { once: true });
  let fenced = false;
  const ai = runAiBranch(deps, intent, aiStop.signal, (state) => {
    if (!fenced) deps.onAiState(state);
  });
  try {
    // A stop rejects this with the engine's own `ScanCancelledError` (at once while it waits for the
    // AI branch); a deterministic failure rejects it with that failure, unchanged.
    return await deps.runGlobalRemoteScan({ ...deterministicOptions, joinAiWebDiscovery: () => ai });
  } finally {
    deps.signal.removeEventListener('abort', stopAi);
    // On the normal path the engine already awaited the branch, so this abort is a no-op.
    aiStop.abort();
    if (!(await settlesWithin(ai, deps.aiStopGraceMs ?? AI_BRANCH_STOP_GRACE_MS))) {
      fenced = true;
      deps.logger.warn({}, 'AI web discovery did not stop in time; its late result will be ignored');
    }
  }
}

/** True once `promise` settles, or false after `ms`. `promise` never rejects. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The AI branch as one promise that never rejects: the rows and source row to merge, or `undefined`
 * when the step's setup failed and there is nothing to merge.
 */
async function runAiBranch(
  deps: VacancyScanBranchesDeps,
  intent: VacancyRunIntent,
  signal: AbortSignal,
  onAiState: (state: AiWebSearchRunState) => void,
): Promise<AiWebDiscoveryJoinResult | undefined> {
  const { logger } = deps;
  try {
    const profile = await deps.loadProfile();
    onAiState('running');
    const aiWebDiscovery = await deps.runAiWebDiscovery({
      profile,
      intent,
      cwd: await deps.ensureAiWorkspace(),
      signal,
    });
    const aiAudit = aiWebDiscovery.sourceAudit;
    const aiFailed = aiAudit.status === 'error' || aiAudit.status === 'blocked';
    onAiState(aiFailed ? 'failed' : 'done');
    // At warn, not only debug: a failed AI step used to leave no trace outside the report (#559). A
    // step that ended because the run was stopped or finished is not a failure worth a warning.
    if (aiFailed && !signal.aborted) {
      logger.warn({ sourceAudit: aiAudit }, 'AI web discovery did not run to completion');
      console.warn(`[ai-web-search] ${aiAudit.status}: ${aiAudit.error ?? aiAudit.completenessReason ?? 'no reason given'}`);
    }
    // Issue #398: "the actual queries used in a run are persisted/reportable" -- logged here,
    // alongside the resulting source audit, since Phase 1 needs no dedicated DB persistence
    // for this (see `runAiWebDiscovery`'s own doc comment on `queriesUsed`).
    logger.debug(
      { queriesUsed: aiWebDiscovery.queriesUsed, sourceAudit: aiWebDiscovery.sourceAudit },
      'AI web discovery pass finished',
    );
    // Which of this run's submitted criteria the model was given (#684). Search terms and counts
    // only: no CV text, skill names or prompt.
    if (aiWebDiscovery.intentProvenance) {
      logger.info({ aiSearchIntent: aiWebDiscovery.intentProvenance }, 'AI web discovery intent');
    }
    return { vacancies: aiWebDiscovery.vacancies, sourceAudit: aiWebDiscovery.sourceAudit };
  } catch (error) {
    onAiState('failed');
    logger.warn({ error }, 'AI web discovery setup failed; skipping this pass for the current scan');
    return undefined;
  }
}
