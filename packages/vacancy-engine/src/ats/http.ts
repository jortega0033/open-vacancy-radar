export type AtsHttpResponse = {
  readonly status: number;
  readonly finalUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type AtsHttpRequestOptions = {
  allowedOrigins?: readonly string[];
  headers?: HeadersInit;
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
