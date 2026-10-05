import { expect, it } from 'vitest';

import { SafeHttpClient } from '../../src/crawler/http-client.js';
import {
  discoverPhilJobNet,
  parsePhilJobNetListing,
  philJobNetSearchUrl,
  PHIL_JOBNET_ORIGIN,
} from '../../src/global-remote/phil-jobnet-discovery.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';

/**
 * Opt-in live contract check, skipped by default so `pnpm test` and CI never depend on
 * philjobnet.gov.ph being reachable. Set `OVR_LIVE_PHIL_JOBNET=1` to run it. Issues one search GET,
 * one pagination postback and two detail GETs, then stops.
 */
const liveIt = process.env.OVR_LIVE_PHIL_JOBNET === '1' ? it : it.skip;

liveIt('matches the anonymous PhilJobNet listing and detail contract', async () => {
  const safeHttp = new SafeHttpClient({
    globalConcurrency: 1,
    perDomainConcurrency: 1,
    timeoutMs: 20_000,
    queueTimeoutMs: 30_000,
    maxRetries: 0,
    maxResponseBytes: 4 * 1024 * 1024,
    userAgent: 'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
  });
  const first = await safeHttp.get(philJobNetSearchUrl('cashier'), { allowedOrigins: [PHIL_JOBNET_ORIGIN] });
  expect(first.status).toBe(200);
  const listing = parsePhilJobNetListing(first.text());
  expect(listing.invalidCards).toBe(0);
  expect(listing.formState).not.toBeNull();

  const base = {
    roleQuery: 'cashier',
    philJobNetEnabled: true,
    philJobNetMaxPages: 2,
    philJobNetMaxDetails: 2,
  };
  const config = {
    version: 'live',
    minimumAnnualBaseUsd: null,
    discovery: base,
    officialSources: [],
  } as unknown as GlobalRemoteConfig;
  const run = await discoverPhilJobNet(createAtsHttpClient(safeHttp), config);
  expect(run.sources).toHaveLength(1);
  expect(['success', 'partial']).toContain(run.sources[0]?.status);
  for (const vacancy of run.vacancies) {
    expect(vacancy.url.startsWith(`${PHIL_JOBNET_ORIGIN}/job-vacancies/job/`)).toBe(true);
  }
});
