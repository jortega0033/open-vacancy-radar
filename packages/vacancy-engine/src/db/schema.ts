import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * PostgreSQL `timestamptz` columns become millisecond-resolution SQLite
 * integers. `timestamp_ms` round-trips to and from native JS `Date` objects,
 * so every existing call site keeps working unchanged, and unlike second
 * resolution it preserves sub-second ordering. That precision is load bearing:
 * `mergeBraveCandidates` advances a catalog stamp by exactly one millisecond,
 * and the discovery/mapping regression guards compare those stamps with
 * `getTime()` equality against persisted values.
 */
const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });

/** Equivalent of PostgreSQL `defaultNow()` for a millisecond timestamp column. */
const nowMs = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

const uuidPrimaryKey = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());

export const indSponsors = sqliteTable(
  'ind_sponsors',
  {
    id: uuidPrimaryKey(),
    sourceIdentityKey: text('source_identity_key').notNull(),
    legalName: text('legal_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    searchName: text('search_name').notNull(),
    kvkNumber: text('kvk_number'),
    sourceUrl: text('source_url').notNull(),
    sourceRetrievedAt: timestampMs('source_retrieved_at').notNull(),
    // Calendar date in the source register. Stored the same way as the other
    // instants so `src/ind/repository.ts` and `src/ind/source.ts` keep reading
    // and writing native `Date` values (`toISOString().slice(0, 10)` and
    // `getTime()` comparisons) without any code change.
    sourceLastUpdated: timestampMs('source_last_updated'),
    firstSeenAt: timestampMs('first_seen_at').notNull().default(nowMs),
    lastSeenAt: timestampMs('last_seen_at').notNull().default(nowMs),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
  },
  (table) => [
    uniqueIndex('ind_sponsors_source_identity_unique').on(table.sourceIdentityKey),
    index('ind_sponsors_kvk_idx').on(table.kvkNumber),
    index('ind_sponsors_normalized_name_idx').on(table.normalizedName),
  ],
);

export const indSponsorSnapshots = sqliteTable(
  'ind_sponsor_snapshots',
  {
    id: uuidPrimaryKey(),
    sourceUrl: text('source_url').notNull(),
    sourceLastUpdated: timestampMs('source_last_updated').notNull(),
    retrievedAt: timestampMs('retrieved_at').notNull(),
    rawRowCount: integer('raw_row_count').notNull(),
    uniqueSponsorCount: integer('unique_sponsor_count').notNull(),
    duplicateRowCount: integer('duplicate_row_count').notNull(),
    membershipHash: text('membership_hash').notNull(),
    accepted: integer('accepted', { mode: 'boolean' }).notNull(),
    rejectionReason: text('rejection_reason'),
  },
  (table) => [index('ind_sponsor_snapshots_accepted_retrieved_idx').on(table.accepted, table.retrievedAt)],
);

/**
 * One row per employer name the worldwide sponsor check has already asked Wikidata about, so a
 * scan only ever spends its (very small) Wikidata budget on employers it has never resolved.
 *
 * Not served by `httpCache`: that cache is conditional-revalidation only (`SafeHttpClient` always
 * re-issues the request with `if-none-match`), and the Wikidata action API sends no validator, so
 * a cached response there still costs a full round trip -- which is the entire cost here, since
 * Wikidata rate-limits anonymous clients to roughly ten requests a minute. This caches the
 * *resolved* answer instead, which is also why only the Wikidata half is stored: whether that KVK
 * number is currently an active IND-recognised sponsor is re-read from `ind_sponsors` on every
 * scan (a local query), so a register change is never masked by this cache.
 */
export const worldwideSponsorLookups = sqliteTable('worldwide_sponsor_lookups', {
  /** The employer name, normalized exactly as `sponsorMatchCompanyKey` normalizes it. */
  companyKey: text('company_key').primaryKey(),
  /** The name as it was queried, kept for auditing which spelling produced the answer. */
  companyName: text('company_name').notNull(),
  /** Null is a real, cacheable answer: "Wikidata resolved no unambiguous KVK for this name". */
  kvkNumber: text('kvk_number'),
  resolvedAt: timestampMs('resolved_at').notNull(),
});

export const httpCache = sqliteTable('http_cache', {
  cacheKey: text('cache_key').primaryKey(),
  url: text('url').notNull(),
  finalUrl: text('final_url').notNull(),
  status: integer('status').notNull(),
  contentType: text('content_type'),
  responseHeaders: text('response_headers', { mode: 'json' })
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  etag: text('etag'),
  lastModified: text('last_modified'),
  body: text('body').notNull(),
  bodyHash: text('body_hash').notNull(),
  fetchedAt: timestampMs('fetched_at').notNull(),
  expiresAt: timestampMs('expires_at'),
});
