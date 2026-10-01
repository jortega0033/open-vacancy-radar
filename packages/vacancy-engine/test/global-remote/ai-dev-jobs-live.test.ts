import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { SafeHttpClient } from '../../src/crawler/http-client.js';
import {
  AI_DEV_JOBS_API_ORIGIN,
  AI_DEV_JOBS_JOBS_URL,
  AI_DEV_JOBS_MAX_PAGE_SIZE,
  discoverAiDevJobs,
} from '../../src/global-remote/ai-dev-jobs-discovery.js';
import { globalRemoteConfigSchema } from '../../src/global-remote/models.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';

/**
 * Opt-in live contract check, mirroring `remoote-live.test.ts`: skipped by default so `pnpm test`
 * never depends on aidevboard.com being reachable. Set `OVR_LIVE_AI_DEV_JOBS=1` to actually run it.
 */
const liveIt = process.env.OVR_LIVE_AI_DEV_JOBS === '1' ? it : it.skip;

liveIt('matches the anonymous AI Dev Jobs REST contract', async () => {
  const safeHttp = new SafeHttpClient({
    globalConcurrency: 1,
    perDomainConcurrency: 1,
    timeoutMs: 15_000,
    queueTimeoutMs: 20_000,
    maxRetries: 0,
    maxResponseBytes: 4 * 1024 * 1024,
    userAgent:
      'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
  });
  const atsHttp = createAtsHttpClient(safeHttp);

  const listUrl = `${AI_DEV_JOBS_JOBS_URL}?workplace=remote&limit=${AI_DEV_JOBS_MAX_PAGE_SIZE}&page=1`;
  const response = await safeHttp.get(listUrl, { allowedOrigins: [AI_DEV_JOBS_API_ORIGIN] });
  expect(response.status).toBe(200);
  const body = JSON.parse(response.text()) as { jobs: unknown; has_next: unknown };
  expect(Array.isArray(body.jobs) || body.jobs === null).toBe(true);
  expect(typeof body.has_next).toBe('boolean');

  const profilePath = path.resolve(process.cwd(), 'config/global-remote-profile-v1.json');
  const profile = globalRemoteConfigSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
  const result = await discoverAiDevJobs(atsHttp, { ...profile, discovery: { ...profile.discovery, aiDevJobsMaxPages: 1 } });

  expect(result.sources).toEqual([
    expect.objectContaining({
      provider: 'ai_dev_jobs',
      requests: 1,
      status: expect.stringMatching(/^(?:success|partial)$/u),
    }),
  ]);
  if (result.vacancies.length > 0) {
    const vacancy = result.vacancies[0];
    expect(vacancy).toBeDefined();
    if (vacancy === undefined) throw new Error('AI Dev Jobs live search returned no usable vacancy');
    expect(vacancy.url.startsWith('http')).toBe(true);
    expect(vacancy.description).toMatch(/^AI Dev Jobs listing: https:\/\/aidevboard\.com\/job\//u);
  }
});
