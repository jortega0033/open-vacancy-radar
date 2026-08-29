import { describe, expect, it } from 'vitest';

import { CrawlerHttpError } from '../../src/crawler/errors.js';
import {
  type DnsResolver,
  isPublicIpAddress,
  validatePublicHttpUrl,
} from '../../src/crawler/url-safety.js';

const publicResolver: DnsResolver = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

describe('validatePublicHttpUrl', () => {
  it('accepts only HTTP(S) hosts whose complete DNS answer is public', async () => {
    await expect(validatePublicHttpUrl('https://jobs.example.com/list', publicResolver)).resolves.toHaveProperty(
      'href',
      'https://jobs.example.com/list',
    );

    const mixedResolver: DnsResolver = () =>
      Promise.resolve([
        { address: '93.184.216.34', family: 4 },
        { address: '10.2.3.4', family: 4 },
      ]);
    await expect(validatePublicHttpUrl('https://jobs.example.com', mixedResolver)).rejects.toMatchObject({
      category: 'unsafe_url',
      code: 'private_address',
    });
  });

  it.each([
    'http://127.0.0.1/jobs',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/jobs',
    'http://[::ffff:127.0.0.1]/jobs',
    'http://[fd00::1234]/jobs',
    'http://[fec0::1]/jobs',
    'http://[100::1]/jobs',
    'http://[64:ff9b::7f00:1]/jobs',
    'http://[2002:7f00:1::]/jobs',
    'http://[3fff::1]/jobs',
    'http://[3ffe::1]/jobs',
  ])('rejects non-public literal address %s', async (url) => {
    await expect(validatePublicHttpUrl(url, publicResolver)).rejects.toMatchObject({
      category: 'unsafe_url',
      code: 'private_address',
    });
  });

  it('recognizes private, mapped, metadata, documentation, and public addresses', () => {
    expect(isPublicIpAddress('10.0.0.1')).toBe(false);
    expect(isPublicIpAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicIpAddress('168.63.129.16')).toBe(false);
    expect(isPublicIpAddress('2001:db8::1')).toBe(false);
    expect(isPublicIpAddress('64:ff9b::a00:1')).toBe(false);
    expect(isPublicIpAddress('fec0::1')).toBe(false);
    expect(isPublicIpAddress('100::1')).toBe(false);
    expect(isPublicIpAddress('2002:a00:1::')).toBe(false);
    expect(isPublicIpAddress('3ffe::1')).toBe(false);
    expect(isPublicIpAddress('93.184.216.34')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects special-use IPv6 returned by DNS even when another answer is public', async () => {
    const mixedIpv6Resolver: DnsResolver = () =>
      Promise.resolve([
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '64:ff9b::7f00:1', family: 6 },
      ]);
    await expect(
      validatePublicHttpUrl('https://jobs.example.com', mixedIpv6Resolver),
    ).rejects.toMatchObject({ category: 'unsafe_url', code: 'private_address' });
  });

  it('rejects credential-bearing URLs and redacts secrets from the error', async () => {
    const attempt = validatePublicHttpUrl(
      'https://alice:secret@jobs.example.com/private/token?api_key=secret',
      publicResolver,
    );
    await expect(attempt).rejects.toBeInstanceOf(CrawlerHttpError);
    await expect(attempt).rejects.toMatchObject({
      category: 'unsafe_url',
      code: 'credentialed_url',
      safeUrl: 'https://jobs.example.com/[REDACTED]?[REDACTED]',
    });
    await expect(attempt).rejects.not.toThrow(/alice|secret|token|api_key/u);
  });

  it('categorizes DNS failures without exposing the raw path or query', async () => {
    const resolver: DnsResolver = () => Promise.reject(new Error('resolver details'));
    const attempt = validatePublicHttpUrl(
      'https://jobs.example.com/tenant-secret?token=top-secret',
      resolver,
    );
    await expect(attempt).rejects.toMatchObject({
      category: 'network_error',
      code: 'dns_resolution_failed',
    });
    await expect(attempt).rejects.not.toThrow(/tenant-secret|top-secret/u);
  });
});
