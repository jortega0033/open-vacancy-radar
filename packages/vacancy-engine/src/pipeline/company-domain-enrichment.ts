import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import {
  companyDomainCandidateFileSchema,
  loadCompanyDomainCandidates,
  type CompanyDomainCandidate,
  type CompanyDomainCandidateFile,
} from '../companies/domain-candidates.js';
import {
  fetchIatiDomainEvidence,
  IATI_DOMAIN_SOURCE_VERSION,
} from '../companies/iati-domain-source.js';
import {
  fetchRooDomainEvidence,
  ROO_DOMAIN_SOURCE_VERSION,
} from '../companies/roo-domain-source.js';
import {
  fetchTedDomainEvidence,
  TED_DOMAIN_SOURCE_VERSION,
} from '../companies/ted-domain-source.js';
import {
  fetchTendernedDomainEvidence,
  TENDERNED_DOMAIN_SOURCE_VERSION,
} from '../companies/tenderned-domain-source.js';
import {
  mergeStructuredDomainEvidence,
  type StructuredDomainMergeOutcome,
} from '../companies/structured-domain-merge.js';
import {
  fetchWikidataKvkWebsites,
  parseWikidataDomainEvidence,
  WIKIDATA_DOMAIN_QUERY_VERSION,
  type WikidataDomainOutcome,
} from '../companies/wikidata-domain-source.js';
import type { AppConfig } from '../config.js';
import { safeErrorClassification } from '../crawler/errors.js';
import type { Database } from '../db/client.js';
import { indSponsors } from '../db/schema.js';
import { createDatabaseBackedAtsHttpClient } from './ats-http-client.js';

export const STRUCTURED_DOMAIN_CATALOG_VERSION = 'company-domain-candidates-v2-structured';
export const WIKIDATA_CANDIDATE_SOURCE = 'wikidata-p3220-p856-exact-kvk';
export const STRUCTURED_CANDIDATE_SOURCE_PREFIX = 'structured-exact-kvk:';
const DOMAIN_SOURCE_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

export type CompanyDomainEnrichmentResult = {
  activeSponsors: number;
  sourceRequests: number;
  structuredBindings: number;
  invalidBindings: number;
  candidatesGenerated: number;
  candidatesPersisted: number;
  manualCandidatesPreserved: number;
  notFound: number;
  missingKvk: number;
  ambiguous: number;
  responseHash: string;
  responseHashes: Record<string, string>;
  sourceStatistics: Record<string, number>;
  catalogPath: string;
  outcomes: StructuredDomainMergeOutcome[];
};

function candidateIdentity(candidate: Pick<CompanyDomainCandidate, 'kvkNumber' | 'legalName'>): string {
  return `${candidate.kvkNumber}:${candidate.legalName.normalize('NFKC').trim().toLowerCase()}`;
}

export function mergeWikidataCandidates(
  current: CompanyDomainCandidateFile,
  outcomes: readonly WikidataDomainOutcome[],
  verifiedAt: Date,
): CompanyDomainCandidateFile {
  const preserved = current.candidates.filter(
    (candidate) => candidate.source !== WIKIDATA_CANDIDATE_SOURCE,
  );
  const byIdentity = new Map(preserved.map((candidate) => [candidateIdentity(candidate), candidate]));
  for (const outcome of outcomes) {
    if (outcome.status !== 'candidate') continue;
    const generated: CompanyDomainCandidate = {
      legalName: outcome.candidate.legalName,
      kvkNumber: outcome.candidate.kvkNumber,
      brandName: outcome.candidate.legalName,
      officialUrl: outcome.candidate.officialUrl,
      confidence: 'high',
      source: WIKIDATA_CANDIDATE_SOURCE,
      evidenceUrls: [...new Set([
        ...outcome.candidate.wikidataItems,
        outcome.candidate.officialUrl,
      ])].sort(),
      priority: 40,
    };
    const identity = candidateIdentity(generated);
    if (!byIdentity.has(identity)) byIdentity.set(identity, generated);
  }
  return companyDomainCandidateFileSchema.parse({
    version: STRUCTURED_DOMAIN_CATALOG_VERSION,
    verifiedAt: verifiedAt.toISOString(),
    candidates: [...byIdentity.values()].sort(
      (left, right) =>
        left.kvkNumber.localeCompare(right.kvkNumber) || left.legalName.localeCompare(right.legalName),
    ),
  });
}

