import { isIP } from 'node:net';

import { z } from 'zod';

import { isForbiddenDiscoveryHostname } from './domain-candidates.js';

export const structuredDomainSourceSchema = z.enum([
  'roo',
  'iati',
  'ted',
  'tenderned',
  'wikidata',
]);

export type StructuredDomainSource = z.infer<typeof structuredDomainSourceSchema>;

export type StructuredOfficialUrl = {
  officialUrl: string;
  hostnameKey: string;
};

export type StructuredDomainEvidence = {
  source: StructuredDomainSource;
  sourceVersion: string;
  sourceRecordId: string;
  sourceName: string;
  kvkNumber: string;
  officialUrl: string;
  hostnameKey: string;
  evidenceUrl: string;
};

type StructuredDomainEvidenceInput = Omit<
  StructuredDomainEvidence,
  'kvkNumber' | 'officialUrl' | 'hostnameKey'
> & {
  kvkNumber: string;
  officialUrl: string;
};

const RESERVED_HOST_SUFFIXES = [
  '.example',
  '.home',
  '.internal',
  '.invalid',
  '.local',
  '.localhost',
  '.test',
] as const;

function normalizeHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, '');
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !hostname.includes('.') ||
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    RESERVED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isForbiddenDiscoveryHostname(hostname)
  ) {
    return null;
  }
  const labels = hostname.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith('-') ||
        label.endsWith('-') ||
        !/^[a-z0-9-]+$/u.test(label),
    )
  ) {
    return null;
  }
  return hostname;
}

export function normalizeStructuredKvk(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{7,8}$/u.test(trimmed)) return null;
  return trimmed.padStart(8, '0');
}

export function normalizeStructuredOfficialUrl(value: string): StructuredOfficialUrl | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username !== '' || url.password !== '' || url.port !== '') return null;
    const hostname = normalizeHostname(url.hostname);
    if (hostname === null) return null;

    url.hostname = hostname;
    url.hash = '';
    url.search = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/u, '');
    return {
      officialUrl: url.toString(),
      hostnameKey: hostname.replace(/^www\./u, ''),
    };
  } catch {
    return null;
  }
}

function normalizeEvidenceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username !== '' || url.password !== '') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function createStructuredDomainEvidence(
  input: StructuredDomainEvidenceInput,
): StructuredDomainEvidence | null {
  const source = structuredDomainSourceSchema.safeParse(input.source);
  const kvkNumber = normalizeStructuredKvk(input.kvkNumber);
  const website = normalizeStructuredOfficialUrl(input.officialUrl);
  const evidenceUrl = normalizeEvidenceUrl(input.evidenceUrl);
  const sourceVersion = input.sourceVersion.trim();
  const sourceRecordId = input.sourceRecordId.trim();
  const sourceName = input.sourceName.trim();
  if (
    !source.success ||
    kvkNumber === null ||
    website === null ||
    evidenceUrl === null ||
    sourceVersion.length === 0 ||
    sourceRecordId.length === 0 ||
    sourceName.length === 0
  ) {
    return null;
  }
  return {
    source: source.data,
    sourceVersion,
    sourceRecordId,
    sourceName,
    kvkNumber,
    officialUrl: website.officialUrl,
    hostnameKey: website.hostnameKey,
    evidenceUrl,
  };
}

function websiteRank(value: string): readonly [number, number, number, string] {
  const url = new URL(value);
  return [
    url.protocol === 'https:' ? 0 : 1,
    url.pathname === '/' ? 0 : 1,
    url.pathname.length,
    value,
  ];
}

export function compareStructuredOfficialUrls(left: string, right: string): number {
  const leftRank = websiteRank(left);
  const rightRank = websiteRank(right);
  return (
    leftRank[0] - rightRank[0] ||
    leftRank[1] - rightRank[1] ||
    leftRank[2] - rightRank[2] ||
    leftRank[3].localeCompare(rightRank[3])
  );
}
