import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';

import type { NormalizedVacancy } from '../domain/models.js';

export const VACANCY_HASH_VERSION = 'vacancy-content-v2';
export const VACANCY_REVISION_VERSION = 'vacancy-revision-v1';
export const VACANCY_SEMANTIC_FINGERPRINT_VERSION = 'vacancy-semantic-fingerprint-v1';

const trackingParameters = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'ref',
  'referrer',
  'source',
  'trk',
  'trackingid',
]);

export function normalizeVacancyText(input: string): string {
  const $ = cheerio.load(input);
  return $.root()
    .text()
    .normalize('NFKC')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en');
}

export function canonicalizeVacancyUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || trackingParameters.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function createVacancyContentHash(vacancy: NormalizedVacancy): string {
  const semanticContent = {
    version: VACANCY_HASH_VERSION,
    title: normalizeVacancyText(vacancy.title),
    description: normalizeVacancyText(vacancy.description),
    location: vacancy.location ? normalizeVacancyText(vacancy.location) : null,
    remote: vacancy.remote,
    workplaceMode: vacancy.workplaceMode,
    employmentType: vacancy.employmentType ? normalizeVacancyText(vacancy.employmentType) : null,
    url: canonicalizeVacancyUrl(vacancy.url),
  };
  return createHash('sha256').update(JSON.stringify(semanticContent)).digest('hex');
}

/** Tracks report-relevant metadata without invalidating semantic score cache entries. */
export function createVacancyRevisionHash(vacancy: NormalizedVacancy): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: VACANCY_REVISION_VERSION,
        contentHash: createVacancyContentHash(vacancy),
        postedAt: vacancy.postedAt?.toISOString() ?? null,
      }),
    )
    .digest('hex');
}

export function createVacancySemanticFingerprint(
  vacancy: Pick<NormalizedVacancy, 'title' | 'description' | 'location'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: VACANCY_SEMANTIC_FINGERPRINT_VERSION,
        title: normalizeVacancyText(vacancy.title),
        description: normalizeVacancyText(vacancy.description),
        location: vacancy.location ? normalizeVacancyText(vacancy.location) : null,
      }),
    )
    .digest('hex');
}

export function createFallbackExternalId(sourceIdentity: string, vacancy: Omit<NormalizedVacancy, 'externalId'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sourceIdentity,
        url: canonicalizeVacancyUrl(vacancy.url),
        title: normalizeVacancyText(vacancy.title),
        location: vacancy.location ? normalizeVacancyText(vacancy.location) : null,
      }),
    )
    .digest('hex');
}
