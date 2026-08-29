import { z } from 'zod';

import type { AtsHttpClient } from '../ats/http.js';
import { requireSuccessfulResponse } from '../ats/http.js';
import { isForbiddenDiscoveryHostname } from './domain-candidates.js';
import {
  createStructuredDomainEvidence,
  type StructuredDomainEvidence,
} from './structured-domain-evidence.js';

export const WIKIDATA_DOMAIN_QUERY_VERSION = 'wikidata-kvk-domain-v1';
export const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

export const WIKIDATA_KVK_WEBSITE_QUERY = `
SELECT ?item ?kvk ?website WHERE {
  ?item wdt:P3220 ?kvk ;
        wdt:P856 ?website .
}
ORDER BY ?kvk ?item ?website
`.trim();

const bindingValueSchema = z.object({ value: z.string().min(1) }).loose();
const responseSchema = z.object({
  results: z.object({
    bindings: z.array(
      z.object({
        item: bindingValueSchema,
        kvk: bindingValueSchema,
        website: bindingValueSchema,
      }),
    ),
  }),
});

export type SponsorForDomainEnrichment = {
  id: string;
  legalName: string;
  kvkNumber: string | null;
};

export type WikidataDomainCandidate = {
  sponsorId: string;
  legalName: string;
  kvkNumber: string;
  officialUrl: string;
  wikidataItems: string[];
};

export type WikidataDomainOutcome =
  | {
      sponsorId: string;
      status: 'candidate';
      reasonCode: 'wikidata_exact_kvk_single_official_host';
      candidate: WikidataDomainCandidate;
    }
  | {
      sponsorId: string;
      status: 'not_found';
      reasonCode: 'no_structured_domain_match';
    }
  | {
      sponsorId: string;
      status: 'missing_kvk';
      reasonCode: 'missing_kvk';
    }
  | {
      sponsorId: string;
      status: 'ambiguous';
      reasonCode: 'multiple_structured_official_hosts' | 'duplicate_structured_kvk_items';
      hostnames: string[];
      evidenceUrls: string[];
    };

export type WikidataDomainResolution = {
  outcomes: WikidataDomainOutcome[];
  candidates: WikidataDomainCandidate[];
  bindingCount: number;
  invalidBindingCount: number;
  uniqueKvkCount: number;
};

export type WikidataDomainEvidenceParseResult = {
  evidence: StructuredDomainEvidence[];
  bindingCount: number;
  invalidBindingCount: number;
};

type ParsedBinding = {
  kvkNumber: string;
  itemUrl: string;
  websiteUrl: string;
  hostnameKey: string;
};

function normalizeKvk(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{7,8}$/u.test(trimmed)) return null;
  return trimmed.padStart(8, '0');
}

function normalizeItemUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:'
    ) return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeWebsiteUrl(value: string): { url: string; hostnameKey: string } | null {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username !== '' || url.password !== '') return null;
    if (url.port !== '' && !['80', '443'].includes(url.port)) return null;
    if (isForbiddenDiscoveryHostname(url.hostname)) return null;
    url.hash = '';
    url.search = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/u, '');
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (hostname.length === 0) return null;
    const hostnameKey = hostname.replace(/^www\./u, '');
    return { url: url.toString(), hostnameKey };
  } catch {
    return null;
  }
}

function parseBinding(value: z.infer<typeof responseSchema>['results']['bindings'][number]): ParsedBinding | null {
  const kvkNumber = normalizeKvk(value.kvk.value);
  const itemUrl = normalizeItemUrl(value.item.value);
  const website = normalizeWebsiteUrl(value.website.value);
  if (kvkNumber === null || itemUrl === null || website === null) return null;
  return {
    kvkNumber,
    itemUrl,
    websiteUrl: website.url,
    hostnameKey: website.hostnameKey,
  };
}

function websiteRank(value: string): readonly [number, number, number, string] {
  const url = new URL(value);
  return [url.protocol === 'https:' ? 0 : 1, url.pathname === '/' ? 0 : 1, url.pathname.length, value];
}

function compareWebsite(left: string, right: string): number {
  const leftRank = websiteRank(left);
  const rightRank = websiteRank(right);
  return (
    leftRank[0] - rightRank[0] ||
    leftRank[1] - rightRank[1] ||
    leftRank[2] - rightRank[2] ||
    leftRank[3].localeCompare(rightRank[3])
  );
}

