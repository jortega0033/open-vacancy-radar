import type { AppConfig } from '../config.js';
import { CrawlerHttpError, isCrawlerHttpError, redactUrl } from './errors.js';
import type { CachedHttpResponse, HttpCache } from './http-cache.js';
import { RequestScheduler } from './scheduler.js';
import { type DnsResolver, systemDnsResolver, validatePublicHttpUrl } from './url-safety.js';

const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504]);
const BLOCKED_HTTP_STATUSES = new Set([401, 403, 406, 407, 451]);
const REDIRECT_HTTP_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REQUEST_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-subscription-token',
];
const SENSITIVE_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
]);
const TIMEOUT_ERROR = new Error('crawler request timeout');
const CACHE_TIMEOUT_ERROR = Object.assign(new Error('crawler cache operation timeout'), {
  name: 'CacheTimeoutError',
});
const ABSOLUTE_MAX_STREAM_TIMEOUT_MS = 15 * 60 * 1_000;
const ABSOLUTE_MAX_STREAM_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024;

export type CacheErrorOperation = 'get' | 'set';

export type SafeHttpClientDependencies = {
  scheduler?: RequestScheduler;
  cache?: HttpCache;
  resolver?: DnsResolver;
  fetchFn?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Bounded independently because large, known public bulk feeds may use a slower persistent cache. */
  cacheTimeoutMs?: number;
  /** Constructor-owned ceiling for exceptional streamed transfers. */
  maxStreamTimeoutMs?: number;
  /** Constructor-owned decoded-body ceiling for exceptional streamed transfers. */
  maxStreamResponseBytes?: number;
  onCacheError?: (error: unknown, operation: CacheErrorOperation, safeUrl: string) => void;
  onNetworkRequest?: (safeUrl: string) => void;
};

export type SafeHttpClientOptions = SafeHttpClientDependencies & {
  globalConcurrency: number;
  perDomainConcurrency: number;
  timeoutMs: number;
  queueTimeoutMs?: number;
  maxRetries: number;
  userAgent: string;
  maxRedirects?: number;
  maxResponseBytes?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRetryAfterMs?: number;
};

export type SafeHttpGetOptions = {
  headers?: HeadersInit;
  /** Optional per-request boundary; redirects outside these origins are not followed. */
  allowedOrigins?: readonly string[];
};

export type SafeHttpStreamGetOptions = SafeHttpGetOptions & {
  /** Whole-operation deadline, including DNS, queueing, redirects, retries, and body consumption. */
  timeoutMs: number;
  /** Hard decoded-body limit. Required so bulk transfers are always explicitly bounded. */
  maxResponseBytes: number;
  /** May only reduce the constructor retry policy; use zero for feeds with long server cooldowns. */
  maxRetries?: number;
  /** Called synchronously while the scheduler slot is held. Throwing cancels the response body. */
  onChunk: (chunk: Uint8Array, signal: AbortSignal) => void;
};

export type SafeHttpStreamResponse = {
  requestedUrl: string;
  url: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  bytesRead: number;
};

export type SafeHttpPostJsonOptions = SafeHttpGetOptions;

type SafeHttpMethod = 'GET' | 'POST';

export type SafeHttpResponseInit = {
  requestedUrl: string;
  url: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  fromCache: boolean;
  revalidated: boolean;
};

export class SafeHttpResponse {
  public readonly requestedUrl: string;
  public readonly url: string;
  public readonly status: number;
  public readonly headers: Readonly<Record<string, string>>;
  public readonly body: Uint8Array;
  public readonly fromCache: boolean;
  public readonly revalidated: boolean;

  public constructor(init: SafeHttpResponseInit) {
    this.requestedUrl = init.requestedUrl;
    this.url = init.url;
    this.status = init.status;
    this.headers = Object.freeze({ ...init.headers });
    this.body = init.body;
    this.fromCache = init.fromCache;
    this.revalidated = init.revalidated;
  }

  public text(): string {
    return new TextDecoder().decode(this.body);
  }

  public json(): unknown {
    return JSON.parse(this.text()) as unknown;
  }
}

