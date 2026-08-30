import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { detectAtsSource } from '../ats/detection.js';
import { safeErrorClassification } from '../crawler/errors.js';
import { withTransaction, type Database } from '../db/client.js';
import { mergeJsonObject } from '../db/json.js';
import {
  careerSources,
  companies,
  companyAliases,
  companyDiscoveryAttempts,
  companySponsors,
  indSponsors,
  scanSourceOutcomes,
  sponsorDiscovery,
} from '../db/schema.js';
import { normalizeLegalName } from '../ind/normalize.js';

const PROMOTION_BATCH_LIMIT = 100;
const DISCOVERY_SOURCE = 'automatic_official_site_discovery';
const RETRYABLE_PROMOTION_DIAGNOSTIC =
  'Latest inspection result no longer matches current discovery state';
const RESERVED_BOARD_IDENTIFIERS = new Set([
  'about',
  'api',
  'auth',
  'blog',
  'contact',
  'docs',
  'embed',
  'help',
  'job',
  'jobs',
  'login',
  'postings',
  'privacy',
  'security',
  'signin',
  'signup',
  'support',
  'terms',
  'www',
]);

export const PROMOTABLE_DISCOVERY_PROVIDERS = [
  'ashby',
  'greenhouse',
  'lever',
  'personio',
  'recruitee',
  'teamtailor',
  'smartrecruiters',
  'successfactors',
  'workable',
  'workday',
] as const;

export type PromotableDiscoveryProvider = (typeof PROMOTABLE_DISCOVERY_PROVIDERS)[number];

const promotableProviders = new Set<string>(PROMOTABLE_DISCOVERY_PROVIDERS);

export type CanonicalDiscoverySource = {
  provider: PromotableDiscoveryProvider;
  sourceType: 'public_ats_api' | 'public_xml' | 'public_rss';
  baseUrl: string;
  boardIdentifier: string;
  canonicalKey: string;
};

export type PromotionDiscoveryState = {
  sponsorId: string;
  officialUrl: string;
  officialHostname: string;
  candidateSource: string;
  candidateVersion: string;
  candidateHash: string;
  candidateVerifiedAt: Date;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  brandName: string;
  careersUrl: string;
  provider: string;
  sourceBaseUrl: string;
  boardIdentifier: string;
};

export type PromotionAttemptEvidence = {
  id: string;
  outcome: string;
  officialUrl: string;
  candidateSource: string;
  candidateVersion: string;
  candidateHash: string;
  result: Record<string, unknown>;
};

export type DiscoveryPromotionResult = {
  examined: number;
  promoted: number;
  terminalized: number;
  skippedUnsupported: number;
  skippedStale: number;
  skippedManualReview: number;
  errors: number;
  promotedSources: {
    sponsorId: string;
    companyId: string;
    careerSourceId: string;
    canonicalKey: string;
  }[];
};

export type DiscoveryPromotionOptions = {
  limit?: number;
  now?: Date;
  provider?: PromotableDiscoveryProvider;
  sponsorIds?: readonly string[];
};

type PromotionDisposition = 'unsupported' | 'stale' | 'manual_review';

export class DiscoveryPromotionBoundaryError extends Error {
  public constructor(
    public readonly disposition: PromotionDisposition,
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryPromotionBoundaryError';
  }
}

function unsupported(message: string): never {
  throw new DiscoveryPromotionBoundaryError('unsupported', message);
}

function stale(message: string): never {
  throw new DiscoveryPromotionBoundaryError('stale', message);
}

function manualReview(message: string): never {
  throw new DiscoveryPromotionBoundaryError('manual_review', message);
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    manualReview(`Discovery evidence is missing ${key}`);
  }
  return value.trim();
}

function equivalentEvidenceUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return false;
  }
}

function normalizedBoardIdentity(provider: PromotableDiscoveryProvider, value: string): string {
  if (provider !== 'teamtailor') return value.trim().toLowerCase();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    manualReview('Teamtailor evidence does not contain an exact RSS URL');
  }
  url.hash = '';
  url.search = '';
  return url.toString().toLowerCase();
}

function requireIdentifierToken(provider: PromotableDiscoveryProvider, value: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })().trim();
  const normalized = decoded.toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9._-]{0,198}[a-z0-9])?$/iu.test(decoded) ||
    RESERVED_BOARD_IDENTIFIERS.has(normalized)
  ) {
    manualReview(`Provider ${provider} returned a generic or unsafe board identifier`);
  }
  return decoded;
}

function encodedPathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Converts only recognized shared ATS URLs into stable source identities. The
 * observed URL is re-detected here; persisted provider fields are not trusted.
 */
