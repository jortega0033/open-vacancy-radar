import { describe, it, expect } from 'vitest';

import {
  generateGapReportHtml,
  generateGapReportText,
} from '../../src/global-remote/gap-report.js';
import type { GapTelemetryReport } from '../../src/global-remote/models.js';

describe('gap-report', () => {
  const sampleReport: GapTelemetryReport = {
    generatedAt: '2026-01-15T10:30:00Z',
    totalRecords: 150,
    records: [
      {
        timestamp: '2026-01-15T10:00:00Z',
        category: 'unsupported_ats',
        detectedProvider: 'BambooHR',
        redactedUrl: 'https://careers.company.com/jobs',
        httpStatus: null,
        failureReason: 'BambooHR API integration not supported',
      },
      {
        timestamp: '2026-01-15T10:05:00Z',
        category: 'blocked',
        detectedProvider: null,
        redactedUrl: 'https://jobs.example.com/api',
        httpStatus: 429,
        failureReason: 'Rate limited',
      },
      {
        timestamp: '2026-01-15T10:10:00Z',
        category: 'malformed',
        detectedProvider: null,
        redactedUrl: 'https://remote.company.com/jobs',
        httpStatus: null,
        failureReason: 'Invalid JSON response',
      },
    ],
    aggregatedByProvider: {
      BambooHR: 45,
      iCIMS: 28,
      Phenom: 12,
    },
    aggregatedByCategory: {
      unsupported_ats: 85,
      blocked: 35,
      malformed: 20,
      empty: 8,
      transient: 2,
    },
  };

  describe('generateGapReportHtml', () => {
    it('generates valid HTML', () => {
      const html = generateGapReportHtml(sampleReport);
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('</html>');
      expect(html).toContain('<title>Open Vacancy Radar - Source Gap Report</title>');
    });

    it('includes report timestamp', () => {
      const html = generateGapReportHtml(sampleReport);
      expect(html).toContain('2026-01-15T10:30:00Z');
    });

    it('includes summary statistics', () => {
      const html = generateGapReportHtml(sampleReport);
      expect(html).toContain('Total Gap Records');
      expect(html).toContain('150');
      expect(html).toContain('Recent Records (capped at 1000)');
      expect(html).toContain('Unique Providers Detected');
      expect(html).toContain('3'); // 3 providers in sample
    });

    it('includes all failure categories with counts', () => {
      const html = generateGapReportHtml(sampleReport);
      expect(html).toContain('unsupported_ats');
      expect(html).toContain('blocked');
      expect(html).toContain('malformed');
      expect(html).toContain('empty');
      expect(html).toContain('transient');
      expect(html).toContain('85'); // unsupported_ats count
      expect(html).toContain('35'); // blocked count
    });

    it('includes top providers', () => {
      const html = generateGapReportHtml(sampleReport);
      expect(html).toContain('Top Unsupported ATS Providers');
      expect(html).toContain('BambooHR');
      expect(html).toContain('iCIMS');
      expect(html).toContain('Phenom');
      expect(html).toContain('45'); // BambooHR count
    });

    it('includes recent records table', () => {
      const html = generateGapReportHtml(sampleReport);
      expect(html).toContain('Recent Gaps (Last 50 Records)');
      expect(html).toContain('2026-01-15T10:00:00Z');
      expect(html).toContain('Rate limited');
    });

    it('escapes HTML in URLs', () => {
      const report: GapTelemetryReport = {
        ...sampleReport,
        records: [
          {
            timestamp: '2026-01-15T10:00:00Z',
            category: 'malformed',
            detectedProvider: null,
            redactedUrl: 'https://example.com/jobs?query=<script>',
            httpStatus: null,
            failureReason: 'Test & verify <tags>',
          },
        ],
      };
      const html = generateGapReportHtml(report);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&amp;');
    });

    it('includes privacy disclaimer', () => {
      const html = generateGapReportHtml(sampleReport);
      expect(html).toContain('No sensitive information');
      expect(html).toContain('query strings');
      expect(html).toContain('local diagnostics');
    });

    it('styles categories with colors', () => {
      const html = generateGapReportHtml(sampleReport);
      expect(html).toContain('fff3cd'); // unsupported_ats yellow
      expect(html).toContain('f8d7da'); // blocked red
      expect(html).toContain('d1ecf1'); // malformed blue
    });
  });

  describe('generateGapReportText', () => {
    it('generates plain text report', () => {
      const text = generateGapReportText(sampleReport);
      expect(text).toContain('=== Source Gap Coverage Report ===');
      expect(text).toContain('Generated: 2026-01-15T10:30:00Z');
    });

    it('includes summary statistics', () => {
      const text = generateGapReportText(sampleReport);
      expect(text).toContain('SUMMARY STATISTICS');
      expect(text).toContain('Total Gap Records: 150');
      expect(text).toContain('Recent Records (capped): 3');
      expect(text).toContain('Unique Providers Detected: 3');
    });

    it('includes failure categories', () => {
      const text = generateGapReportText(sampleReport);
      expect(text).toContain('FAILURE CATEGORIES');
      expect(text).toContain('unsupported_ats: 85');
      expect(text).toContain('blocked: 35');
      expect(text).toContain('malformed: 20');
      expect(text).toContain('empty: 8');
      expect(text).toContain('transient: 2');
    });

    it('includes top providers', () => {
      const text = generateGapReportText(sampleReport);
      expect(text).toContain('TOP UNSUPPORTED ATS PROVIDERS');
      expect(text).toContain('BambooHR: 45');
      expect(text).toContain('iCIMS: 28');
      expect(text).toContain('Phenom: 12');
    });

    it('handles empty provider list', () => {
      const reportNoProviders: GapTelemetryReport = {
        ...sampleReport,
        aggregatedByProvider: {},
      };
      const text = generateGapReportText(reportNoProviders);
      expect(text).not.toContain('TOP UNSUPPORTED ATS PROVIDERS');
    });

    it('includes methodology note', () => {
      const text = generateGapReportText(sampleReport);
      expect(text).toContain('internal diagnostics');
      expect(text).toContain('CI fixture verification');
    });

    it('is readable and parseable', () => {
      const text = generateGapReportText(sampleReport);
      const lines = text.split('\n');
      expect(lines.length).toBeGreaterThan(10);
      expect(lines[0]).toContain('Source Gap Coverage Report');
    });
  });
});
