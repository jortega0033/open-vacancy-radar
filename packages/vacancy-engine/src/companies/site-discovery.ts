import * as cheerio from 'cheerio';

import { isRecognizableAccessChallenge } from '../ats/company-site.js';
import { detectAtsSource, type DetectedAtsSource } from '../ats/detection.js';
import type { AtsHttpClient, AtsHttpResponse } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import { extractJsonLdVacanciesWithDiagnostics } from '../ats/json-ld.js';
import { isForbiddenDiscoveryHostname } from './domain-candidates.js';

const provider = 'company_discovery';
const CAREER_TOKENS = new Set([
  'career',
  'careers',
  'carriere',
  'carrieres',
  'job',
  'jobs',
  'vacancy',
  'vacancies',
  'vacature',
  'vacatures',
  'werkenbij',
]);
const CAREER_PHRASES = ['join us', 'work with us', 'werken bij'] as const;
const LISTING_SUFFIXES = new Set(['jobs', 'open positions', 'openings', 'opportunities', 'vacancies']);
const LOGIN_TOKENS = new Set([
  'account',
  'apply',
  'application',
  'auth',
  'login',
  'register',
  'signin',
]);
const LOGIN_PHRASES = ['log in', 'sign in'] as const;
const FILE_EXTENSION = /\.(?:docx?|jpe?g|pdf|png|pptx?|rtf|xlsx?|zip)$/iu;
const PROVIDER_RESERVED_IDENTIFIERS = new Set([
  'about',
  'api',
  'auth',
  'blog',
  'contact',
  'docs',
  'embed',
  'help',
  'job',
  'jobs',
  'login',
  'postings',
  'privacy',
  'security',
  'signin',
  'signup',
  'support',
  'terms',
  'www',
]);

type DiscoveryStatus =
  | 'careers_found'
  | 'no_public_careers'
  | 'unsupported'
  | 'manual_review';

export type OfficialSiteDiscoveryResult = {
  status: DiscoveryStatus;
  pagesInspected: 1 | 2;
  careersUrl: string | null;
  provider: string | null;
  sourceBaseUrl: string | null;
  boardIdentifier: string | null;
  diagnostic: string;
  observations: OfficialSiteDiscoveryObservation[];
};

export type OfficialSiteDiscoveryObservation = {
  provider: string | null;
  boardIdentifier: string | null;
  sourceBaseUrl: string | null;
  observedUrl: string;
  observedOnPage: string;
  element: 'page' | 'anchor' | 'iframe' | 'script';
};

type PageLink = {
  url: URL;
  text: string;
  kind: 'page' | 'anchor' | 'iframe' | 'script';
  raw: string;
  hadFragment: boolean;
  observedOnPage: string;
};

type DetectedLink = {
  link: PageLink;
  source: DetectedAtsSource;
};

type DetectionSummary =
  | { kind: 'none'; observations: DetectedLink[] }
  | { kind: 'one'; detected: DetectedLink; observations: DetectedLink[] }
  | { kind: 'ambiguous'; observations: DetectedLink[] };

function responseHeader(response: AtsHttpResponse, name: string): string | null {
  const expected = name.toLowerCase();
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === expected)?.[1] ?? null;
}

function requireSafeFinalUrl(response: AtsHttpResponse, context: string): URL {
  requireSuccessfulResponse(provider, response);
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.finalUrl);
  } catch {
    throw new AtsResponseError(provider, `${context} returned an invalid final URL`);
  }
  if (
    !['http:', 'https:'].includes(finalUrl.protocol) ||
    finalUrl.username !== '' ||
    finalUrl.password !== ''
  ) {
    throw new AtsResponseError(provider, `${context} returned an unsafe final URL`);
  }
  return finalUrl;
}

function requireHtmlBody(response: AtsHttpResponse, context: string): void {
  const contentType = responseHeader(response, 'content-type');
  if (
    contentType !== null &&
    !contentType.toLowerCase().includes('text/html') &&
    !contentType.toLowerCase().includes('application/xhtml+xml')
  ) {
    throw new AtsResponseError(provider, `${context} did not return HTML`);
  }
  if (isRecognizableAccessChallenge(response.body)) {
    throw new AtsResponseError(provider, `${context} returned an access challenge`, 403);
  }
}

