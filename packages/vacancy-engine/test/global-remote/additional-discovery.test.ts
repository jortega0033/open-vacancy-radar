import { describe, expect, it } from 'vitest';

import { runAdditionalDiscovery } from '../../src/global-remote/additional-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { REMOOTE_SEARCH_URL } from '../../src/global-remote/remoote-discovery.js';
import { globalRemoteSourceRegistry } from '../../src/global-remote/source-registry.js';
import { FixtureHttpClient, jsonPostFixtureKey } from '../ats/helpers.js';

const DICE_URL = 'https://mcp.dice.com/mcp';
const MUSE_URL = 'https://www.themuse.com/api/public/jobs?page=1&category=Computer+and+IT&location=Remote';

function profile(museEnabled = false): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: 100_000,
    discovery: {
      roleQuery: 'frontend',
      himalayasQueries: ['frontend'],
      himalayasCountry: 'NL',
      himalayasMaxPagesPerQuery: 1,
      jobicyCount: 1,
      freehireLimit: 1,
      jobOpportunitiesLimit: 1,
      remoteLandersMaxPages: 1,
      jobgetherMaxPages: 1,
      remoteFirstMaxPages: 1,
      jobRemotelyMaxPages: 1,
      arbeitnowMaxPages: 1,
      diceMaxPages: 1,
      remooteRoleTitle: 'frontend',
      remooteCountry: 'Netherlands',
      remooteLimit: 10,
      museEnabled,
      museMaxPages: 1,
      adzunaAppId: '',
      adzunaAppKey: '',
      adzunaMaxPages: 1,
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
    },
    officialSources: [],
  };
}

function diceBody(): unknown {
  return {
    jsonrpc: '2.0',
    id: 'dice-frontend-1',
    method: 'tools/call',
    params: {
      name: 'search_jobs',
      arguments: {
        keyword: 'frontend developer',
        jobs_per_page: 100,
        page_number: 1,
        sort: 'relevance',
        posted_date: 'SEVEN',
        workplace_types: ['Remote'],
      },
    },
  };
}

function diceSse(data: unknown[]): string {
  return `event: message\ndata: ${JSON.stringify({
    jsonrpc: '2.0',
    id: 'dice-frontend-1',
    result: { structuredContent: { data } },
  })}\n\n`;
}

function remooteBody(): unknown {
  return {
    role_title: 'frontend',
    country: 'Netherlands',
    salary_required: false,
    limit: 10,
  };
}

function emptyRemooteSearch(): string {
  return JSON.stringify({
    status: 'ok',
    data: { jobs: [], result_count: 0, total_available: 0 },
    limits: { requested_limit: 10, applied_limit: 10, max_public_results: 10 },
  });
}

describe('Additional public and configuration-gated discovery', () => {
  it('uses the sanctioned Dice MCP endpoint with explicit MCP headers', async () => {
    const routes = new Map([
      [jsonPostFixtureKey(DICE_URL, diceBody()), diceSse([{
        guid: 'dice-1',
        title: 'Senior Frontend Developer',
        companyName: 'Dice Co',
        detailsPageUrl: 'https://www.dice.com/job-detail/dice-1',
        summary: 'Remote web UI work. Base salary $150,000 per year.',
        salary: '$150,000 - $180,000 yearly',
        jobLocation: { displayName: 'Remote' },
        workplaceTypes: ['Remote'],
        employmentType: ['Full-time'],
      }])],
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, remooteBody()), emptyRemooteSearch()],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await runAdditionalDiscovery(http, profile());

    expect(result.sources.map((source) => source.provider)).toEqual(['dice', 'remoote']);
    expect(result.sources.find((source) => source.provider === 'dice')).toMatchObject({
      status: 'success',
      listings: 1,
    });
    expect(result.vacancies[0]).toMatchObject({
      provider: 'dice',
      company: 'Dice Co',
      title: 'Senior Frontend Developer',
      advertisedMinimum: 150_000,
    });
    expect(http.requestedOptions[0]?.headers).toMatchObject({
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    });
  });

  it('runs The Muse only after the project profile explicitly enables it', async () => {
    const routes = new Map([
      [jsonPostFixtureKey(DICE_URL, diceBody()), diceSse([])],
      [jsonPostFixtureKey(REMOOTE_SEARCH_URL, remooteBody()), emptyRemooteSearch()],
      [MUSE_URL, JSON.stringify({
        page: 1,
        page_count: 1,
        total: 1,
        results: [{
          id: 42,
          name: 'Frontend Engineer',
          contents: '<p>Remote product work. $130,000 annual base.</p>',
          company: { name: 'Muse Co' },
          locations: [{ name: 'Flexible / Remote' }],
          refs: { landing_page: 'https://www.themuse.com/jobs/muse-co/frontend-engineer' },
        }],
      })],
    ]);

    const result = await runAdditionalDiscovery(new FixtureHttpClient(routes), profile(true));

    expect(result.sources.map((source) => source.provider)).toEqual(['dice', 'remoote', 'the_muse']);
    expect(result.vacancies).toEqual([expect.objectContaining({ provider: 'the_muse', company: 'Muse Co' })]);
  });

  it('keeps every researched source visible without mislabeling gated portals as active', () => {
    const registry = globalRemoteSourceRegistry(profile());

    expect(registry.length).toBeGreaterThanOrEqual(30);
    expect(registry.every((source) =>
      source.state === 'active'
        ? source.ingestionMode !== 'disabled'
        : source.ingestionMode === 'disabled',
    )).toBe(true);
    expect(registry.filter((source) => source.state === 'active')).toHaveLength(25);
    expect(registry.find((source) => source.id === 'remotive')).toMatchObject({
      transport: 'rss',
      url: 'https://remotive.com/remote-jobs/feed',
      ingestionMode: 'full_ingestion',
    });
    expect(registry.find((source) => source.id === 'un_careers')).toMatchObject({
      state: 'active',
      transport: 'rss',
      ingestionMode: 'linked_index',
    });
    expect(registry.find((source) => source.id === 'jobtech_sweden')).toMatchObject({
      state: 'active',
      url: 'https://jobsearch.api.jobtechdev.se/',
      transport: 'api',
      ingestionMode: 'full_ingestion',
    });
    expect(registry.find((source) => source.id === 'workable_global')).toMatchObject({
      state: 'active',
      url: 'https://www.workable.com/boards/workable.xml',
      transport: 'structured',
      ingestionMode: 'full_ingestion',
    });
    expect(registry.find((source) => source.id === 'remoote')).toMatchObject({
      state: 'active',
      transport: 'api',
      ingestionMode: 'linked_index',
      adapter: 'active',
    });
    expect(registry.find((source) => source.id === 'eures')).toMatchObject({
      state: 'prohibited',
      adapter: 'none',
      ingestionMode: 'disabled',
    });
    expect(registry.find((source) => source.id === 'the_muse')).toMatchObject({
      state: 'configuration_required',
      adapter: 'ready',
    });
    expect(registry.find((source) => source.id === 'linkedin')).toMatchObject({ state: 'prohibited' });
    expect(registry.find((source) => source.id === 'ziprecruiter')).toMatchObject({ state: 'blocked' });
  });
});