export function canonicalizeSupportedDiscoverySource(input: {
  provider: string;
  careersUrl: string;
  boardIdentifier: string;
}): CanonicalDiscoverySource {
  if (!promotableProviders.has(input.provider)) {
    unsupported(`Provider ${input.provider} has no automatic promotion path`);
  }
  const provider = input.provider as PromotableDiscoveryProvider;
  const detected = detectAtsSource(input.careersUrl);
  if (detected?.provider !== provider) {
    manualReview('The observed careers URL no longer matches the persisted provider');
  }
  if (
    normalizedBoardIdentity(provider, detected.boardIdentifier) !==
    normalizedBoardIdentity(provider, input.boardIdentifier)
  ) {
    stale('The observed careers URL no longer matches the persisted board identifier');
  }

  switch (provider) {
    case 'ashby': {
      const boardIdentifier = requireIdentifierToken(provider, detected.boardIdentifier);
      return {
        provider,
        sourceType: 'public_ats_api',
        baseUrl: `https://jobs.ashbyhq.com/${encodedPathSegment(boardIdentifier)}`,
        boardIdentifier,
        canonicalKey: `ashby:${boardIdentifier.toLowerCase()}`,
      };
    }
    case 'greenhouse': {
      const boardIdentifier = requireIdentifierToken(provider, detected.boardIdentifier);
      return {
        provider,
        sourceType: 'public_ats_api',
        baseUrl: `https://boards-api.greenhouse.io/v1/boards/${encodedPathSegment(boardIdentifier)}`,
        boardIdentifier,
        canonicalKey: `greenhouse:${boardIdentifier.toLowerCase()}`,
      };
    }
    case 'lever': {
      const boardIdentifier = requireIdentifierToken(provider, detected.boardIdentifier);
      const detectedHostname = new URL(detected.baseUrl).hostname.toLowerCase();
      const region = detectedHostname.includes('.eu.') ? 'eu' : 'global';
      const jobsOrigin = region === 'eu' ? 'https://jobs.eu.lever.co' : 'https://jobs.lever.co';
      return {
        provider,
        sourceType: 'public_ats_api',
        baseUrl: `${jobsOrigin}/${encodedPathSegment(boardIdentifier)}`,
        boardIdentifier,
        canonicalKey: `lever:${region}:${boardIdentifier.toLowerCase()}`,
      };
    }
    case 'personio': {
      const boardIdentifier = requireIdentifierToken(
        provider,
        detected.boardIdentifier,
      ).toLowerCase();
      const hostname = new URL(detected.baseUrl).hostname.toLowerCase();
      return {
        provider,
        sourceType: 'public_xml',
        baseUrl: detected.baseUrl,
        boardIdentifier,
        canonicalKey: `personio:${hostname}:${boardIdentifier}`,
      };
    }
    case 'recruitee': {
      const boardIdentifier = requireIdentifierToken(
        provider,
        detected.boardIdentifier,
      ).toLowerCase();
      return {
        provider,
        sourceType: 'public_xml',
        baseUrl: `https://${boardIdentifier}.recruitee.com`,
        boardIdentifier,
        canonicalKey: `recruitee:${boardIdentifier}`,
      };
    }
    case 'teamtailor': {
      const feedUrl = new URL(detected.boardIdentifier);
      if (feedUrl.protocol !== 'https:' || feedUrl.hostname.toLowerCase().startsWith('www.')) {
        manualReview('Teamtailor automatic promotion requires an HTTPS tenant feed');
      }
      feedUrl.hash = '';
      feedUrl.search = '';
      const boardIdentifier = feedUrl.toString();
      const listingUrl = new URL(boardIdentifier);
      listingUrl.pathname = listingUrl.pathname.replace(/\.rss$/iu, '');
      return {
        provider,
        sourceType: 'public_rss',
        baseUrl: listingUrl.toString().replace(/\/$/u, ''),
        boardIdentifier,
        canonicalKey: `teamtailor:${boardIdentifier.toLowerCase()}`,
      };
    }
    case 'smartrecruiters': {
      const boardIdentifier = requireIdentifierToken(provider, detected.boardIdentifier);
      return {
        provider,
        sourceType: 'public_ats_api',
        baseUrl: `https://jobs.smartrecruiters.com/${encodedPathSegment(boardIdentifier)}`,
        boardIdentifier,
        canonicalKey: `smartrecruiters:${boardIdentifier.toLowerCase()}`,
      };
    }
    case 'successfactors': {
      const hostname = new URL(detected.baseUrl).hostname.toLowerCase();
      const boardIdentifier = requireIdentifierToken(
        provider,
        detected.boardIdentifier,
      ).toLowerCase();
      if (boardIdentifier !== hostname) {
        manualReview('SuccessFactors board identifier must match its exact career-site hostname');
      }
      return {
        provider,
        sourceType: 'public_xml',
        baseUrl: `${new URL(detected.baseUrl).origin}/`,
        boardIdentifier,
        canonicalKey: `successfactors:${hostname}`,
      };
    }
    case 'workable': {
      const boardIdentifier = requireIdentifierToken(provider, detected.boardIdentifier);
      return {
        provider,
        sourceType: 'public_ats_api',
        baseUrl: `https://apply.workable.com/${encodedPathSegment(boardIdentifier)}`,
        boardIdentifier,
        canonicalKey: `workable:${boardIdentifier.toLowerCase()}`,
      };
    }
    case 'workday': {
      const boardIdentifier = requireIdentifierToken(provider, detected.boardIdentifier);
      const canonicalBoard = new URL(detected.baseUrl);
      const hostname = canonicalBoard.hostname.toLowerCase();
      return {
        provider,
        sourceType: 'public_ats_api',
        baseUrl: canonicalBoard.toString().replace(/\/$/u, ''),
        boardIdentifier,
        canonicalKey: `workday:${hostname}:${boardIdentifier.toLowerCase()}`,
      };
    }
  }
}

