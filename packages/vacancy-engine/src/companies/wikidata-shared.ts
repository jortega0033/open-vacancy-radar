/**
 * URL/KVK normalization shared by every Wikidata-backed lookup in this package. Extracted from the
 * now-deleted curated `wikidata-domain-source.ts` (the exact-KVK SPARQL lookup, removed with the
 * rest of the curated Netherlands pipeline) because `wikidata-name-source.ts` -- the worldwide,
 * best-effort counterpart this package keeps -- needs the exact same URL safety/normalization
 * rules regardless of whether a P856 website statement was reached via a KVK-keyed or a
 * name-keyed lookup. These three functions have no pipeline-specific logic of their own.
 */

/** LinkedIn is forbidden as a discovery/verification target on either lookup path. */
export function isForbiddenDiscoveryHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, '');
  return normalized === 'linkedin.com' || normalized.endsWith('.linkedin.com');
}

/** A Dutch KVK (Chamber of Commerce) number is 7 or 8 digits; normalized to zero-padded 8. */
export function normalizeKvk(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{7,8}$/u.test(trimmed)) return null;
  return trimmed.padStart(8, '0');
}

export function normalizeWebsiteUrl(value: string): { url: string; hostnameKey: string } | null {
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

function websiteRank(value: string): readonly [number, number, number, string] {
  const url = new URL(value);
  return [url.protocol === 'https:' ? 0 : 1, url.pathname === '/' ? 0 : 1, url.pathname.length, value];
}

/** Deterministically picks one URL among several valid ones on the same host. */
export function compareWebsite(left: string, right: string): number {
  const leftRank = websiteRank(left);
  const rightRank = websiteRank(right);
  return (
    leftRank[0] - rightRank[0] ||
    leftRank[1] - rightRank[1] ||
    leftRank[2] - rightRank[2] ||
    leftRank[3].localeCompare(rightRank[3])
  );
}
