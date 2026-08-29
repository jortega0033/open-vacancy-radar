import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  it('keeps AI disabled without any credentials', () => {
    const config = loadConfig({}, process.cwd());
    expect(config.ai.enabled).toBe(false);
    expect(config.braveSearch).toMatchObject({
      apiKey: '',
      batchSize: 25,
      maxRequests: 25,
      recheckDays: 30,
    });
    expect(config.keyedDiscovery).toEqual({
      adzunaAppId: '',
      adzunaAppKey: '',
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
    });
    expect(config.globalConcurrency).toBe(6);
    expect(config.perDomainConcurrency).toBe(1);
    expect(config.maxResponseBytes).toBe(16 * 1024 * 1024);
    expect(config.maxPostingAgeDays).toBe(365);
    expect(config.httpCacheRetentionDays).toBe(90);
    expect(config.requestQueueTimeoutMs).toBe(120_000);
    expect(config.sponsorBaselineMaxAgeDays).toBe(45);
  });

  it('requires project-explicit AI configuration when enabled', () => {
    expect(() => loadConfig({ AI_ENABLED: 'true' }, process.cwd())).toThrow('AI_BASE_URL');
  });

  it('rejects a cache path outside the project', () => {
    expect(() =>
      loadConfig({ HTTP_CACHE_DIR: path.resolve(process.cwd(), '..', 'elsewhere') }, process.cwd()),
    ).toThrow('must remain inside');
  });

  it('does not allow a report threshold below the rendered review categories', () => {
    expect(() => loadConfig({ REPORT_MIN_SCORE: '69' }, process.cwd())).toThrow();
  });

  it('keeps the posting-age policy within conservative bounds', () => {
    expect(() => loadConfig({ MAX_POSTING_AGE_DAYS: '29' }, process.cwd())).toThrow();
    expect(() => loadConfig({ MAX_POSTING_AGE_DAYS: '731' }, process.cwd())).toThrow();
  });

  it('rejects an unsafe HTTP cache retention window', () => {
    expect(() => loadConfig({ HTTP_CACHE_RETENTION_DAYS: '6' }, process.cwd())).toThrow();
  });
});
