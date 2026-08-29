import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { CrawlerHttpError } from './errors.js';

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemDnsResolver: DnsResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => {
    if (result.family !== 4 && result.family !== 6) {
      throw new TypeError('DNS resolver returned an unsupported address family');
    }
    return { address: result.address, family: result.family };
  });
};

function parseIpv4(address: string): readonly [number, number, number, number] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/u.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  if (octets.some(Number.isNaN)) return undefined;
  return octets as unknown as readonly [number, number, number, number];
}

function ipv4InCidr(
  octets: readonly [number, number, number, number],
  network: readonly [number, number, number, number],
  prefixLength: number,
): boolean {
  const addressValue =
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const networkValue =
    ((network[0] << 24) | (network[1] << 16) | (network[2] << 8) | network[3]) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xffff_ffff << (32 - prefixLength)) >>> 0;
  return (addressValue & mask) === (networkValue & mask);
}

const NON_PUBLIC_IPV4_RANGES: readonly (
  readonly [readonly [number, number, number, number], number]
)[] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

const KNOWN_METADATA_IPV4 = new Set(['168.63.129.16']);

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (octets === undefined || KNOWN_METADATA_IPV4.has(address)) return false;
  return !NON_PUBLIC_IPV4_RANGES.some(([network, prefix]) =>
    ipv4InCidr(octets, network, prefix),
  );
}

function parseIpv6(address: string): Uint8Array | undefined {
  let normalized = address.toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  if (normalized.includes('%')) return undefined;

  const dottedTailIndex = normalized.lastIndexOf(':');
  if (normalized.includes('.') && dottedTailIndex >= 0) {
    const ipv4 = parseIpv4(normalized.slice(dottedTailIndex + 1));
    if (ipv4 === undefined) return undefined;
    const high = (ipv4[0] << 8) | ipv4[1];
    const low = (ipv4[2] << 8) | ipv4[3];
    normalized = `${normalized.slice(0, dottedTailIndex + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const compressed = normalized.split('::');
  if (compressed.length > 2) return undefined;
  const head = compressed[0] === '' ? [] : (compressed[0]?.split(':') ?? []);
  const tail = compressed.length === 1 || compressed[1] === '' ? [] : (compressed[1]?.split(':') ?? []);
  const missing = 8 - head.length - tail.length;
  if ((compressed.length === 1 && missing !== 0) || (compressed.length === 2 && missing < 1)) {
    return undefined;
  }

  const groups = [...head, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/u.test(group))) {
    return undefined;
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

function hasIpv6Prefix(address: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((address[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (bytes === undefined) return false;

  const isMappedIpv4 =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isMappedIpv4) {
    return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }

  // Public careers endpoints should resolve to ordinary global-unicast space.
  // A denylist is insufficient here because IPv4 transition, NAT64, discarded
  // site-local, benchmarking, and future special-use blocks can embed private
  // targets. Start with 2000::/3 and remove IANA special/transition ranges.
  if (!hasIpv6Prefix(bytes, [0x20], 3)) return false;
  return !(
    hasIpv6Prefix(bytes, [0x20, 0x01, 0x00], 23) ||
    hasIpv6Prefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) ||
    hasIpv6Prefix(bytes, [0x20, 0x02], 16) ||
    hasIpv6Prefix(bytes, [0x3f, 0xfe], 16) ||
    hasIpv6Prefix(bytes, [0x3f, 0xff], 20)
  );
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

function isClearlyNonPublicHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home') ||
    normalized.endsWith('.lan')
  );
}

function containsControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

function unsafeUrl(url: URL, code: 'non_public_hostname' | 'private_address', detail: string): never {
  throw new CrawlerHttpError({
    category: 'unsafe_url',
    code,
    url,
    detail,
  });
}

export async function validatePublicHttpUrl(
  input: string | URL,
  resolver: DnsResolver = systemDnsResolver,
): Promise<URL> {
  let url: URL;
  try {
    const rawInput = input instanceof URL ? input.href : input;
    if (containsControlOrSpace(rawInput)) {
      throw new TypeError('URL contains control characters');
    }
    url = new URL(rawInput);
  } catch {
    throw new CrawlerHttpError({
      category: 'unsafe_url',
      code: 'invalid_url',
      url: '[invalid URL]',
      detail: 'Rejected an invalid URL',
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CrawlerHttpError({
      category: 'unsafe_url',
      code: 'unsupported_protocol',
      url,
      detail: 'Only HTTP and HTTPS URLs are allowed',
    });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new CrawlerHttpError({
      category: 'unsafe_url',
      code: 'credentialed_url',
      url,
      detail: 'Credential-bearing URLs are not allowed',
    });
  }

  url.hash = '';
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname.length === 0 || isClearlyNonPublicHostname(hostname)) {
    unsafeUrl(url, 'non_public_hostname', 'The URL hostname is not public');
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicIpAddress(hostname)) {
      unsafeUrl(url, 'private_address', 'The URL resolves to a non-public address');
    }
    return url;
  }

  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new CrawlerHttpError({
      category: 'network_error',
      code: 'dns_resolution_failed',
      url,
      detail: 'DNS resolution failed',
    });
  }

  if (addresses.length === 0) {
    throw new CrawlerHttpError({
      category: 'network_error',
      code: 'dns_resolution_failed',
      url,
      detail: 'DNS resolution returned no addresses',
    });
  }

  for (const result of addresses) {
    if (isIP(result.address) !== result.family || !isPublicIpAddress(result.address)) {
      unsafeUrl(url, 'private_address', 'The URL resolves to a non-public address');
    }
  }

  return url;
}
