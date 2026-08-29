import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import { normalizeLegalName } from '../ind/normalize.js';
import {
  normalizeStructuredOfficialUrl,
  type StructuredDomainEvidence,
} from './structured-domain-evidence.js';

export const TENDERNED_DOMAIN_SOURCE_VERSION =
  'tenderned-ocds-supplier-domain-2021-through-2026-h1-v2';

export type TendernedDatasetDescriptor = {
  readonly period: string;
  readonly sourceVersion: string;
  readonly url: string;
};

export const TENDERNED_BULK_DATASETS = [
  {
    period: '2021',
    sourceVersion: 'tenderned-ocds-supplier-domain-2021-v1',
    url: 'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2021-01-01-2021-12-31.json',
  },
  {
    period: '2022',
    sourceVersion: 'tenderned-ocds-supplier-domain-2022-v1',
    url: 'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2022-01-01-2022-12-31.json',
  },
  {
    period: '2023',
    sourceVersion: 'tenderned-ocds-supplier-domain-2023-v1',
    url: 'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2023-01-01-2023-12-31.json',
  },
  {
    period: '2024',
    sourceVersion: 'tenderned-ocds-supplier-domain-2024-v1',
    url: 'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2024-01-01-2024-12-31.json',
  },
  {
    period: '2025',
    sourceVersion: 'tenderned-ocds-supplier-domain-2025-v1',
    url: 'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2025-01-01-2025-12-31.json',
  },
  {
    period: '2026-h1',
    sourceVersion: 'tenderned-ocds-supplier-domain-2026-h1-v1',
    url: 'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2026-01-01-2026-06-30.json',
  },
] as const satisfies readonly TendernedDatasetDescriptor[];

export const TENDERNED_BULK_JSON_URLS: readonly string[] = Object.freeze(
  TENDERNED_BULK_DATASETS.map(({ url }) => url),
);
export const TENDERNED_BULK_JSON_URL = TENDERNED_BULK_DATASETS[5].url;
export const TENDERNED_DATASET_LANDING_URL =
  'https://www.tenderned.nl/cms/nl/aanbesteden-in-cijfers/datasets-aanbestedingen';

const TENDERNED_ORIGIN = new URL(TENDERNED_BULK_JSON_URL).origin;
const MAX_TENDERNED_JSON_CHARACTERS = 128 * 1024 * 1024;
const MAX_RELEASES = 100_000;
const MAX_PARTIES_PER_RELEASE = 1_000;
const MAX_AWARDS_PER_RELEASE = 2_000;
const MAX_SUPPLIERS_PER_AWARD = 1_000;
const MAX_DOCUMENTS_PER_RELEASE = 100;

export type TendernedDomainEvidence = Omit<StructuredDomainEvidence, 'source'> & {
  source: 'tenderned';
};

export type TendernedDomainParseResult = {
  evidence: TendernedDomainEvidence[];
  releaseCount: number;
  supplierPartyCount: number;
  awardedSupplierPartyCount: number;
  invalidIdentifierCount: number;
  nonDutchSupplierCount: number;
  unconfirmedAwardCount: number;
  ambiguousPairingCount: number;
  invalidUrlCount: number;
  incompleteRecordCount: number;
};

export type TendernedDatasetStatistics = Omit<TendernedDomainParseResult, 'evidence'> & {
  datasetUrl: string;
  period: string;
  sourceVersion: string;
  evidenceCount: number;
};

export type TendernedDomainFetchResult = TendernedDomainParseResult & {
  datasetsFetched: number;
  datasetStatistics: TendernedDatasetStatistics[];
};

export type TendernedDomainFetchOptions = {
  /** Test/pilot selection. Every value must still be one of the six pinned official snapshots. */
  datasetUrls?: readonly string[];
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new AtsResponseError('tenderned_domain_source', `${label} is not an object`);
  }
  return value;
}

function boundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new AtsResponseError('tenderned_domain_source', `${label} is not an array`);
  }
  if (value.length > maximum) {
    throw new AtsResponseError('tenderned_domain_source', `${label} exceeds the parser limit`);
  }
  return value;
}

function optionalBoundedArray(value: unknown, label: string, maximum: number): unknown[] {
  return value === undefined ? [] : boundedArray(value, label, maximum);
}

function normalizedText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
    : '';
}

function exactKvk(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return /^\d{8}$/u.test(candidate) ? candidate : null;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new AtsResponseError('tenderned_domain_source', `${label} is not a string array`);
  }
  const result: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      throw new AtsResponseError('tenderned_domain_source', `${label} is not a string array`);
    }
    result.push(item.normalize('NFKC').trim());
  }
  return result;
}

function isDutchCountry(value: unknown): boolean {
  const normalized = normalizedText(value).toLocaleLowerCase('nl-NL').replace(/[.\s_-]+/gu, ' ');
  return new Set(['nl', 'nld', 'nederland', 'netherlands', 'the netherlands']).has(normalized);
}

function supplierPartyRecords(release: JsonRecord, releaseIndex: number): JsonRecord[] {
  const parties = optionalBoundedArray(
    release.parties,
    `release ${releaseIndex} parties`,
    MAX_PARTIES_PER_RELEASE,
  );
  return parties.map((value, partyIndex) => {
    const party = requireRecord(value, `release ${releaseIndex} party ${partyIndex}`);
    const roles = party.roles === undefined
      ? []
      : stringArray(party.roles, `release ${releaseIndex} party ${partyIndex} roles`);
    return roles.includes('supplier') ? party : null;
  }).filter((value): value is JsonRecord => value !== null);
}

function awardedNamesByKvk(release: JsonRecord, releaseIndex: number): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const awards = optionalBoundedArray(
    release.awards,
    `release ${releaseIndex} awards`,
    MAX_AWARDS_PER_RELEASE,
  );
  for (const [awardIndex, rawAward] of awards.entries()) {
    const award = requireRecord(rawAward, `release ${releaseIndex} award ${awardIndex}`);
    const suppliers = optionalBoundedArray(
      award.suppliers,
      `release ${releaseIndex} award ${awardIndex} suppliers`,
      MAX_SUPPLIERS_PER_AWARD,
    );
    for (const [supplierIndex, rawSupplier] of suppliers.entries()) {
      const supplier = requireRecord(
        rawSupplier,
        `release ${releaseIndex} award ${awardIndex} supplier ${supplierIndex}`,
      );
      const kvkNumber = exactKvk(supplier.id);
      const sourceName = normalizedText(supplier.name);
      const normalizedName = normalizeLegalName(sourceName);
      if (kvkNumber === null || normalizedName.length === 0) continue;
      const names = result.get(kvkNumber) ?? new Set<string>();
      names.add(normalizedName);
      result.set(kvkNumber, names);
    }
  }
  return result;
}

function normalizeTendernedEvidenceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (
      url.origin !== TENDERNED_ORIGIN ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      !/^\/tenderned-tap\/aankondigingen\/\d+$/u.test(url.pathname)
    ) {
      return null;
    }
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

const AMBIGUOUS_EVIDENCE_URL = Symbol('ambiguous TenderNed evidence URL');

function releaseEvidenceUrl(
  release: JsonRecord,
  releaseIndex: number,
): string | null | typeof AMBIGUOUS_EVIDENCE_URL {
  if (release.tender === undefined) return null;
  const tender = requireRecord(release.tender, `release ${releaseIndex} tender`);
  const documents = optionalBoundedArray(
    tender.documents,
    `release ${releaseIndex} tender documents`,
    MAX_DOCUMENTS_PER_RELEASE,
  );
  const urls = new Set<string>();
  for (const [documentIndex, rawDocument] of documents.entries()) {
    const document = requireRecord(
      rawDocument,
      `release ${releaseIndex} tender document ${documentIndex}`,
    );
    if (normalizedText(document.documentType) !== 'tenderNotice') continue;
    const url = normalizeTendernedEvidenceUrl(document.url);
    if (url !== null) urls.add(url);
  }
  if (urls.size === 0) return null;
  if (urls.size > 1) return AMBIGUOUS_EVIDENCE_URL;
  return [...urls][0] ?? null;
}

