import type { GlobalRemoteReport, ScanProgressEvent, SearchPlanSnapshot } from '@open-vacancy-radar/vacancy-engine';
import { describeVacancyRunIntent, captureVacancyRunIntent, type VacancyRunIntent } from './vacancy-run-intent.js';
import { runVacancyScanBranches, type VacancyScanBranchesDeps } from './vacancy-scan-orchestration.js';
import type { ParsedVacancyScanRequest } from './vacancy-scan-query.js';
import type {
  VacancyScanAiWebSearchState,
  VacancyScanCancelResult,
  VacancyScanProgressEvent,
  VacancyScanStatus,
} from './vacancy-scan-progress-types.js';

/**
 * The lifecycle of one user-visible vacancy scan run (#459, #685), kept free of Electron so tests can
 * drive the real sequence: stop the background scout, take the one exclusive scan, run both branches
 * under one scan id and one intent snapshot, forward progress to the page, adopt the finished report
 * and report the outcome once. `main.ts` supplies the Electron and engine pieces.
 */

/** The vacancy scan this process is running right now, with the progress its engine events have
 * reported so far (#459). Held in the main process, not the renderer, so a page that remounts
 * mid-scan still shows the true source count, start time and run id. */
export interface ActiveVacancyScan {
  id: string;
  startedAt: number;
  controller: AbortController;
  doneSources: Set<string>;
  total: number;
  vacancies: number;
  /** What this run was asked to look for, fixed when it started (#684). */
  intent: VacancyRunIntent;
  /** Only set when this run was asked to also search the web with AI (#559). */
  aiWebSearch?: VacancyScanAiWebSearchState;
}

/** What one run needs from the engine, built inside the exclusive scan (config, logger, database). */
export type VacancyScanRunBranchDeps = Pick<
  VacancyScanBranchesDeps,
  'loadProfile' | 'ensureAiWorkspace' | 'runAiWebDiscovery' | 'runGlobalRemoteScan' | 'logger' | 'browseAllResultCap' | 'aiStopGraceMs'
>;

export interface VacancyScanRunnerDeps {
  /** Work done before taking the scan (stop the background scout, open the engine database). */
  beforeScan(): Promise<void>;
  runExclusiveScan<T>(run: () => Promise<T>): Promise<T>;
  /** Called once per run, inside the exclusive scan. */
  prepareRun(): Promise<VacancyScanRunBranchDeps>;
  /**
   * The saved search plan as a frozen copy, or null when there is no usable plan (#686). Read only for a
   * run that asked for the plan, at the moment the run's intent is captured, so what the run searches is
   * fixed here and a later save of the plan cannot reach it. A plan file that cannot be read rejects.
   */
  loadSearchPlanSnapshot(): Promise<SearchPlanSnapshot | null>;
  newScanId(): string;
  now(): number;
  /** How many progress groups a run reports (`SCAN_PROGRESS_SOURCE_IDS.length`). */
  progressSourceTotal: number;
  /** The renderer-facing `vacancy:scan-progress` push. */
  sendProgress(event: VacancyScanProgressEvent): void;
  /** Makes a finished run's report the app's current state (#561 rules live with the caller). */
  adoptReport(report: GlobalRemoteReport): void;
  notifyCompleted(report: GlobalRemoteReport): void;
  notifyFailed(detail: string): void;
  /** Errors that are not a failure of this run: another scan held the lock, or the person stopped it. */
  isQuietError(error: unknown): boolean;
  throwCancelled(): never;
}

export interface VacancyScanRunner {
  run(request: ParsedVacancyScanRequest): Promise<GlobalRemoteReport>;
  /** `vacancy:get-scan-progress` for the active run, or `undefined` when this process runs none. */
  status(): VacancyScanStatus | undefined;
  /** Stops the run named by `scanId`; a stale id (finished, or a newer run started) stops nothing. */
  cancel(scanId: unknown): VacancyScanCancelResult;
}

export function createVacancyScanRunner(deps: VacancyScanRunnerDeps): VacancyScanRunner {
  let active: ActiveVacancyScan | undefined;

  async function run(request: ParsedVacancyScanRequest): Promise<GlobalRemoteReport> {
    await deps.beforeScan();
    try {
      const report = await deps.runExclusiveScan(async () => {
        const branchDeps = await deps.prepareRun();
        const scanId = deps.newScanId();
        // Fixed here, from the validated request, before any saved profile is read: the AI branch and
        // the deterministic branch both take their criteria from this snapshot (#684).
        const searchPlan =
          request.mode === 'query' && request.useSearchPlan === true ? await deps.loadSearchPlanSnapshot() : null;
        const intent = captureVacancyRunIntent(scanId, request, new Date(), searchPlan);
        const scan: ActiveVacancyScan = {
          id: scanId,
          startedAt: deps.now(),
          controller: new AbortController(),
          doneSources: new Set(),
          total: deps.progressSourceTotal,
          vacancies: 0,
          intent,
          ...(intent.aiWebDiscovery ? { aiWebSearch: 'waiting' as const } : {}),
        };
        active = scan;
        try {
          // Both branches run inside this one exclusive scan, under this one scan id (#685). Neither
          // takes the scan guard again: `runAiWebDiscovery` never imports it, and the orchestration
          // only ever calls the engine once.
          const result = await runVacancyScanBranches(
            {
              ...branchDeps,
              signal: scan.controller.signal,
              throwCancelled: deps.throwCancelled,
              onAiState: (state) => {
                if (active === scan) scan.aiWebSearch = state;
              },
              onProgress: (event: ScanProgressEvent) => {
                // A stopped run's late events must not reach the page: it has already gone back to the
                // previous report. Nor may a run that is no longer the active one.
                if (scan.controller.signal.aborted || active !== scan) return;
                scan.doneSources.add(event.sourceId);
                scan.vacancies += event.vacancies.length;
                deps.sendProgress({
                  ...event,
                  scanId: scan.id,
                  sourcesDone: scan.doneSources.size,
                  sourcesTotal: scan.total,
                });
              },
            },
            intent,
          );
          deps.adoptReport(result.report);
          return result.report;
        } finally {
          if (active === scan) active = undefined;
        }
      });
      deps.notifyCompleted(report);
      return report;
    } catch (error) {
      // A stop the person asked for is neither a failure nor worth a notification, and neither is
      // losing the race for the scan to another run.
      if (!deps.isQuietError(error)) {
        deps.notifyFailed(error instanceof Error ? error.message : 'unknown error');
      }
      throw error;
    }
  }

  function status(): VacancyScanStatus | undefined {
    const scan = active;
    if (!scan) return undefined;
    return {
      scanning: true,
      scanId: scan.id,
      startedAt: scan.startedAt,
      sourcesDone: scan.doneSources.size,
      sourcesTotal: scan.total,
      vacanciesSoFar: scan.vacancies,
      intent: describeVacancyRunIntent(scan.intent),
      ...(scan.aiWebSearch ? { aiWebSearch: scan.aiWebSearch } : {}),
      ...(scan.controller.signal.aborted ? { stopping: true } : {}),
    };
  }

  function cancel(scanId: unknown): VacancyScanCancelResult {
    const scan = active;
    if (!scan || typeof scanId !== 'string' || scan.id !== scanId) return { cancelled: false };
    scan.controller.abort();
    return { cancelled: true };
  }

  return { run, status, cancel };
}
