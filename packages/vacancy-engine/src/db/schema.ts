import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * SQLite has no standalone enum type, so the previously shared `pgEnum`
 * definitions become reusable allowed-value tuples applied inline to each
 * column. drizzle-orm derives the same TypeScript union from them, and the
 * generated DDL keeps an equivalent `CHECK (col IN (...))` guard.
 */
export const mappingConfidenceValues = ['high', 'medium', 'low', 'unknown'] as const;
export const workplaceModeValues = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export const careerSourceStatusValues = [
  'active',
  'blocked',
  'manual_review',
  'unsupported',
  'error',
] as const;
export const companyDiscoveryStatusValues = [
  'needs_domain',
  'candidate_ready',
  'domain_verified',
  'careers_found',
  'source_verified',
  'active',
  'no_public_careers',
  'unsupported',
  'blocked',
  'manual_review',
  'error',
] as const;
export const companyDiscoveryCampaignItemStateValues = ['pending', 'terminal'] as const;
export const scanRunStatusValues = ['running', 'succeeded', 'partial', 'failed'] as const;
export const scanOutcomeStatusValues = [
  'succeeded',
  'blocked',
  'manual_review',
  'unsupported',
  'failed',
] as const;
export const scanErrorCategoryValues = [
  'network_error',
  'timeout',
  'blocked',
  'parse_error',
  'unsupported_ats',
  'invalid_vacancy',
  'company_mapping_error',
  'semantic_score_error',
  'rate_limited',
  'unsafe_url',
  'http_error',
] as const;
export const applicationStatusValues = [
  'new',
  'reviewed',
  'ignored',
  'saved',
  'applied',
  'interview',
  'rejected',
] as const;

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

/**
 * SQLite has no `~` regex operator. These GLOB approximations keep a
 * defence-in-depth guard with the same intent as the previous PostgreSQL
 * regular expressions:
 *
 * - official URLs must be HTTP(S) and must not carry credentials, a query, or
 *   a fragment. The authoritative check still runs in application code, where
 *   `officialUrlSchema` in `src/companies/domain-candidates.ts` parses the URL
 *   and rejects non-HTTP(S) schemes, embedded credentials, query strings,
 *   fragments, and LinkedIn hosts before a row is ever written.
 * - candidate hashes must be 64 lowercase hex characters, which GLOB can
 *   express exactly through a length test plus a negated character class.
 */
const httpUrlShape = (column: unknown) =>
  sql`(${column} glob 'http://?*' or ${column} glob 'https://?*') and ${column} not glob '*[?#@]*'`;

const sha256HexShape = (column: unknown) =>
  sql`length(${column}) = 64 and ${column} not glob '*[^0-9a-f]*'`;

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

