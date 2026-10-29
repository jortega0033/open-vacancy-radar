export type AtsHttpResponse = {
  readonly status: number;
  readonly finalUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /**
   * True when the shared HTTP cache's stored validators (ETag / Last-Modified) were sent and the
   * origin answered 304, so `body` is the previously stored one confirmed unchanged now (#687).
   * Absent on seams that have no cache.
   */
  readonly revalidated?: boolean;
};

export type AtsHttpRequestOptions = {
  allowedOrigins?: readonly string[];
  headers?: HeadersInit;
  cache?: 'default' | 'no-store';
  /**
   * May only reduce the client's configured retry policy, never raise it. Adapters normally have no
   * business overriding it -- a scan runs unattended, so grinding through the full retry ladder is
   * exactly right there. This exists for the opposite case: an on-demand fetch made while a person
   * is sitting in front of a click path waiting for it, where a fast, honest failure beats a long
   * ladder of retries nobody is watching.
   */
  maxRetries?: number;
  /** May only reduce the client's redirect limit, never raise it (#687: a bounded posting check). */
  maxRedirects?: number;
  /**
   * Caller cancellation (#687). The shared SafeHttpClient stops DNS, a queued scheduler slot and the
   * in-flight fetch when it aborts; a seam with no network may ignore it.
   */
  signal?: AbortSignal;
};

/**
 * Deliberately small injection seam. Request policy, caching, retries, and
 * conditional headers belong to the crawler HTTP implementation, not adapters.
 */
export type AtsHttpClient = {
  get(url: string, options?: AtsHttpRequestOptions): Promise<AtsHttpResponse>;
  /** Read-only, idempotent JSON query for public ATS listing endpoints. */
  postJson(
    url: string,
    body: unknown,
    options?: AtsHttpRequestOptions,
  ): Promise<AtsHttpResponse>;
  /**
   * Read-only form-encoded query for public listings paginated by ASP.NET Web Forms postbacks.
   * Optional so existing seams keep working; an adapter that needs it must report a missing
   * implementation as a source failure.
   */
  postForm?(
    url: string,
    fields: Readonly<Record<string, string>>,
    options?: AtsHttpRequestOptions,
  ): Promise<AtsHttpResponse>;
};

export class AtsResponseError extends Error {
  public readonly provider: string;
  public readonly status: number | null;

  public constructor(
    provider: string,
    message: string,
    status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(`${provider}: ${message}`, options);
    this.name = 'AtsResponseError';
    this.provider = provider;
    this.status = status;
  }
}

export function requireSuccessfulResponse(provider: string, response: AtsHttpResponse): void {
  if (response.status < 200 || response.status >= 300) {
    throw new AtsResponseError(provider, `HTTP ${response.status}`, response.status);
  }
}
