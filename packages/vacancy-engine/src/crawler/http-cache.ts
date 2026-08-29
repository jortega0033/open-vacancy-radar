export type CachedHttpResponse = {
  finalUrl: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  etag?: string;
  lastModified?: string;
  fetchedAt: Date;
};

/** Storage seam for a database- or filesystem-backed conditional HTTP cache. */
export type HttpCache = {
  get(url: string): Promise<CachedHttpResponse | undefined>;
  set(url: string, response: CachedHttpResponse): Promise<void>;
};

function cloneEntry(entry: CachedHttpResponse): CachedHttpResponse {
  return {
    finalUrl: entry.finalUrl,
    status: entry.status,
    headers: { ...entry.headers },
    body: entry.body.slice(),
    ...(entry.etag === undefined ? {} : { etag: entry.etag }),
    ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
    fetchedAt: new Date(entry.fetchedAt),
  };
}

/** Useful for tests and short-lived commands; production persistence is injected. */
export class MemoryHttpCache implements HttpCache {
  readonly #entries = new Map<string, CachedHttpResponse>();

  public get(url: string): Promise<CachedHttpResponse | undefined> {
    const entry = this.#entries.get(url);
    return Promise.resolve(entry === undefined ? undefined : cloneEntry(entry));
  }

  public set(url: string, response: CachedHttpResponse): Promise<void> {
    this.#entries.set(url, cloneEntry(response));
    return Promise.resolve();
  }
}