export const companies = sqliteTable(
  'companies',
  {
    id: uuidPrimaryKey(),
    brandName: text('brand_name').notNull(),
    domain: text('domain'),
    mappingConfidence: text('mapping_confidence', { enum: mappingConfidenceValues })
      .notNull()
      .default('unknown'),
    mappingSource: text('mapping_source').notNull().default('unknown'),
    mappingEvidence: text('mapping_evidence', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    lastVerifiedAt: timestampMs('last_verified_at'),
    catalogHash: text('catalog_hash'),
    lastScannedAt: timestampMs('last_scanned_at'),
    scanEnabled: integer('scan_enabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestampMs('created_at').notNull().default(nowMs),
    updatedAt: timestampMs('updated_at').notNull().default(nowMs),
  },
  (table) => [uniqueIndex('companies_domain_unique').on(table.domain)],
);

export const companyAliases = sqliteTable(
  'company_aliases',
  {
    id: uuidPrimaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    normalizedAlias: text('normalized_alias').notNull(),
    source: text('source').notNull(),
    confidence: text('confidence', { enum: mappingConfidenceValues }).notNull().default('unknown'),
  },
  (table) => [uniqueIndex('company_aliases_company_alias_unique').on(table.companyId, table.normalizedAlias)],
);

export const companySponsors = sqliteTable(
  'company_sponsors',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    sponsorId: text('sponsor_id')
      .notNull()
      .references(() => indSponsors.id, { onDelete: 'cascade' }),
    relationship: text('relationship').notNull().default('legal_entity'),
    confidence: text('confidence', { enum: mappingConfidenceValues }).notNull(),
    source: text('source').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    catalogManaged: integer('catalog_managed', { mode: 'boolean' }).notNull().default(true),
    discoveryManaged: integer('discovery_managed', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestampMs('created_at').notNull().default(nowMs),
  },
  (table) => [primaryKey({ columns: [table.companyId, table.sponsorId] })],
);

/**
 * Resumable sponsor-to-domain/source discovery state. A row is inventory, not
 * permission to scan: only evidence-backed candidate_ready rows are inspected.
 */
export const sponsorDiscovery = sqliteTable(
  'sponsor_discovery',
  {
    sponsorId: text('sponsor_id')
      .primaryKey()
      .references(() => indSponsors.id, { onDelete: 'cascade' }),
    status: text('status', { enum: companyDiscoveryStatusValues }).notNull().default('needs_domain'),
    brandName: text('brand_name'),
    officialUrl: text('official_url'),
    officialHostname: text('official_hostname'),
    candidateSource: text('candidate_source'),
    candidateVersion: text('candidate_version'),
    candidateHash: text('candidate_hash'),
    confidence: text('confidence', { enum: mappingConfidenceValues }).notNull().default('unknown'),
    evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    priority: integer('priority').notNull().default(0),
    careersUrl: text('careers_url'),
    provider: text('provider'),
    sourceBaseUrl: text('source_base_url'),
    boardIdentifier: text('board_identifier'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestampMs('last_attempt_at'),
    nextCheckAt: timestampMs('next_check_at'),
    lastHttpStatus: integer('last_http_status'),
    diagnostic: text('diagnostic'),
    candidateVerifiedAt: timestampMs('candidate_verified_at'),
    createdAt: timestampMs('created_at').notNull().default(nowMs),
    updatedAt: timestampMs('updated_at').notNull().default(nowMs),
  },
  (table) => [
    index('sponsor_discovery_candidate_queue_idx').on(
      table.status,
      table.priority,
      table.nextCheckAt,
      table.sponsorId,
    ),
    index('sponsor_discovery_official_hostname_idx').on(table.officialHostname),
    check('sponsor_discovery_priority_check', sql`${table.priority} between 0 and 100`),
    check('sponsor_discovery_attempt_count_check', sql`${table.attemptCount} >= 0`),
    check(
      'sponsor_discovery_diagnostic_length_check',
      sql`${table.diagnostic} is null or length(${table.diagnostic}) <= 4000`,
    ),
    check(
      'sponsor_discovery_http_status_check',
      sql`${table.lastHttpStatus} is null or ${table.lastHttpStatus} between 100 and 599`,
    ),
    check('sponsor_discovery_evidence_object_check', sql`json_type(${table.evidence}) = 'object'`),
    check(
      'sponsor_discovery_candidate_contract_check',
      sql`${table.status} not in (
        'candidate_ready',
        'domain_verified',
        'careers_found',
        'source_verified',
        'no_public_careers',
        'unsupported',
        'blocked',
        'error'
      ) or (
        ${httpUrlShape(table.officialUrl)}
        and ${table.officialHostname} is not null
        and length(${table.officialHostname}) > 0
        and ${table.candidateSource} is not null
        and length(${table.candidateSource}) > 0
        and ${table.candidateVersion} is not null
        and length(${table.candidateVersion}) > 0
        and ${sha256HexShape(table.candidateHash)}
        and ${table.confidence} = 'high'
        and ${table.evidence} <> '{}'
        and ${table.candidateVerifiedAt} is not null
      )`,
    ),
  ],
);

export const careerSources = sqliteTable(
  'career_sources',
  {
    id: uuidPrimaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    provider: text('provider').notNull(),
    baseUrl: text('base_url').notNull(),
    boardIdentifier: text('board_identifier'),
    canonicalKey: text('canonical_key'),
    discoveryMethod: text('discovery_method').notNull(),
    discoveryEvidence: text('discovery_evidence', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    lastSuccessAt: timestampMs('last_success_at'),
    lastFailureAt: timestampMs('last_failure_at'),
    status: text('status', { enum: careerSourceStatusValues }).notNull().default('active'),
    retiredAt: timestampMs('retired_at'),
    consecutiveCompleteMisses: integer('consecutive_complete_misses').notNull().default(0),
    catalogManaged: integer('catalog_managed', { mode: 'boolean' }).notNull().default(true),
    discoveryManaged: integer('discovery_managed', { mode: 'boolean' }).notNull().default(false),
    createdAt: timestampMs('created_at').notNull().default(nowMs),
    updatedAt: timestampMs('updated_at').notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex('career_sources_company_url_unique').on(table.companyId, table.baseUrl),
    uniqueIndex('career_sources_canonical_key_unique').on(table.canonicalKey),
  ],
);

export const vacancies = sqliteTable(
  'vacancies',
  {
    id: uuidPrimaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    careerSourceId: text('career_source_id')
      .notNull()
      .references(() => careerSources.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    location: text('location'),
    description: text('description').notNull(),
    url: text('url').notNull(),
    employmentType: text('employment_type'),
    remote: integer('remote', { mode: 'boolean' }),
    workplaceMode: text('workplace_mode', { enum: workplaceModeValues }).notNull().default('unknown'),
    postedAt: timestampMs('posted_at'),
    firstSeenAt: timestampMs('first_seen_at').notNull().default(nowMs),
    lastSeenAt: timestampMs('last_seen_at').notNull().default(nowMs),
    contentHash: text('content_hash').notNull(),
    hashVersion: text('hash_version').notNull().default('vacancy-content-v2'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    missingCompleteScans: integer('missing_complete_scans').notNull().default(0),
  },
  (table) => [
    uniqueIndex('vacancies_source_external_unique').on(table.careerSourceId, table.externalId),
    index('vacancies_active_score_idx').on(table.active, table.lastSeenAt),
    index('vacancies_content_hash_idx').on(table.contentHash),
  ],
);

export const vacancySnapshots = sqliteTable(
  'vacancy_snapshots',
  {
    id: uuidPrimaryKey(),
    vacancyId: text('vacancy_id')
      .notNull()
      .references(() => vacancies.id, { onDelete: 'cascade' }),
    contentHash: text('content_hash').notNull(),
    hashVersion: text('hash_version').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    observedAt: timestampMs('observed_at').notNull().default(nowMs),
  },
  (table) => [uniqueIndex('vacancy_snapshots_vacancy_hash_unique').on(table.vacancyId, table.contentHash)],
);

export const vacancyScores = sqliteTable(
  'vacancy_scores',
  {
    id: uuidPrimaryKey(),
    vacancyId: text('vacancy_id')
      .notNull()
      .references(() => vacancies.id, { onDelete: 'cascade' }),
    candidateProfileVersion: text('candidate_profile_version').notNull(),
    scoringVersion: text('scoring_version').notNull(),
    deterministicScore: integer('deterministic_score').notNull(),
    semanticScore: integer('semantic_score'),
    semanticConfigVersion: text('semantic_config_version'),
    finalScore: integer('final_score').notNull(),
    technicalFit: integer('technical_fit').notNull(),
    roleFit: integer('role_fit').notNull(),
    seniorityFit: integer('seniority_fit').notNull(),
    languageFit: integer('language_fit').notNull(),
    locationFit: integer('location_fit').notNull(),
    dutchRequired: integer('dutch_required', { mode: 'boolean' }).notNull(),
    dutchPreferred: integer('dutch_preferred', { mode: 'boolean' }).notNull(),
    languageEvidence: text('language_evidence', { mode: 'json' }).$type<string[]>().notNull().default([]),
    primaryFit: text('primary_fit').notNull(),
    matchingSkills: text('matching_skills', { mode: 'json' }).$type<string[]>().notNull().default([]),
    gaps: text('gaps', { mode: 'json' }).$type<string[]>().notNull().default([]),
    reasons: text('reasons', { mode: 'json' }).$type<string[]>().notNull().default([]),
    contentHash: text('content_hash').notNull(),
    scoredAt: timestampMs('scored_at').notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex('vacancy_scores_cache_unique').on(
      table.vacancyId,
      table.contentHash,
      table.candidateProfileVersion,
      table.scoringVersion,
    ),
  ],
);

export const scanRuns = sqliteTable('scan_runs', {
  id: uuidPrimaryKey(),
  command: text('command').notNull(),
  status: text('status', { enum: scanRunStatusValues }).notNull().default('running'),
  aiEnabled: integer('ai_enabled', { mode: 'boolean' }).notNull().default(false),
  startedAt: timestampMs('started_at').notNull().default(nowMs),
  finishedAt: timestampMs('finished_at'),
  statistics: text('statistics', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
});

/**
 * Append-only evidence for each bounded inspection attempt. The restrictive
 * inventory/run references preserve the audit trail if cleanup is attempted.
 */
export const companyDiscoveryAttempts = sqliteTable(
  'company_discovery_attempts',
  {
    id: uuidPrimaryKey(),
    scanRunId: text('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'restrict' }),
    sponsorId: text('sponsor_id')
      .notNull()
      .references(() => sponsorDiscovery.sponsorId, { onDelete: 'restrict' }),
    officialUrl: text('official_url').notNull(),
    candidateSource: text('candidate_source').notNull(),
    candidateVersion: text('candidate_version').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    inspectionPolicyVersion: text('inspection_policy_version').notNull(),
    outcome: text('outcome', { enum: companyDiscoveryStatusValues }).notNull(),
    pagesInspected: integer('pages_inspected').notNull().default(0),
    physicalRequestCount: integer('physical_request_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    httpStatus: integer('http_status'),
    category: text('category'),
    diagnostic: text('diagnostic'),
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestampMs('created_at').notNull().default(nowMs),
  },
  (table) => [
    uniqueIndex('company_discovery_attempts_run_sponsor_unique').on(table.scanRunId, table.sponsorId),
    index('company_discovery_attempts_sponsor_created_idx').on(table.sponsorId, table.createdAt),
    check('company_discovery_attempts_official_url_check', httpUrlShape(table.officialUrl)),
    check('company_discovery_attempts_candidate_hash_check', sha256HexShape(table.candidateHash)),
    check(
      'company_discovery_attempts_provenance_check',
      sql`length(${table.candidateSource}) > 0
        and length(${table.candidateVersion}) > 0
        and length(${table.inspectionPolicyVersion}) > 0`,
    ),
    check(
      'company_discovery_attempts_outcome_check',
      sql`${table.outcome} in (
        'careers_found',
        'no_public_careers',
        'unsupported',
        'blocked',
        'manual_review',
        'error'
      )`,
    ),
    check(
      'company_discovery_attempts_pages_check',
      sql`${table.pagesInspected} between 0 and 2`,
    ),
    check(
      'company_discovery_attempts_request_count_check',
      sql`${table.physicalRequestCount} >= 0`,
    ),
    check('company_discovery_attempts_duration_check', sql`${table.durationMs} >= 0`),
    check(
      'company_discovery_attempts_diagnostic_length_check',
      sql`${table.diagnostic} is null or length(${table.diagnostic}) <= 4000`,
    ),
    check(
      'company_discovery_attempts_http_status_check',
      sql`${table.httpStatus} is null or ${table.httpStatus} between 100 and 599`,
    ),
    check(
      'company_discovery_attempts_result_object_check',
      sql`json_type(${table.result}) = 'object'`,
    ),
  ],
);

/**
 * Immutable sponsor membership plus the final per-sponsor outcome for one
 * discovery campaign. Mutable discovery inventory remains separate.
 */
export const companyDiscoveryCampaignItems = sqliteTable(
  'company_discovery_campaign_items',
  {
    campaignRunId: text('campaign_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'restrict' }),
    sponsorId: text('sponsor_id')
      .notNull()
      .references(() => indSponsors.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    sourceIdentityKeySnapshot: text('source_identity_key_snapshot').notNull(),
    legalNameSnapshot: text('legal_name_snapshot').notNull(),
    kvkNumberSnapshot: text('kvk_number_snapshot'),
    state: text('state', { enum: companyDiscoveryCampaignItemStateValues })
      .notNull()
      .default('pending'),
    finalPhase: text('final_phase'),
    outcome: text('outcome', { enum: companyDiscoveryStatusValues }),
    reasonCode: text('reason_code'),
    networkAttempted: integer('network_attempted', { mode: 'boolean' }).notNull().default(false),
    pagesAttempted: integer('pages_attempted').notNull().default(0),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    physicalRequestCount: integer('physical_request_count').notNull().default(0),
    httpStatus: integer('http_status'),
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    completedAt: timestampMs('completed_at'),
    createdAt: timestampMs('created_at').notNull().default(nowMs),
    updatedAt: timestampMs('updated_at').notNull().default(nowMs),
  },
  (table) => [
    primaryKey({ columns: [table.campaignRunId, table.sponsorId] }),
    uniqueIndex('company_discovery_campaign_items_run_ordinal_unique').on(
      table.campaignRunId,
      table.ordinal,
    ),
    index('company_discovery_campaign_items_queue_idx').on(
      table.campaignRunId,
      table.state,
      table.ordinal,
    ),
    check('company_discovery_campaign_items_ordinal_check', sql`${table.ordinal} > 0`),
    check(
      'company_discovery_campaign_items_pages_check',
      sql`${table.pagesAttempted} between 0 and 2
        and ${table.pagesFetched} between 0 and ${table.pagesAttempted}`,
    ),
    check(
      'company_discovery_campaign_items_request_count_check',
      sql`${table.physicalRequestCount} >= 0`,
    ),
    check(
      'company_discovery_campaign_items_network_check',
      sql`(
        ${table.networkAttempted} = true
        and ${table.pagesAttempted} > 0
      ) or (
        ${table.networkAttempted} = false
        and ${table.pagesAttempted} = 0
        and ${table.pagesFetched} = 0
        and ${table.physicalRequestCount} = 0
        and ${table.httpStatus} is null
      )`,
    ),
    check(
      'company_discovery_campaign_items_http_status_check',
      sql`${table.httpStatus} is null or ${table.httpStatus} between 100 and 599`,
    ),
    check(
      'company_discovery_campaign_items_details_object_check',
      sql`json_type(${table.details}) = 'object'`,
    ),
    check(
      'company_discovery_campaign_items_terminal_check',
      sql`(
        ${table.state} = 'pending'
        and ${table.finalPhase} is null
        and ${table.outcome} is null
        and ${table.reasonCode} is null
        and ${table.completedAt} is null
      ) or (
        ${table.state} = 'terminal'
        and ${table.finalPhase} is not null
        and length(${table.finalPhase}) between 1 and 100
        and ${table.outcome} is not null
        and ${table.reasonCode} is not null
        and length(${table.reasonCode}) between 1 and 100
        and ${table.completedAt} is not null
      )`,
    ),
  ],
);

export const scanSourceOutcomes = sqliteTable(
  'scan_source_outcomes',
  {
    id: uuidPrimaryKey(),
    scanRunId: text('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    careerSourceId: text('career_source_id')
      .notNull()
      .references(() => careerSources.id, { onDelete: 'cascade' }),
    status: text('status', { enum: scanOutcomeStatusValues }).notNull(),
    complete: integer('complete', { mode: 'boolean' }).notNull().default(false),
    vacanciesSeen: integer('vacancies_seen').notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestampMs('created_at').notNull().default(nowMs),
  },
  (table) => [uniqueIndex('scan_source_outcomes_run_source_unique').on(table.scanRunId, table.careerSourceId)],
);

export const scanErrors = sqliteTable('scan_errors', {
  id: uuidPrimaryKey(),
  scanRunId: text('scan_run_id').references(() => scanRuns.id, { onDelete: 'cascade' }),
  companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
  careerSourceId: text('career_source_id').references(() => careerSources.id, { onDelete: 'set null' }),
  category: text('category', { enum: scanErrorCategoryValues }).notNull(),
  message: text('message').notNull(),
  httpStatus: integer('http_status'),
  context: text('context', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestampMs('occurred_at').notNull().default(nowMs),
});

export const applicationStatuses = sqliteTable('application_status', {
  vacancyId: text('vacancy_id')
    .primaryKey()
    .references(() => vacancies.id, { onDelete: 'cascade' }),
  status: text('status', { enum: applicationStatusValues }).notNull().default('new'),
  notes: text('notes'),
  updatedAt: timestampMs('updated_at').notNull().default(nowMs),
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
