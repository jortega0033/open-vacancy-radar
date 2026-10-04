import type { ScanProgressEvent } from '@open-vacancy-radar/vacancy-engine';

/**
 * Wire types for scan progress and cancellation (#459). Type-only, so nothing here is emitted into
 * the renderer bundle.
 */

/** What `vacancy:get-scan-status` reports. Everything after `scanning` is present only while a scan
 * this app started is running; a scan started by another process reports `scanning` alone. */
export interface VacancyScanStatus {
  scanning: boolean;
  /** Names the active run, so Stop can only ever cancel the run the person was looking at. */
  scanId?: string;
  /** Epoch milliseconds from the main process, so elapsed time survives the page remounting. */
  startedAt?: number;
  /** Discovery groups that have finished, counted from engine progress events and nothing else. */
  sourcesDone?: number;
  /** How many groups a scan reports on, or absent when the run reports no such events. */
  sourcesTotal?: number;
  /** Vacancy rows those groups have found so far, before de-duplication. */
  vacanciesSoFar?: number;
  /** True once a stop was requested and the run is winding down. */
  stopping?: boolean;
  /** Where the optional AI web search step is (#559). Absent when the run did not ask for it. */
  aiWebSearch?: VacancyScanAiWebSearchState;
}

/** `failed` covers a skipped step too (not installed, not signed in, no search profile). */
export type VacancyScanAiWebSearchState = 'waiting' | 'running' | 'done' | 'failed';

export interface VacancyScanCancelResult {
  /** False when there was no such active run (it finished first, or the id belonged to another run). */
  cancelled: boolean;
}

/** A `vacancy:scan-progress` push: the engine's own event plus the run it belongs to and the
 * running source count, so the page can ignore a late event from a run it has already left. */
export type VacancyScanProgressEvent = ScanProgressEvent & {
  scanId?: string;
  sourcesDone?: number;
  sourcesTotal?: number;
};