function assertSameCandidate(
  current: PromotionDiscoveryState,
  attempt: PromotionAttemptEvidence,
): void {
  if (
    attempt.outcome !== 'careers_found' ||
    attempt.officialUrl !== current.officialUrl ||
    attempt.candidateSource !== current.candidateSource ||
    attempt.candidateVersion !== current.candidateVersion ||
    attempt.candidateHash !== current.candidateHash
  ) {
    stale('Latest inspection attempt does not belong to the current trusted candidate');
  }
}

/** Validates the append-only observation that authorizes a promotion. */
export function validatePromotionProvenance(
  current: PromotionDiscoveryState,
  attempt: PromotionAttemptEvidence,
): CanonicalDiscoverySource {
  assertSameCandidate(current, attempt);
  if (current.confidence !== 'high' || !/^[0-9a-f]{64}$/u.test(current.candidateHash)) {
    stale('Current discovery state is not a high-confidence trusted candidate');
  }
  let officialUrl: URL;
  try {
    officialUrl = new URL(current.officialUrl);
  } catch {
    stale('Current official URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(officialUrl.protocol) ||
    officialUrl.username !== '' ||
    officialUrl.password !== '' ||
    officialUrl.hostname.toLowerCase().replace(/\.$/u, '') !== current.officialHostname
  ) {
    stale('Current official URL no longer matches the trusted hostname');
  }
  if (detectAtsSource(current.officialUrl) !== null) {
    manualReview('A shared ATS hostname cannot become the company identity');
  }

  const result = recordOrNull(attempt.result);
  if (result?.status !== 'careers_found') {
    stale('Latest inspection attempt does not contain a careers-found result');
  }
  const resultProvider = requiredString(result, 'provider');
  const resultCareersUrl = requiredString(result, 'careersUrl');
  const resultSourceBaseUrl = requiredString(result, 'sourceBaseUrl');
  const resultBoardIdentifier = requiredString(result, 'boardIdentifier');
  if (
    resultProvider !== current.provider ||
    !equivalentEvidenceUrl(resultCareersUrl, current.careersUrl) ||
    !equivalentEvidenceUrl(resultSourceBaseUrl, current.sourceBaseUrl) ||
    resultBoardIdentifier !== current.boardIdentifier
  ) {
    stale('Latest inspection result no longer matches current discovery state');
  }

  const canonical = canonicalizeSupportedDiscoverySource({
    provider: current.provider,
    careersUrl: current.careersUrl,
    boardIdentifier: current.boardIdentifier,
  });
  if (!Array.isArray(result.observations) || result.observations.length === 0) {
    manualReview('Latest inspection result has no URL-bearing ATS observation');
  }

  const observedKeys = new Set<string>();
  for (const value of result.observations) {
    const observation = recordOrNull(value);
    if (observation === null) manualReview('ATS observation is malformed');
    const observedOnPage = requiredString(observation, 'observedOnPage');
    const observedUrl = requiredString(observation, 'observedUrl');
    const observedProvider = requiredString(observation, 'provider');
    const observedBoardIdentifier = requiredString(observation, 'boardIdentifier');
    let observedPageUrl: URL;
    try {
      observedPageUrl = new URL(observedOnPage);
    } catch {
      manualReview('ATS observation page URL is invalid');
    }
    if (observedPageUrl.origin !== officialUrl.origin) {
      manualReview('ATS observation was not made on the exact official origin');
    }
    const observedCanonical = canonicalizeSupportedDiscoverySource({
      provider: observedProvider,
      careersUrl: observedUrl,
      boardIdentifier: observedBoardIdentifier,
    });
    observedKeys.add(observedCanonical.canonicalKey);
  }
  if (observedKeys.size !== 1 || !observedKeys.has(canonical.canonicalKey)) {
    manualReview('Inspection contains multiple or conflicting ATS board observations');
  }
  return canonical;
}

function canonicalCompanyDomain(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '');
  return normalized.startsWith('www.') ? normalized.slice(4) : normalized;
}

