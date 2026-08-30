import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { SafeHttpClient } from '../../src/crawler/http-client.js';
import { globalRemoteConfigSchema } from '../../src/global-remote/models.js';
import {
  discoverRemoote,
  REMOOTE_PUBLIC_LIMIT,
} from '../../src/global-remote/remoote-discovery.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';

const REMOOTE_API_ORIGIN = 'https://api.remoote.app';
const REMOOTE_TOOLS_URL = `${REMOOTE_API_ORIGIN}/remoote/agents/tools`;
const liveIt = process.env.OVR_LIVE_REMOOTE === '1' ? it : it.skip;

type RemooteTools = {
  tools: Array<{
    name: string;
    auth_required: boolean;
    public_limit: number | null;
    input_schema: { properties: Record<string, unknown> };
  }>;
  public_limits: {
    max_results_per_call: number;
    bulk_export: boolean;
    raw_employer_apply_urls: boolean;
  };
};

type RemooteDetail = {
  status: string;
  data: null | {
    job: {
      id: number;
      remoote_url: string;
      salary: unknown;
      location: unknown;
      apply_action: { url: string };
    };
  };
};

liveIt('matches the anonymous Remoote tools, search, and detail contracts', async () => {
  const safeHttp = new SafeHttpClient({
    globalConcurrency: 1,
    perDomainConcurrency: 1,
    timeoutMs: 15_000,
    queueTimeoutMs: 20_000,
    maxRetries: 0,
    maxResponseBytes: 2 * 1024 * 1024,
    userAgent:
      'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
  });
  const allowedOrigins = [REMOOTE_API_ORIGIN];

  const toolsResponse = await safeHttp.get(REMOOTE_TOOLS_URL, { allowedOrigins });
  expect(toolsResponse.status).toBe(200);
  const tools = JSON.parse(toolsResponse.text()) as RemooteTools;
  const searchTool = tools.tools.find((tool) => tool.name === 'search_jobs');
  const detailTool = tools.tools.find((tool) => tool.name === 'get_job');
  expect(searchTool).toMatchObject({ auth_required: false, public_limit: REMOOTE_PUBLIC_LIMIT });
  expect(searchTool?.input_schema.properties).toHaveProperty('role_title');
  expect(searchTool?.input_schema.properties).toHaveProperty('country');
  expect(searchTool?.input_schema.properties).toHaveProperty('salary_required');
  expect(searchTool?.input_schema.properties).toHaveProperty('limit');
  expect(detailTool).toMatchObject({ auth_required: false, public_limit: null });
  expect(tools.public_limits).toMatchObject({
    max_results_per_call: REMOOTE_PUBLIC_LIMIT,
    bulk_export: false,
    raw_employer_apply_urls: false,
  });

  const profilePath = path.resolve(process.cwd(), 'config/global-remote-profile-v1.json');
  const profile = globalRemoteConfigSchema.parse(JSON.parse(await readFile(profilePath, 'utf8')));
  const result = await discoverRemoote(createAtsHttpClient(safeHttp), {
    ...profile,
    discovery: {
      ...profile.discovery,
      remooteLimit: 3,
    },
  });

  expect(result.sources).toEqual([
    expect.objectContaining({
      provider: 'remoote',
      requests: 1,
      status: 'success',
    }),
  ]);
  expect(result.vacancies.length).toBeGreaterThan(0);
  expect(result.vacancies.length).toBeLessThanOrEqual(3);
  expect(JSON.stringify(result)).not.toMatch(/employer_apply_url/iu);

  const vacancy = result.vacancies[0];
  expect(vacancy).toBeDefined();
  if (vacancy === undefined) throw new Error('Remoote live search returned no usable vacancy');
  expect(vacancy.url).toMatch(/^https:\/\/remoote\.app\/jobs\//u);
  expect(vacancy.location.length).toBeGreaterThan(0);
  expect(vacancy.advertisedMinimum === null || vacancy.advertisedMinimum > 0).toBe(true);

  const jobId = Number(vacancy.key.slice('remoote:'.length));
  const detailResponse = await safeHttp.get(`${REMOOTE_API_ORIGIN}/remoote/agents/jobs/${jobId}`, {
    allowedOrigins,
  });
  expect(detailResponse.status).toBe(200);
  const detail = JSON.parse(detailResponse.text()) as RemooteDetail;
  expect(detail.status).toBe('ok');
  expect(detail.data?.job.id).toBe(jobId);
  expect(detail.data?.job.remoote_url).toMatch(
    new RegExp(`^https://remoote\\.app/jobs/${jobId}(?:-|/?$)`, 'u'),
  );
  expect(detail.data?.job.apply_action.url).toBe(detail.data?.job.remoote_url);
  expect(detail.data?.job).toHaveProperty('salary');
  expect(detail.data?.job).toHaveProperty('location');
  expect(JSON.stringify(detail)).not.toMatch(/employer_apply_url/iu);
});