export function mergeStructuredCandidates(
  current: CompanyDomainCandidateFile,
  outcomes: readonly StructuredDomainMergeOutcome[],
  verifiedAt: Date,
): CompanyDomainCandidateFile {
  const preserved = current.candidates.filter(
    (candidate) =>
      candidate.source !== WIKIDATA_CANDIDATE_SOURCE &&
      !candidate.source.startsWith(STRUCTURED_CANDIDATE_SOURCE_PREFIX),
  );
  const byIdentity = new Map(preserved.map((candidate) => [candidateIdentity(candidate), candidate]));
  for (const outcome of outcomes) {
    if (outcome.status !== 'candidate') continue;
    const generated: CompanyDomainCandidate = {
      legalName: outcome.candidate.legalName,
      kvkNumber: outcome.candidate.kvkNumber,
      brandName: outcome.candidate.legalName,
      officialUrl: outcome.candidate.officialUrl,
      confidence: 'high',
      source: `${STRUCTURED_CANDIDATE_SOURCE_PREFIX}${outcome.candidate.sources.join('+')}`,
      evidenceUrls: [
        ...new Set([
          outcome.candidate.officialUrl,
          ...outcome.candidate.provenance.flatMap((item) => [
            item.evidenceUrl,
            item.observedOfficialUrl,
          ]),
        ]),
      ].sort(),
      priority: outcome.candidate.sources.includes('roo')
        ? 70
        : outcome.candidate.sources.includes('tenderned')
          ? 65
        : outcome.candidate.sources.includes('ted')
          ? 60
        : outcome.candidate.sources.includes('iati')
          ? 50
          : 40,
    };
    const identity = candidateIdentity(generated);
    if (!byIdentity.has(identity)) byIdentity.set(identity, generated);
  }
  return companyDomainCandidateFileSchema.parse({
    version: STRUCTURED_DOMAIN_CATALOG_VERSION,
    verifiedAt: verifiedAt.toISOString(),
    candidates: [...byIdentity.values()].sort(
      (left, right) =>
        left.kvkNumber.localeCompare(right.kvkNumber) || left.legalName.localeCompare(right.legalName),
    ),
  });
}

function safeProjectFile(projectRoot: string, filePath: string): string {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Domain candidate catalog must remain inside the project directory');
  }
  return resolved;
}