function discoveryEvidence(
  current: PromotionDiscoveryState,
  attemptId: string,
  canonical: CanonicalDiscoverySource,
): Record<string, unknown> {
  return {
    kind: 'verified_official_site_observation',
    sponsorId: current.sponsorId,
    candidateSource: current.candidateSource,
    candidateVersion: current.candidateVersion,
    candidateHash: current.candidateHash,
    candidateVerifiedAt: current.candidateVerifiedAt.toISOString(),
    officialUrl: current.officialUrl,
    careersUrl: current.careersUrl,
    inspectionAttemptId: attemptId,
    canonicalKey: canonical.canonicalKey,
  };
}

function mergedEvidence(
  column: typeof companySponsors.evidence | typeof careerSources.discoveryEvidence,
  evidence: Record<string, unknown>,
): ReturnType<typeof sql> {
  return mergeJsonObject(column, { automaticDiscovery: evidence });
}

type QueueRow = PromotionDiscoveryState & {
  legalName: string;
};

type QueuedFailureIdentity = {
  sponsorId: string;
  officialUrl: string | null;
  candidateVersion: string | null;
  candidateHash: string | null;
};

export function terminalStatusForPromotionFailure(
  disposition: PromotionDisposition | 'unexpected_error',
): 'unsupported' | 'manual_review' | 'error' {
  if (disposition === 'unsupported') return 'unsupported';
  if (disposition === 'unexpected_error') return 'error';
  return 'manual_review';
}

async function terminalizePromotionFailure(
  database: Database,
  queued: QueuedFailureIdentity,
  status: 'unsupported' | 'manual_review' | 'error',
  diagnostic: string,
  now: Date,
): Promise<boolean> {
  const updated = await database
    .update(sponsorDiscovery)
    .set({ status, diagnostic: diagnostic.slice(0, 4_000), updatedAt: now })
    .where(
      and(
        eq(sponsorDiscovery.sponsorId, queued.sponsorId),
        or(
          eq(sponsorDiscovery.status, 'careers_found'),
          and(
            eq(sponsorDiscovery.status, 'manual_review'),
            eq(sponsorDiscovery.diagnostic, RETRYABLE_PROMOTION_DIAGNOSTIC),
          ),
        ),
        queued.officialUrl === null
          ? isNull(sponsorDiscovery.officialUrl)
          : eq(sponsorDiscovery.officialUrl, queued.officialUrl),
        queued.candidateVersion === null
          ? isNull(sponsorDiscovery.candidateVersion)
          : eq(sponsorDiscovery.candidateVersion, queued.candidateVersion),
        queued.candidateHash === null
          ? isNull(sponsorDiscovery.candidateHash)
          : eq(sponsorDiscovery.candidateHash, queued.candidateHash),
      ),
    )
    .returning({ sponsorId: sponsorDiscovery.sponsorId });
  return updated.length > 0;
}

function stateFromQueueRow(row: {
  sponsorId: string;
  officialUrl: string | null;
  officialHostname: string | null;
  candidateSource: string | null;
  candidateVersion: string | null;
  candidateHash: string | null;
  candidateVerifiedAt: Date | null;
  confidence: PromotionDiscoveryState['confidence'];
  brandName: string | null;
  careersUrl: string | null;
  provider: string | null;
  sourceBaseUrl: string | null;
  boardIdentifier: string | null;
}): PromotionDiscoveryState {
  if (
    row.officialUrl === null ||
    row.officialHostname === null ||
    row.candidateSource === null ||
    row.candidateVersion === null ||
    row.candidateHash === null ||
    row.candidateVerifiedAt === null ||
    row.brandName === null ||
    row.careersUrl === null ||
    row.provider === null ||
    row.sourceBaseUrl === null ||
    row.boardIdentifier === null
  ) {
    stale(`Careers-found discovery row ${row.sponsorId} violates its persisted contract`);
  }
  return {
    sponsorId: row.sponsorId,
    officialUrl: row.officialUrl,
    officialHostname: row.officialHostname,
    candidateSource: row.candidateSource,
    candidateVersion: row.candidateVersion,
    candidateHash: row.candidateHash,
    candidateVerifiedAt: row.candidateVerifiedAt,
    confidence: row.confidence,
    brandName: row.brandName,
    careersUrl: row.careersUrl,
    provider: row.provider,
    sourceBaseUrl: row.sourceBaseUrl,
    boardIdentifier: row.boardIdentifier,
  };
}

