import { AsyncLocalStorage } from 'node:async_hooks';

import type { AtsHttpClient, AtsHttpRequestOptions, AtsHttpResponse } from '../ats/http.js';
import type {
  SafeHttpClient,
  SafeHttpStreamGetOptions,
  SafeHttpStreamResponse,
} from '../crawler/http-client.js';
import type { DiscoverySourceAudit } from './models.js';

/**
 * Attempt bookkeeping for exactly one `DiscoverySourceAudit` row: every real network fetch
 * `SafeHttpClient` makes on this row's behalf (`attempts`), and the subset of those beyond the
 * first attempt of each logical request (`retries` -- a bounded retry after a 429/5xx/timeout,
 * whether or not it eventually succeeded). Deliberately separate from `requests`/`listings` on
 * `DiscoverySourceAudit`, which count this source's own logical fetch calls and parsed listings --
 * `SafeHttpClient` already retries transparently underneath those, so `requests` alone cannot tell
 * "one clean fetch" from "three attempts that eventually succeeded".
 */
export type NetworkAttemptCounters = {
  attempts: number;
  retries: number;
};

type AttributionStore = { counters: NetworkAttemptCounters };

/**
 * Every discovery source in this package shares one `SafeHttpClient` instance (and therefore one
 * `onNetworkRequest` callback) for a whole scan -- see `createDatabaseBackedHttpClients` in
 * pipeline/global-remote.ts -- and most of them run concurrently with each other via one of this
 * package's several `Promise.all` fan-outs (`runGlobalRemoteDiscovery`'s top-level ten branches,
 * `runFeedDiscovery`'s fifteen, and more inside `structured-discovery.ts`, `keyed-discovery.ts`,
 * `additional-discovery.ts`). A single shared counter driven off that one callback would have no
 * way to tell which of the sources in flight at a given instant a retry belonged to -- exactly the
 * "accidentally pooled" failure mode issue #279 calls out.
 *
 * `AsyncLocalStorage` avoids that without any change to `SafeHttpClient` itself: which counters
 * object a given attempt reaches is determined by which wrapped client (`attributeNetworkRequests`/
 * `attributeStreamNetworkRequests` below) issued the call, not by wall-clock timing. This holds even
 * though a network attempt is not a direct continuation of the call that started it -- it is queued
 * in `RequestScheduler` and resumed later -- because the scheduler already carries a caller's async
 * context through that queuing via `AsyncResource.bind` (see crawler/scheduler.ts), which is exactly
 * what preserves an `AsyncLocalStorage` store across a deferred continuation like this one.
 */
const attributionContext = new AsyncLocalStorage<AttributionStore>();

export function newNetworkAttemptCounters(): NetworkAttemptCounters {
  return { attempts: 0, retries: 0 };
}

/**
 * Wired as the shared `SafeHttpClient`'s `onNetworkRequest` for a whole scan (see
 * `createDatabaseBackedHttpClients` in pipeline/global-remote.ts). A network hop fired outside any
 * `attributeNetworkRequests`/`attributeStreamNetworkRequests` context -- this codebase's one such
 * caller is the worldwide sponsor-match enrichment in pipeline/global-remote.ts, which has no
 * `DiscoverySourceAudit` row to attribute a Wikidata lookup to -- is silently dropped, matching how
 * `SafeHttpClient` already documents its telemetry hooks as tolerant of doing nothing.
 */
export function recordAttributedNetworkAttempt(retryIndex: number): void {
  const store = attributionContext.getStore();
  if (store === undefined) return;
  store.counters.attempts += 1;
  if (retryIndex > 0) store.counters.retries += 1;
}

/**
 * Wraps an `AtsHttpClient` so every request made through it -- including every bounded retry
 * `SafeHttpClient` performs underneath and every redirect hop it follows -- is attributed to
 * `counters` and never any other source's, regardless of how many other sources are making requests
 * through their own wrapped clients at the same moment. Two calls through the *same* wrapped client
 * (sequential page-walk requests, or a handful of concurrent ones within one source) correctly
 * accumulate into the same `counters` object; nothing here needs those to be isolated from each
 * other, only from other sources.
 */
export function attributeNetworkRequests(
  http: AtsHttpClient,
  counters: NetworkAttemptCounters = newNetworkAttemptCounters(),
): AtsHttpClient {
  return {
    get(url: string, options?: AtsHttpRequestOptions): Promise<AtsHttpResponse> {
      return attributionContext.run({ counters }, () =>
        (options === undefined ? http.get(url) : http.get(url, options)));
    },
    postJson(url: string, body: unknown, options?: AtsHttpRequestOptions): Promise<AtsHttpResponse> {
      return attributionContext.run({ counters }, () =>
        (options === undefined ? http.postJson(url, body) : http.postJson(url, body, options)));
    },
  };
}

/**
 * Same wrapping as `attributeNetworkRequests`, for the one discovery source (`workable_global`)
 * that streams through `SafeHttpClient.streamGet` directly instead of the smaller `AtsHttpClient`
 * seam -- see `runWorkableGlobalDiscovery` in workable-global-discovery.ts.
 */
export function attributeStreamNetworkRequests(
  http: Pick<SafeHttpClient, 'streamGet'>,
  counters: NetworkAttemptCounters = newNetworkAttemptCounters(),
): { streamGet: (url: string, options: SafeHttpStreamGetOptions) => Promise<SafeHttpStreamResponse> } {
  return {
    streamGet(url: string, options: SafeHttpStreamGetOptions): Promise<SafeHttpStreamResponse> {
      return attributionContext.run({ counters }, () => http.streamGet(url, options));
    },
  };
}

/** Spreads a counters snapshot onto a `DiscoverySourceAudit` literal. */
export function networkAttemptFields(
  counters: NetworkAttemptCounters,
): Pick<DiscoverySourceAudit, 'networkAttempts' | 'retries'> {
  return { networkAttempts: counters.attempts, retries: counters.retries };
}
