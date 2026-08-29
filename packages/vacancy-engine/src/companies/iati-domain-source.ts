import { z } from 'zod';

import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import {
  createStructuredDomainEvidence,
  type StructuredDomainEvidence,
} from './structured-domain-evidence.js';

export const IATI_DOMAIN_SOURCE_VERSION = 'iati-reporting-org-domain-v1';
export const IATI_REPORTING_ORGS_URL =
  'https://merged.dashboard.iatistandard.org/api/reporting-orgs/?format=json&page_size=5000';
const IATI_ORIGIN = new URL(IATI_REPORTING_ORGS_URL).origin;
const IATI_REPORTING_ORGS_PATH = '/api/reporting-orgs/';
const MAX_IATI_PAGES = 100;

const reportingOrgSchema = z.looseObject({
  id: z.string().optional().default(''),
  short_name: z.string().optional().default(''),
  human_readable_name: z.string().optional().default(''),
  organisation_identifier: z.string().nullable().optional(),
  reporting_source_type: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
});

const reportingOrgPageSchema = z.object({
  count: z.number().int().nonnegative(),
  next: z.string().nullable(),
  results: z.array(reportingOrgSchema),
});

type ReportingOrgPage = z.infer<typeof reportingOrgPageSchema>;

export type IatiDomainParseResult = {
  evidence: StructuredDomainEvidence[];
  recordCount: number;
  primarySourceCount: number;
  invalidIdentifierCount: number;
  invalidUrlCount: number;
  incompleteRecordCount: number;
};

export type IatiDomainFetchResult = IatiDomainParseResult & {
  pagesFetched: number;
  reportedRecordCount: number;
};

function parsePage(payload: unknown): ReportingOrgPage {
  return reportingOrgPageSchema.parse(payload);
}

function reportingOrgEvidenceUrl(shortName: string): string {
  return `${IATI_ORIGIN}${IATI_REPORTING_ORGS_PATH}${encodeURIComponent(shortName)}/`;
}

export function parseIatiDomainPage(payload: unknown): IatiDomainParseResult {
  const page = parsePage(payload);
  const evidence: StructuredDomainEvidence[] = [];
  let primarySourceCount = 0;
  let invalidIdentifierCount = 0;
  let invalidUrlCount = 0;
  let incompleteRecordCount = 0;

  for (const record of page.results) {
    if (record.reporting_source_type !== 'primary_source') continue;
    primarySourceCount += 1;
    const identifier = record.organisation_identifier?.trim() ?? '';
    const match = /^NL-KVK-(\d{7,8})(?:-|$)/u.exec(identifier);
    if (match === null) {
      invalidIdentifierCount += 1;
      continue;
    }
    const kvkNumber = match[1];
    const website = record.website?.trim() ?? '';
    const sourceRecordId = record.id.trim();
    const sourceName = record.human_readable_name.trim();
    const shortName = record.short_name.trim();
    if (
      kvkNumber === undefined ||
      sourceRecordId.length === 0 ||
      sourceName.length === 0 ||
      shortName.length === 0 ||
      website.length === 0
    ) {
      incompleteRecordCount += 1;
      continue;
    }
    const item = createStructuredDomainEvidence({
      source: 'iati',
      sourceVersion: IATI_DOMAIN_SOURCE_VERSION,
      sourceRecordId,
      sourceName,
      kvkNumber,
      officialUrl: website,
      evidenceUrl: reportingOrgEvidenceUrl(shortName),
    });
    if (item === null) {
      invalidUrlCount += 1;
      continue;
    }
    evidence.push(item);
  }

  return {
    evidence,
    recordCount: page.results.length,
    primarySourceCount,
    invalidIdentifierCount,
    invalidUrlCount,
    incompleteRecordCount,
  };
}

function normalizePageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AtsResponseError('iati_domain_source', 'pagination URL is invalid', null, {
      cause: error,
    });
  }
  if (
    url.origin !== IATI_ORIGIN ||
    url.pathname !== IATI_REPORTING_ORGS_PATH ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new AtsResponseError('iati_domain_source', 'pagination URL left the reporting-org feed');
  }
  url.hash = '';
  return url.toString();
}

function mergePageResult(target: IatiDomainParseResult, page: IatiDomainParseResult): void {
  target.evidence.push(...page.evidence);
  target.recordCount += page.recordCount;
  target.primarySourceCount += page.primarySourceCount;
  target.invalidIdentifierCount += page.invalidIdentifierCount;
  target.invalidUrlCount += page.invalidUrlCount;
  target.incompleteRecordCount += page.incompleteRecordCount;
}

export async function fetchIatiDomainEvidence(
  http: AtsHttpClient,
  initialUrl = IATI_REPORTING_ORGS_URL,
): Promise<IatiDomainFetchResult> {
  const aggregate: IatiDomainParseResult = {
    evidence: [],
    recordCount: 0,
    primarySourceCount: 0,
    invalidIdentifierCount: 0,
    invalidUrlCount: 0,
    incompleteRecordCount: 0,
  };
  const visited = new Set<string>();
  let next: string | null = normalizePageUrl(initialUrl);
  let pagesFetched = 0;
  let reportedRecordCount = 0;

  while (next !== null) {
    if (visited.has(next)) {
      throw new AtsResponseError('iati_domain_source', 'pagination cycle detected');
    }
    if (pagesFetched >= MAX_IATI_PAGES) {
      throw new AtsResponseError('iati_domain_source', 'pagination exceeded the page limit');
    }
    visited.add(next);
    const response = await http.get(next, { allowedOrigins: [IATI_ORIGIN] });
    requireSuccessfulResponse('iati_domain_source', response);
    if (new URL(response.finalUrl).origin !== IATI_ORIGIN) {
      throw new AtsResponseError('iati_domain_source', 'response left the IATI origin');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new AtsResponseError('iati_domain_source', 'response is not valid JSON', null, {
        cause: error,
      });
    }
    const parsedPage = parsePage(payload);
    reportedRecordCount = Math.max(reportedRecordCount, parsedPage.count);
    mergePageResult(aggregate, parseIatiDomainPage(parsedPage));
    pagesFetched += 1;
    next = parsedPage.next === null ? null : normalizePageUrl(parsedPage.next);
  }

  return { ...aggregate, pagesFetched, reportedRecordCount };
}
