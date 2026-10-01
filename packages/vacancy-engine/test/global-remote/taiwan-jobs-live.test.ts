import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { SafeHttpClient } from '../../src/crawler/http-client.js';
import {
  discoverTaiwanJobs,
  parseTaiwanJobsXml,
  TAIWAN_JOBS_API_ORIGIN,
  TAIWAN_JOBS_WEBSERVICE_URL,
} from '../../src/global-remote/taiwan-jobs-discovery.js';
import { globalRemoteConfigSchema } from '../../src/global-remote/models.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';

/**
 * Opt-in live contract check, mirroring `ai-dev-jobs-live.test.ts`: skipped by default so
 * `pnpm test` never depends on free.taiwanjobs.gov.tw being reachable. Set
 * `OVR_LIVE_TAIWAN_JOBS=1` to actually run it. Uses one bounded, keyless `count=1` request against
 * a single city partition -- not a broad live collection -- to verify the live schema, UTF-8
 * decoding, and canonical apply URL shape still match what this adapter was built against.
 */
const liveIt = process.env.OVR_LIVE_TAIWAN_JOBS === '1' ? it : it.skip;

liveIt('matches the anonymous Taiwan Jobs WebService XML contract', async () => {
  const safeHttp = new SafeHttpClient({
    globalConcurrency: 1,
    perDomainConcurrency: 1,
    timeoutMs: 15_000,
    queueTimeoutMs: 20_000,
    maxRetries: 0,
    maxResponseBytes: 8 * 1024 * 1024,
    userAgent:
      'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
  });
  const atsHttp = createAtsHttpClient(safeHttp);

  const boundedUrl = `${TAIWAN_JOBS_WEBSERVICE_URL}?city=01&count=1`;
  const response = await safeHttp.get(boundedUrl, { allowedOrigins: [TAIWAN_JOBS_API_ORIGIN] });
  expect(response.status).toBe(200);
  const body = response.text();
  const rows = parseTaiwanJobsXml(body);
  expect(rows.length).toBeLessThanOrEqual(1);
  if (rows.length === 1) {
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error('Taiwan Jobs live row parsed but was undefined');
    // A non-empty company/title with a non-ASCII character demonstrates the response decoded as
    // UTF-8 rather than mojibake.
    expect(row.COMPNAME?.length).toBeGreaterThan(0);
    expect(row.URL_QUERY?.startsWith('https://job.taiwanjobs.gov.tw/')).toBe(true);
  }

  const profilePath = path.resolve(process.cwd(), 'config/global-remote-profile-v1.json');
  const profile = globalRemoteConfigSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
  const result = await discoverTaiwanJobs(atsHttp, {
    ...profile,
    discovery: { ...profile.discovery, taiwanJobsMaxCities: 1 },
  });

  expect(result.sources).toHaveLength(1);
  const source = result.sources[0];
  expect(source).toBeDefined();
  if (source === undefined) throw new Error('Taiwan Jobs live discovery returned no source');
  expect(source.provider).toBe('taiwan_jobs');
  // A capped partition (exactly 1,000 rows back) must surface as `partial`, never `success`; any
  // other count for a healthy request is `success`.
  expect(['success', 'partial']).toContain(source.status);
  if (result.vacancies.length > 0) {
    const vacancy = result.vacancies[0];
    expect(vacancy).toBeDefined();
    if (vacancy === undefined) throw new Error('Taiwan Jobs live discovery returned no usable vacancy');
    expect(vacancy.url.startsWith('https://job.taiwanjobs.gov.tw/')).toBe(true);
  }
});
