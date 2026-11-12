import {
  POSTING_FRESHNESS_WINDOW_MS,
  POSTING_UNABLE_RETRY_AFTER_MS,
  POSTING_VERIFY_TIMEOUT_MS,
  resolvePostingProbe,
  type PostingObservation,
} from '@open-vacancy-radar/vacancy-engine';
import type { PostingLivenessView, PostingVerificationReasonCode } from './application-pipeline-types.js';

/**
 * Plain liveness for search results (#720): what the app knows right now about whether a result's
 * posting is still open, so no fit score is ever shown without it.
 *
 * - `read` never touches the network. A result nobody has checked is "not checked yet"; a result whose
 *   link has no authoritative route is "couldn't check" (it never can be, so saying "not checked yet"
 *   would promise a check that will not come).
 * - `check` is person-triggered (selecting one result) and is ONE bounded check through the same
 *   verifier, request envelope, freshness windows and source policy as preparation: a fresh answer is
 *   reused with its original time and costs no request, overlapping checks of one link share one request,
 *   and a link with no route costs no request at all.
 * - Only a summary is kept (time, outcome, reason, source label): never posting text, never anything
 *   about the person. It lives in memory, bounded, and is lost on restart, when results honestly read
 *   "not checked yet" again. Preparation's own checks are remembered here too, so a result whose
 *   application found it closed says so.
 */

export interface PostingLivenessDeps {
  /** The link a result would be prepared from (the same resolution `startFromVacancy` uses), or null. */
  resolveUrl(vacancyKey: string): string | null;
  /** Absent when no verifier can be built: results then stay "not checked yet". */
  verify?: (input: { url: string }) => Promise<PostingObservation>;
  now?(): Date;
  log?(message: string, meta?: Record<string, unknown>): void;
}

interface Remembered {
  observedAt: string;
  outcome: PostingObservation['outcome'];
  reason: PostingVerificationReasonCode;
  source: string | null;
  sourceRef: string | null;
}

/** Results one read may ask about (a page is far smaller); more are ignored, not an error. */
export const POSTING_LIVENESS_READ_LIMIT = 200;
/** Links remembered at once; the oldest entry goes first. */
export const POSTING_LIVENESS_MEMORY_LIMIT = 500;
const PORT_BACKSTOP_MS = POSTING_VERIFY_TIMEOUT_MS + 5_000;

function summarize(observation: PostingObservation): Remembered {
  return {
    observedAt: observation.observedAt,
    outcome: observation.outcome,
    reason: observation.reason as PostingVerificationReasonCode,
    source: observation.source === 'none' ? null : observation.source,
    sourceRef: observation.source === 'none' ? null : observation.sourceRef,
  };
}

function isFresh(entry: Remembered, now: Date): boolean {
  const age = now.getTime() - Date.parse(entry.observedAt);
  const window = entry.outcome === 'unable' ? POSTING_UNABLE_RETRY_AFTER_MS : POSTING_FRESHNESS_WINDOW_MS;
  return age >= 0 && age < window;
}

export interface PostingLivenessService {
  read(vacancyKeys: readonly string[]): PostingLivenessView[];
  check(vacancyKey: string): Promise<PostingLivenessView>;
  /** Records an observation made elsewhere (preparation's own check) for the same link. */
  remember(url: string, observation: PostingObservation): void;
}

export function createPostingLivenessService(deps: PostingLivenessDeps): PostingLivenessService {
  const memory = new Map<string, Remembered>();
  const inFlight = new Map<string, Promise<PostingObservation>>();
  const now = () => deps.now?.() ?? new Date();

  function remember(url: string, observation: PostingObservation): void {
    const next = summarize(observation);
    const previous = memory.get(url);
    // An older observation never replaces a newer one.
    if (previous && Date.parse(previous.observedAt) > Date.parse(next.observedAt)) return;
    memory.delete(url);
    memory.set(url, next);
    while (memory.size > POSTING_LIVENESS_MEMORY_LIMIT) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
  }

  function viewOf(vacancyKey: string, url: string | null): PostingLivenessView {
    const checkable = url !== null && resolvePostingProbe(url) !== null;
    const entry = url === null ? undefined : memory.get(url);
    if (entry) {
      return {
        vacancyKey,
        state: entry.outcome === 'open' ? 'open' : entry.outcome === 'closed' ? 'closed' : 'unverifiable',
        checkedAt: entry.observedAt,
        source: entry.source,
        sourceRef: entry.sourceRef,
        reason: entry.reason,
        checkable,
      };
    }
    return {
      vacancyKey,
      state: checkable ? 'not_checked' : 'unverifiable',
      checkedAt: null,
      source: null,
      sourceRef: null,
      reason: checkable ? null : 'no_authoritative_source',
      checkable,
    };
  }

  async function observeOnce(url: string, verify: NonNullable<PostingLivenessDeps['verify']>): Promise<PostingObservation> {
    const existing = inFlight.get(url);
    if (existing) return existing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backstop = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('posting check backstop reached')), PORT_BACKSTOP_MS);
    });
    const promise = Promise.race([Promise.resolve().then(() => verify({ url })), backstop]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (inFlight.get(url) === promise) inFlight.delete(url);
    });
    inFlight.set(url, promise);
    return promise;
  }

  return {
    read(vacancyKeys) {
      return vacancyKeys.slice(0, POSTING_LIVENESS_READ_LIMIT).map((key) => viewOf(key, deps.resolveUrl(key)));
    },
    async check(vacancyKey) {
      const url = deps.resolveUrl(vacancyKey);
      const view = viewOf(vacancyKey, url);
      if (url === null || !view.checkable || !deps.verify) return view;
      const known = memory.get(url);
      if (known && isFresh(known, now())) return view;
      try {
        remember(url, await observeOnce(url, deps.verify));
      } catch (error) {
        // A check that could not run is "couldn't check" at this time (never closure), as in preparation.
        deps.log?.('a result posting check could not run', { error: error instanceof Error ? error.message : String(error) });
        const probe = resolvePostingProbe(url);
        remember(url, {
          observedAt: now().toISOString(),
          source: probe?.source ?? 'none',
          sourceRef: probe?.sourceRef ?? 'none',
          outcome: 'unable',
          reason: 'check_failed',
          httpStatus: null,
          text: null,
          contentHash: null,
          validators: null,
          notModified: false,
          deadline: null,
          logicalRequests: 0,
        });
      }
      return viewOf(vacancyKey, url);
    },
    remember,
  };
}