async function promoteOne(
  database: Database,
  queued: QueueRow,
  now: Date,
): Promise<DiscoveryPromotionResult['promotedSources'][number]> {
  return withTransaction(database, async (transaction) => {
    const [lockedRow] = await transaction
      .select({
        sponsorId: sponsorDiscovery.sponsorId,
        status: sponsorDiscovery.status,
        diagnostic: sponsorDiscovery.diagnostic,
        officialUrl: sponsorDiscovery.officialUrl,
        officialHostname: sponsorDiscovery.officialHostname,
        candidateSource: sponsorDiscovery.candidateSource,
        candidateVersion: sponsorDiscovery.candidateVersion,
        candidateHash: sponsorDiscovery.candidateHash,
        candidateVerifiedAt: sponsorDiscovery.candidateVerifiedAt,
        confidence: sponsorDiscovery.confidence,
        brandName: sponsorDiscovery.brandName,
        careersUrl: sponsorDiscovery.careersUrl,
        provider: sponsorDiscovery.provider,
        sourceBaseUrl: sponsorDiscovery.sourceBaseUrl,
        boardIdentifier: sponsorDiscovery.boardIdentifier,
      })
      .from(sponsorDiscovery)
      .where(eq(sponsorDiscovery.sponsorId, queued.sponsorId))

      .limit(1);
    if (
      lockedRow === undefined ||
      (lockedRow.status !== 'careers_found' &&
        !(
          lockedRow.status === 'manual_review' &&
          lockedRow.diagnostic === RETRYABLE_PROMOTION_DIAGNOSTIC
        ))
    ) {
      stale(`Discovery row ${queued.sponsorId} is no longer eligible for promotion`);
    }
    const current = stateFromQueueRow(lockedRow);
    if (
      current.candidateHash !== queued.candidateHash ||
      current.candidateVersion !== queued.candidateVersion ||
      current.officialUrl !== queued.officialUrl
    ) {
      stale(`Discovery row ${queued.sponsorId} changed after queue selection`);
    }

    const [sponsor] = await transaction
      .select({ legalName: indSponsors.legalName, active: indSponsors.active })
      .from(indSponsors)
      .where(eq(indSponsors.id, current.sponsorId))
      .limit(1);
    if (sponsor === undefined || !sponsor.active || sponsor.legalName !== queued.legalName) {
      stale(`Sponsor ${queued.sponsorId} is no longer the active queued identity`);
    }

    const [latestAttempt] = await transaction
      .select({
        id: companyDiscoveryAttempts.id,
        outcome: companyDiscoveryAttempts.outcome,
        officialUrl: companyDiscoveryAttempts.officialUrl,
        candidateSource: companyDiscoveryAttempts.candidateSource,
        candidateVersion: companyDiscoveryAttempts.candidateVersion,
        candidateHash: companyDiscoveryAttempts.candidateHash,
        result: companyDiscoveryAttempts.result,
      })
      .from(companyDiscoveryAttempts)
      .where(eq(companyDiscoveryAttempts.sponsorId, current.sponsorId))
      .orderBy(desc(companyDiscoveryAttempts.createdAt), desc(companyDiscoveryAttempts.id))
      .limit(1);
    if (latestAttempt === undefined) {
      stale(`Sponsor ${queued.sponsorId} has no append-only inspection evidence`);
    }
    const canonical = validatePromotionProvenance(current, latestAttempt);
    const domain = canonicalCompanyDomain(current.officialHostname);
    const evidence = discoveryEvidence(current, latestAttempt.id, canonical);

    const [existingCompany] = await transaction
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.domain, domain))
      .limit(1);
    const linkedCompanies = await transaction
      .select({ companyId: companySponsors.companyId })
      .from(companySponsors)
      .where(eq(companySponsors.sponsorId, current.sponsorId));
    if (linkedCompanies.some((link) => link.companyId !== existingCompany?.id)) {
      manualReview('Sponsor is already linked to a different company identity');
    }

    let companyId = existingCompany?.id;
    if (companyId === undefined) {
      const [created] = await transaction
        .insert(companies)
        .values({
          brandName: current.brandName,
          domain,
          mappingConfidence: 'high',
          mappingSource: DISCOVERY_SOURCE,
          mappingEvidence: { automaticDiscovery: evidence },
          lastVerifiedAt: current.candidateVerifiedAt,
          scanEnabled: true,
          updatedAt: now,
        })
        .returning({ id: companies.id });
      if (created === undefined) throw new Error('Dynamic company insert did not return an id');
      companyId = created.id;
    } else {
      await transaction
        .update(companies)
        .set({ scanEnabled: true, updatedAt: now })
        .where(eq(companies.id, companyId));
    }

    const aliases = new Map<string, string>();
    for (const alias of [current.brandName, sponsor.legalName]) {
      aliases.set(normalizeLegalName(alias), alias);
    }
    await transaction
      .insert(companyAliases)
      .values(
        [...aliases].map(([normalizedAlias, alias]) => ({
          companyId,
          alias,
          normalizedAlias,
          source: DISCOVERY_SOURCE,
          confidence: 'high' as const,
        })),
      )
      .onConflictDoNothing();

    await transaction
      .insert(companySponsors)
      .values({
        companyId,
        sponsorId: current.sponsorId,
        relationship: 'recognised_legal_entity',
        confidence: 'high',
        source: DISCOVERY_SOURCE,
        evidence: { automaticDiscovery: evidence },
        catalogManaged: false,
        discoveryManaged: true,
      })
      .onConflictDoUpdate({
        target: [companySponsors.companyId, companySponsors.sponsorId],
        set: {
          discoveryManaged: true,
          evidence: mergedEvidence(companySponsors.evidence, evidence),
        },
      });

    const [canonicalCollision] = await transaction
      .select({ id: careerSources.id, companyId: careerSources.companyId })
      .from(careerSources)
      .where(eq(careerSources.canonicalKey, canonical.canonicalKey))
      .limit(1);
    if (canonicalCollision !== undefined && canonicalCollision.companyId !== companyId) {
      manualReview('Canonical career source is already owned by another company');
    }
    const [urlMatch] = await transaction
      .select({
        id: careerSources.id,
        canonicalKey: careerSources.canonicalKey,
      })
      .from(careerSources)
      .where(
        and(eq(careerSources.companyId, companyId), eq(careerSources.baseUrl, canonical.baseUrl)),
      )
      .limit(1);
    if (
      urlMatch?.canonicalKey !== null &&
      urlMatch?.canonicalKey !== undefined &&
      urlMatch.canonicalKey !== canonical.canonicalKey
    ) {
      manualReview('Existing career source URL has a conflicting canonical identity');
    }
    const existingSourceId = canonicalCollision?.id ?? urlMatch?.id;
    let careerSourceId: string;
    if (existingSourceId === undefined) {
      const [created] = await transaction
        .insert(careerSources)
        .values({
          companyId,
          sourceType: canonical.sourceType,
          provider: canonical.provider,
          baseUrl: canonical.baseUrl,
          boardIdentifier: canonical.boardIdentifier,
          canonicalKey: canonical.canonicalKey,
          discoveryMethod: DISCOVERY_SOURCE,
          discoveryEvidence: {
            automaticDiscovery: evidence,
            lifecycleAuthoritative: false,
          },
          status: 'active',
          retiredAt: null,
          catalogManaged: false,
          discoveryManaged: true,
          updatedAt: now,
        })
        .returning({ id: careerSources.id });
      if (created === undefined)
        throw new Error('Dynamic career source insert did not return an id');
      careerSourceId = created.id;
    } else {
      careerSourceId = existingSourceId;
      await transaction
        .update(careerSources)
        .set({
          sourceType: canonical.sourceType,
          provider: canonical.provider,
          baseUrl: canonical.baseUrl,
          boardIdentifier: canonical.boardIdentifier,
          canonicalKey: canonical.canonicalKey,
          discoveryMethod: DISCOVERY_SOURCE,
          discoveryEvidence: mergedEvidence(careerSources.discoveryEvidence, evidence),
          status: 'active',
          retiredAt: null,
          discoveryManaged: true,
          updatedAt: now,
        })
        .where(eq(careerSources.id, existingSourceId));
    }

    await transaction
      .update(sponsorDiscovery)
      .set({
        status: 'source_verified',
        provider: canonical.provider,
        sourceBaseUrl: canonical.baseUrl,
        boardIdentifier: canonical.boardIdentifier,
        diagnostic:
          'Career source promoted from exact official-site evidence; awaiting source scan',
        updatedAt: now,
      })
      .where(eq(sponsorDiscovery.sponsorId, current.sponsorId));

    return {
      sponsorId: current.sponsorId,
      companyId,
      careerSourceId,
      canonicalKey: canonical.canonicalKey,
    };
  });
}

