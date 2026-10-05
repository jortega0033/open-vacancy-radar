import { expect, it } from 'vitest';

import { SafeHttpClient } from '../../src/crawler/http-client.js';
import { discoverTheirStack } from '../../src/global-remote/theirstack-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { globalRemoteConfigSchema } from '../../src/global-remote/models.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Opt-in live contract check. Skipped unless BOTH `OVR_LIVE_THEIRSTACK=1` and a user-supplied
 * `THEIRSTACK_API_KEY` are present, because every returned job spends one paid credit. It runs one
 * tightly bounded query (a 2-credit ceiling, one request) to verify auth, the current response
 * schema, and the closed-job field. Default CI never runs it and never holds a key.
 */
const apiKey = process.env.THEIRSTACK_API_KEY?.trim() ?? '';
const liveIt = process.env.OVR_LIVE_THEIRSTACK === '1' && apiKey.length > 0 ? it : it.skip;

liveIt('matches the TheirStack Jobs API contract within a 2-credit budget', async () => {
  const safeHttp = new SafeHttpClient({
    globalConcurrency: 1,
    perDomainConcurrency: 1,
    timeoutMs: 20_000,
    queueTimeoutMs: 25_000,
    maxRetries: 0,
    maxResponseBytes: 8 * 1024 * 1024,
    userAgent: 'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
  });
  const profilePath = path.resolve(process.cwd(), 'config/global-remote-profile-v1.json');
  const profile = globalRemoteConfigSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
  const config: GlobalRemoteConfig = {
    ...profile,
    discovery: {
      ...profile.discovery,
      roleQuery: process.env.OVR_LIVE_THEIRSTACK_ROLE?.trim() || 'software engineer',
      theirstackEnabled: true,
      theirstackApiKey: apiKey,
      theirstackMaxCredits: 2,
      theirstackMaxPages: 1,
      theirstackPostedWithinDays: 3,
    },
  };

  const result = await discoverTheirStack(createAtsHttpClient(safeHttp), config);
  const source = result.sources[0];
  expect(source).toBeDefined();
  if (source === undefined) throw new Error('TheirStack live discovery returned no source row');
  expect(source.provider).toBe('theirstack');
  expect(['success', 'partial']).toContain(source.status);
  expect(source.creditsUsed).toBeLessThanOrEqual(2);
  expect(JSON.stringify(result)).not.toContain(apiKey);
  for (const vacancy of result.vacancies) {
    expect(vacancy.url.startsWith('http')).toBe(true);
  }
});