export async function writeDomainCandidateCatalog(
  file: CompanyDomainCandidateFile,
  filePath: string,
  projectRoot = process.cwd(),
): Promise<string> {
  const target = safeProjectFile(projectRoot, filePath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

export async function runCompanyDomainEnrichment(
  database: Database,
  config: AppConfig,
  logger: Logger,
  options: {
    candidateFilePath?: string;
    now?: Date;
    projectRoot?: string;
  } = {},
): Promise<CompanyDomainEnrichmentResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const candidateFilePath = options.candidateFilePath ?? 'config/company-domain-candidates-v1.json';
  const current = await loadCompanyDomainCandidates(
    safeProjectFile(projectRoot, candidateFilePath),
  );
  const sponsors = await database
    .select({
      id: indSponsors.id,
      legalName: indSponsors.legalName,
      kvkNumber: indSponsors.kvkNumber,
    })
    .from(indSponsors)
    .where(eq(indSponsors.active, true));

  let sourceRequests = 0;
  const http = createDatabaseBackedAtsHttpClient(
    {
      ...config,
      globalConcurrency: 1,
      perDomainConcurrency: 1,
      maxResponseBytes: Math.max(config.maxResponseBytes, DOMAIN_SOURCE_MAX_RESPONSE_BYTES),
    },
    database,
    {
      cacheTimeoutMs: 60_000,
      onNetworkRequest: () => {
        sourceRequests += 1;
      },
      onCacheError: (error, operation, safeUrl) =>
        logger.warn(
          { ...safeErrorClassification(error), operation, url: safeUrl },
          'Structured domain-source cache operation failed; continuing without cache',
        ),
    },
  );
  // Intentionally sequential: each source is a single public bulk/feed origin.
  const roo = await fetchRooDomainEvidence(http);
  const wikidataPayload = await fetchWikidataKvkWebsites(http);
  const wikidata = parseWikidataDomainEvidence(wikidataPayload);
  const iati = await fetchIatiDomainEvidence(http);
  const tenderned = await fetchTendernedDomainEvidence(http);
  const ted = await fetchTedDomainEvidence(http, {
    snapshotPath: safeProjectFile(
      projectRoot,
      '.cache/domain-sources/ted-winner-domain-v1-2024plus.json',
    ),
  });
  const evidence = [
    ...roo.evidence,
    ...wikidata.evidence,
    ...iati.evidence,
    ...tenderned.evidence,
    ...ted.evidence,
  ];
  const resolution = mergeStructuredDomainEvidence(sponsors, evidence);
  const responseHashes = {
    roo: createHash('sha256').update(JSON.stringify(roo)).digest('hex'),
    wikidata: createHash('sha256').update(JSON.stringify(wikidataPayload)).digest('hex'),
    iati: createHash('sha256').update(JSON.stringify(iati)).digest('hex'),
    tenderned: createHash('sha256').update(JSON.stringify(tenderned)).digest('hex'),
    ted: createHash('sha256').update(JSON.stringify(ted)).digest('hex'),
  };
  const responseHash = createHash('sha256')
    .update(JSON.stringify(responseHashes))
    .digest('hex');
  const verifiedAt = options.now ?? new Date();
  const catalog = mergeStructuredCandidates(current, resolution.outcomes, verifiedAt);
  const catalogPath = await writeDomainCandidateCatalog(
    catalog,
    candidateFilePath,
    projectRoot,
  );
  const counts = {
    notFound: resolution.outcomes.filter((outcome) => outcome.status === 'not_found').length,
    missingKvk: resolution.outcomes.filter((outcome) => outcome.status === 'missing_kvk').length,
    ambiguous: resolution.outcomes.filter((outcome) => outcome.status === 'manual_review').length,
  };
  const sourceStatistics = {
    rooRecords: roo.recordCount,
    rooEvidence: roo.evidence.length,
    wikidataBindings: wikidata.bindingCount,
    wikidataEvidence: wikidata.evidence.length,
    iatiRecords: iati.recordCount,
    iatiEvidence: iati.evidence.length,
    iatiPages: iati.pagesFetched,
    tendernedDatasetsFetched: tenderned.datasetsFetched,
    tendernedReleases: tenderned.releaseCount,
    tendernedSupplierParties: tenderned.supplierPartyCount,
    tendernedAwardedSupplierParties: tenderned.awardedSupplierPartyCount,
    tendernedEvidence: tenderned.evidence.length,
    tendernedAmbiguousPairings: tenderned.ambiguousPairingCount,
    tedNotices: ted.noticeCount,
    tedEligibleSingletonNotices: ted.eligibleSingletonNoticeCount,
    tedEvidence: ted.evidence.length,
    tedPages: ted.pagesFetched,
    tedAmbiguousPairings: ted.ambiguousPairingCount,
    ignoredEvidence: resolution.ignoredEvidenceCount,
  };
  const result: CompanyDomainEnrichmentResult = {
    activeSponsors: sponsors.length,
    sourceRequests,
    structuredBindings: evidence.length,
    invalidBindings:
      roo.invalidKvkRecordCount +
      roo.invalidUrlCount +
      roo.incompleteRecordCount +
      wikidata.invalidBindingCount +
      iati.invalidIdentifierCount +
      iati.invalidUrlCount +
      iati.incompleteRecordCount +
      tenderned.invalidIdentifierCount +
      tenderned.invalidUrlCount +
      tenderned.incompleteRecordCount +
      tenderned.ambiguousPairingCount +
      ted.invalidIdentifierCount +
      ted.invalidUrlCount +
      ted.incompleteRecordCount +
      ted.ambiguousPairingCount,
    candidatesGenerated: resolution.candidates.length,
    candidatesPersisted: catalog.candidates.length,
    manualCandidatesPreserved: catalog.candidates.filter(
      (candidate) => !candidate.source.startsWith(STRUCTURED_CANDIDATE_SOURCE_PREFIX),
    ).length,
    ...counts,
    responseHash,
    responseHashes,
    sourceStatistics,
    catalogPath,
    outcomes: resolution.outcomes,
  };
  logger.info(
    {
      sources: [
        ROO_DOMAIN_SOURCE_VERSION,
        WIKIDATA_DOMAIN_QUERY_VERSION,
        IATI_DOMAIN_SOURCE_VERSION,
        TENDERNED_DOMAIN_SOURCE_VERSION,
        TED_DOMAIN_SOURCE_VERSION,
      ],
      activeSponsors: result.activeSponsors,
      candidates: result.candidatesGenerated,
      ambiguous: result.ambiguous,
      missingKvk: result.missingKvk,
      noStructuredMatch: result.notFound,
      requests: result.sourceRequests,
      responseHash,
      sourceStatistics,
      catalogPath,
    },
    'Structured exact-KVK company-domain enrichment completed',
  );
  return result;
}