/**
 * Promotes supported, provenance-valid observations independently. One bad row
 * is logged and counted without rolling back any other company.
 */
export async function promoteDiscoveredCareerSources(
  database: Database,
  logger: Logger,
  options: DiscoveryPromotionOptions = {},
): Promise<DiscoveryPromotionResult> {
  const limit = options.limit ?? PROMOTION_BATCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PROMOTION_BATCH_LIMIT) {
    throw new RangeError(
      `Promotion limit must be an integer from 1 through ${PROMOTION_BATCH_LIMIT}`,
    );
  }
  const now = options.now ?? new Date();
  if (options.provider !== undefined && !promotableProviders.has(options.provider)) {
    throw new Error(`Provider ${options.provider} cannot be promoted automatically`);
  }
  const sponsorIds =
    options.sponsorIds === undefined ? undefined : [...new Set(options.sponsorIds)];
  if (sponsorIds !== undefined && sponsorIds.length > limit) {
    throw new RangeError('Promotion scope cannot contain more sponsor ids than its limit');
  }
  if (sponsorIds?.length === 0) {
    return {
      examined: 0,
      promoted: 0,
      terminalized: 0,
      skippedUnsupported: 0,
      skippedStale: 0,
      skippedManualReview: 0,
      errors: 0,
      promotedSources: [],
    };
  }
  const queuePredicates = [
    or(
      eq(sponsorDiscovery.status, 'careers_found'),
      and(
        eq(sponsorDiscovery.status, 'manual_review'),
        eq(sponsorDiscovery.diagnostic, RETRYABLE_PROMOTION_DIAGNOSTIC),
      ),
    ),
  ];
  if (options.provider !== undefined) {
    queuePredicates.push(eq(sponsorDiscovery.provider, options.provider));
  }
  if (sponsorIds !== undefined) {
    queuePredicates.push(inArray(sponsorDiscovery.sponsorId, sponsorIds));
  }
  const queuedRows = await database
    .select({
      sponsorId: sponsorDiscovery.sponsorId,
      legalName: indSponsors.legalName,
      officialUrl: sponsorDiscovery.officialUrl,
      officialHostname: sponsorDiscovery.officialHostname,
      candidateSource: sponsorDiscovery.candidateSource,
      candidateVersion: sponsorDiscovery.candidateVersion,
      candidateHash: sponsorDiscovery.candidateHash,
      candidateVerifiedAt: sponsorDiscovery.candidateVerifiedAt,
      confidence: sponsorDiscovery.confidence,
      brandName: sponsorDiscovery.brandName,
      careersUrl: sponsorDiscovery.careersUrl,
      provider: sponsorDiscovery.provider,
      sourceBaseUrl: sponsorDiscovery.sourceBaseUrl,
      boardIdentifier: sponsorDiscovery.boardIdentifier,
    })
    .from(sponsorDiscovery)
    .innerJoin(
      indSponsors,
      and(eq(indSponsors.id, sponsorDiscovery.sponsorId), eq(indSponsors.active, true)),
    )
    .where(and(...queuePredicates))
    .orderBy(asc(sponsorDiscovery.sponsorId))
    .limit(limit);

  const result: DiscoveryPromotionResult = {
    examined: queuedRows.length,
    promoted: 0,
    terminalized: 0,
    skippedUnsupported: 0,
    skippedStale: 0,
    skippedManualReview: 0,
    errors: 0,
    promotedSources: [],
  };
  for (const row of queuedRows) {
    let queued: QueueRow;
    try {
      queued = { ...stateFromQueueRow(row), legalName: row.legalName };
      const promoted = await promoteOne(database, queued, now);
      result.promoted += 1;
      result.promotedSources.push(promoted);
      logger.info(
        {
          sponsorId: promoted.sponsorId,
          companyId: promoted.companyId,
          careerSourceId: promoted.careerSourceId,
          canonicalKey: promoted.canonicalKey,
        },
        'Official-site career source promoted for adapter verification',
      );
    } catch (error) {
      if (error instanceof DiscoveryPromotionBoundaryError) {
        if (error.disposition === 'unsupported') result.skippedUnsupported += 1;
        else if (error.disposition === 'stale') result.skippedStale += 1;
        else result.skippedManualReview += 1;
        logger.warn(
          { sponsorId: row.sponsorId, disposition: error.disposition, reason: error.message },
          'Company discovery observation was not promoted',
        );
        try {
          const terminalized = await terminalizePromotionFailure(
            database,
            row,
            terminalStatusForPromotionFailure(error.disposition),
            error.message,
            now,
          );
          if (terminalized) result.terminalized += 1;
        } catch (settlementError) {
          result.errors += 1;
          logger.error(
            { sponsorId: row.sponsorId, ...safeErrorClassification(settlementError) },
            'Promotion rejection could not be terminalized; continuing with other companies',
          );
        }
      } else {
        result.errors += 1;
        logger.error(
          { sponsorId: row.sponsorId, ...safeErrorClassification(error) },
          'Company discovery promotion failed; continuing with other companies',
        );
        try {
          const classification = safeErrorClassification(error);
          const terminalized = await terminalizePromotionFailure(
            database,
            row,
            terminalStatusForPromotionFailure('unexpected_error'),
            `Automatic career-source promotion failed (${classification.errorType})`,
            now,
          );
          if (terminalized) result.terminalized += 1;
        } catch (settlementError) {
          logger.error(
            { sponsorId: row.sponsorId, ...safeErrorClassification(settlementError) },
            'Promotion failure could not be terminalized; continuing with other companies',
          );
        }
      }
    }
  }
  return result;
}

