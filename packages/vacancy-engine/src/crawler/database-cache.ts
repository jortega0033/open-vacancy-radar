import { createHash } from 'node:crypto';

import { eq, lt } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { httpCache } from '../db/schema.js';
import type { CachedHttpResponse, HttpCache } from './http-cache.js';

function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

export class DatabaseHttpCache implements HttpCache {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public async get(url: string): Promise<CachedHttpResponse | undefined> {
    const [row] = await this.#database
      .select()
      .from(httpCache)
      .where(eq(httpCache.cacheKey, cacheKey(url)))
      .limit(1);
    if (row?.url !== url) return undefined;
    return {
      finalUrl: row.finalUrl,
      status: row.status,
      headers: row.responseHeaders,
      body: Uint8Array.from(Buffer.from(row.body, 'base64')),
      ...(row.etag === null ? {} : { etag: row.etag }),
      ...(row.lastModified === null ? {} : { lastModified: row.lastModified }),
      fetchedAt: row.fetchedAt,
    };
  }

  public async set(url: string, response: CachedHttpResponse): Promise<void> {
    const body = Buffer.from(response.body);
    const values = {
      cacheKey: cacheKey(url),
      url,
      finalUrl: response.finalUrl,
      status: response.status,
      contentType: response.headers['content-type'] ?? null,
      responseHeaders: { ...response.headers },
      etag: response.etag ?? null,
      lastModified: response.lastModified ?? null,
      body: body.toString('base64'),
      bodyHash: createHash('sha256').update(body).digest('hex'),
      fetchedAt: response.fetchedAt,
      expiresAt: null,
    };
    await this.#database
      .insert(httpCache)
      .values(values)
      .onConflictDoUpdate({ target: httpCache.cacheKey, set: values });
  }
}

export async function pruneHttpCache(database: Database, olderThan: Date): Promise<number> {
  if (Number.isNaN(olderThan.valueOf())) throw new RangeError('HTTP cache cutoff is invalid');
  const removed = await database
    .delete(httpCache)
    .where(lt(httpCache.fetchedAt, olderThan))
    .returning({ cacheKey: httpCache.cacheKey });
  return removed.length;
}
