import { AsyncLocalStorage } from 'node:async_hooks';

import type { AtsHttpClient, AtsHttpRequestOptions, AtsHttpResponse } from '../ats/http.js';
import { currentPlanAdmissionRecorder, type PlanAdmissionEvent } from './discovery-attribution.js';
import type { DiscoveryProvider, SearchPlanEnvelope } from './models.js';

/**
 * Issue #686 -- the ONE envelope a search plan runs in, enforced where requests really happen.
 *
 * The unit is a physical network attempt: every fetch `SafeHttpClient` makes, i.e. the first attempt
 * of a request, every bounded retry and every redirect hop. The ledger is charged from
 * `SafeHttpClient`'s `admitNetworkRequest` hook (wired by the scan's composition root), which fires
 * immediately before each fetch and can refuse it -- so a request cap can never be exceeded first and
 * estimated afterwards. One counter, one deadline and one result count cover the literal pass (every
 * title-search source, every fixed feed, the ATS roster) and every variant pass.
 *
 * Which ledger an attempt belongs to is carried by `AsyncLocalStorage`, the same technique
 * `discovery-attribution.ts` uses: a plan-scoped client (`SearchPlanLedger#client`) enters a scope per
 * logical call, and `RequestScheduler` preserves that scope through queuing. A hop made outside any
 * plan scope (a scan without a plan, official employer checks, sponsor lookups) is admitted untouched.
 */

export type SearchPlanRefusal = 'request' | 'time';

/**
 * A call refused BEFORE any network contact was never sent ("Not asked"). A call the allowance cut
 * AFTER it reached the network -- a retry or redirect hop that was refused, or an attempt aborted in
 * flight by the deadline -- was asked, so it says "Stopped after asking" and is counted as sent.
 */
const REFUSAL_MESSAGES: Record<SearchPlanRefusal, string> = {
  request: 'Not asked: the search plan had used its whole shared request allowance.',
  time: 'Not asked: the search plan had used its whole shared time allowance.',
};

const CUT_MESSAGES: Record<SearchPlanRefusal, string> = {
  request: 'Stopped after asking: the search plan used its whole shared request allowance before this source finished.',
  time: 'Stopped after asking: the search plan used its whole shared time allowance before this source finished.',
};

export class SearchPlanBudgetError extends Error {
  /** `afterContact`: the call had already made at least one physical network attempt when it was cut. */
  public constructor(public readonly kind: SearchPlanRefusal, public readonly afterContact = false) {
    super(afterContact ? CUT_MESSAGES[kind] : REFUSAL_MESSAGES[kind]);
    this.name = 'SearchPlanBudgetError';
  }
}

export function isSearchPlanBudgetError(error: unknown): error is SearchPlanBudgetError {
  return error instanceof Error && error.name === 'SearchPlanBudgetError';
}

/** A source row whose only error is a plan refusal: coverage the plan did not spend, not a broken source. */
export function isSearchPlanRefusalMessage(message: string | null | undefined): boolean {
  return (
    message === REFUSAL_MESSAGES.request ||
    message === REFUSAL_MESSAGES.time ||
    isSearchPlanCutMessage(message)
  );
}

/** The refusal text of a call that had already reached the network (see `CUT_MESSAGES`). */
export function isSearchPlanCutMessage(message: string | null | undefined): boolean {
  return message === CUT_MESSAGES.request || message === CUT_MESSAGES.time;
}

interface ProviderQuota {
  limit: number;
  used: number;
  done: boolean;
}

/** One pass of the plan: the literal pass, or one approved title. */
export interface SearchPlanPass {
  readonly id: string;
  /** Attempts this pass may make; `Infinity` for the literal pass (bounded by the whole-plan cap). */
  limit: number;
  used: number;
  refused: SearchPlanRefusal | null;
  /** Per-provider fair shares inside a variant pass; null = no per-provider split. */
  quotas: Map<string, ProviderQuota> | null;
  /** Quota returned by providers that finished under their share; any provider may draw from it. */
  pool: number;
}

interface CallState {
  attempts: number;
  refused: SearchPlanRefusal | null;
}

interface PlanScope {
  readonly ledger: SearchPlanLedger;
  readonly pass: SearchPlanPass;
  readonly provider: string | null;
  readonly call: CallState;
  /** Bound when the call starts, to the source row that made it (see `currentPlanAdmissionRecorder`). */
  readonly record: (event: PlanAdmissionEvent) => void;
}

const planScope = new AsyncLocalStorage<PlanScope>();

