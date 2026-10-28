import type {
  CandidateProfile,
  GlobalRemoteScanOptions,
  GlobalRemoteScanResult,
} from '@open-vacancy-radar/vacancy-engine';
import { deterministicScanCriteria, type VacancyRunIntent } from './vacancy-run-intent.js';
import type { AiWebDiscoveryOutcome, RunAiWebDiscoveryOptions } from './vacancy-web-discovery.js';

/**
 * Issue #684 -- the two branches of one scan run (the optional AI web search and the deterministic
 * sources), kept free of Electron and of the database so tests can drive them with fakes.
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

export interface VacancyScanBranchesDeps {
  loadProfile(): Promise<CandidateProfile>;
  /** An app-owned scratch directory for the one-shot AI session. */
  ensureAiWorkspace(): Promise<string>;
  runAiWebDiscovery(options: RunAiWebDiscoveryOptions): Promise<AiWebDiscoveryOutcome>;
  runGlobalRemoteScan(options: GlobalRemoteScanOptions): Promise<GlobalRemoteScanResult>;
  logger: VacancyScanLogger;
  signal: AbortSignal;
  /** Throws the caller's "scan cancelled" error; called when `signal` is aborted before the scan. */
  throwCancelled(): never;
  onAiState(state: AiWebSearchRunState): void;
  onProgress: NonNullable<GlobalRemoteScanOptions['onProgress']>;
  browseAllResultCap: number;
}

/**
 * Runs the AI branch (when the run asked for it) and then the deterministic scan, both from `intent`.
 *
 * The AI branch never aborts the scan: `runAiWebDiscovery` itself never throws, and a failure of the
 * setup around it (a malformed saved profile file, no writable scratch directory) is logged and the
 * run continues as if AI search had not been requested. When AI search was not requested nothing here
 * touches the AI dependencies, so the options for the deterministic scan carry no AI fields at all.
 */
export async function runVacancyScanBranches(
  deps: VacancyScanBranchesDeps,
  intent: VacancyRunIntent,
): Promise<GlobalRemoteScanResult> {
  const { logger } = deps;
  let aiWebDiscovery: AiWebDiscoveryOutcome | undefined;
  if (intent.aiWebDiscovery) {
    try {
      const profile = await deps.loadProfile();
      deps.onAiState('running');
      aiWebDiscovery = await deps.runAiWebDiscovery({
        profile,
        intent,
        cwd: await deps.ensureAiWorkspace(),
      });
      const aiAudit = aiWebDiscovery.sourceAudit;
      const aiFailed = aiAudit.status === 'error' || aiAudit.status === 'blocked';
      deps.onAiState(aiFailed ? 'failed' : 'done');
      // At warn, not only debug: a failed AI step used to leave no trace outside the report (#559).
      if (aiFailed) {
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
    } catch (error) {
      deps.onAiState('failed');
      logger.warn({ error }, 'AI web discovery setup failed; skipping this pass for the current scan');
    }
  }
  if (deps.signal.aborted) deps.throwCancelled();
  return deps.runGlobalRemoteScan({
    signal: deps.signal,
    ...deterministicScanCriteria(intent, deps.browseAllResultCap),
    onProgress: deps.onProgress,
    ...(aiWebDiscovery
      ? {
          aiWebDiscoveryVacancies: aiWebDiscovery.vacancies,
          aiWebDiscoverySourceAudit: aiWebDiscovery.sourceAudit,
        }
      : {}),
  });
}
