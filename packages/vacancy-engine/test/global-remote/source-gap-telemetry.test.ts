import { describe, it, expect } from 'vitest';

import {
  aggregateGapRecords,
  classifyFailure,
  detectAtsProviderFromError,
  redactUrl,
  recordFromSourceAudit,
} from '../../src/global-remote/source-gap-telemetry.js';
import type { DiscoverySourceAudit } from '../../src/global-remote/models.js';

describe('source-gap-telemetry', () => {
  describe('redactUrl', () => {
    it('removes query strings from URLs', () => {
      const url = 'https://example.com/jobs?page=1&query=developer&api_key=secret123';
      const redacted = redactUrl(url);
      expect(redacted).toBe('https://example.com/jobs');
      expect(redacted).not.toContain('query');
      expect(redacted).not.toContain('api_key');
      expect(redacted).not.toContain('secret');
    });

    it('removes fragments from URLs', () => {
      const url = 'https://example.com/jobs#section';
      const redacted = redactUrl(url);
      expect(redacted).toBe('https://example.com/jobs');
    });

    it('preserves protocol and domain', () => {
      const url = 'https://careers.company.com/jobs/listings/123?filter=remote';
      const redacted = redactUrl(url);
      expect(redacted).toContain('https://');
      expect(redacted).toContain('careers.company.com');
    });

    it('handles invalid URLs gracefully', () => {
      const url = 'not a valid url at all!!!';
      const redacted = redactUrl(url);
      expect(redacted).toMatch(/^\[redacted-\d+-bytes\]$/);
    });

    it('keeps only first path segment', () => {
      const url = 'https://example.com/api/v2/jobs/123/details?key=value';
      const redacted = redactUrl(url);
      expect(redacted).toBe('https://example.com/api');
    });
  });

  describe('classifyFailure', () => {
    it('classifies blocked status as blocked', () => {
      const result = classifyFailure('blocked', null, null);
      expect(result).toBe('blocked');
    });

    it('classifies HTTP 429 (rate limit) as blocked', () => {
      const result = classifyFailure('error', 429, 'Too many requests');
      expect(result).toBe('blocked');
    });

    it('classifies HTTP 401 (unauthorized) as blocked', () => {
      const result = classifyFailure('error', 401, 'Unauthorized');
      expect(result).toBe('blocked');
    });

    it('classifies malformed JSON error as malformed', () => {
      const result = classifyFailure('error', null, 'invalid JSON');
      expect(result).toBe('malformed');
    });

    it('classifies "not an array" error as malformed', () => {
      const result = classifyFailure('error', null, 'jobs is not an array');
      expect(result).toBe('malformed');
    });

    it('classifies empty results as empty', () => {
      const result = classifyFailure('error', null, 'No jobs found');
      expect(result).toBe('empty');
    });

    it('classifies timeout as transient', () => {
      const result = classifyFailure('error', null, 'Request timeout');
      expect(result).toBe('transient');
    });

    it('classifies connection error as transient', () => {
      const result = classifyFailure('error', null, 'ECONNREFUSED');
      expect(result).toBe('transient');
    });

    it('classifies partial status without error as transient', () => {
      const result = classifyFailure('partial', null, null);
      expect(result).toBe('transient');
    });

    it('classifies error with no message as transient', () => {
      const result = classifyFailure('error', null, null);
      expect(result).toBe('transient');
    });
  });

  describe('detectAtsProviderFromError', () => {
    it('detects BambooHR from error message', () => {
      const result = detectAtsProviderFromError('Failed to reach BambooHR API', 'https://example.com');
      expect(result).toBe('BambooHR');
    });

    it('detects iCIMS from URL', () => {
      const result = detectAtsProviderFromError(null, 'https://jobs.icims.com/jobs/list');
      expect(result).toBe('iCIMS');
    });

    it('detects Workday from error message', () => {
      const result = detectAtsProviderFromError('Workday authentication required', 'https://example.com');
      expect(result).toBe('Workday');
    });

    it('detects Phenom from URL', () => {
      const result = detectAtsProviderFromError(null, 'https://careers.phenom.com/jobs');
      expect(result).toBe('Phenom');
    });

    it('returns null when no provider is detected', () => {
      const result = detectAtsProviderFromError('Generic error message', 'https://generic-site.com/jobs');
      expect(result).toBeNull();
    });

    it('handles case-insensitive matching', () => {
      const result = detectAtsProviderFromError('BAMBOOHR integration failed', 'https://example.com');
      expect(result).toBe('BambooHR');
    });

    it('returns null for null error message', () => {
      const result = detectAtsProviderFromError(null, 'https://generic-site.com/jobs');
      expect(result).toBeNull();
    });
  });

  describe('recordFromSourceAudit', () => {
    it('returns null for successful source', () => {
      const audit: DiscoverySourceAudit = {
        id: 'test:success',
        provider: 'himalayas',
        url: 'https://himalayas.app/jobs/api/search',
        requests: 5,
        listings: 42,
        status: 'success',
        error: null,
        networkAttempts: 5,
        retries: 0,
        complete: true,
        completenessReason: null,
        continuationCursor: null,
      };
      const result = recordFromSourceAudit(audit);
      expect(result).toBeNull();
    });

    it('records failure with category and provider', () => {
      const audit: DiscoverySourceAudit = {
        id: 'test:error',
        provider: 'remotive',
        url: 'https://remotive.com/api/remote-jobs?bamboohr',
        requests: 1,
        listings: 0,
        status: 'error',
        error: 'BambooHR integration not supported',
        networkAttempts: 1,
        retries: 0,
        complete: false,
        completenessReason: 'BambooHR integration not supported',
        continuationCursor: null,
      };
      const result = recordFromSourceAudit(audit);
      expect(result).not.toBeNull();
      expect(result?.category).toBe('unsupported_ats');
      expect(result?.detectedProvider).toBe('BambooHR');
      expect(result?.redactedUrl).toBe('https://remotive.com/api');
    });

    it('records blocked status correctly', () => {
      const audit: DiscoverySourceAudit = {
        id: 'test:blocked',
        provider: 'jobicy',
        url: 'https://jobicy.com/api/v2/remote-jobs',
        requests: 0,
        listings: 0,
        status: 'blocked',
        error: 'HTTP 429: Rate limited',
        networkAttempts: 1,
        retries: 0,
        complete: false,
        completenessReason: 'HTTP 429: Rate limited',
        continuationCursor: null,
      };
      const result = recordFromSourceAudit(audit);
      expect(result).not.toBeNull();
      expect(result?.category).toBe('blocked');
    });

    it('includes timestamp in record', () => {
      const audit: DiscoverySourceAudit = {
        id: 'test:error',
        provider: 'himalayas',
        url: 'https://himalayas.app/jobs/api/search',
        requests: 0,
        listings: 0,
        status: 'error',
        error: 'Connection timeout',
        networkAttempts: 1,
        retries: 0,
        complete: false,
        completenessReason: 'Connection timeout',
        continuationCursor: null,
      };
      const result = recordFromSourceAudit(audit);
      expect(result?.timestamp).toBeDefined();
      expect(new Date(result!.timestamp).getTime()).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('aggregateGapRecords', () => {
    it('sums provider occurrences correctly', () => {
      const records = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          category: 'unsupported_ats' as const,
          detectedProvider: 'BambooHR',
          redactedUrl: 'https://example.com/api',
          httpStatus: null,
          failureReason: 'BambooHR not supported',
        },
        {
          timestamp: '2026-01-01T00:00:01Z',
          category: 'unsupported_ats' as const,
          detectedProvider: 'BambooHR',
          redactedUrl: 'https://example.com/api',
          httpStatus: null,
          failureReason: 'BambooHR not supported',
        },
        {
          timestamp: '2026-01-01T00:00:02Z',
          category: 'unsupported_ats' as const,
          detectedProvider: 'iCIMS',
          redactedUrl: 'https://example.com/api',
          httpStatus: null,
          failureReason: 'iCIMS not supported',
        },
      ];

      const report = aggregateGapRecords(records);
      expect(report.aggregatedByProvider['BambooHR']).toBe(2);
      expect(report.aggregatedByProvider['iCIMS']).toBe(1);
    });

    it('sums category counts correctly', () => {
      const records = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          category: 'blocked' as const,
          detectedProvider: null,
          redactedUrl: 'https://example.com/api',
          httpStatus: 429,
          failureReason: 'Rate limited',
        },
        {
          timestamp: '2026-01-01T00:00:01Z',
          category: 'malformed' as const,
          detectedProvider: null,
          redactedUrl: 'https://example.com/api',
          httpStatus: null,
          failureReason: 'Invalid JSON',
        },
        {
          timestamp: '2026-01-01T00:00:02Z',
          category: 'blocked' as const,
          detectedProvider: null,
          redactedUrl: 'https://example.com/api',
          httpStatus: 403,
          failureReason: 'Forbidden',
        },
      ];

      const report = aggregateGapRecords(records);
      expect(report.aggregatedByCategory.blocked).toBe(2);
      expect(report.aggregatedByCategory.malformed).toBe(1);
      expect(report.aggregatedByCategory.unsupported_ats).toBe(0);
    });

    it('caps records at 1000', () => {
      const baseTime = Date.now();
      const records = Array.from({ length: 1500 }, (_, i) => ({
        timestamp: new Date(baseTime + i * 1000).toISOString(),
        category: 'transient' as const,
        detectedProvider: null,
        redactedUrl: 'https://example.com/api',
        httpStatus: null,
        failureReason: 'Timeout',
      }));

      const report = aggregateGapRecords(records);
      expect(report.records.length).toBe(1000);
      expect(report.totalRecords).toBe(1500);
      // Should keep the last 1000 (from index 500 onwards)
      // The first record should be the one that was at index 500 in the original
      expect(report.records[0]?.timestamp).toBe(records[500]?.timestamp);
    });

    it('sorts providers by count descending', () => {
      const records = [
        ...Array.from({ length: 5 }, () => ({
          timestamp: '2026-01-01T00:00:00Z',
          category: 'unsupported_ats' as const,
          detectedProvider: 'BambooHR',
          redactedUrl: 'https://example.com/api',
          httpStatus: null,
          failureReason: 'BambooHR not supported',
        })),
        ...Array.from({ length: 3 }, () => ({
          timestamp: '2026-01-01T00:00:00Z',
          category: 'unsupported_ats' as const,
          detectedProvider: 'iCIMS',
          redactedUrl: 'https://example.com/api',
          httpStatus: null,
          failureReason: 'iCIMS not supported',
        })),
      ];

      const report = aggregateGapRecords(records);
      const providerEntries = Object.entries(report.aggregatedByProvider);
      expect(providerEntries[0]![0]).toBe('BambooHR');
      expect(providerEntries[0]![1]).toBe(5);
    });

    it('includes timestamp in report', () => {
      const records = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          category: 'transient' as const,
          detectedProvider: null,
          redactedUrl: 'https://example.com/api',
          httpStatus: null,
          failureReason: 'Timeout',
        },
      ];

      const report = aggregateGapRecords(records);
      expect(report.generatedAt).toBeDefined();
      expect(new Date(report.generatedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('handles empty records array', () => {
      const report = aggregateGapRecords([]);
      expect(report.records.length).toBe(0);
      expect(report.totalRecords).toBe(0);
      expect(report.aggregatedByProvider).toEqual({});
      expect(report.aggregatedByCategory).toEqual({
        unsupported_ats: 0,
        blocked: 0,
        malformed: 0,
        empty: 0,
        transient: 0,
      });
    });
  });
});
