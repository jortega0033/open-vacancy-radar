/**
 * The `window.applicationPipeline` wire contract (#272), mirroring `application-queue-types.ts`'s
 * role for the #200 queue and `application-executor-types.ts`'s for the #201 executor: declared
 * here, implemented by `preload.ts`, re-exported by `src/window.d.ts`. Type-only, so nothing here
 * is emitted into the renderer bundle.
 *
 * Entry points accept only app-owned record ids. Everything an application is actually made of is
 * resolved in Electron main. Recovery methods can choose the recorded tailoring mode, but cannot
 * supply document content, a URL, or a job description.
 */

export type StartApplicationAttemptRefusal =
  /** The vacancy has no application URL recorded, so there is nothing to apply through. */
  | 'no_apply_url'
  /** The CV library is empty, so there is nothing to build an application from. */
  | 'no_cv_available'
  /** A non-terminal attempt for this same vacancy already exists (#198's dedup rule). */
  | 'attempt_already_in_progress';

export interface StartApplicationAttemptResult {
  ok: boolean;
  /**
   * Present when `ok`, and also for `attempt_already_in_progress` -- which attempt already exists
   * is exactly what a caller needs in order to show it rather than start a second one.
   */
  attemptId?: string;
  reason?: StartApplicationAttemptRefusal;
  /** A message written by this process, never by the daemon or by any remote source. */
  detail?: string;
}

export interface StartApplicationFromVacancyResult extends StartApplicationAttemptResult {
  /** The saved-job record resolved or created for the vacancy. */
  savedJobId?: string;
  /** True only when this call created the saved-job record. */
  created?: boolean;
}

export interface RestartApplicationTailoringResult {
  ok: boolean;
  attemptId: string;
  tailoringMode: 'ai' | 'original';
  detail?: string;
}

export interface ApplicationPipelineBridge {
  /**
   * Records an application attempt for one saved job and hands it to the daemon queue. Returns as
   * soon as the attempt exists -- preparing it (documents, form filling) happens under a queue
   * lease afterwards, and its progress is read from the attempt's own `checkpoint`.
   *
   * Never submits anything: this path stops at "ready for you to review".
   */
  start(savedJobId: string): Promise<StartApplicationAttemptResult>;
  /** Starts the same pipeline directly from a search result. Main resolves every vacancy field. */
  startFromVacancy(vacancyKey: string): Promise<StartApplicationFromVacancyResult>;
  /** Retries failed AI tailoring for the same durable attempt. */
  retryTailoring(attemptId: string): Promise<RestartApplicationTailoringResult>;
  /** Explicitly prepares the reviewed source CV after AI tailoring failed. */
  useOriginalCv(attemptId: string): Promise<RestartApplicationTailoringResult>;
  /** Re-runs a needs-user preparation after the person addresses its blocker. */
  resume(attemptId: string): Promise<RestartApplicationTailoringResult>;
}