/**
 * Wired as `SafeHttpClient`'s `admitNetworkRequest` by the scan's composition root. Outside a plan
 * scope it does nothing and returns nothing, so a scan without a plan behaves exactly as before.
 */
export function admitSearchPlanAttempt(
  _safeUrl: string,
  meta: { retryIndex: number; redirectIndex: number },
): AbortSignal | undefined {
  const scope = planScope.getStore();
  if (scope === undefined) return undefined;
  return scope.ledger.admit(scope, meta);
}

export class SearchPlanTransportError extends Error {
  public constructor() {
    super(
      'A search plan needs a transport that reports every network attempt (SafeHttpClient with admitNetworkRequest); this client made a request the plan could not count.',
    );
    this.name = 'SearchPlanTransportError';
  }
}

export class SearchPlanLedger {
  public readonly envelope: Readonly<SearchPlanEnvelope>;
  public readonly startedAt: number;
  public attempts = 0;
  public literalAttempts = 0;
  public variantAttempts = 0;
  /** Logical calls refused before any network contact. */
  public refusedCalls = 0;
  /** Retries or redirect hops refused after a call had already reached the network. */
  public refusedFollowUps = 0;
  /** Rows matching the plan's OR set that were kept, and those trimmed by the result allowance. */
  public matchingRows = 0;
  public trimmedRows = 0;
  public firstRefusal: SearchPlanRefusal | null = null;
  readonly #now: () => number;
  readonly #deadline = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(envelope: SearchPlanEnvelope, options: { now?: () => number } = {}) {
    this.envelope = Object.freeze({ ...envelope });
    this.#now = options.now ?? Date.now;
    this.startedAt = this.#now();
    if (envelope.maxDurationMs <= 0) {
      this.#deadline.abort(new SearchPlanBudgetError('time'));
    } else {
      this.#timer = setTimeout(
        () => this.#deadline.abort(new SearchPlanBudgetError('time')),
        envelope.maxDurationMs,
      );
      // The deadline must never keep the process alive on its own.
      (this.#timer as { unref?: () => void }).unref?.();
    }
  }

  public get deadlineAt(): number {
    return this.startedAt + this.envelope.maxDurationMs;
  }

  /** Aborts at the shared deadline; every admitted attempt carries it, so an in-flight fetch is cut. */
  public get signal(): AbortSignal {
    return this.#deadline.signal;
  }

  public elapsedMs(): number {
    return Math.max(0, this.#now() - this.startedAt);
  }

  public timeExhausted(): boolean {
    if (!this.#deadline.signal.aborted && this.#now() >= this.deadlineAt) {
      this.#deadline.abort(new SearchPlanBudgetError('time'));
    }
    return this.#deadline.signal.aborted;
  }

  public remainingRequests(): number {
    return Math.max(0, this.envelope.maxRequests - this.attempts);
  }

  public remainingResults(): number {
    return Math.max(0, this.envelope.maxResults - this.matchingRows);
  }

  public dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
  }

  public literalPass(): SearchPlanPass {
    return { id: 'literal', limit: Number.POSITIVE_INFINITY, used: 0, refused: null, quotas: null, pool: 0 };
  }

  /**
   * A variant pass with `limit` attempts, split across `providers` in the given order: each gets an
   * equal share and the first `limit mod n` get one more. Rotating that order per title is what keeps
   * a tight allowance from always serving the same first source.
   */
  public variantPass(id: string, limit: number, providers: readonly string[]): SearchPlanPass {
    const quotas = new Map<string, ProviderQuota>();
    const n = providers.length;
    providers.forEach((provider, index) => {
      const share = n === 0 ? 0 : Math.floor(limit / n) + (index < limit % n ? 1 : 0);
      quotas.set(provider, { limit: share, used: 0, done: false });
    });
    return { id, limit, used: 0, refused: null, quotas: n === 0 ? null : quotas, pool: 0 };
  }

  /** Called when a provider's part of a pass has settled: what it did not use goes back to the pass. */
  public finishProvider(pass: SearchPlanPass, provider: string): void {
    const quota = pass.quotas?.get(provider);
    if (!quota || quota.done) return;
    quota.done = true;
    pass.pool += Math.max(0, quota.limit - quota.used);
    quota.limit = quota.used;
  }

  /** Why the next attempt in this scope would be refused, or null when it may go out. */
  #refusalFor(pass: SearchPlanPass, provider: string | null, consumePool: boolean): SearchPlanRefusal | null {
    if (this.timeExhausted()) return 'time';
    if (this.attempts >= this.envelope.maxRequests) return 'request';
    if (pass.used >= pass.limit) return 'request';
    if (provider !== null && pass.quotas !== null) {
      // A provider with no share of its own (it did not answer the literal pass) may only use what
      // finished providers gave back; it never takes another provider's share.
      const quota = pass.quotas.get(provider);
      if (quota === undefined || quota.used >= quota.limit) {
        if (pass.pool <= 0) return 'request';
        if (consumePool) {
          pass.pool -= 1;
          if (quota === undefined) pass.quotas.set(provider, { limit: 1, used: 0, done: false });
          else quota.limit += 1;
        }
      }
    }
    return null;
  }

  #refuse(scope: PlanScope, kind: SearchPlanRefusal, firstContact: boolean): SearchPlanBudgetError {
    const { pass, call } = scope;
    pass.refused ??= kind;
    this.firstRefusal ??= kind;
    if (call.refused === null) {
      call.refused = kind;
      if (call.attempts === 0 && firstContact) {
        this.refusedCalls += 1;
        scope.record({ kind: 'unsent_call', refusal: kind });
      } else {
        this.refusedFollowUps += 1;
        scope.record({ kind: 'refused_follow_up', refusal: kind });
      }
    }
    return new SearchPlanBudgetError(kind, call.attempts > 0);
  }

  /** The admission decision for one physical attempt. Throws to refuse; charges every counter otherwise. */
  public admit(scope: PlanScope, meta: { retryIndex: number; redirectIndex: number }): AbortSignal {
    const firstContact = meta.retryIndex === 0 && meta.redirectIndex === 0;
    // A call already cut by the deadline race may wake up later; it must not reach the network.
    if (scope.call.refused !== null) throw new SearchPlanBudgetError(scope.call.refused, scope.call.attempts > 0);
    const refusal = this.#refusalFor(scope.pass, scope.provider, true);
    if (refusal !== null) throw this.#refuse(scope, refusal, firstContact);
    this.attempts += 1;
    if (scope.pass.id === 'literal') this.literalAttempts += 1;
    else this.variantAttempts += 1;
    scope.pass.used += 1;
    if (scope.provider !== null) {
      const quota = scope.pass.quotas?.get(scope.provider);
      if (quota !== undefined) quota.used += 1;
    }
    if (scope.call.attempts === 0) scope.record({ kind: 'sent_call' });
    scope.call.attempts += 1;
    return this.#deadline.signal;
  }

  /**
   * An `AtsHttpClient` whose every call is charged to this ledger, inside `pass`, for `provider`.
   * A call the ledger would refuse anyway is refused before it is even handed to the transport (no DNS
   * lookup either), and every call returns no later than the shared deadline.
   */
  public client(http: AtsHttpClient, pass: SearchPlanPass, provider: DiscoveryProvider | string | null): AtsHttpClient {
    const run = <T extends AtsHttpResponse>(invoke: () => Promise<T>): Promise<T> => {
      const call: CallState = { attempts: 0, refused: null };
      const scope: PlanScope = { ledger: this, pass, provider, call, record: currentPlanAdmissionRecorder() };
      const early = this.#refusalFor(pass, provider, false);
      if (early !== null) return Promise.reject(this.#refuse(scope, early, true));
      return planScope.run(scope, async () => {
        const pending = invoke();
        const outcome = await this.#beforeDeadline(pending, scope);
        // A completed request the transport never reported means the envelope was not enforced.
        if (call.attempts === 0) throw new SearchPlanTransportError();
        return outcome;
      });
    };
    return {
      get: (url: string, options?: AtsHttpRequestOptions) =>
        run(() => (options === undefined ? http.get(url) : http.get(url, options))),
      postJson: (url: string, body: unknown, options?: AtsHttpRequestOptions) =>
        run(() => (options === undefined ? http.postJson(url, body) : http.postJson(url, body, options))),
      ...(http.postForm === undefined
        ? {}
        : {
            postForm: (url: string, fields: Readonly<Record<string, string>>, options?: AtsHttpRequestOptions) => {
              const post = http.postForm;
              if (post === undefined) return Promise.reject(new Error('postForm is unavailable'));
              return run(() => (options === undefined ? post.call(http, url, fields) : post.call(http, url, fields, options)));
            },
          }),
    };
  }

  /** Settles at the deadline at the latest; the transport's own promise is left to fail quietly. */
  #beforeDeadline<T>(pending: Promise<T>, scope: PlanScope): Promise<T> {
    pending.catch(() => undefined);
    const signal = this.#deadline.signal;
    if (signal.aborted) return Promise.reject(this.#refuse(scope, 'time', true));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.#refuse(scope, 'time', true));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
}