export type ReconciledDiscoveryStatus =
  'active' | 'blocked' | 'error' | 'unsupported' | 'manual_review';

export function discoveryStatusForSourceOutcome(
  outcome: typeof scanSourceOutcomes.$inferSelect.status,
): ReconciledDiscoveryStatus {
  switch (outcome) {
    case 'succeeded':
      return 'active';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'error';
    case 'unsupported':
      return 'unsupported';
    case 'manual_review':
      return 'manual_review';
  }
}

function reconciliationDiagnostic(status: ReconciledDiscoveryStatus): string | null {
  switch (status) {
    case 'active':
      return null;
    case 'blocked':
      return 'Promoted career source was blocked during adapter verification';
    case 'error':
      return 'Promoted career source failed adapter verification';
    case 'unsupported':
      return 'Promoted career source is not accepted by a production adapter';
    case 'manual_review':
      return 'Promoted career source scan requires manual review';
  }
}

export type DiscoveryReconciliationResult = Record<ReconciledDiscoveryStatus, number> & {
  considered: number;
};

/** Applies source-scan outcomes only to their exact discovery-owned descriptor. */
export async function reconcileDiscoverySourceOutcomes(
  database: Database,
  scanRunId: string,
): Promise<DiscoveryReconciliationResult> {
  const rows = await database
    .select({
      careerSourceId: careerSources.id,
      sponsorId: companySponsors.sponsorId,
      outcome: scanSourceOutcomes.status,
      observedAt: scanSourceOutcomes.createdAt,
      sourceProvider: careerSources.provider,
      sourceBoardIdentifier: careerSources.boardIdentifier,
      discoveryProvider: sponsorDiscovery.provider,
      discoveryBoardIdentifier: sponsorDiscovery.boardIdentifier,
    })
    .from(scanSourceOutcomes)
    .innerJoin(careerSources, eq(careerSources.id, scanSourceOutcomes.careerSourceId))
    .innerJoin(companySponsors, eq(companySponsors.companyId, careerSources.companyId))
    .innerJoin(sponsorDiscovery, eq(sponsorDiscovery.sponsorId, companySponsors.sponsorId))
    .where(
      and(
        eq(scanSourceOutcomes.scanRunId, scanRunId),
        eq(careerSources.discoveryManaged, true),
        eq(companySponsors.discoveryManaged, true),
      ),
    );

  const result: DiscoveryReconciliationResult = {
    considered: 0,
    active: 0,
    blocked: 0,
    error: 0,
    unsupported: 0,
    manual_review: 0,
  };
  const reconciledPairs = new Set<string>();
  for (const row of rows) {
    if (
      row.sourceBoardIdentifier === null ||
      row.discoveryBoardIdentifier === null ||
      row.sourceProvider !== row.discoveryProvider ||
      row.sourceBoardIdentifier !== row.discoveryBoardIdentifier
    ) {
      continue;
    }
    const pairKey = `${row.careerSourceId}:${row.sponsorId}`;
    if (reconciledPairs.has(pairKey)) continue;
    reconciledPairs.add(pairKey);
    result.considered += 1;
    const status = discoveryStatusForSourceOutcome(row.outcome);
    const updated = await database
      .update(sponsorDiscovery)
      .set({
        status,
        diagnostic: reconciliationDiagnostic(status),
        updatedAt: row.observedAt,
      })
      .where(
        and(
          eq(sponsorDiscovery.sponsorId, row.sponsorId),
          eq(sponsorDiscovery.provider, row.sourceProvider),
          eq(sponsorDiscovery.boardIdentifier, row.sourceBoardIdentifier),
          lte(sponsorDiscovery.updatedAt, row.observedAt),
        ),
      )
      .returning({ sponsorId: sponsorDiscovery.sponsorId });
    if (updated.length > 0) result[status] += 1;
  }
  return result;
}