type HopResult<TBody> =
  | { kind: 'redirect'; status: number; location: string }
  | {
      kind: 'retryable';
      status: number;
      retryDelayMs: number;
      serverRetryAfterMs?: number;
      cooldownUntil?: number;
    }
  | { kind: 'not_modified'; url: string; headers: Readonly<Record<string, string>> }
  | {
      kind: 'success';
      url: string;
      status: number;
      headers: Readonly<Record<string, string>>;
      body: TBody;
    }
  | { kind: 'error'; status: number };

type AttemptResult<TBody> = Exclude<HopResult<TBody>, { kind: 'redirect' }>;
type DeferredHop = { kind: 'deferred'; until: number; status: number };
type ResponseBodyReader<TBody> = (
  response: Response,
  requestUrl: URL,
  controller: AbortController,
) => Promise<TBody>;

class StreamConsumerError extends Error {
  public readonly consumerCause: unknown;

  public constructor(cause: unknown) {
    super('stream consumer failed');
    this.consumerCause = cause;
  }
}

function positiveInteger(value: number, name: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return value;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  positiveInteger(value, name);
  if (value > maximum) {
    throw new RangeError(`${name} must not exceed ${maximum}`);
  }
  return value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function headersToRecord(headers: Headers): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!SENSITIVE_RESPONSE_HEADERS.has(key.toLowerCase())) record[key.toLowerCase()] = value;
  });
  return record;
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort.
  }
}

async function rejectOversizedDeclaredBody(
  response: Response,
  maxResponseBytes: number,
  requestUrl: URL,
  controller: AbortController,
): Promise<void> {
  const contentLength = response.headers.get('content-length');
  if (contentLength === null || !/^\d+$/u.test(contentLength)) return;
  const declaredSize = Number(contentLength);
  if (declaredSize <= maxResponseBytes) return;
  controller.abort();
  await discardResponse(response);
  throw new CrawlerHttpError({
    category: 'http_error',
    code: 'response_too_large',
    url: requestUrl,
    detail: `Response exceeds the ${maxResponseBytes}-byte limit`,
    status: response.status,
  });
}

async function readBoundedBody(
  response: Response,
  maxResponseBytes: number,
  requestUrl: URL,
  controller: AbortController,
): Promise<Uint8Array> {
  await rejectOversizedDeclaredBody(response, maxResponseBytes, requestUrl, controller);

  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // Aborting the request may already have errored the stream.
        }
        throw new CrawlerHttpError({
          category: 'http_error',
          code: 'response_too_large',
          url: requestUrl,
          detail: `Response exceeds the ${maxResponseBytes}-byte limit`,
          status: response.status,
        });
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function consumeBoundedBody(
  response: Response,
  maxResponseBytes: number,
  requestUrl: URL,
  controller: AbortController,
  onChunk: SafeHttpStreamGetOptions['onChunk'],
): Promise<number> {
  await rejectOversizedDeclaredBody(response, maxResponseBytes, requestUrl, controller);
  if (response.body === null) return 0;

  const reader = response.body.getReader();
  let totalBytes = 0;
  const cancelReader = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // Aborting or a consumer failure may already have errored the stream.
    }
  };
  const abortListener = (): void => {
    void cancelReader();
  };
  controller.signal.addEventListener('abort', abortListener, { once: true });

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxResponseBytes) {
        throw new CrawlerHttpError({
          category: 'http_error',
          code: 'response_too_large',
          url: requestUrl,
          detail: `Response exceeds the ${maxResponseBytes}-byte limit`,
          status: response.status,
        });
      }
      try {
        const callbackResult: unknown = onChunk(chunk.value, controller.signal);
        if (isThenable(callbackResult)) {
          void Promise.resolve(callbackResult).catch(() => undefined);
          throw new TypeError('stream onChunk callback must be synchronous');
        }
      } catch (error) {
        throw new StreamConsumerError(error);
      }
    }
    return totalBytes;
  } catch (error) {
    controller.abort();
    await cancelReader();
    throw error;
  } finally {
    controller.signal.removeEventListener('abort', abortListener);
    reader.releaseLock();
  }
}

