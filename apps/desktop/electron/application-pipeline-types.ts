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
  /**
   * Present when the attempt was started but the chosen CV profile will make tailoring weak, e.g.
   * it lists no skills (#521). The attempt still runs; this is what the caller shows up front.
   */
  warning?: string;
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

/** What a posting check currently says about one attempt (#687). */
export type PostingVerificationStatus =
  /** No check has been made for this attempt (or no verifier is available). */
  | 'not_checked'
  | 'confirmed_open'
  | 'confirmed_closed'
  | 'materially_changed'
  /** Timeout, denial, login wall, rate limit, server error or an unsupported source. Never closure. */
  | 'unable_to_verify'
  /** Submitted / reported / skipped attempts keep their package; the live posting is not consulted. */
  | 'not_applicable';

export type PostingVerificationAction = 'check_again' | 'open_posting' | 'refresh' | 'keep_current' | 'prepare_anyway';

export type PostingVerificationReasonCode =
  | 'verified_open' | 'not_modified' | 'not_found' | 'gone' | 'closure_notice' | 'account_not_found'
  | 'no_authoritative_source' | 'timeout' | 'denied' | 'rate_limited' | 'server_error' | 'network_error'
  | 'login_wall' | 'redirected_elsewhere' | 'unexpected_response' | 'empty_content';

/**
 * Read model for the application flow. Contains no posting text, URL or remote-supplied prose
 * beyond a few capped changed lines, and the renderer cannot send any of it back: every action names
 * only an attempt id and main re-derives the rest.
 */
export interface PostingVerificationView {
  attemptId: string;
  status: PostingVerificationStatus;
  /** ISO-8601 time the authority was actually contacted, preserved when a stored check is reused. */
  checkedAt: string | null;
  source: string | null;
  sourceRef: string | null;
  reason: PostingVerificationReasonCode | null;
  httpStatus: number | null;
  /** Per attempt; the text the work was prepared against is version 1. */
  contentVersion: number | null;
  /** A deadline the posting itself states, with the sentence it came from. Never inferred. */
  deadline: { date: string; excerpt: string } | null;
  /** True only after a check that read the posting and found no deadline stated. */
  noDeadlineStated: boolean;
  change: { added: string[]; removed: string[] } | null;
  resolution: 'refreshed' | 'prepare_anyway' | 'keep_current' | null;
  /** This call reused a stored check and made no request. */
  reused: boolean;
  /** Older than the freshness window (or never checked). */
  stale: boolean;
  /** This call took a prepared attempt out of `ready` because the posting changed. */
  invalidated: boolean;
  actions: PostingVerificationAction[];
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
  /**
   * Re-runs a needs-user preparation after the person addresses its blocker. `resolution` records the
   * person's explicit decision about a posting finding first (#687): `prepare_anyway` for a posting
   * reported closed, `keep_current` for one whose requirements changed.
   */
  resume(attemptId: string, options?: { resolution?: 'prepare_anyway' | 'keep_current' }): Promise<RestartApplicationTailoringResult>;
  /** Reads the stored posting check for this attempt. Makes no request. */
  postingVerification(attemptId: string): Promise<PostingVerificationView>;
  /**
   * One bounded check of the live posting for a prepared attempt (#687). Reuses a stored check
   * younger than the freshness window unless `force` is set; refuses submitted attempts.
   */
  verifyPosting(attemptId: string, options?: { force?: boolean }): Promise<PostingVerificationView>;
  /** Replaces the job description with the changed posting and prepares again, deleting the old package. */
  refreshFromPosting(attemptId: string): Promise<RestartApplicationTailoringResult>;
  /** Links the letter just saved from the review hand-off to this attempt. Main finds the letter. */
  attachLetter(attemptId: string): Promise<{ ok: boolean; attemptId: string; detail?: string }>;
}