function validReleaseIdentity(release: JsonRecord): { ocid: string; id: string } | null {
  const ocid = normalizedText(release.ocid);
  const id = normalizedText(release.id);
  if (!/^ocds-[a-z0-9][a-z0-9-]{1,199}$/iu.test(ocid) || !/^\d{1,20}$/u.test(id)) {
    return null;
  }
  return { ocid, id };
}

function parseDataset(json: string): JsonRecord {
  if (json.length === 0 || json.length > MAX_TENDERNED_JSON_CHARACTERS) {
    throw new AtsResponseError(
      'tenderned_domain_source',
      'bulk JSON is empty or exceeds the parser limit',
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(json) as unknown;
  } catch (error) {
    throw new AtsResponseError('tenderned_domain_source', 'bulk response is not valid JSON', null, {
      cause: error,
    });
  }
  const dataset = requireRecord(payload, 'bulk response');
  if (
    normalizedText(dataset.uri) !== TENDERNED_DATASET_LANDING_URL ||
    normalizedText(dataset.version) !== '1.1'
  ) {
    throw new AtsResponseError(
      'tenderned_domain_source',
      'bulk response is not the expected TenderNed OCDS dataset',
    );
  }
  boundedArray(dataset.releases, 'bulk response releases', MAX_RELEASES);
  return dataset;
}

function parseTendernedDomainEvidenceForVersion(
  json: string,
  sourceVersion: string,
): TendernedDomainParseResult {
  const dataset = parseDataset(json);
  const releases = boundedArray(dataset.releases, 'bulk response releases', MAX_RELEASES);
  const result: TendernedDomainParseResult = {
    evidence: [],
    releaseCount: releases.length,
    supplierPartyCount: 0,
    awardedSupplierPartyCount: 0,
    invalidIdentifierCount: 0,
    nonDutchSupplierCount: 0,
    unconfirmedAwardCount: 0,
    ambiguousPairingCount: 0,
    invalidUrlCount: 0,
    incompleteRecordCount: 0,
  };
  const evidenceByIdentity = new Map<string, TendernedDomainEvidence>();

  for (const [releaseIndex, rawRelease] of releases.entries()) {
    const release = requireRecord(rawRelease, `release ${releaseIndex}`);
    const supplierParties = supplierPartyRecords(release, releaseIndex);
    result.supplierPartyCount += supplierParties.length;
    if (supplierParties.length === 0) continue;

    const releaseIdentity = validReleaseIdentity(release);
    const evidenceUrl = releaseEvidenceUrl(release, releaseIndex);
    if (releaseIdentity === null || evidenceUrl === null) {
      result.incompleteRecordCount += supplierParties.length;
      continue;
    }
    if (evidenceUrl === AMBIGUOUS_EVIDENCE_URL) {
      result.ambiguousPairingCount += supplierParties.length;
      continue;
    }
    const awardNames = awardedNamesByKvk(release, releaseIndex);

    for (const party of supplierParties) {
      const kvkNumber = exactKvk(party.id);
      if (kvkNumber === null) {
        result.invalidIdentifierCount += 1;
        continue;
      }
      const address = party.address === undefined
        ? null
        : requireRecord(party.address, `release ${releaseIndex} supplier address`);
      if (address === null || !isDutchCountry(address.countryName)) {
        result.nonDutchSupplierCount += 1;
        continue;
      }
      const sourceName = normalizedText(party.name);
      const contactPoint = party.contactPoint === undefined
        ? null
        : requireRecord(party.contactPoint, `release ${releaseIndex} supplier contactPoint`);
      const rawOfficialUrl = contactPoint?.url;
      if (sourceName.length === 0 || typeof rawOfficialUrl !== 'string' || rawOfficialUrl.trim() === '') {
        result.incompleteRecordCount += 1;
        continue;
      }

      const names = awardNames.get(kvkNumber);
      const normalizedName = normalizeLegalName(sourceName);
      if (!names?.has(normalizedName)) {
        result.unconfirmedAwardCount += 1;
        continue;
      }
      if (names.size !== 1) {
        result.ambiguousPairingCount += 1;
        continue;
      }
      result.awardedSupplierPartyCount += 1;

      const website = normalizeStructuredOfficialUrl(rawOfficialUrl);
      if (website === null) {
        result.invalidUrlCount += 1;
        continue;
      }
      const sourceRecordId = [
        releaseIdentity.ocid,
        releaseIdentity.id,
        'supplier',
        kvkNumber,
      ].join(':');
      const item: TendernedDomainEvidence = {
        source: 'tenderned',
        sourceVersion,
        sourceRecordId,
        sourceName,
        kvkNumber,
        officialUrl: website.officialUrl,
        hostnameKey: website.hostnameKey,
        evidenceUrl,
      };
      const identity = [sourceRecordId, item.officialUrl].join('\u0000');
      if (!evidenceByIdentity.has(identity)) evidenceByIdentity.set(identity, item);
    }
  }

  result.evidence = [...evidenceByIdentity.values()].sort(
    (left, right) =>
      left.kvkNumber.localeCompare(right.kvkNumber) ||
      left.sourceRecordId.localeCompare(right.sourceRecordId) ||
      left.officialUrl.localeCompare(right.officialUrl),
  );
  return result;
}

export function parseTendernedDomainEvidence(json: string): TendernedDomainParseResult {
  return parseTendernedDomainEvidenceForVersion(
    json,
    TENDERNED_BULK_DATASETS[5].sourceVersion,
  );
}

function selectDatasets(datasetUrls: readonly string[] | undefined): TendernedDatasetDescriptor[] {
  if (datasetUrls === undefined) return [...TENDERNED_BULK_DATASETS];
  if (datasetUrls.length === 0) {
    throw new RangeError('datasetUrls must select at least one pinned TenderNed snapshot');
  }
  const byUrl = new Map<string, TendernedDatasetDescriptor>(
    TENDERNED_BULK_DATASETS.map((dataset) => [dataset.url, dataset]),
  );
  const selected: TendernedDatasetDescriptor[] = [];
  const seen = new Set<string>();
  for (const datasetUrl of datasetUrls) {
    const dataset = byUrl.get(datasetUrl);
    if (dataset === undefined) {
      throw new RangeError('datasetUrls contains an unpinned TenderNed snapshot URL');
    }
    if (seen.has(datasetUrl)) {
      throw new RangeError('datasetUrls contains a duplicate TenderNed snapshot URL');
    }
    seen.add(datasetUrl);
    selected.push(dataset);
  }
  return selected;
}

function emptyParseResult(): TendernedDomainParseResult {
  return {
    evidence: [],
    releaseCount: 0,
    supplierPartyCount: 0,
    awardedSupplierPartyCount: 0,
    invalidIdentifierCount: 0,
    nonDutchSupplierCount: 0,
    unconfirmedAwardCount: 0,
    ambiguousPairingCount: 0,
    invalidUrlCount: 0,
    incompleteRecordCount: 0,
  };
}

function addParseStatistics(
  aggregate: TendernedDomainParseResult,
  value: TendernedDomainParseResult,
): void {
  aggregate.releaseCount += value.releaseCount;
  aggregate.supplierPartyCount += value.supplierPartyCount;
  aggregate.awardedSupplierPartyCount += value.awardedSupplierPartyCount;
  aggregate.invalidIdentifierCount += value.invalidIdentifierCount;
  aggregate.nonDutchSupplierCount += value.nonDutchSupplierCount;
  aggregate.unconfirmedAwardCount += value.unconfirmedAwardCount;
  aggregate.ambiguousPairingCount += value.ambiguousPairingCount;
  aggregate.invalidUrlCount += value.invalidUrlCount;
  aggregate.incompleteRecordCount += value.incompleteRecordCount;
}

function evidenceIdentity(value: TendernedDomainEvidence): string {
  return [
    value.sourceRecordId,
    value.sourceName,
    value.kvkNumber,
    value.officialUrl,
    value.evidenceUrl,
  ].join('\u0000');
}

function exactFinalDatasetUrl(expected: string, actual: string): boolean {
  try {
    const expectedUrl = new URL(expected);
    const finalUrl = new URL(actual);
    return (
      finalUrl.origin === expectedUrl.origin &&
      finalUrl.pathname === expectedUrl.pathname &&
      finalUrl.search === '' &&
      finalUrl.hash === '' &&
      finalUrl.username === '' &&
      finalUrl.password === ''
    );
  } catch {
    return false;
  }
}

export async function fetchTendernedDomainEvidence(
  http: AtsHttpClient,
  options: TendernedDomainFetchOptions = {},
): Promise<TendernedDomainFetchResult> {
  const datasets = selectDatasets(options.datasetUrls);
  const aggregate = emptyParseResult();
  const evidenceByIdentity = new Map<string, TendernedDomainEvidence>();
  const datasetStatistics: TendernedDatasetStatistics[] = [];

  // Deliberately sequential: these are large immutable files on one public origin.
  for (const dataset of datasets) {
    const response = await http.get(dataset.url, {
      allowedOrigins: [TENDERNED_ORIGIN],
    });
    requireSuccessfulResponse('tenderned_domain_source', response);
    if (!exactFinalDatasetUrl(dataset.url, response.finalUrl)) {
      throw new AtsResponseError(
        'tenderned_domain_source',
        'bulk response left the pinned TenderNed dataset URL',
      );
    }
    const contentType = response.headers['content-type'];
    if (contentType !== undefined && !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      throw new AtsResponseError('tenderned_domain_source', 'bulk response is not JSON content');
    }
    const parsed = parseTendernedDomainEvidenceForVersion(
      response.body,
      dataset.sourceVersion,
    );
    addParseStatistics(aggregate, parsed);
    for (const evidence of parsed.evidence) {
      // Later snapshots win only when every evidence field except the snapshot version is equal.
      evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
    }
    datasetStatistics.push({
      datasetUrl: dataset.url,
      period: dataset.period,
      sourceVersion: dataset.sourceVersion,
      evidenceCount: parsed.evidence.length,
      releaseCount: parsed.releaseCount,
      supplierPartyCount: parsed.supplierPartyCount,
      awardedSupplierPartyCount: parsed.awardedSupplierPartyCount,
      invalidIdentifierCount: parsed.invalidIdentifierCount,
      nonDutchSupplierCount: parsed.nonDutchSupplierCount,
      unconfirmedAwardCount: parsed.unconfirmedAwardCount,
      ambiguousPairingCount: parsed.ambiguousPairingCount,
      invalidUrlCount: parsed.invalidUrlCount,
      incompleteRecordCount: parsed.incompleteRecordCount,
    });
  }

  aggregate.evidence = [...evidenceByIdentity.values()].sort(
    (left, right) =>
      left.kvkNumber.localeCompare(right.kvkNumber) ||
      left.sourceRecordId.localeCompare(right.sourceRecordId) ||
      left.officialUrl.localeCompare(right.officialUrl),
  );
  return {
    ...aggregate,
    datasetsFetched: datasetStatistics.length,
    datasetStatistics,
  };
}