function parsedRetryAfter(rawValue: string | null, now: number): number | undefined {
  if (rawValue === null) return undefined;
  const trimmed = rawValue.trim();
  let milliseconds: number;
  if (/^\d+$/u.test(trimmed)) {
    milliseconds = Number(trimmed) * 1_000;
  } else {
    const date = Date.parse(trimmed);
    if (!Number.isFinite(date)) return undefined;
    milliseconds = Math.max(0, date - now);
  }
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function retryAfterDelay(rawValue: string | null, now: number, capMs: number): number | undefined {
  const milliseconds = parsedRetryAfter(rawValue, now);
  return milliseconds === undefined ? undefined : Math.min(capMs, milliseconds);
}

function cachedFinalUrl(cacheEntry: CachedHttpResponse | undefined): string | undefined {
  if (cacheEntry === undefined) return undefined;
  try {
    const url = new URL(cacheEntry.finalUrl);
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function normalizeAllowedOrigins(
  values: readonly string[] | undefined,
): ReadonlySet<string> | null {
  if (values === undefined) return null;
  if (values.length === 0) throw new RangeError('allowedOrigins must not be empty');
  const origins = new Set<string>();
  for (const value of values) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      throw new RangeError('allowedOrigins entries must be credential-free HTTP(S) URLs');
    }
    origins.add(url.origin);
  }
  return origins;
}

export class SafeHttpClient {
  readonly #scheduler: RequestScheduler;
  readonly #cache: HttpCache | undefined;
  readonly #resolver: DnsResolver;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #onCacheError: SafeHttpClientDependencies['onCacheError'];
  readonly #onNetworkRequest: SafeHttpClientDependencies['onNetworkRequest'];
  readonly #timeoutMs: number;
  readonly #queueTimeoutMs: number;
  readonly #cacheTimeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxRedirects: number;
  readonly #maxResponseBytes: number;
  readonly #maxStreamTimeoutMs: number;
  readonly #maxStreamResponseBytes: number;
  readonly #baseRetryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #maxRetryAfterMs: number;
  readonly #userAgent: string;
  readonly #domainCooldownUntil = new Map<string, { until: number; status: number }>();

  public constructor(options: SafeHttpClientOptions) {
    this.#scheduler =
      options.scheduler ??
      new RequestScheduler(options.globalConcurrency, options.perDomainConcurrency);
    this.#cache = options.cache;
    this.#resolver = options.resolver ?? systemDnsResolver;
    this.#fetch = options.fetchFn ?? globalThis.fetch;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#onCacheError = options.onCacheError;
    this.#onNetworkRequest = options.onNetworkRequest;
    this.#timeoutMs = positiveInteger(options.timeoutMs, 'timeoutMs');
    this.#queueTimeoutMs = positiveInteger(
      options.queueTimeoutMs ?? options.timeoutMs,
      'queueTimeoutMs',
    );
    this.#cacheTimeoutMs = positiveInteger(
      options.cacheTimeoutMs ?? Math.max(50, Math.min(5_000, Math.floor(options.timeoutMs / 3))),
      'cacheTimeoutMs',
    );
    this.#maxRetries = positiveInteger(options.maxRetries, 'maxRetries', true);
    this.#maxRedirects = positiveInteger(options.maxRedirects ?? 5, 'maxRedirects', true);
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? 5 * 1024 * 1024,
      'maxResponseBytes',
    );
    this.#maxStreamTimeoutMs = boundedPositiveInteger(
      options.maxStreamTimeoutMs ?? Math.min(this.#timeoutMs, ABSOLUTE_MAX_STREAM_TIMEOUT_MS),
      'maxStreamTimeoutMs',
      ABSOLUTE_MAX_STREAM_TIMEOUT_MS,
    );
    this.#maxStreamResponseBytes = boundedPositiveInteger(
      options.maxStreamResponseBytes ??
        Math.min(this.#maxResponseBytes, ABSOLUTE_MAX_STREAM_RESPONSE_BYTES),
      'maxStreamResponseBytes',
      ABSOLUTE_MAX_STREAM_RESPONSE_BYTES,
    );
    this.#baseRetryDelayMs = positiveInteger(options.baseRetryDelayMs ?? 500, 'baseRetryDelayMs');
    this.#maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs ?? 15_000, 'maxRetryDelayMs');
    this.#maxRetryAfterMs = positiveInteger(options.maxRetryAfterMs ?? 60_000, 'maxRetryAfterMs');
    const userAgent = options.userAgent.trim();
    if (userAgent.length < 10) throw new RangeError('userAgent must be descriptive');
    this.#userAgent = userAgent;
  }

  public async get(
    input: string | URL,
    options: SafeHttpGetOptions = {},
  ): Promise<SafeHttpResponse> {
    return this.#request(input, 'GET', undefined, options, true);
  }

  /**
   * Streams an uncached GET through the same URL, redirect, scheduling, retry, and status policy
   * as buffered requests. A 304 is returned to the caller because this path never owns raw-body
   * cache state. The scheduler slot remains held until every chunk callback completes.
   */
  public async streamGet(
    input: string | URL,
    options: SafeHttpStreamGetOptions,
  ): Promise<SafeHttpStreamResponse> {
    const timeoutMs = boundedPositiveInteger(
      options.timeoutMs,
      'timeoutMs',
      this.#maxStreamTimeoutMs,
    );
    const maxResponseBytes = boundedPositiveInteger(
      options.maxResponseBytes,
      'maxResponseBytes',
      this.#maxStreamResponseBytes,
    );
    const maxRetries = positiveInteger(options.maxRetries ?? this.#maxRetries, 'maxRetries', true);
    if (maxRetries > this.#maxRetries) {
      throw new RangeError(`maxRetries must not exceed ${this.#maxRetries}`);
    }
    const deadline = this.#now() + timeoutMs;
    const requestedUrl = await this.#awaitBeforeDeadline(
      validatePublicHttpUrl(input, this.#resolver),
      deadline,
      input,
      timeoutMs,
    );
    const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
    if (allowedOrigins !== null && !allowedOrigins.has(requestedUrl.origin)) {
      throw new CrawlerHttpError({
        category: 'unsafe_url',
        code: 'disallowed_redirect_origin',
        url: requestedUrl,
        detail: 'Request URL is outside the configured origin boundary',
      });
    }

    const result = await this.#executeWithRetries(
      requestedUrl,
      options.headers,
      undefined,
      deadline,
      allowedOrigins,
      'GET',
      undefined,
      async (response, requestUrl, controller) => {
        if (response.status !== 200) {
          await discardResponse(response);
          throw this.#statusError(requestUrl, response.status);
        }
        return consumeBoundedBody(
          response,
          maxResponseBytes,
          requestUrl,
          controller,
          options.onChunk,
        );
      },
      timeoutMs,
      maxRetries,
    );

    if (result.kind === 'not_modified') {
      return {
        requestedUrl: requestedUrl.href,
        url: result.url,
        status: 304,
        headers: result.headers,
        bytesRead: 0,
      };
    }
    return {
      requestedUrl: requestedUrl.href,
      url: result.url,
      status: result.status,
      headers: result.headers,
      bytesRead: result.body,
    };
  }

  /**
   * Executes an idempotent, read-only JSON query. This exists for public ATS
   * listing contracts such as Workday CXS; it must not be used for mutations.
   * POST responses bypass the conditional GET cache because replaying a cached
   * POST response without a validator would hide upstream vacancy changes.
   */
  public async postJson(
    input: string | URL,
    body: unknown,
    options: SafeHttpPostJsonOptions = {},
  ): Promise<SafeHttpResponse> {
    let serializedBody: string;
    try {
      const serialized = JSON.stringify(body) as string | undefined;
      if (typeof serialized !== 'string') throw new TypeError('JSON body is not serializable');
      serializedBody = serialized;
    } catch (error) {
      throw new TypeError('JSON body is not serializable', { cause: error });
    }
    const headers = new Headers(options.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', headers.get('accept') ?? 'application/json');
    return this.#request(input, 'POST', serializedBody, { ...options, headers }, false);
  }

  async #request(
    input: string | URL,
    method: SafeHttpMethod,
    requestBody: string | undefined,
    options: SafeHttpGetOptions,
    useCache: boolean,
  ): Promise<SafeHttpResponse> {
    const preflightDeadline = this.#now() + this.#timeoutMs;
    const requestedUrl = await this.#awaitBeforeDeadline(
      validatePublicHttpUrl(input, this.#resolver),
      preflightDeadline,
      input,
    );
    const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
    if (allowedOrigins !== null && !allowedOrigins.has(requestedUrl.origin)) {
      throw new CrawlerHttpError({
        category: 'unsafe_url',
        code: 'disallowed_redirect_origin',
        url: requestedUrl,
        detail: 'Request URL is outside the configured origin boundary',
      });
    }
    const requestKey = requestedUrl.href;
    const cached = useCache ? await this.#readCache(requestKey) : undefined;
    const deadline = this.#now() + this.#queueTimeoutMs;

    const result = await this.#executeWithRetries(
      requestedUrl,
      options.headers,
      cached,
      deadline,
      allowedOrigins,
      method,
      requestBody,
      (response, requestUrl, controller) =>
        readBoundedBody(response, this.#maxResponseBytes, requestUrl, controller),
      this.#timeoutMs,
    );

    if (result.kind === 'not_modified') {
      const reusable =
        cached !== undefined && cachedFinalUrl(cached) === result.url ? cached : undefined;
      if (reusable === undefined) {
        throw new CrawlerHttpError({
          category: 'http_error',
          code: 'unexpected_not_modified',
          url: result.url,
          detail: 'Received 304 without a reusable cached response',
          status: 304,
        });
      }
      const refreshed = this.#refreshCachedEntry(reusable, result);
      if (useCache) await this.#writeCache(requestKey, refreshed);
      return this.#responseFromCache(requestKey, refreshed);
    }

    const cacheEntry = this.#cacheEntryFromSuccess(result);
    if (useCache) await this.#writeCache(requestKey, cacheEntry);
    return new SafeHttpResponse({
      requestedUrl: requestKey,
      url: result.url,
      status: result.status,
      headers: result.headers,
      body: result.body,
      fromCache: false,
      revalidated: false,
    });
  }

  async #executeWithRetries<TBody>(
    requestedUrl: URL,
    inputHeaders: HeadersInit | undefined,
    cached: CachedHttpResponse | undefined,
    deadline: number,
    allowedOrigins: ReadonlySet<string> | null,
    method: SafeHttpMethod,
    requestBody: string | undefined,
    readBody: ResponseBodyReader<TBody>,
    requestTimeoutMs: number,
    maxRetries = this.#maxRetries,
  ): Promise<Exclude<AttemptResult<TBody>, { kind: 'retryable' } | { kind: 'error' }>> {
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      const initialUrl =
        retry === 0
          ? requestedUrl
          : await this.#awaitBeforeDeadline(
              validatePublicHttpUrl(requestedUrl, this.#resolver),
              Math.min(deadline, this.#now() + requestTimeoutMs),
              requestedUrl,
              requestTimeoutMs,
            );
      const result = await this.#executeAttempt(
        initialUrl,
        inputHeaders,
        cached,
        deadline,
        retry,
        allowedOrigins,
        method,
        requestBody,
        readBody,
        requestTimeoutMs,
      );

      if (result.kind === 'retryable') {
        if (retry < maxRetries) {
          if (result.retryDelayMs >= deadline - this.#now()) {
            throw this.#statusError(requestedUrl, result.status, result.serverRetryAfterMs);
          }
          await this.#sleepBeforeDeadline(
            result.retryDelayMs,
            deadline,
            requestedUrl,
            requestTimeoutMs,
          );
          if (
            result.cooldownUntil !== undefined &&
            this.#domainCooldownUntil.get(requestedUrl.hostname)?.until === result.cooldownUntil
          ) {
            this.#domainCooldownUntil.delete(requestedUrl.hostname);
          }
          continue;
        }
        throw this.#statusError(requestedUrl, result.status, result.serverRetryAfterMs);
      }

      if (result.kind === 'error') throw this.#statusError(requestedUrl, result.status);
      return result;
    }

    throw new Error('Unreachable retry state');
  }

  async #executeAttempt<TBody>(
    initialUrl: URL,
    inputHeaders: HeadersInit | undefined,
    cached: CachedHttpResponse | undefined,
    deadline: number,
    retryIndex: number,
    allowedOrigins: ReadonlySet<string> | null,
    method: SafeHttpMethod,
    requestBody: string | undefined,
    readBody: ResponseBodyReader<TBody>,
    requestTimeoutMs: number,
  ): Promise<AttemptResult<TBody>> {
    let currentUrl = initialUrl;
    let redirectCount = 0;
    const redirectHeaders = new Headers(inputHeaders);
    redirectHeaders.set(
      'accept',
      redirectHeaders.get('accept') ?? 'application/json,text/html;q=0.9,*/*;q=0.8',
    );
    redirectHeaders.set('user-agent', this.#userAgent);
    const expectedCachedUrl = cachedFinalUrl(cached);

    for (;;) {
      const hopHeaders = new Headers(redirectHeaders);
      if (cached !== undefined && expectedCachedUrl === currentUrl.href) {
        if (cached.etag !== undefined) hopHeaders.set('if-none-match', cached.etag);
        if (cached.lastModified !== undefined) {
          hopHeaders.set('if-modified-since', cached.lastModified);
        }
      }

      const result = await this.#networkHop(
        currentUrl,
        hopHeaders,
        deadline,
        retryIndex,
        method,
        requestBody,
        readBody,
        requestTimeoutMs,
      );
      if (result.kind !== 'redirect') return result;

      if (method === 'POST' && result.status !== 307 && result.status !== 308) {
        throw new CrawlerHttpError({
          category: 'http_error',
          code: 'post_redirect_not_preserved',
          url: currentUrl,
          detail: 'Read-only JSON POST received a redirect that would change its method',
          status: result.status,
        });
      }

      if (redirectCount >= this.#maxRedirects) {
        throw new CrawlerHttpError({
          category: 'http_error',
          code: 'redirect_limit',
          url: currentUrl,
          detail: `Redirect limit of ${this.#maxRedirects} exceeded`,
          status: result.status,
        });
      }

      let redirectTarget: URL;
      try {
        redirectTarget = new URL(result.location, currentUrl);
      } catch {
        throw new CrawlerHttpError({
          category: 'http_error',
          code: 'invalid_redirect',
          url: currentUrl,
          detail: 'Redirect response contains an invalid Location header',
          status: result.status,
        });
      }

      if (allowedOrigins !== null && !allowedOrigins.has(redirectTarget.origin)) {
        throw new CrawlerHttpError({
          category: 'unsafe_url',
          code: 'disallowed_redirect_origin',
          url: redirectTarget,
          detail: 'Redirect target is outside the configured origin boundary',
          status: result.status,
        });
      }

      const validatedTarget = await this.#awaitBeforeDeadline(
        validatePublicHttpUrl(redirectTarget, this.#resolver),
        Math.min(deadline, this.#now() + requestTimeoutMs),
        redirectTarget,
        requestTimeoutMs,
      );
      if (validatedTarget.origin !== currentUrl.origin) {
        for (const header of SENSITIVE_REQUEST_HEADERS) redirectHeaders.delete(header);
      }
      currentUrl = validatedTarget;
      redirectCount += 1;
    }
  }

  async #networkHop<TBody>(
    url: URL,
    headers: Headers,
    deadline: number,
    retryIndex: number,
    method: SafeHttpMethod,
    requestBody: string | undefined,
    readBody: ResponseBodyReader<TBody>,
    requestTimeoutMs: number,
  ): Promise<HopResult<TBody>> {
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    for (;;) {
      const scheduled = this.#scheduler.run<HopResult<TBody> | DeferredHop>(hostname, async () => {
        const cooldown = this.#domainCooldownUntil.get(hostname);
        if (cooldown !== undefined) {
          if (cooldown.until > this.#now()) {
            return { kind: 'deferred', until: cooldown.until, status: cooldown.status };
          }
          if (this.#domainCooldownUntil.get(hostname)?.until === cooldown.until) {
            this.#domainCooldownUntil.delete(hostname);
          }
        }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const remainingMs = Math.min(deadline - this.#now(), requestTimeoutMs);
        if (remainingMs <= 0) throw this.#timeoutError(url, requestTimeoutMs);
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(TIMEOUT_ERROR);
            controller.abort();
          }, remainingMs);
        });

        const operation = (async (): Promise<HopResult<TBody>> => {
          try {
            this.#onNetworkRequest?.(redactUrl(url));
          } catch {
            // Telemetry must not make a source request fail.
          }
          const response = await this.#fetch(url, {
            method,
            headers,
            ...(requestBody === undefined ? {} : { body: requestBody }),
            redirect: 'manual',
            signal: controller.signal,
          });

          if (REDIRECT_HTTP_STATUSES.has(response.status)) {
            const location = response.headers.get('location');
            await discardResponse(response);
            if (location === null || location.trim().length === 0) {
              throw new CrawlerHttpError({
                category: 'http_error',
                code: 'invalid_redirect',
                url,
                detail: 'Redirect response is missing a Location header',
                status: response.status,
              });
            }
            return { kind: 'redirect', status: response.status, location };
          }

          if (response.status === 304) {
            const responseHeaders = headersToRecord(response.headers);
            await discardResponse(response);
            return { kind: 'not_modified', url: url.href, headers: responseHeaders };
          }

          if (response.status === 429 || TRANSIENT_HTTP_STATUSES.has(response.status)) {
            const retryAfter = response.headers.get('retry-after');
            const serverRetryAfterMs = parsedRetryAfter(retryAfter, this.#now());
            const explicitRetryDelayMs = retryAfterDelay(
              retryAfter,
              this.#now(),
              this.#maxRetryAfterMs,
            );
            const retryDelayMs = explicitRetryDelayMs ?? this.#retryDelay(null, retryIndex);
            let cooldownUntil: number | undefined;
            if (response.status === 429 || explicitRetryDelayMs !== undefined) {
              cooldownUntil = this.#now() + retryDelayMs;
              const existingCooldown = this.#domainCooldownUntil.get(hostname);
              if (existingCooldown === undefined || existingCooldown.until <= cooldownUntil) {
                this.#domainCooldownUntil.set(hostname, {
                  until: cooldownUntil,
                  status: response.status,
                });
              }
            }
            await discardResponse(response);
            return {
              kind: 'retryable',
              status: response.status,
              retryDelayMs,
              ...(serverRetryAfterMs === undefined ? {} : { serverRetryAfterMs }),
              ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
            };
          }

          if (!response.ok) {
            const status = response.status;
            await discardResponse(response);
            return { kind: 'error', status };
          }

          const responseHeaders = headersToRecord(response.headers);
          const responseBody = await readBody(response, url, controller);
          return {
            kind: 'success',
            url: url.href,
            status: response.status,
            headers: responseHeaders,
            body: responseBody,
          };
        })();

        try {
          return await Promise.race([operation, timeout]);
        } catch (error) {
          if (error === TIMEOUT_ERROR) {
            throw this.#timeoutError(url, requestTimeoutMs);
          }
          if (error instanceof StreamConsumerError) throw error.consumerCause;
          if (isCrawlerHttpError(error)) throw error;
          throw new CrawlerHttpError({
            category: 'network_error',
            code: 'request_failed',
            url,
            detail: 'HTTP request failed',
          });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      });
      const result = await this.#awaitBeforeDeadline(scheduled, deadline, url, requestTimeoutMs);
      if (result.kind !== 'deferred') return result;
      const delayMs = result.until - this.#now();
      if (delayMs <= 0) continue;
      if (delayMs >= deadline - this.#now()) {
        throw this.#statusError(url, result.status);
      }
      await this.#sleepBeforeDeadline(delayMs, deadline, url, requestTimeoutMs);
    }
  }

  async #awaitBeforeDeadline<T>(
    operation: Promise<T>,
    deadline: number,
    url: string | URL,
    requestTimeoutMs = this.#timeoutMs,
  ): Promise<T> {
    const remainingMs = deadline - this.#now();
    if (remainingMs <= 0) throw this.#timeoutError(url, requestTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(TIMEOUT_ERROR), remainingMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error === TIMEOUT_ERROR) throw this.#timeoutError(url, requestTimeoutMs);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #sleepBeforeDeadline(
    requestedDelayMs: number,
    deadline: number,
    url: string | URL,
    requestTimeoutMs = this.#timeoutMs,
  ): Promise<void> {
    const remainingMs = deadline - this.#now();
    if (remainingMs <= 0) throw this.#timeoutError(url, requestTimeoutMs);
    const boundedDelayMs = Math.min(requestedDelayMs, remainingMs);
    await this.#sleep(boundedDelayMs);
    if (requestedDelayMs >= remainingMs || this.#now() >= deadline) {
      throw this.#timeoutError(url, requestTimeoutMs);
    }
  }

  #timeoutError(url: string | URL, requestTimeoutMs = this.#timeoutMs): CrawlerHttpError {
    return new CrawlerHttpError({
      category: 'timeout',
      code: 'request_timeout',
      url,
      detail: `Request timed out after ${requestTimeoutMs}ms`,
    });
  }

  #retryDelay(retryAfter: string | null, retryIndex: number): number {
    const fromHeader = retryAfterDelay(retryAfter, this.#now(), this.#maxRetryAfterMs);
    if (fromHeader !== undefined) return fromHeader;
    const exponential = Math.min(this.#maxRetryDelayMs, this.#baseRetryDelayMs * 2 ** retryIndex);
    const boundedRandom = Math.max(0, Math.min(1, this.#random()));
    return Math.round(exponential * (0.8 + boundedRandom * 0.4));
  }

  #statusError(url: URL, status: number, retryAfterMs?: number): CrawlerHttpError {
    if (status === 429) {
      return new CrawlerHttpError({
        category: 'rate_limited',
        code: 'rate_limited_status',
        url,
        detail: 'Remote server remained rate-limited after bounded retries',
        status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    if (BLOCKED_HTTP_STATUSES.has(status)) {
      return new CrawlerHttpError({
        category: 'blocked',
        code: 'blocked_status',
        url,
        detail: 'Remote server blocked or requires access',
        status,
      });
    }
    return new CrawlerHttpError({
      category: 'http_error',
      code: 'http_status',
      url,
      detail: `Remote server returned HTTP ${status}`,
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  async #readCache(url: string): Promise<CachedHttpResponse | undefined> {
    if (this.#cache === undefined) return undefined;
    try {
      return await this.#awaitCacheOperation(this.#cache.get(url));
    } catch (error) {
      this.#reportCacheError(error, 'get', url);
      return undefined;
    }
  }

  async #writeCache(url: string, entry: CachedHttpResponse): Promise<void> {
    if (this.#cache === undefined) return;
    try {
      await this.#awaitCacheOperation(this.#cache.set(url, entry));
    } catch (error) {
      this.#reportCacheError(error, 'set', url);
    }
  }

  #reportCacheError(error: unknown, operation: CacheErrorOperation, url: string): void {
    try {
      this.#onCacheError?.(error, operation, redactUrl(url));
    } catch {
      // Cache diagnostics must never make a source scan fail.
    }
  }

  async #awaitCacheOperation<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(CACHE_TIMEOUT_ERROR), this.#cacheTimeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #cacheEntryFromSuccess(
    result: Extract<AttemptResult<Uint8Array>, { kind: 'success' }>,
  ): CachedHttpResponse {
    const etag = result.headers.etag;
    const lastModified = result.headers['last-modified'];
    return {
      finalUrl: result.url,
      status: result.status,
      headers: result.headers,
      body: result.body,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
      fetchedAt: new Date(this.#now()),
    };
  }

  #refreshCachedEntry(
    cached: CachedHttpResponse,
    result: Extract<AttemptResult<Uint8Array>, { kind: 'not_modified' }>,
  ): CachedHttpResponse {
    const headers = { ...cached.headers, ...result.headers };
    const etag = result.headers.etag ?? cached.etag;
    const lastModified = result.headers['last-modified'] ?? cached.lastModified;
    return {
      finalUrl: result.url,
      status: cached.status,
      headers,
      body: cached.body,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
      fetchedAt: new Date(this.#now()),
    };
  }

  #responseFromCache(requestedUrl: string, cached: CachedHttpResponse): SafeHttpResponse {
    return new SafeHttpResponse({
      requestedUrl,
      url: cached.finalUrl,
      status: cached.status,
      headers: cached.headers,
      body: cached.body.slice(),
      fromCache: true,
      revalidated: true,
    });
  }
}

type HttpConfig = Pick<
  AppConfig,
  | 'globalConcurrency'
  | 'perDomainConcurrency'
  | 'requestTimeoutMs'
  | 'requestQueueTimeoutMs'
  | 'maxResponseBytes'
  | 'maxRetries'
  | 'userAgent'
>;

export function createSafeHttpClient(
  config: HttpConfig,
  dependencies: SafeHttpClientDependencies = {},
): SafeHttpClient {
  return new SafeHttpClient({
    globalConcurrency: config.globalConcurrency,
    perDomainConcurrency: config.perDomainConcurrency,
    timeoutMs: config.requestTimeoutMs,
    queueTimeoutMs: config.requestQueueTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxRetries: config.maxRetries,
    userAgent: config.userAgent,
    ...dependencies,
  });
}
