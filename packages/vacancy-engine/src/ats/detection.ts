import type { AtsProvider } from '../domain/models.js';

export type DetectedAtsSource = {
  provider: Extract<
    AtsProvider,
    'ashby' | 'greenhouse' | 'lever' | 'recruitee' | 'teamtailor' | 'smartrecruiters' | 'workday'
  >;
  boardIdentifier: string;
  baseUrl: string;
};

export type WorkdayBoard = {
  origin: string;
  tenant: string;
  shard: string;
  locale: string | null;
  site: string;
  boardUrl: string;
  listUrl: string;
  detailPrefix: string;
};

function parseUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function firstPathSegment(url: URL): string | null {
  const segment = url.pathname.split('/').find((value) => value.length > 0);
  return segment === undefined || segment.length === 0 ? null : segment;
}

function pathSegmentAfter(url: URL, marker: string): string | null {
  const segments = url.pathname.split('/').filter(Boolean);
  const index = segments.indexOf(marker);
  const value = index < 0 ? undefined : segments[index + 1];
  return value === undefined || value.length === 0 ? null : value;
}

function decodedPathSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim();
    return /^[a-z0-9](?:[a-z0-9._-]{0,198}[a-z0-9])?$/iu.test(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function normalizedWorkdayLocale(value: string): string | null {
  const match = /^([a-z]{2})-([a-z]{2})$/iu.exec(value);
  return match === null ? null : `${match[1]?.toLowerCase()}-${match[2]?.toUpperCase()}`;
}

/** Parses an observed public Workday board without guessing a tenant, shard, or site. */
export function parseWorkdayBoard(input: string): WorkdayBoard | null {
  const url = parseUrl(input);
  if (
    url?.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const hostMatch = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(wd\d+)\.myworkdayjobs\.com$/u.exec(
    hostname,
  );
  if (hostMatch === null) return null;
  const tenant = hostMatch[1];
  const shard = hostMatch[2];
  if (tenant === undefined || shard === undefined) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  let locale: string | null = null;
  let rawSite: string | undefined;
  if (
    segments[0]?.toLowerCase() === 'wday' &&
    segments[1]?.toLowerCase() === 'cxs'
  ) {
    const pathTenant = segments[2]?.toLowerCase();
    if (pathTenant !== tenant) return null;
    rawSite = segments[3];
  } else {
    const first = segments[0];
    if (first === undefined) return null;
    locale = normalizedWorkdayLocale(first);
    rawSite = locale === null ? first : segments[1];
  }
  if (rawSite === undefined) return null;
  const site = decodedPathSegment(rawSite);
  if (site === null) return null;

  const origin = url.origin;
  const encodedTenant = encodeURIComponent(tenant);
  const encodedSite = encodeURIComponent(site);
  const boardUrl = `${origin}/${locale === null ? '' : `${locale}/`}${encodedSite}`;
  return {
    origin,
    tenant,
    shard,
    locale,
    site,
    boardUrl,
    listUrl: `${origin}/wday/cxs/${encodedTenant}/${encodedSite}/jobs`,
    detailPrefix: `${origin}/wday/cxs/${encodedTenant}/${encodedSite}`,
  };
}

export function detectGreenhouseSource(input: string): DetectedAtsSource | null {
  const url = parseUrl(input);
  if (url === null) return null;
  const hostname = url.hostname.toLowerCase();
  let boardIdentifier: string | null = null;
  if (hostname === 'boards-api.greenhouse.io') {
    boardIdentifier = pathSegmentAfter(url, 'boards');
  } else if (hostname === 'job-boards.greenhouse.io' || hostname === 'boards.greenhouse.io') {
    const queryIdentifier = url.searchParams.get('for')?.trim();
    boardIdentifier = queryIdentifier === undefined || queryIdentifier.length === 0
      ? firstPathSegment(url)
      : queryIdentifier;
  }
  return boardIdentifier === null
    ? null
    : { provider: 'greenhouse', boardIdentifier, baseUrl: url.origin };
}

export function detectAshbySource(input: string): DetectedAtsSource | null {
  const url = parseUrl(input);
  if (url === null) return null;
  const hostname = url.hostname.toLowerCase();
  const boardIdentifier = hostname === 'jobs.ashbyhq.com'
    ? firstPathSegment(url)
    : hostname === 'api.ashbyhq.com'
      ? pathSegmentAfter(url, 'job-board')
      : null;
  return boardIdentifier === null
    ? null
    : { provider: 'ashby', boardIdentifier, baseUrl: url.origin };
}

export function detectLeverSource(input: string): DetectedAtsSource | null {
  const url = parseUrl(input);
  if (url === null) return null;
  const hostname = url.hostname.toLowerCase();
  if (!['jobs.lever.co', 'jobs.eu.lever.co', 'api.lever.co', 'api.eu.lever.co'].includes(hostname)) {
    return null;
  }
  const boardIdentifier =
    hostname.startsWith('api.') ? pathSegmentAfter(url, 'postings') : firstPathSegment(url);
  return boardIdentifier === null
    ? null
    : { provider: 'lever', boardIdentifier, baseUrl: url.origin };
}

export function detectRecruiteeSource(input: string): DetectedAtsSource | null {
  const url = parseUrl(input);
  if (url === null) return null;
  const hostname = url.hostname.toLowerCase();
  const suffix = '.recruitee.com';
  if (!hostname.endsWith(suffix)) return null;
  const boardIdentifier = hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(boardIdentifier)) return null;
  return { provider: 'recruitee', boardIdentifier, baseUrl: url.origin };
}

export function detectTeamtailorSource(input: string): DetectedAtsSource | null {
  const url = parseUrl(input);
  if (!url?.hostname.toLowerCase().endsWith('.teamtailor.com')) return null;
  const path = url.pathname.replace(/\/+$/u, '');
  if (!path.toLowerCase().endsWith('/jobs') && !path.toLowerCase().endsWith('/jobs.rss')) return null;
  url.pathname = path.toLowerCase().endsWith('.rss') ? path : `${path}.rss`;
  url.search = '';
  url.hash = '';
  return { provider: 'teamtailor', boardIdentifier: url.toString(), baseUrl: url.origin };
}

export function detectSmartRecruitersSource(input: string): DetectedAtsSource | null {
  const url = parseUrl(input);
  if (url === null) return null;
  const hostname = url.hostname.toLowerCase();
  let boardIdentifier: string | null = null;
  if (hostname === 'api.smartrecruiters.com') {
    boardIdentifier = pathSegmentAfter(url, 'companies');
  } else if (hostname === 'careers.smartrecruiters.com' || hostname === 'jobs.smartrecruiters.com') {
    boardIdentifier = firstPathSegment(url);
  }
  return boardIdentifier === null
    ? null
    : { provider: 'smartrecruiters', boardIdentifier, baseUrl: url.origin };
}

export function detectWorkdaySource(input: string): DetectedAtsSource | null {
  const board = parseWorkdayBoard(input);
  return board === null
    ? null
    : {
        provider: 'workday',
        boardIdentifier: board.site,
        baseUrl: board.boardUrl,
      };
}

export function detectAtsSource(input: string): DetectedAtsSource | null {
  return (
    detectAshbySource(input) ??
    detectGreenhouseSource(input) ??
    detectLeverSource(input) ??
    detectRecruiteeSource(input) ??
    detectTeamtailorSource(input) ??
    detectSmartRecruitersSource(input) ??
    detectWorkdaySource(input)
  );
}
