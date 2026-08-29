import type { AtsHttpClient, AtsHttpResponse } from '../ats/http.js';
import type { AppConfig } from '../config.js';
import { DatabaseHttpCache } from '../crawler/database-cache.js';
import {
  createSafeHttpClient,
  type SafeHttpClient,
  type SafeHttpClientDependencies,
  type SafeHttpResponse,
} from '../crawler/http-client.js';
import type { Database } from '../db/client.js';

export type AtsHttpSafeClient = Pick<SafeHttpClient, 'get' | 'postJson'>;

export type DatabaseBackedAtsHttpClientDependencies = Omit<
  SafeHttpClientDependencies,
  'cache'
>;

function toAtsResponse(response: SafeHttpResponse): AtsHttpResponse {
  return {
    status: response.status,
    finalUrl: response.url,
    headers: response.headers,
    body: response.text(),
  };
}

/** Adapts the shared safety-policy client to the deliberately small ATS seam. */
export function createAtsHttpClient(httpClient: AtsHttpSafeClient): AtsHttpClient {
  return {
    async get(url, options) {
      return toAtsResponse(
        await (options === undefined ? httpClient.get(url) : httpClient.get(url, options)),
      );
    },
    async postJson(url, body, options) {
      return toAtsResponse(
        await (options === undefined
          ? httpClient.postJson(url, body)
          : httpClient.postJson(url, body, options)),
      );
    },
  };
}

/** Production composition root: shared safety policy plus persistent DB cache. */
export function createDatabaseBackedAtsHttpClient(
  config: Pick<
    AppConfig,
    | 'globalConcurrency'
    | 'perDomainConcurrency'
    | 'requestTimeoutMs'
    | 'requestQueueTimeoutMs'
    | 'maxResponseBytes'
    | 'maxRetries'
    | 'userAgent'
  >,
  database: Database,
  dependencies: DatabaseBackedAtsHttpClientDependencies = {},
): AtsHttpClient {
  const safeClient = createSafeHttpClient(config, {
    ...dependencies,
    cache: new DatabaseHttpCache(database),
  });
  return createAtsHttpClient(safeClient);
}
