import { expect, it } from 'vitest';

import { SafeHttpClient } from '../../src/crawler/http-client.js';
import {
  MPSV_CZ_CORE_KEYS,
  MPSV_CZ_PERSONAL_DATA_KEYS,
  MPSV_CZ_SCHEMA_URL,
  MPSV_CZ_SNAPSHOT_URL,
  runMpsvCzDiscovery,
} from '../../src/global-remote/mpsv-cz-discovery.js';

/**
 * Opt-in live contract check, mirroring `taiwan-jobs-live.test.ts`: skipped by default so
 * `pnpm test` never depends on data.mpsv.cz being reachable. Set `OVR_LIVE_MPSV_CZ=1` to run it.
 *
 * Bounded by design: one HEAD request, one schema download (~35 KB), and a stream parse that stops
 * after 300 snapshot entries (a few hundred KB of the ~185 MB decoded file). Nothing is written to
 * disk and no personal field is ever printed or asserted on by value.
 */
const liveIt = process.env.OVR_LIVE_MPSV_CZ === '1' ? it : it.skip;

liveIt('matches the official MPSV vacancy snapshot contract', { timeout: 120_000 }, async () => {
  const head = await fetch(MPSV_CZ_SNAPSHOT_URL, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('content-type')).toMatch(/gzip|json|octet-stream/u);
  const lastModified = Date.parse(head.headers.get('last-modified') ?? '');
  expect(Number.isFinite(lastModified)).toBe(true);
  // Published daily; a week of slack keeps this from flapping over a missed publication.
  expect(Date.now() - lastModified).toBeLessThan(7 * 24 * 60 * 60 * 1_000);

  const schemaResponse = await fetch(MPSV_CZ_SCHEMA_URL);
  expect(schemaResponse.status).toBe(200);
  const schema = (await schemaResponse.json()) as {
    properties: { polozky: { items: { properties: Record<string, unknown> } } };
  };
  const documented = new Set(Object.keys(schema.properties.polozky.items.properties));
  for (const key of MPSV_CZ_CORE_KEYS) expect(documented.has(key)).toBe(true);

  const http = new SafeHttpClient({
    globalConcurrency: 4,
    perDomainConcurrency: 4,
    timeoutMs: 60_000,
    queueTimeoutMs: 60_000,
    maxRetries: 0,
    maxResponseBytes: 8 * 1024 * 1024,
    maxStreamTimeoutMs: 120_000,
    maxStreamResponseBytes: 64 * 1024 * 1024,
    userAgent: 'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
  });
  const run = await runMpsvCzDiscovery(
    http,
    { minimumAnnualBaseUsd: null },
    { maxScannedRecords: 300, maxRetainedRecords: 100, timeoutMs: 120_000, maxResponseBytes: 64 * 1024 * 1024 },
  );

  expect(run.sources).toHaveLength(1);
  const source = run.sources[0];
  expect(source?.provider).toBe('mpsv_cz');
  // A capped scan is reported as partial; a failure here means a contract change.
  expect(['success', 'partial']).toContain(source?.status);
  expect(run.vacancies.length).toBeGreaterThan(0);

  const serialized = JSON.stringify(run);
  for (const key of MPSV_CZ_PERSONAL_DATA_KEYS) expect(serialized).not.toContain(`"${key}"`);
  expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/iu);

  for (const vacancy of run.vacancies) {
    expect(vacancy.key).toMatch(/^mpsv_cz:\d+$/u);
    const url = new URL(vacancy.url);
    expect(['http:', 'https:']).toContain(url.protocol);
    expect(vacancy.location).toMatch(/Czechia$/u);
  }
  // At least one row carries a valid source link (the dataset page when no employer URL exists).
  expect(run.vacancies.some((vacancy) => /^https?:\/\//u.test(vacancy.url))).toBe(true);
});
