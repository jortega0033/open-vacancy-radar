import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { AtsResponseError, type AtsHttpClient } from '../../src/ats/http.js';
import type {
  DiscoveryCandidateRow,
  PersistDiscoveryAttemptInput,
} from '../../src/companies/discovery-repository.js';
import type { AppConfig } from '../../src/config.js';
import { CrawlerHttpError } from '../../src/crawler/errors.js';
import type { Database } from '../../src/db/client.js';
import {
  COMPANY_DISCOVERY_RUN_LIMIT,
  runCompanyDiscoveryInspection,
  type CompanyDiscoveryRunDependencies,
} from '../../src/pipeline/company-discovery.js';

const database = {} as Database;
const config = { globalConcurrency: 12 } as AppConfig;

function logger(): Logger {
  return { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function candidate(
  sponsorId: string,
  officialUrl = `https://${sponsorId}.example/`,
): DiscoveryCandidateRow {
  return {
    sponsorId,
    legalName: `${sponsorId} B.V.`,
    kvkNumber: '12345678',
    brandName: sponsorId,
    officialUrl,
    officialHostname: new URL(officialUrl).hostname,
    candidateSource: 'curated-test',
    candidateVersion: 'test-v1',
    candidateHash: sponsorId.padEnd(64, 'a').slice(0, 64),
    evidence: { test: true },
    priority: 1,
    attemptCount: 0,
  };
}

function baseDependencies(
  candidates: DiscoveryCandidateRow[],
  persisted: PersistDiscoveryAttemptInput[],
  httpGet: AtsHttpClient['get'] = (url) =>
    Promise.resolve({
      status: 200,
      finalUrl: url,
      headers: { 'content-type': 'text/html' },
      body: '<html></html>',
    }),
): CompanyDiscoveryRunDependencies {
  return {
    prepare: () => Promise.resolve(new Set(candidates.map((entry) => entry.candidateHash))),
    listCandidates: (_database, limit) => {
      expect(limit).toBe(COMPANY_DISCOVERY_RUN_LIMIT);
      return Promise.resolve(candidates);
    },
    persistAttempt: (_database, input) => {
      persisted.push(input);
      return Promise.resolve();
    },
    startRun: () => Promise.resolve('run-1'),
    finishRun: () => Promise.resolve(),
    createHttp: (_config, _database, dependencies) => ({
      async get(url, options) {
        dependencies?.onNetworkRequest?.(url);
        return httpGet(url, options);
      },
      postJson() {
        throw new Error('Discovery test HTTP client permits GET only');
      },
    }),
  };
}

describe('bounded company discovery pipeline', () => {
  it('finishes an empty candidate run without making a request', async () => {
    const persisted: PersistDiscoveryAttemptInput[] = [];
    const finishRun = vi.fn(() => Promise.resolve());
    const httpGet = vi.fn<AtsHttpClient['get']>();
    const dependencies = {
      ...baseDependencies([], persisted, httpGet),
      finishRun,
    };

    const result = await runCompanyDiscoveryInspection(database, config, logger(), dependencies);

    expect(httpGet).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
    expect(result).toMatchObject({
      status: 'succeeded',
      statistics: { candidatesQueued: 0, sitesInspected: 0, requestCount: 0 },
    });
    expect(finishRun).toHaveBeenCalledWith(
      database,
      'run-1',
      'succeeded',
      expect.objectContaining({ requestCount: 0 }),
    );
  });

  it('reconciles an empty current catalog before stale persisted candidates can make HTTP requests', async () => {
    const persisted: PersistDiscoveryAttemptInput[] = [];
    const createHttp = vi.fn();
    const staleCandidate = candidate('stale-candidate');
    const order: string[] = [];
    const dependencies: CompanyDiscoveryRunDependencies = {
      ...baseDependencies([staleCandidate], persisted),
      prepare: () => {
        order.push('prepare');
        return Promise.resolve(new Set());
      },
      listCandidates: () => {
        order.push('list');
        return Promise.resolve([staleCandidate]);
      },
      createHttp,
    };

    const result = await runCompanyDiscoveryInspection(database, config, logger(), dependencies);

    expect(createHttp).not.toHaveBeenCalled();
    expect(order).toEqual(['prepare', 'list']);
    expect(persisted).toEqual([]);
    expect(result).toMatchObject({
      status: 'succeeded',
      statistics: {
        candidatesQueued: 0,
        candidatesExcludedByCatalog: 1,
        requestCount: 0,
      },
    });
  });

  it('inspects a shared official URL once and persists one auditable attempt per sponsor', async () => {
    const persisted: PersistDiscoveryAttemptInput[] = [];
    let networkCallback: (() => void) | undefined;
    let observedConfig: { globalConcurrency: number; perDomainConcurrency: number } | undefined;
    const inspect = vi.fn(async (http: AtsHttpClient, officialUrl: string) => {
      await http.get(officialUrl);
      return {
        status: 'careers_found' as const,
        careersUrl: `${officialUrl}careers`,
        provider: 'greenhouse',
        sourceBaseUrl: 'https://boards-api.greenhouse.io',
        boardIdentifier: 'shared-brand',
        diagnostic: 'recognized ATS',
        pagesInspected: 1 as const,
        observations: [],
      };
    });
    const sharedUrl = 'https://shared.example/';
    const dependencies: CompanyDiscoveryRunDependencies = {
      ...baseDependencies([candidate('sponsor-a', sharedUrl), candidate('sponsor-b', sharedUrl)], persisted),
      inspect,
      createHttp: (httpConfig, _database, httpDependencies) => {
        observedConfig = httpConfig;
        networkCallback = () => httpDependencies?.onNetworkRequest?.(sharedUrl);
        return {
          get(url) {
            networkCallback?.();
            return Promise.resolve({
              status: 200,
              finalUrl: url,
              headers: {},
              body: '<html></html>',
            });
          },
          postJson() {
            throw new Error('Discovery test HTTP client permits GET only');
          },
        };
      },
    };

    const result = await runCompanyDiscoveryInspection(database, config, logger(), dependencies);

    expect(observedConfig).toMatchObject({ globalConcurrency: 4, perDomainConcurrency: 1 });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(2);
    expect(persisted.map((attempt) => attempt.physicalRequestCount)).toEqual([1, 0]);
    expect(persisted[0]?.result).toMatchObject({
      sharedObservation: {
        normalizedOfficialUrl: sharedUrl,
        sponsorCount: 2,
        representativeSponsorId: 'sponsor-a',
      },
    });
    expect(result.statistics).toMatchObject({
      candidatesAttempted: 2,
      sitesInspected: 1,
      careersFound: 2,
      requestCount: 1,
    });
  });

  it('records a blocked candidate and continues inspecting unrelated candidates', async () => {
    const persisted: PersistDiscoveryAttemptInput[] = [];
    const inspect = vi.fn((_http: AtsHttpClient, officialUrl: string) => {
      if (officialUrl.includes('blocked')) {
        return Promise.reject(
          new CrawlerHttpError({
            category: 'rate_limited',
            code: 'rate_limited_status',
            url: officialUrl,
            detail: 'bounded retries exhausted',
            status: 429,
          }),
        );
      }
      return Promise.resolve({
        status: 'no_public_careers' as const,
        careersUrl: null,
        provider: null,
        sourceBaseUrl: null,
        boardIdentifier: null,
        diagnostic: 'none found',
        pagesInspected: 1 as const,
        observations: [],
      });
    });
    const dependencies = {
      ...baseDependencies([candidate('blocked'), candidate('healthy')], persisted),
      inspect,
    };

    const result = await runCompanyDiscoveryInspection(database, config, logger(), dependencies);

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(persisted).toHaveLength(2);
    expect(persisted.find((attempt) => attempt.sponsorId === 'blocked')).toMatchObject({
      outcome: 'blocked',
      httpStatus: 429,
      category: 'rate_limited',
    });
    expect(persisted.find((attempt) => attempt.sponsorId === 'blocked')?.nextCheckAt).toBeUndefined();
    expect(result).toMatchObject({
      status: 'partial',
      statistics: { blocked: 1, noPublicCareers: 1 },
    });
  });

  it('rejects a third logical page before it reaches the HTTP client', async () => {
    const persisted: PersistDiscoveryAttemptInput[] = [];
    const httpGet = vi.fn<AtsHttpClient['get']>((url) =>
      Promise.resolve({ status: 200, finalUrl: url, headers: {}, body: '<html></html>' }),
    );
    const inspect = vi.fn(async (http: AtsHttpClient, officialUrl: string) => {
      await http.get(officialUrl);
      await http.get(`${officialUrl}careers`);
      await http.get(`${officialUrl}third-page`);
      throw new Error('unreachable');
    });
    const dependencies = {
      ...baseDependencies([candidate('page-cap')], persisted, httpGet),
      inspect,
    };

    const result = await runCompanyDiscoveryInspection(database, config, logger(), dependencies);

    expect(httpGet).toHaveBeenCalledTimes(2);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      outcome: 'error',
      category: 'parse_error',
      pagesInspected: 2,
      physicalRequestCount: 2,
    });
    expect(result.statistics.requestCount).toBe(2);
  });

  it('treats access statuses as blocked and unsupported findings as partial coverage', async () => {
    const persisted: PersistDiscoveryAttemptInput[] = [];
    const inspect = vi.fn((_http: AtsHttpClient, officialUrl: string) => {
      if (officialUrl.includes('access')) {
        return Promise.reject(new AtsResponseError('company_discovery', 'access required', 407));
      }
      return Promise.resolve({
        status: 'unsupported' as const,
        careersUrl: `${officialUrl}careers`,
        provider: 'successfactors',
        sourceBaseUrl: null,
        boardIdentifier: null,
        diagnostic: 'provider lacks a production adapter',
        pagesInspected: 1 as const,
        observations: [],
      });
    });
    const dependencies = {
      ...baseDependencies([candidate('access'), candidate('unsupported')], persisted),
      inspect,
    };

    const result = await runCompanyDiscoveryInspection(database, config, logger(), dependencies);

    expect(persisted.find((attempt) => attempt.sponsorId === 'access')).toMatchObject({
      outcome: 'blocked',
      category: 'blocked',
      httpStatus: 407,
    });
    expect(persisted.find((attempt) => attempt.sponsorId === 'unsupported')).toMatchObject({
      outcome: 'unsupported',
      provider: 'successfactors',
    });
    expect(result).toMatchObject({
      status: 'partial',
      statistics: { blocked: 1, unsupported: 1 },
    });
  });

  it('inspects only one distinct URL per hostname and records the rest for manual review', async () => {
    const persisted: PersistDiscoveryAttemptInput[] = [];
    const inspect = vi.fn(async (http: AtsHttpClient, officialUrl: string) => {
      await http.get(officialUrl);
      return {
        status: 'no_public_careers' as const,
        careersUrl: null,
        provider: null,
        sourceBaseUrl: null,
        boardIdentifier: null,
        diagnostic: 'none found',
        pagesInspected: 1 as const,
        observations: [],
      };
    });
    const dependencies = {
      ...baseDependencies(
        [
          candidate('host-first', 'https://shared-host.example/brand-a'),
          candidate('host-capped', 'https://shared-host.example/brand-b'),
        ],
        persisted,
      ),
      inspect,
    };

    const result = await runCompanyDiscoveryInspection(database, config, logger(), dependencies);

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(2);
    expect(persisted.find((attempt) => attempt.sponsorId === 'host-capped')).toMatchObject({
      outcome: 'manual_review',
      pagesInspected: 0,
      physicalRequestCount: 0,
      category: 'per_host_distinct_url_cap',
    });
    expect(result).toMatchObject({
      status: 'partial',
      statistics: {
        candidatesAttempted: 2,
        sitesInspected: 1,
        hostCappedCandidates: 1,
        requestCount: 1,
      },
    });
  });

  it('fails a repository contract breach above 100 candidates before creating an HTTP client', async () => {
    const candidates = Array.from({ length: 101 }, (_value, index) =>
      candidate(`cap-${String(index).padStart(3, '0')}`),
    );
    const persisted: PersistDiscoveryAttemptInput[] = [];
    const createHttp = vi.fn();
    const finishRun = vi.fn(() => Promise.resolve());
    const dependencies: CompanyDiscoveryRunDependencies = {
      ...baseDependencies(candidates, persisted),
      createHttp,
      finishRun,
    };

    await expect(
      runCompanyDiscoveryInspection(database, config, logger(), dependencies),
    ).rejects.toThrow('more than 100 candidates');

    expect(createHttp).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
    expect(finishRun).toHaveBeenCalledWith(
      database,
      'run-1',
      'failed',
      expect.objectContaining({ requestCount: 0 }),
    );
  });
});
