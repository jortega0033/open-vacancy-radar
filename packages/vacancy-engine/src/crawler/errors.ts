export type CrawlerHttpErrorCategory =
  | 'network_error'
  | 'timeout'
  | 'blocked'
  | 'rate_limited'
  | 'unsafe_url'
  | 'http_error';

export type CrawlerHttpErrorCode =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'credentialed_url'
  | 'non_public_hostname'
  | 'private_address'
  | 'dns_resolution_failed'
  | 'request_timeout'
  | 'request_failed'
  | 'invalid_redirect'
  | 'post_redirect_not_preserved'
  | 'disallowed_redirect_origin'
  | 'redirect_limit'
  | 'response_too_large'
  | 'unexpected_not_modified'
  | 'blocked_status'
  | 'rate_limited_status'
  | 'http_status';

export type CrawlerHttpErrorOptions = {
  category: CrawlerHttpErrorCategory;
  code: CrawlerHttpErrorCode;
  url: string | URL;
  detail: string;
  status?: number;
  retryAfterMs?: number;
};

/**
 * Removes credentials, query values, fragments, and path values before a URL
 * is placed in an error or log record.
 */
export function redactUrl(input: string | URL): string {
  try {
    const url = input instanceof URL ? new URL(input.href) : new URL(input);
    const path = url.pathname === '/' || url.pathname === '' ? '/' : '/[REDACTED]';
    const query = url.search.length > 0 ? '?[REDACTED]' : '';
    return `${url.protocol}//${url.host}${path}${query}`;
  } catch {
    return '[invalid URL]';
  }
}

export class CrawlerHttpError extends Error {
  public readonly category: CrawlerHttpErrorCategory;
  public readonly code: CrawlerHttpErrorCode;
  public readonly safeUrl: string;
  public readonly status: number | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(options: CrawlerHttpErrorOptions) {
    const safeUrl = redactUrl(options.url);
    super(`${options.detail} (${safeUrl})`);
    this.name = 'CrawlerHttpError';
    this.category = options.category;
    this.code = options.code;
    this.safeUrl = safeUrl;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isCrawlerHttpError(error: unknown): error is CrawlerHttpError {
  return error instanceof CrawlerHttpError;
}

/** Returns log-safe cache diagnostics without serializing messages, SQL params, URLs, or bodies. */
export function safeErrorClassification(error: unknown): { errorType: string } {
  if (!(error instanceof Error)) return { errorType: typeof error };
  return {
    errorType: /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/u.test(error.name) ? error.name : 'Error',
  };
}
