import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';

import { createSponsorIdentity, type SponsorIdentity } from './normalize.js';

export const OFFICIAL_IND_WORK_REGISTER_URL =
  'https://ind.nl/en/public-register-recognised-sponsors/public-register-work';

export type OfficialSponsorRecord = SponsorIdentity & {
  sourceIdentityKey: string;
};

export type OfficialSponsorSnapshot = {
  sourceUrl: string;
  sourceLastUpdated: Date;
  records: OfficialSponsorRecord[];
  rawRowCount: number;
  duplicateRowCount: number;
  membershipHash: string;
};

export type SponsorParserOptions = {
  minimumRows?: number;
  sourceUrl?: string;
};

const monthNumbers = new Map([
  ['january', 0],
  ['february', 1],
  ['march', 2],
  ['april', 3],
  ['may', 4],
  ['june', 5],
  ['july', 6],
  ['august', 7],
  ['september', 8],
  ['october', 9],
  ['november', 10],
  ['december', 11],
]);

function createSourceIdentityKey(legalName: string, kvkNumber: string | null): string {
  return createHash('sha256').update(`${legalName}\0${kvkNumber ?? ''}`).digest('hex');
}

function parseDeclaredUpdateDate(pageText: string): Date {
  const match = /overview was last updated on\s+(\d{1,2})\s+([a-z]+)\s+(\d{4})/iu.exec(pageText);
  if (!match) throw new Error('IND register update date was not found');
  const [, dayText, monthText, yearText] = match;
  const month = monthNumbers.get((monthText ?? '').toLowerCase());
  if (month === undefined || !dayText || !yearText) throw new Error('IND register update date is invalid');
  const date = new Date(Date.UTC(Number(yearText), month, Number(dayText)));
  if (Number.isNaN(date.valueOf())) throw new Error('IND register update date is invalid');
  return date;
}

function findSponsorTable($: cheerio.CheerioAPI) {
  const candidate = $('table')
    .filter((_index, table) => {
      const headers = $(table)
        .find('thead th')
        .map((_headerIndex, header) => $(header).text().replace(/\s+/g, ' ').trim().toLowerCase())
        .get();
      return headers.some((header) => header === 'organisation') && headers.some((header) => header.includes('kvk'));
    })
    .first();
  if (candidate.length === 0) throw new Error('IND sponsor table with expected headers was not found');
  return candidate;
}

export function parseOfficialSponsorRegister(
  html: string,
  options: SponsorParserOptions = {},
): OfficialSponsorSnapshot {
  const minimumRows = options.minimumRows ?? 10_000;
  const sourceUrl = options.sourceUrl ?? OFFICIAL_IND_WORK_REGISTER_URL;
  const $ = cheerio.load(html);
  const sourceLastUpdated = parseDeclaredUpdateDate($.root().text().replace(/\s+/g, ' '));
  const table = findSponsorTable($);
  const rows = table.find('tbody tr').toArray();
  if (rows.length < minimumRows) {
    throw new Error(`IND sponsor table contains ${rows.length} rows; expected at least ${minimumRows}`);
  }

  const recordsByIdentity = new Map<string, OfficialSponsorRecord>();
  for (const [index, row] of rows.entries()) {
    const legalName = $(row).find('th[scope="row"]').first().text();
    const kvkNumber = $(row).find('td').first().text();
    let identity: SponsorIdentity;
    try {
      identity = createSponsorIdentity(legalName, kvkNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid IND sponsor row ${index + 1}: ${message}`, { cause: error });
    }
    const sourceIdentityKey = createSourceIdentityKey(identity.legalName, identity.kvkNumber);
    recordsByIdentity.set(sourceIdentityKey, { ...identity, sourceIdentityKey });
  }

  const records = [...recordsByIdentity.values()].sort((left, right) =>
    left.sourceIdentityKey.localeCompare(right.sourceIdentityKey),
  );
  const membershipHash = createHash('sha256')
    .update(records.map((record) => `${record.legalName}\0${record.kvkNumber ?? ''}`).sort().join('\n'))
    .digest('hex');

  return {
    sourceUrl,
    sourceLastUpdated,
    records,
    rawRowCount: rows.length,
    duplicateRowCount: rows.length - records.length,
    membershipHash,
  };
}
