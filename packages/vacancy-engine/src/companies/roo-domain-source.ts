import * as cheerio from 'cheerio';

import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import {
  createStructuredDomainEvidence,
  type StructuredDomainEvidence,
} from './structured-domain-evidence.js';

export const ROO_DOMAIN_SOURCE_VERSION = 'roo-kvk-domain-v1';
export const ROO_BULK_XML_URL = 'https://organisaties.overheid.nl/archive/exportOO.xml';
const ROO_ORIGIN = new URL(ROO_BULK_XML_URL).origin;
const MAX_ROO_XML_CHARACTERS = 80 * 1024 * 1024;

export type RooDomainParseResult = {
  evidence: StructuredDomainEvidence[];
  recordCount: number;
  kvkRecordCount: number;
  invalidKvkRecordCount: number;
  invalidUrlCount: number;
  incompleteRecordCount: number;
};

type CheerioInput = Parameters<cheerio.CheerioAPI>[0];

function elementChildren($: cheerio.CheerioAPI, node: CheerioInput, selector: string) {
  return $(node).children(selector);
}

function directText($: cheerio.CheerioAPI, node: CheerioInput, selector: string): string {
  return elementChildren($, node, selector).first().text().trim();
}

function recordIdentifier($: cheerio.CheerioAPI, record: CheerioInput): string | null {
  const attributeIdentifier = $(record).attr('p:resourceIdentifierTOOI')?.trim();
  if (attributeIdentifier !== undefined && attributeIdentifier.length > 0) {
    return attributeIdentifier;
  }
  const identificationCodes = elementChildren($, record, 'p\\:identificatiecodes');
  const identifier = identificationCodes
    .children('p\\:resourceIdentifier')
    .filter((_index, node) => $(node).attr('p:naam') === 'resourceIdentifierTOOI')
    .first()
    .text()
    .trim();
  if (identifier.length > 0) return identifier;
  const systemId = $(record).attr('p:systeemId')?.trim();
  return systemId === undefined || systemId.length === 0 ? null : `roo:${systemId}`;
}

function recordEvidenceUrl(sourceRecordId: string): string {
  return sourceRecordId.startsWith('http') ? sourceRecordId : ROO_BULK_XML_URL;
}

function directKvkValues($: cheerio.CheerioAPI, record: CheerioInput): string[] {
  const identificationCodes = elementChildren($, record, 'p\\:identificatiecodes');
  return identificationCodes
    .children('p\\:resourceIdentifier')
    .filter((_index, node) => $(node).attr('p:naam') === 'KVK-nummer')
    .toArray()
    .map((node) => $(node).text().trim())
    .filter((value) => value.length > 0);
}

function directContactUrls($: cheerio.CheerioAPI, record: CheerioInput): string[] {
  return elementChildren($, record, 'p\\:contact')
    .children('p\\:internetadressen')
    .children('p\\:internetadres')
    .children('p\\:url')
    .toArray()
    .map((node) => $(node).text().trim())
    .filter((value) => value.length > 0);
}

export function parseRooDomainEvidence(xml: string): RooDomainParseResult {
  if (xml.length === 0 || xml.length > MAX_ROO_XML_CHARACTERS) {
    throw new AtsResponseError('roo_domain_source', 'bulk XML is empty or exceeds the parser limit');
  }
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($('p\\:overheidsorganisaties').length !== 1) {
    throw new AtsResponseError('roo_domain_source', 'bulk response is not a ROO export');
  }

  const evidence: StructuredDomainEvidence[] = [];
  let recordCount = 0;
  let kvkRecordCount = 0;
  let invalidKvkRecordCount = 0;
  let invalidUrlCount = 0;
  let incompleteRecordCount = 0;

  $('p\\:organisatie').each((_index, node) => {
    recordCount += 1;
    const kvkValues = directKvkValues($, node);
    if (kvkValues.length === 0) return;
    kvkRecordCount += 1;
    const normalizedKvks = new Set(
      kvkValues.map((value) => (/^\d{7,8}$/u.test(value) ? value.padStart(8, '0') : null)),
    );
    if (normalizedKvks.has(null) || normalizedKvks.size !== 1) {
      invalidKvkRecordCount += 1;
      return;
    }
    const kvkNumber = [...normalizedKvks][0];
    const sourceName = directText($, node, 'p\\:naam');
    const sourceRecordId = recordIdentifier($, node);
    if (
      kvkNumber === undefined ||
      kvkNumber === null ||
      sourceName.length === 0 ||
      sourceRecordId === null
    ) {
      incompleteRecordCount += 1;
      return;
    }

    const seenUrls = new Set<string>();
    for (const officialUrl of directContactUrls($, node)) {
      const item = createStructuredDomainEvidence({
        source: 'roo',
        sourceVersion: ROO_DOMAIN_SOURCE_VERSION,
        sourceRecordId,
        sourceName,
        kvkNumber,
        officialUrl,
        evidenceUrl: recordEvidenceUrl(sourceRecordId),
      });
      if (item === null) {
        invalidUrlCount += 1;
        continue;
      }
      const identity = `${item.sourceRecordId}:${item.officialUrl}`;
      if (!seenUrls.has(identity)) {
        seenUrls.add(identity);
        evidence.push(item);
      }
    }
  });

  return {
    evidence,
    recordCount,
    kvkRecordCount,
    invalidKvkRecordCount,
    invalidUrlCount,
    incompleteRecordCount,
  };
}

export async function fetchRooDomainEvidence(http: AtsHttpClient): Promise<RooDomainParseResult> {
  const response = await http.get(ROO_BULK_XML_URL, { allowedOrigins: [ROO_ORIGIN] });
  requireSuccessfulResponse('roo_domain_source', response);
  if (new URL(response.finalUrl).origin !== ROO_ORIGIN) {
    throw new AtsResponseError('roo_domain_source', 'bulk response left the ROO origin');
  }
  return parseRooDomainEvidence(response.body);
}
