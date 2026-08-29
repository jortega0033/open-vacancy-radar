import { createHash } from 'node:crypto';

import {
  and,
  asc,
  count,
  desc,
  eq,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import { withTransaction, type Database } from '../db/client.js';
import { declaredEnumOrder } from '../db/enum-order.js';
import {
  careerSources,
  companies,
  companyDiscoveryAttempts,
  companyDiscoveryStatusValues,
  companySponsors,
  indSponsors,
  sponsorDiscovery,
} from '../db/schema.js';
import { normalizeLegalName } from '../ind/normalize.js';
import { sanitizeDiagnosticContext } from '../scans/repository.js';
import {
  hashDomainCandidate,
  normalizeOfficialUrl,
  type CompanyDomainCandidate,
  type CompanyDomainCandidateFile,
} from './domain-candidates.js';

export const MAX_DISCOVERY_BATCH_SIZE = 100;

const INVENTORY_INSERT_BATCH_SIZE = 500;
const DISCOVERY_ATTEMPT_OUTCOMES = new Set<DiscoveryAttemptOutcome>([
  'careers_found',
  'no_public_careers',
  'unsupported',
  'blocked',
  'manual_review',
  'error',
]);
const TRUSTED_CANDIDATE_EVIDENCE_KIND = 'trusted_official_domain_candidate';
const WITHDRAWN_CANDIDATE_EVIDENCE_KIND = 'trusted_official_domain_candidate_withdrawal';
const WITHDRAWN_CANDIDATE_SOURCE = 'trusted-domain-catalog-withdrawal';

type SponsorIdentity = {
  id: string;
  legalName: string;
  kvkNumber: string | null;
};

export type TrustedCandidateMatch = {
  sponsor: SponsorIdentity;
  candidate: CompanyDomainCandidate;
};

export type TrustedCandidateMiss = {
  candidate: CompanyDomainCandidate;
  reason: 'not_found' | 'ambiguous';
};

export type TrustedCandidateMatchResult = {
  matches: TrustedCandidateMatch[];
  misses: TrustedCandidateMiss[];
};

export type DiscoveryCoverageRow = {
  status: typeof sponsorDiscovery.$inferSelect.status;
  count: number;
};

export type DiscoverySeedResult = {
  activeSponsors: number;
  inventoryInserted: number;
  candidateMatches: number;
  candidateReady: number;
  candidateManualReview: number;
  candidateNotFound: number;
  candidateAmbiguous: number;
  mappedSponsors: number;
  mappedActive: number;
  mappedManualReview: number;
  coverage: DiscoveryCoverageRow[];
};

export type DiscoveryCandidateRow = {
  sponsorId: string;
  legalName: string;
  kvkNumber: string | null;
  brandName: string;
  officialUrl: string;
  officialHostname: string;
  candidateSource: string;
  candidateVersion: string;
  candidateHash: string;
  evidence: Record<string, unknown>;
  priority: number;
  attemptCount: number;
};

export type DiscoveryAttemptOutcome =
  | 'careers_found'
  | 'no_public_careers'
  | 'unsupported'
  | 'blocked'
  | 'manual_review'
  | 'error';

export type PersistDiscoveryAttemptInput = {
  scanRunId: string;
  sponsorId: string;
  officialUrl: string;
  candidateSource: string;
  candidateVersion: string;
  candidateHash: string;
  inspectionPolicyVersion: string;
  outcome: DiscoveryAttemptOutcome;
  pagesInspected: number;
  physicalRequestCount: number;
  durationMs: number;
  httpStatus?: number | null;
  category?: string | null;
  diagnostic?: string | null;
  result?: Record<string, unknown>;
  careersUrl?: string | null;
  provider?: string | null;
  sourceBaseUrl?: string | null;
  boardIdentifier?: string | null;
  nextCheckAt?: Date | null;
  attemptedAt?: Date;
};

function candidateIdentity(kvkNumber: string, legalName: string): string {
  return `${kvkNumber}:${normalizeLegalName(legalName)}`;
}

/**
 * Matches only an exact KVK plus normalized legal-name identity. Ambiguous IND
 * rows are deliberately left untouched rather than guessed.
 */
export function matchTrustedDomainCandidates(
  sponsors: readonly SponsorIdentity[],
  candidates: readonly CompanyDomainCandidate[],
): TrustedCandidateMatchResult {
  const sponsorsByIdentity = new Map<string, SponsorIdentity[]>();
  for (const sponsor of sponsors) {
    if (sponsor.kvkNumber === null) continue;
    const identity = candidateIdentity(sponsor.kvkNumber, sponsor.legalName);
    const matches = sponsorsByIdentity.get(identity) ?? [];
    matches.push(sponsor);
    sponsorsByIdentity.set(identity, matches);
  }

  const result: TrustedCandidateMatchResult = { matches: [], misses: [] };
  for (const candidate of candidates) {
    const matches = sponsorsByIdentity.get(
      candidateIdentity(candidate.kvkNumber, candidate.legalName),
    );
    if (matches === undefined || matches.length === 0) {
      result.misses.push({ candidate, reason: 'not_found' });
    } else if (matches.length > 1) {
      result.misses.push({ candidate, reason: 'ambiguous' });
    } else {
      const sponsor = matches[0];
      if (sponsor !== undefined) result.matches.push({ sponsor, candidate });
    }
  }
  return result;
}

function mappedOfficialUrl(domain: string | null): string | null {
  if (domain === null || domain.trim().length === 0) return null;
  try {
    return normalizeOfficialUrl(
      /^[a-z][a-z\d+.-]*:/iu.test(domain) ? domain : `https://${domain}/`,
    );
  } catch {
    return null;
  }
}

function candidateEvidence(candidate: CompanyDomainCandidate): Record<string, unknown> {
  return {
    kind: TRUSTED_CANDIDATE_EVIDENCE_KIND,
    legalName: candidate.legalName,
    kvkNumber: candidate.kvkNumber,
    evidenceUrls: candidate.evidenceUrls,
  };
}

function withdrawalHash(sponsor: SponsorIdentity): string {
  return createHash('sha256')
    .update(`withdrawn:${candidateIdentity(sponsor.kvkNumber ?? '', sponsor.legalName)}`)
    .digest('hex');
}

type MappedSponsorRow = {
  sponsorId: string;
  brandName: string;
  domain: string | null;
  scanEnabled: boolean;
  mappingConfidence: typeof companies.$inferSelect.mappingConfidence;
  mappingSource: string;
  mappingEvidence: Record<string, unknown>;
  relationship: string;
  relationshipSource: string;
  relationshipEvidence: Record<string, unknown>;
  sourceStatus: typeof careerSources.$inferSelect.status | null;
  sourceRetiredAt: Date | null;
  sourceProvider: string | null;
  sourceBaseUrl: string | null;
  sourceBoardIdentifier: string | null;
};

function isCurrentActiveMapping(row: MappedSponsorRow): boolean {
  return row.scanEnabled && row.sourceStatus === 'active' && row.sourceRetiredAt === null;
}

function chooseMappedSponsorRows(rows: readonly MappedSponsorRow[]): Map<string, MappedSponsorRow> {
  const selected = new Map<string, MappedSponsorRow>();
  for (const row of rows) {
    const current = selected.get(row.sponsorId);
    if (
      current === undefined ||
      (isCurrentActiveMapping(row) && !isCurrentActiveMapping(current)) ||
      (isCurrentActiveMapping(row) === isCurrentActiveMapping(current) &&
        `${row.brandName}:${row.sourceBaseUrl ?? ''}`.localeCompare(
          `${current.brandName}:${current.sourceBaseUrl ?? ''}`,
        ) < 0)
    ) {
      selected.set(row.sponsorId, row);
    }
  }
  return selected;
}

export async function seedSponsorDiscovery(
  database: Database,
  candidateFile: CompanyDomainCandidateFile,
  now = new Date(),
): Promise<DiscoverySeedResult> {
  const seedResult = await withTransaction(database, async (transaction) => {
    const activeSponsors = await transaction
      .select({
        id: indSponsors.id,
        legalName: indSponsors.legalName,
        kvkNumber: indSponsors.kvkNumber,
      })
      .from(indSponsors)
      .where(eq(indSponsors.active, true));

    let inventoryInserted = 0;
    for (let offset = 0; offset < activeSponsors.length; offset += INVENTORY_INSERT_BATCH_SIZE) {
      const batch = activeSponsors.slice(offset, offset + INVENTORY_INSERT_BATCH_SIZE);
      if (batch.length === 0) continue;
      const inserted = await transaction
        .insert(sponsorDiscovery)
        .values(batch.map((sponsor) => ({ sponsorId: sponsor.id })))
        .onConflictDoNothing({ target: sponsorDiscovery.sponsorId })
        .returning({ sponsorId: sponsorDiscovery.sponsorId });
      inventoryInserted += inserted.length;
    }

    const mappedRows = await transaction
      .select({
        sponsorId: companySponsors.sponsorId,
        brandName: companies.brandName,
        domain: companies.domain,
        scanEnabled: companies.scanEnabled,
        mappingConfidence: companies.mappingConfidence,
        mappingSource: companies.mappingSource,
        mappingEvidence: companies.mappingEvidence,
        relationship: companySponsors.relationship,
        relationshipSource: companySponsors.source,
        relationshipEvidence: companySponsors.evidence,
        sourceStatus: careerSources.status,
        sourceRetiredAt: careerSources.retiredAt,
        sourceProvider: careerSources.provider,
        sourceBaseUrl: careerSources.baseUrl,
        sourceBoardIdentifier: careerSources.boardIdentifier,
      })
      .from(companySponsors)
      .innerJoin(companies, eq(companies.id, companySponsors.companyId))
      .innerJoin(
        indSponsors,
        and(eq(indSponsors.id, companySponsors.sponsorId), eq(indSponsors.active, true)),
      )
      .leftJoin(careerSources, eq(careerSources.companyId, companies.id));
    const mappedSponsors = chooseMappedSponsorRows(mappedRows);

    const inventoryRows = await transaction
      .select({
        sponsorId: sponsorDiscovery.sponsorId,
        legalName: indSponsors.legalName,
        kvkNumber: indSponsors.kvkNumber,
        status: sponsorDiscovery.status,
        evidence: sponsorDiscovery.evidence,
        candidateSource: sponsorDiscovery.candidateSource,
        candidateVersion: sponsorDiscovery.candidateVersion,
        candidateHash: sponsorDiscovery.candidateHash,
        candidateVerifiedAt: sponsorDiscovery.candidateVerifiedAt,
      })
      .from(sponsorDiscovery)
      .innerJoin(
        indSponsors,
        and(eq(indSponsors.id, sponsorDiscovery.sponsorId), eq(indSponsors.active, true)),
      );
    for (const row of inventoryRows) {
      if (
        row.evidence.kind !== 'verified_company_mapping' ||
        mappedSponsors.has(row.sponsorId)
      ) {
        continue;
      }
      const restoredCandidateEvidence =
        row.candidateSource === WITHDRAWN_CANDIDATE_SOURCE
          ? { kind: WITHDRAWN_CANDIDATE_EVIDENCE_KIND }
          : row.candidateHash !== null && row.candidateVerifiedAt !== null
            ? { kind: TRUSTED_CANDIDATE_EVIDENCE_KIND, recoveredAfterMappingRemoval: true }
            : {};
      await transaction
        .update(sponsorDiscovery)
        .set({
          status: 'needs_domain',
          brandName: null,
          officialUrl: null,
          officialHostname: null,
          confidence: 'unknown',
          evidence: restoredCandidateEvidence,
          priority: 0,
          careersUrl: null,
          provider: null,
          sourceBaseUrl: null,
          boardIdentifier: null,
          lastAttemptAt: null,
          nextCheckAt: null,
          lastHttpStatus: null,
          diagnostic: null,
          updatedAt: now,
        })
        .where(eq(sponsorDiscovery.sponsorId, row.sponsorId));
      row.status = 'needs_domain';
      row.evidence = restoredCandidateEvidence;
    }
    const candidateMatches = matchTrustedDomainCandidates(activeSponsors, candidateFile.candidates);
    const verifiedAt = new Date(candidateFile.verifiedAt);
    const matchedSponsorIds = new Set(
      candidateMatches.matches.map(({ sponsor }) => sponsor.id),
    );

    for (const row of inventoryRows) {
      const evidenceKind = row.evidence.kind;
      if (
        mappedSponsors.has(row.sponsorId) ||
        (evidenceKind !== TRUSTED_CANDIDATE_EVIDENCE_KIND &&
          evidenceKind !== WITHDRAWN_CANDIDATE_EVIDENCE_KIND) ||
        matchedSponsorIds.has(row.sponsorId)
      ) {
        continue;
      }

      const persistedVerifiedAt = row.candidateVerifiedAt;
      const tombstoneHash = withdrawalHash({
        id: row.sponsorId,
        legalName: row.legalName,
        kvkNumber: row.kvkNumber,
      });
      if (persistedVerifiedAt !== null && verifiedAt.getTime() < persistedVerifiedAt.getTime()) {
        throw new Error(
          `Refusing domain candidate withdrawal regression for sponsor ${row.sponsorId}: catalog verified at ${candidateFile.verifiedAt} is older than persisted ${persistedVerifiedAt.toISOString()}`,
        );
      }
      if (persistedVerifiedAt?.getTime() === verifiedAt.getTime()) {
        const unchangedWithdrawal =
          evidenceKind === WITHDRAWN_CANDIDATE_EVIDENCE_KIND &&
          row.candidateVersion === candidateFile.version &&
          row.candidateHash === tombstoneHash;
        if (unchangedWithdrawal) continue;
        throw new Error(
          `Refusing domain candidate withdrawal conflict for sponsor ${row.sponsorId}: candidate was omitted without advancing verifiedAt ${candidateFile.verifiedAt}`,
        );
      }

      await transaction
        .update(sponsorDiscovery)
        .set({
          status: 'needs_domain',
          brandName: null,
          officialUrl: null,
          officialHostname: null,
          candidateSource: WITHDRAWN_CANDIDATE_SOURCE,
          candidateVersion: candidateFile.version,
          candidateHash: tombstoneHash,
          confidence: 'unknown',
          evidence: { kind: WITHDRAWN_CANDIDATE_EVIDENCE_KIND },
          priority: 0,
          careersUrl: null,
          provider: null,
          sourceBaseUrl: null,
          boardIdentifier: null,
          nextCheckAt: null,
          lastHttpStatus: null,
          diagnostic: null,
          candidateVerifiedAt: verifiedAt,
          updatedAt: now,
        })
        .where(eq(sponsorDiscovery.sponsorId, row.sponsorId));
      row.status = 'needs_domain';
      row.evidence = { kind: WITHDRAWN_CANDIDATE_EVIDENCE_KIND };
      row.candidateVersion = candidateFile.version;
      row.candidateHash = tombstoneHash;
      row.candidateVerifiedAt = verifiedAt;
    }

    const inventoryBySponsor = new Map(inventoryRows.map((row) => [row.sponsorId, row]));
    let candidateReady = 0;
    let candidateManualReview = 0;

    for (const { sponsor, candidate } of candidateMatches.matches) {
      const current = inventoryBySponsor.get(sponsor.id);
      if (current === undefined) {
        throw new Error(`Discovery inventory is missing active sponsor ${sponsor.id}`);
      }
      if (mappedSponsors.has(sponsor.id)) continue;

      const candidateHash = hashDomainCandidate(candidate);
      if (
        current.candidateVerifiedAt !== null &&
        current.candidateVerifiedAt.getTime() > verifiedAt.getTime()
      ) {
        throw new Error(
          `Refusing domain candidate regression for sponsor ${sponsor.id}: candidate verified at ${candidateFile.verifiedAt} is older than persisted ${current.candidateVerifiedAt.toISOString()}`,
        );
      }
      if (
        current.candidateVerifiedAt?.getTime() === verifiedAt.getTime() &&
        ((current.candidateHash !== null && current.candidateHash !== candidateHash) ||
          (current.candidateVersion !== null && current.candidateVersion !== candidateFile.version))
      ) {
        throw new Error(
          `Refusing domain candidate conflict for sponsor ${sponsor.id}: content changed without advancing verifiedAt ${candidateFile.verifiedAt}`,
        );
      }

      const officialUrl = normalizeOfficialUrl(candidate.officialUrl);
      const targetStatus = candidate.confidence === 'high' ? 'candidate_ready' : 'manual_review';
      const candidateChanged = current.candidateHash !== candidateHash;
      const status =
        !candidateChanged && current.status !== 'needs_domain' ? current.status : targetStatus;
      await transaction
        .update(sponsorDiscovery)
        .set({
          status,
          brandName: candidate.brandName,
          officialUrl,
          officialHostname: new URL(officialUrl).hostname.toLowerCase(),
          candidateSource: candidate.source,
          candidateVersion: candidateFile.version,
          candidateHash,
          confidence: candidate.confidence,
          evidence: candidateEvidence(candidate),
          priority: candidate.priority,
          candidateVerifiedAt: verifiedAt,
          ...(candidateChanged
            ? {
                careersUrl: null,
                provider: null,
                sourceBaseUrl: null,
                boardIdentifier: null,
                lastAttemptAt: null,
                nextCheckAt: null,
                lastHttpStatus: null,
                diagnostic: null,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(sponsorDiscovery.sponsorId, sponsor.id));
      if (status === 'candidate_ready') candidateReady += 1;
      else if (status === 'manual_review') candidateManualReview += 1;
    }

    let mappedActive = 0;
    let mappedManualReview = 0;
    for (const row of mappedSponsors.values()) {
      const active = isCurrentActiveMapping(row);
      const officialUrl = mappedOfficialUrl(row.domain);
      await transaction
        .update(sponsorDiscovery)
        .set({
          status: active ? 'active' : 'manual_review',
          brandName: row.brandName,
          officialUrl,
          officialHostname: officialUrl === null ? null : new URL(officialUrl).hostname.toLowerCase(),
          confidence: row.mappingConfidence,
          evidence: {
            kind: 'verified_company_mapping',
            mappingSource: row.mappingSource,
            mappingEvidence: row.mappingEvidence,
            relationship: row.relationship,
            relationshipSource: row.relationshipSource,
            relationshipEvidence: row.relationshipEvidence,
          },
          careersUrl: null,
          provider: row.sourceProvider,
          sourceBaseUrl: row.sourceBaseUrl,
          boardIdentifier: row.sourceBoardIdentifier,
          nextCheckAt: null,
          diagnostic: active ? null : 'Current verified mapping is not scan-enabled with an active source',
          updatedAt: now,
        })
        .where(eq(sponsorDiscovery.sponsorId, row.sponsorId));
      if (active) mappedActive += 1;
      else mappedManualReview += 1;
    }

    return {
      activeSponsors: activeSponsors.length,
      inventoryInserted,
      candidateMatches: candidateMatches.matches.length,
      candidateReady,
      candidateManualReview,
      candidateNotFound: candidateMatches.misses.filter((miss) => miss.reason === 'not_found').length,
      candidateAmbiguous: candidateMatches.misses.filter((miss) => miss.reason === 'ambiguous').length,
      mappedSponsors: mappedSponsors.size,
      mappedActive,
      mappedManualReview,
    };
  });

  return { ...seedResult, coverage: await getDiscoveryCoverage(database) };
}

export async function listDueDiscoveryCandidates(
  database: Database,
  limit = MAX_DISCOVERY_BATCH_SIZE,
  now = new Date(),
): Promise<DiscoveryCandidateRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DISCOVERY_BATCH_SIZE) {
    throw new RangeError(
      `Discovery batch limit must be an integer from 1 through ${MAX_DISCOVERY_BATCH_SIZE}`,
    );
  }

  const rows = await database
    .select({
      sponsorId: sponsorDiscovery.sponsorId,
      legalName: indSponsors.legalName,
      kvkNumber: indSponsors.kvkNumber,
      brandName: sponsorDiscovery.brandName,
      officialUrl: sponsorDiscovery.officialUrl,
      officialHostname: sponsorDiscovery.officialHostname,
      candidateSource: sponsorDiscovery.candidateSource,
      candidateVersion: sponsorDiscovery.candidateVersion,
      candidateHash: sponsorDiscovery.candidateHash,
      confidence: sponsorDiscovery.confidence,
      evidence: sponsorDiscovery.evidence,
      priority: sponsorDiscovery.priority,
      attemptCount: sponsorDiscovery.attemptCount,
    })
    .from(sponsorDiscovery)
    .innerJoin(
      indSponsors,
      and(eq(indSponsors.id, sponsorDiscovery.sponsorId), eq(indSponsors.active, true)),
    )
    .where(
      and(
        eq(sponsorDiscovery.status, 'candidate_ready'),
        or(isNull(sponsorDiscovery.nextCheckAt), lte(sponsorDiscovery.nextCheckAt, now)),
      ),
    )
    .orderBy(desc(sponsorDiscovery.priority), asc(sponsorDiscovery.sponsorId))
    .limit(limit);

  return rows.map((row) => {
    if (
      row.brandName === null ||
      row.officialUrl === null ||
      row.officialHostname === null ||
      row.candidateSource === null ||
      row.candidateVersion === null ||
      row.candidateHash === null ||
      row.confidence !== 'high'
    ) {
      throw new Error(`Candidate-ready discovery row ${row.sponsorId} violates its contract`);
    }
    return {
      sponsorId: row.sponsorId,
      legalName: row.legalName,
      kvkNumber: row.kvkNumber,
      brandName: row.brandName,
      officialUrl: row.officialUrl,
      officialHostname: row.officialHostname,
      candidateSource: row.candidateSource,
      candidateVersion: row.candidateVersion,
      candidateHash: row.candidateHash,
      evidence: row.evidence,
      priority: row.priority,
      attemptCount: row.attemptCount,
    };
  });
}

export async function getDiscoveryCoverage(database: Database): Promise<DiscoveryCoverageRow[]> {
  return database
    .select({ status: sponsorDiscovery.status, count: count() })
    .from(sponsorDiscovery)
    .innerJoin(
      indSponsors,
      and(eq(indSponsors.id, sponsorDiscovery.sponsorId), eq(indSponsors.active, true)),
    )
    .groupBy(sponsorDiscovery.status)
    .orderBy(asc(declaredEnumOrder(sponsorDiscovery.status, companyDiscoveryStatusValues)));
}

function assertAttemptInput(input: PersistDiscoveryAttemptInput): void {
  if (!DISCOVERY_ATTEMPT_OUTCOMES.has(input.outcome)) {
    throw new Error(`Discovery attempt outcome ${input.outcome} cannot be persisted by the inspector`);
  }
  if (!Number.isInteger(input.pagesInspected) || input.pagesInspected < 0 || input.pagesInspected > 2) {
    throw new RangeError('pagesInspected must be an integer from 0 through 2');
  }
  if (!Number.isInteger(input.physicalRequestCount) || input.physicalRequestCount < 0) {
    throw new RangeError('physicalRequestCount must be a non-negative integer');
  }
  if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
    throw new RangeError('durationMs must be a non-negative integer');
  }
}

export async function persistDiscoveryAttempt(
  database: Database,
  input: PersistDiscoveryAttemptInput,
): Promise<void> {
  assertAttemptInput(input);
  const attemptedAt = input.attemptedAt ?? new Date();
  const sanitized = sanitizeDiagnosticContext({
    diagnostic: input.diagnostic ?? null,
    result: input.result ?? {},
  });
  const diagnostic =
    typeof sanitized.diagnostic === 'string' ? sanitized.diagnostic.slice(0, 4_000) : null;
  const result =
    sanitized.result !== null && typeof sanitized.result === 'object' && !Array.isArray(sanitized.result)
      ? (sanitized.result as Record<string, unknown>)
      : {};

  await withTransaction(database, async (transaction) => {
    const [current] = await transaction
      .select({
        status: sponsorDiscovery.status,
        officialUrl: sponsorDiscovery.officialUrl,
        candidateSource: sponsorDiscovery.candidateSource,
        candidateVersion: sponsorDiscovery.candidateVersion,
        candidateHash: sponsorDiscovery.candidateHash,
      })
      .from(sponsorDiscovery)
      .where(eq(sponsorDiscovery.sponsorId, input.sponsorId))

      .limit(1);
    if (current === undefined) {
      throw new Error(`Discovery inventory row ${input.sponsorId} does not exist`);
    }
    if (
      current.status !== 'candidate_ready' ||
      current.officialUrl !== input.officialUrl ||
      current.candidateSource !== input.candidateSource ||
      current.candidateVersion !== input.candidateVersion ||
      current.candidateHash !== input.candidateHash
    ) {
      throw new Error(`Refusing stale discovery attempt for sponsor ${input.sponsorId}`);
    }

    await transaction.insert(companyDiscoveryAttempts).values({
      scanRunId: input.scanRunId,
      sponsorId: input.sponsorId,
      officialUrl: input.officialUrl,
      candidateSource: input.candidateSource,
      candidateVersion: input.candidateVersion,
      candidateHash: input.candidateHash,
      inspectionPolicyVersion: input.inspectionPolicyVersion,
      outcome: input.outcome,
      pagesInspected: input.pagesInspected,
      physicalRequestCount: input.physicalRequestCount,
      durationMs: input.durationMs,
      httpStatus: input.httpStatus ?? null,
      category: input.category?.slice(0, 200) ?? null,
      diagnostic,
      result,
      createdAt: attemptedAt,
    });

    await transaction
      .update(sponsorDiscovery)
      .set({
        status: input.outcome,
        careersUrl: input.careersUrl ?? null,
        provider: input.provider ?? null,
        sourceBaseUrl: input.sourceBaseUrl ?? null,
        boardIdentifier: input.boardIdentifier ?? null,
        attemptCount: sql`${sponsorDiscovery.attemptCount} + 1`,
        lastAttemptAt: attemptedAt,
        nextCheckAt: input.nextCheckAt ?? null,
        lastHttpStatus: input.httpStatus ?? null,
        diagnostic,
        updatedAt: attemptedAt,
      })
      .where(eq(sponsorDiscovery.sponsorId, input.sponsorId));
  });
}
