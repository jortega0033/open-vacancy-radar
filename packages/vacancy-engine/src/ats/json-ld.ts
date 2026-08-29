import { createHash } from 'node:crypto';

import * as cheerio from 'cheerio';

import type { NormalizedVacancy } from '../domain/models.js';
import {
  htmlToText,
  httpUrl,
  joinNonEmpty,
  makeVacancy,
  optionalString,
  parseDate,
} from './shared.js';

export type JsonLdExtractionOptions = {
  source?: string;
  allowedOrigins?: readonly string[];
  preferNodeUrl?: boolean;
};

export type JsonLdExtractionResult = {
  vacancies: NormalizedVacancy[];
  jobPostingNodes: number;
  invalidNodes: number;
  duplicateNodes: number;
  malformedScripts: number;
};

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function typesOf(node: Record<string, unknown>): string[] {
  const type = node['@type'];
  if (typeof type === 'string') return [type];
  if (!Array.isArray(type)) return [];
  return type.filter((entry): entry is string => typeof entry === 'string');
}

function collectJobPostingNodes(value: unknown, target: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectJobPostingNodes(entry, target);
    return;
  }
  const node = objectOrNull(value);
  if (node === null) return;
  if (typesOf(node).some((type) => type.toLowerCase() === 'jobposting')) target.push(node);
  const graph = node['@graph'];
  if (graph !== undefined) collectJobPostingNodes(graph, target);
}

function countryName(value: unknown): string | null {
  if (typeof value === 'string') return optionalString(value);
  const record = objectOrNull(value);
  return optionalString(record?.name);
}

function addressText(value: unknown): string | null {
  if (typeof value === 'string') return optionalString(value);
  const address = objectOrNull(value);
  if (address === null) return null;
  return joinNonEmpty([
    optionalString(address.streetAddress),
    optionalString(address.postalCode),
    optionalString(address.addressLocality),
    optionalString(address.addressRegion),
    countryName(address.addressCountry),
  ]);
}

function placeText(value: unknown): string | null {
  if (typeof value === 'string') return optionalString(value);
  const place = objectOrNull(value);
  if (place === null) return null;
  return addressText(place.address) ?? optionalString(place.name);
}

function locationText(node: Record<string, unknown>): string | null {
  const locations = Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation];
  const physical = locations.map((location) => placeText(location));
  if (physical.some((location) => location !== null)) return joinNonEmpty(physical);
  const requirements = Array.isArray(node.applicantLocationRequirements)
    ? node.applicantLocationRequirements
    : [node.applicantLocationRequirements];
  return joinNonEmpty(requirements.map((requirement) => placeText(requirement)));
}

function employmentType(value: unknown): string | null {
  if (Array.isArray(value)) return joinNonEmpty(value.map((entry) => optionalString(entry)));
  return optionalString(value);
}

function identifier(node: Record<string, unknown>, canonicalUrl: string): string {
  const identifierValue = node.identifier;
  let value = optionalString(identifierValue);
  if (value === null) {
    const record = objectOrNull(identifierValue);
    value = optionalString(record?.value) ?? optionalString(record?.name);
  }
  const nodeId = optionalString(node['@id']);
  value ??=
    nodeId?.startsWith('#') === true
      ? (httpUrl(nodeId, canonicalUrl) ?? nodeId)
      : nodeId;
  value ??= canonicalUrl;
  return value.length <= 500
    ? value
    : createHash('sha256').update(value).digest('hex');
}

function isRemote(node: Record<string, unknown>): boolean | null {
  const raw = Array.isArray(node.jobLocationType) ? node.jobLocationType : [node.jobLocationType];
  if (raw.some((value) => optionalString(value)?.toUpperCase() === 'TELECOMMUTE')) return true;
  return node.jobLocation === undefined ? null : false;
}

function normalizeNode(
  node: Record<string, unknown>,
  pageUrl: string,
  canonicalPageUrl: string | null,
  options: JsonLdExtractionOptions,
): NormalizedVacancy | null {
  const title = optionalString(node.title);
  const descriptionHtml = optionalString(node.description);
  const nodeUrl = httpUrl(node.url, pageUrl);
  const fallbackPageUrl = httpUrl(pageUrl);
  const candidates = options.preferNodeUrl
    ? [nodeUrl, canonicalPageUrl, fallbackPageUrl]
    : [canonicalPageUrl, nodeUrl, fallbackPageUrl];
  const allowedOrigins =
    options.allowedOrigins === undefined
      ? null
      : new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));
  const url =
    candidates.find(
      (candidate): candidate is string =>
        candidate !== null &&
        (allowedOrigins === null || allowedOrigins.has(new URL(candidate).origin)),
    ) ?? null;
  if (title === null || descriptionHtml === null || url === null) return null;
  const remote = isRemote(node);
  return makeVacancy({
    externalId: identifier(node, url),
    title,
    description: htmlToText(descriptionHtml),
    location: locationText(node),
    remote,
    workplaceMode: remote === true ? 'remote' : remote === false ? 'onsite' : 'unknown',
    url,
    postedAt: parseDate(node.datePosted),
    employmentType: employmentType(node.employmentType),
    source: options.source ?? 'json_ld',
  });
}

/** Extracts normalized JobPosting nodes plus diagnostics from one already-fetched page. */
export function extractJsonLdVacanciesWithDiagnostics(
  html: string,
  pageUrl: string,
  options: JsonLdExtractionOptions = {},
): JsonLdExtractionResult {
  const $ = cheerio.load(html);
  const canonicalPageUrl = httpUrl($('link[rel~="canonical"]').first().attr('href'), pageUrl);
  const nodes: Record<string, unknown>[] = [];
  let malformedScripts = 0;
  $('script[type="application/ld+json"]').each((_index, script) => {
    const json = $(script).text().trim();
    if (json.length === 0) return;
    try {
      collectJobPostingNodes(JSON.parse(json) as unknown, nodes);
    } catch {
      // One malformed script must not hide valid JobPosting data in other scripts.
      malformedScripts += 1;
    }
  });
  const byId = new Map<string, NormalizedVacancy>();
  let invalidNodes = 0;
  let duplicateNodes = 0;
  for (const node of nodes) {
    const vacancy = normalizeNode(node, pageUrl, canonicalPageUrl, options);
    if (vacancy === null) invalidNodes += 1;
    else if (byId.has(vacancy.externalId)) duplicateNodes += 1;
    else byId.set(vacancy.externalId, vacancy);
  }
  return {
    vacancies: [...byId.values()],
    jobPostingNodes: nodes.length,
    invalidNodes,
    duplicateNodes,
    malformedScripts,
  };
}

/** Backward-compatible convenience wrapper for callers that need only normalized vacancies. */
export function extractJsonLdVacancies(
  html: string,
  pageUrl: string,
  options: JsonLdExtractionOptions = {},
): NormalizedVacancy[] {
  return extractJsonLdVacanciesWithDiagnostics(html, pageUrl, options).vacancies;
}