export function resolveWikidataDomains(
  payload: unknown,
  sponsors: readonly SponsorForDomainEnrichment[],
): WikidataDomainResolution {
  const parsed = responseSchema.parse(payload);
  const bindings: ParsedBinding[] = [];
  let invalidBindingCount = 0;
  for (const raw of parsed.results.bindings) {
    const binding = parseBinding(raw);
    if (binding === null) invalidBindingCount += 1;
    else bindings.push(binding);
  }

  const byKvk = new Map<string, ParsedBinding[]>();
  for (const binding of bindings) {
    const group = byKvk.get(binding.kvkNumber) ?? [];
    group.push(binding);
    byKvk.set(binding.kvkNumber, group);
  }

  const outcomes: WikidataDomainOutcome[] = [];
  const candidates: WikidataDomainCandidate[] = [];
  for (const sponsor of sponsors) {
    if (sponsor.kvkNumber === null) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'missing_kvk',
        reasonCode: 'missing_kvk',
      });
      continue;
    }
    const kvkNumber = normalizeKvk(sponsor.kvkNumber);
    const sponsorBindings = kvkNumber === null ? undefined : byKvk.get(kvkNumber);
    if (kvkNumber === null || sponsorBindings === undefined || sponsorBindings.length === 0) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'not_found',
        reasonCode: 'no_structured_domain_match',
      });
      continue;
    }

    const hosts = new Map<string, ParsedBinding[]>();
    for (const binding of sponsorBindings) {
      const group = hosts.get(binding.hostnameKey) ?? [];
      group.push(binding);
      hosts.set(binding.hostnameKey, group);
    }
    const evidenceUrls = [...new Set(sponsorBindings.map((binding) => binding.itemUrl))].sort();
    if (hosts.size !== 1 || evidenceUrls.length !== 1) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'ambiguous',
        reasonCode:
          hosts.size !== 1
            ? 'multiple_structured_official_hosts'
            : 'duplicate_structured_kvk_items',
        hostnames: [...hosts.keys()].sort(),
        evidenceUrls,
      });
      continue;
    }

    const onlyHost = [...hosts.values()][0];
    if (onlyHost === undefined || onlyHost.length === 0) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'not_found',
        reasonCode: 'no_structured_domain_match',
      });
      continue;
    }
    const officialUrl = [...new Set(onlyHost.map((binding) => binding.websiteUrl))].sort(compareWebsite)[0];
    if (officialUrl === undefined) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'not_found',
        reasonCode: 'no_structured_domain_match',
      });
      continue;
    }
    const candidate: WikidataDomainCandidate = {
      sponsorId: sponsor.id,
      legalName: sponsor.legalName,
      kvkNumber,
      officialUrl,
      wikidataItems: [...new Set(onlyHost.map((binding) => binding.itemUrl))].sort(),
    };
    candidates.push(candidate);
    outcomes.push({
      sponsorId: sponsor.id,
      status: 'candidate',
      reasonCode: 'wikidata_exact_kvk_single_official_host',
      candidate,
    });
  }

  return {
    outcomes,
    candidates,
    bindingCount: parsed.results.bindings.length,
    invalidBindingCount,
    uniqueKvkCount: byKvk.size,
  };
}

/** Preserves every valid statement so the cross-source merger can quarantine conflicts. */
export function parseWikidataDomainEvidence(payload: unknown): WikidataDomainEvidenceParseResult {
  const parsed = responseSchema.parse(payload);
  const evidence: StructuredDomainEvidence[] = [];
  let invalidBindingCount = 0;
  for (const raw of parsed.results.bindings) {
    const item = createStructuredDomainEvidence({
      source: 'wikidata',
      sourceVersion: WIKIDATA_DOMAIN_QUERY_VERSION,
      sourceRecordId: raw.item.value,
      sourceName: raw.item.value.split('/').at(-1) ?? raw.item.value,
      kvkNumber: raw.kvk.value,
      officialUrl: raw.website.value,
      evidenceUrl: raw.item.value,
    });
    if (item === null) invalidBindingCount += 1;
    else evidence.push(item);
  }
  return { evidence, bindingCount: parsed.results.bindings.length, invalidBindingCount };
}

export async function fetchWikidataKvkWebsites(http: AtsHttpClient): Promise<unknown> {
  const url = new URL(WIKIDATA_SPARQL_ENDPOINT);
  url.searchParams.set('query', WIKIDATA_KVK_WEBSITE_QUERY);
  url.searchParams.set('format', 'json');
  const response = await http.get(url.toString(), {
    allowedOrigins: [new URL(WIKIDATA_SPARQL_ENDPOINT).origin],
  });
  requireSuccessfulResponse('wikidata_domain_source', response);
  return JSON.parse(response.body) as unknown;
}