function manualReview(
  diagnostic: string,
  careersUrl: string | null = null,
  pagesInspected: 1 | 2 = 1,
  observations: OfficialSiteDiscoveryObservation[] = [],
): OfficialSiteDiscoveryResult {
  return {
    status: 'manual_review',
    pagesInspected,
    careersUrl,
    provider: null,
    sourceBaseUrl: null,
    boardIdentifier: null,
    diagnostic,
    observations,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizedWords(value: string): string[] {
  return safeDecode(value)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function containsCareerSignal(value: string): boolean {
  const words = normalizedWords(value);
  if (words.some((word) => CAREER_TOKENS.has(word))) return true;
  const phrase = ` ${words.join(' ')} `;
  return CAREER_PHRASES.some((signal) => phrase.includes(` ${signal} `));
}

function collectPageLinks(html: string, pageUrl: URL): PageLink[] {
  const $ = cheerio.load(html);
  const byUrl = new Map<string, PageLink>();
  const kindRank = { page: 0, anchor: 1, iframe: 2, script: 3 } as const;
  $('a[href], iframe[src], script[src]').each((_index, element) => {
    const node = $(element);
    const tagName = element.tagName.toLowerCase();
    const kind = tagName === 'a' ? 'anchor' : tagName === 'iframe' ? 'iframe' : 'script';
    const raw = (kind === 'anchor' ? node.attr('href') : node.attr('src'))?.trim();
    if (raw === undefined || raw.length === 0) return;
    let url: URL;
    try {
      url = new URL(raw, pageUrl);
    } catch {
      return;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      return;
    }
    const hadFragment = url.hash.length > 0;
    url.hash = '';
    const text = `${node.text()} ${node.attr('aria-label') ?? ''} ${node.attr('title') ?? ''}`
      .replace(/\s+/gu, ' ')
      .trim();
    const candidate = {
      url,
      text,
      kind,
      raw,
      hadFragment,
      observedOnPage: pageUrl.toString(),
    } satisfies PageLink;
    const previous = byUrl.get(url.toString());
    if (
      previous === undefined ||
      kindRank[kind] < kindRank[previous.kind] ||
      (kindRank[kind] === kindRank[previous.kind] && previous.hadFragment && !hadFragment)
    ) {
      byUrl.set(url.toString(), candidate);
    }
  });
  return [...byUrl.values()].sort(
    (left, right) =>
      kindRank[left.kind] - kindRank[right.kind] ||
      left.url.toString().localeCompare(right.url.toString()),
  );
}

function isPlausibleDetectedSource(link: PageLink, source: DetectedAtsSource): boolean {
  const identifier = safeDecode(source.boardIdentifier).trim().toLowerCase();
  if (identifier.length === 0) return false;
  const hostname = link.url.hostname.toLowerCase();

  switch (source.provider) {
    case 'ashby':
      return !PROVIDER_RESERVED_IDENTIFIERS.has(identifier);
    case 'greenhouse': {
      if (PROVIDER_RESERVED_IDENTIFIERS.has(identifier) || identifier === 'job_board') return false;
      const isEmbed = link.url.pathname.toLowerCase().split('/').includes('embed');
      return !isEmbed || (link.url.searchParams.get('for')?.trim().length ?? 0) > 0;
    }
    case 'lever':
      return !PROVIDER_RESERVED_IDENTIFIERS.has(identifier);
    case 'recruitee':
      return !new Set(['api', 'auth', 'docs', 'help', 'support', 'www']).has(identifier);
    case 'teamtailor':
      return hostname !== 'www.teamtailor.com' && !hostname.startsWith('www.');
    case 'smartrecruiters':
      return !PROVIDER_RESERVED_IDENTIFIERS.has(identifier);
    case 'workday':
      return !PROVIDER_RESERVED_IDENTIFIERS.has(identifier);
  }
}

function detectedSources(links: readonly PageLink[]): DetectionSummary {
  const byBoard = new Map<string, DetectedLink>();
  const observations: DetectedLink[] = [];
  for (const link of links) {
    const source = detectAtsSource(link.url.toString());
    if (source === null || !isPlausibleDetectedSource(link, source)) continue;
    observations.push({ link, source });
    const normalizedIdentifier = source.boardIdentifier.trim().toLowerCase();
    const identity =
      source.provider === 'workday'
        ? `workday:${new URL(source.baseUrl).hostname.toLowerCase()}:${normalizedIdentifier}`
        : `${source.provider}:${normalizedIdentifier}`;
    if (!byBoard.has(identity)) byBoard.set(identity, { link, source });
  }
  if (byBoard.size === 0) return { kind: 'none', observations };
  if (byBoard.size > 1) return { kind: 'ambiguous', observations };
  const detected = [...byBoard.values()][0];
  if (detected === undefined) return { kind: 'none', observations };
  return { kind: 'one', detected, observations };
}

function experimentalProvider(url: URL): 'personio' | 'successfactors' | null {
  const hostname = url.hostname.toLowerCase();
  if (hostname.includes('personio.')) return 'personio';
  if (hostname.includes('successfactors.') || hostname.includes('successfactorsjobs.')) {
    return 'successfactors';
  }
  return null;
}

function normalizedPath(url: URL): string {
  const path = url.pathname.replace(/\/+$/u, '');
  return path.length === 0 ? '/' : path;
}

function isLikelyDetailPath(url: URL): boolean {
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => normalizedWords(segment).join(' '));
  const careerIndex = segments.findIndex((segment) => containsCareerSignal(segment));
  if (careerIndex < 0 || careerIndex === segments.length - 1) return false;
  return !LISTING_SUFFIXES.has(segments.slice(careerIndex + 1).join(' '));
}

function isEligibleCareersAnchor(link: PageLink, pageUrl: URL): boolean {
  if (link.kind !== 'anchor' || link.url.origin !== pageUrl.origin) return false;
  if (link.raw.startsWith('#') || link.raw.startsWith('?')) return false;
  if (link.hadFragment || link.url.search.length > 0) return false;
  if (normalizedPath(link.url) === normalizedPath(pageUrl)) return false;
  if (FILE_EXTENSION.test(link.url.pathname)) return false;
  const pathWords = normalizedWords(link.url.pathname);
  if (pathWords.some((word) => LOGIN_TOKENS.has(word))) return false;
  const pathPhrase = ` ${pathWords.join(' ')} `;
  if (LOGIN_PHRASES.some((signal) => pathPhrase.includes(` ${signal} `))) return false;
  if (!containsCareerSignal(`${link.text} ${link.url.pathname}`)) return false;
  return !isLikelyDetailPath(link.url);
}

function careerRank(link: PageLink): readonly [number, number, number, string] {
  const pathSegments = link.url.pathname.split('/').filter(Boolean);
  const lastSegment = normalizedWords(pathSegments.at(-1) ?? '').join(' ');
  const exactPath = containsCareerSignal(lastSegment) ? 0 : 1;
  const textSignal = containsCareerSignal(link.text) ? 0 : 1;
  return [exactPath, textSignal, pathSegments.length, link.url.toString()];
}

function compareCareerLinks(left: PageLink, right: PageLink): number {
  const leftRank = careerRank(left);
  const rightRank = careerRank(right);
  return (
    leftRank[0] - rightRank[0] ||
    leftRank[1] - rightRank[1] ||
    leftRank[2] - rightRank[2] ||
    leftRank[3].localeCompare(rightRank[3])
  );
}

function supportedResult(
  careersUrl: string,
  source: DetectedAtsSource,
  pagesInspected: 1 | 2,
  observations: OfficialSiteDiscoveryObservation[],
): OfficialSiteDiscoveryResult {
  return {
    status: 'careers_found',
    pagesInspected,
    careersUrl,
    provider: source.provider,
    sourceBaseUrl: source.baseUrl,
    boardIdentifier: source.boardIdentifier,
    diagnostic: 'Recognized public ATS link; endpoint validation is required before activation',
    observations,
  };
}

function careersPageResult(
  html: string,
  pageUrl: URL,
  pagesInspected: 1 | 2,
): OfficialSiteDiscoveryResult {
  const jsonLd = extractJsonLdVacanciesWithDiagnostics(html, pageUrl.toString(), {
    allowedOrigins: [pageUrl.origin],
  });
  return manualReview(
    jsonLd.jobPostingNodes > 0
      ? 'JobPosting JSON-LD found; exact detail-prefix review is required before activation'
      : 'Official careers page found; no supported public source contract detected',
    pageUrl.toString(),
    pagesInspected,
    [
      {
        provider: jsonLd.jobPostingNodes > 0 ? 'json_ld' : null,
        boardIdentifier: null,
        sourceBaseUrl: pageUrl.origin,
        observedUrl: pageUrl.toString(),
        observedOnPage: pageUrl.toString(),
        element: 'page',
      },
    ],
  );
}

function atsObservations(detected: readonly DetectedLink[]): OfficialSiteDiscoveryObservation[] {
  return detected.map(({ link, source }) => ({
    provider: source.provider,
    boardIdentifier: source.boardIdentifier,
    sourceBaseUrl: source.baseUrl,
    observedUrl: link.url.toString(),
    observedOnPage: link.observedOnPage,
    element: link.kind,
  }));
}

function detectedResult(
  summary: DetectionSummary,
  pagesInspected: 1 | 2,
): OfficialSiteDiscoveryResult | null {
  const observations = atsObservations(summary.observations);
  if (summary.kind === 'ambiguous') {
    return manualReview(
      'Multiple distinct public ATS boards were found; ownership requires review',
      null,
      pagesInspected,
      observations,
    );
  }
  if (summary.kind === 'one') {
    return supportedResult(
      summary.detected.link.url.toString(),
      summary.detected.source,
      pagesInspected,
      observations,
    );
  }
  return null;
}

function unsupportedCareersLink(
  links: readonly PageLink[],
  pagesInspected: 1 | 2,
): OfficialSiteDiscoveryResult | null {
  const candidates = links
    .filter((link) => containsCareerSignal(`${link.text} ${link.url.pathname}`))
    .map((link) => ({ link, provider: experimentalProvider(link.url) }))
    .filter(
      (entry): entry is { link: PageLink; provider: 'personio' | 'successfactors' } =>
        entry.provider !== null,
    )
    .sort((left, right) => left.link.url.toString().localeCompare(right.link.url.toString()));
  const candidate = candidates[0];
  if (candidate === undefined) return null;
  return {
    status: 'unsupported',
    pagesInspected,
    careersUrl: candidate.link.url.toString(),
    provider: candidate.provider,
    sourceBaseUrl: null,
    boardIdentifier: null,
    diagnostic: 'Careers link uses a provider without a production adapter',
    observations: candidates.map(({ link, provider: observedProvider }) => ({
      provider: observedProvider,
      boardIdentifier: null,
      sourceBaseUrl: null,
      observedUrl: link.url.toString(),
      observedOnPage: link.observedOnPage,
      element: link.kind,
    })),
  };
}

/**
 * Inspects at most two HTML pages: the evidence-backed official URL and, when
 * explicitly linked on the exact same origin, one careers page. Outbound ATS
 * links are observations only and are never fetched here.
 */
export async function inspectOfficialCompanySite(
  http: AtsHttpClient,
  officialUrl: string,
): Promise<OfficialSiteDiscoveryResult> {
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(officialUrl);
  } catch {
    throw new AtsResponseError(provider, 'official URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(requestedUrl.protocol) ||
    requestedUrl.username !== '' ||
    requestedUrl.password !== '' ||
    requestedUrl.search.length > 0 ||
    requestedUrl.hash.length > 0
  ) {
    throw new AtsResponseError(provider, 'official URL must be a credential-free HTTP(S) URL');
  }
  if (isForbiddenDiscoveryHostname(requestedUrl.hostname)) {
    throw new AtsResponseError(provider, 'LinkedIn is forbidden as a discovery target');
  }

  const homepageResponse = await http.get(requestedUrl.toString(), {
    allowedOrigins: [requestedUrl.origin],
  });
  const homepageUrl = requireSafeFinalUrl(homepageResponse, 'official homepage');
  if (homepageUrl.origin !== requestedUrl.origin) {
    return manualReview(
      'Official URL redirected outside its exact origin boundary',
      null,
      1,
      [
        {
          provider: null,
          boardIdentifier: null,
          sourceBaseUrl: null,
          observedUrl: homepageUrl.toString(),
          observedOnPage: requestedUrl.toString(),
          element: 'page',
        },
      ],
    );
  }
  requireHtmlBody(homepageResponse, 'official homepage');

  const homepageLinks = collectPageLinks(homepageResponse.body, homepageUrl);
  const homepageReference = {
    url: homepageUrl,
    text: '',
    kind: 'anchor',
    raw: homepageUrl.toString(),
    hadFragment: false,
    observedOnPage: homepageUrl.toString(),
  } satisfies PageLink;
  const homepageObservations = [homepageReference, ...homepageLinks];
  const directResult = detectedResult(detectedSources(homepageObservations), 1);
  if (directResult !== null) return directResult;

  const unsupported = unsupportedCareersLink(homepageObservations, 1);
  if (unsupported !== null) return unsupported;

  if (containsCareerSignal(homepageUrl.pathname)) {
    return careersPageResult(homepageResponse.body, homepageUrl, 1);
  }

  const sameOriginCareers = homepageLinks
    .filter((link) => isEligibleCareersAnchor(link, homepageUrl))
    .sort(compareCareerLinks);
  const careersLink = sameOriginCareers[0];
  if (careersLink === undefined) {
    const outboundCareer = homepageLinks
      .filter(
        (link) =>
          link.kind === 'anchor' &&
          link.url.origin !== homepageUrl.origin &&
          containsCareerSignal(`${link.text} ${link.url.pathname}`),
      )
      .sort((left, right) => left.url.toString().localeCompare(right.url.toString()))[0];
    if (outboundCareer !== undefined) {
      return manualReview(
        'Unknown outbound careers link requires manual verification',
        outboundCareer.url.toString(),
        1,
        [
          {
            provider: null,
            boardIdentifier: null,
            sourceBaseUrl: null,
            observedUrl: outboundCareer.url.toString(),
            observedOnPage: outboundCareer.observedOnPage,
            element: outboundCareer.kind,
          },
        ],
      );
    }
    return {
      status: 'no_public_careers',
      pagesInspected: 1,
      careersUrl: null,
      provider: null,
      sourceBaseUrl: null,
      boardIdentifier: null,
      diagnostic: 'No explicit public careers link was found on the official page',
      observations: [],
    };
  }

  const careersResponse = await http.get(careersLink.url.toString(), {
    allowedOrigins: [homepageUrl.origin],
  });
  const careersFinalUrl = requireSafeFinalUrl(careersResponse, 'official careers page');
  if (careersFinalUrl.origin !== homepageUrl.origin) {
    return manualReview(
      'Official careers page redirected outside its exact origin boundary',
      careersLink.url.toString(),
      2,
      [
        {
          provider: null,
          boardIdentifier: null,
          sourceBaseUrl: null,
          observedUrl: careersFinalUrl.toString(),
          observedOnPage: careersLink.url.toString(),
          element: 'page',
        },
      ],
    );
  }
  requireHtmlBody(careersResponse, 'official careers page');

  const careersLinks = collectPageLinks(careersResponse.body, careersFinalUrl);
  const careersResult = detectedResult(detectedSources(careersLinks), 2);
  if (careersResult !== null) return careersResult;

  const linkedUnsupported = unsupportedCareersLink(careersLinks, 2);
  if (linkedUnsupported !== null) return linkedUnsupported;

  return careersPageResult(careersResponse.body, careersFinalUrl, 2);
}
