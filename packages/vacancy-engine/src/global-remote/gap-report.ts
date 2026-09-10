/**
 * Gap Report Generator: creates HTML reports for local diagnostics and CI fixtures
 * showing unsupported ATS coverage gaps and discovery failure patterns.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GapTelemetryReport } from './models.js';

/**
 * Generates an HTML report from telemetry data suitable for local diagnostics.
 * Includes tables of top failing providers and categorized failures.
 */
export function generateGapReportHtml(report: GapTelemetryReport): string {
  const categoryStyles = {
    unsupported_ats: 'background: #fff3cd; color: #856404;',
    blocked: 'background: #f8d7da; color: #721c24;',
    malformed: 'background: #d1ecf1; color: #0c5460;',
    empty: 'background: #d4edda; color: #155724;',
    transient: 'background: #e2e3e5; color: #383d41;',
  };

  const providerRows = Object.entries(report.aggregatedByProvider)
    .map(
      ([provider, count]) =>
        `<tr><td>${escapeHtml(provider)}</td><td style="text-align: right;">${count}</td></tr>`,
    )
    .join('');

  const categoryRows = Object.entries(report.aggregatedByCategory)
    .map(
      ([category, count]) => `
      <tr style="${categoryStyles[category as keyof typeof categoryStyles] || ''}">
        <td>${escapeHtml(category)}</td>
        <td style="text-align: right;">${count}</td>
      </tr>
    `,
    )
    .join('');

  const recentRecordsHtml = report.records
    .slice(-50)
    .reverse()
    .map(
      (record) => `
      <tr style="${categoryStyles[record.category as keyof typeof categoryStyles] || ''}">
        <td style="font-size: 0.85rem;">${record.timestamp}</td>
        <td><strong>${escapeHtml(record.category)}</strong></td>
        <td>${record.detectedProvider ? escapeHtml(record.detectedProvider) : '(unidentified)'}</td>
        <td><code style="font-size: 0.8rem;">${escapeHtml(record.redactedUrl)}</code></td>
        <td style="font-size: 0.85rem;">${escapeHtml(record.failureReason)}</td>
      </tr>
    `,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Open Vacancy Radar - Source Gap Report</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
      background: #f7f9fb;
      color: #17202a;
    }
    h1, h2 {
      color: #0757a6;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      margin: 1.5rem 0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    th {
      background: #edf2f7;
      border: 1px solid #d8dee4;
      padding: 0.75rem;
      text-align: left;
      font-weight: 600;
    }
    td {
      border: 1px solid #d8dee4;
      padding: 0.75rem;
    }
    tr:hover {
      background: #f7f9fb;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin: 1.5rem 0;
    }
    .stat-card {
      background: white;
      border: 1px solid #d8dee4;
      border-radius: 8px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .stat-number {
      font-size: 2rem;
      font-weight: 700;
      color: #0757a6;
      margin-bottom: 0.5rem;
    }
    .stat-label {
      font-size: 0.9rem;
      color: #5f6b76;
    }
    code {
      background: #f0f1f3;
      padding: 0.2rem 0.4rem;
      border-radius: 3px;
      font-family: 'Monaco', 'Courier New', monospace;
    }
    .warning {
      background: #fff8dc;
      border-left: 4px solid #d39e00;
      padding: 1rem;
      margin: 1rem 0;
      border-radius: 4px;
    }
    .warning strong {
      color: #d39e00;
    }
  </style>
</head>
<body>
  <h1>Source Gap Coverage Report</h1>
  <p>Generated: <time>${escapeHtml(report.generatedAt)}</time></p>

  <div class="warning">
    <strong>Note:</strong> This report is generated locally and contains only aggregated,
    redacted data. No sensitive information (query strings, credentials, personal data)
    is retained. Report intended for internal diagnostics and CI fixture verification.
  </div>

  <h2>Summary Statistics</h2>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-number">${report.totalRecords}</div>
      <div class="stat-label">Total Gap Records</div>
    </div>
    <div class="stat-card">
      <div class="stat-number">${report.records.length}</div>
      <div class="stat-label">Recent Records (capped at 1000)</div>
    </div>
    <div class="stat-card">
      <div class="stat-number">${Object.keys(report.aggregatedByProvider).length}</div>
      <div class="stat-label">Unique Providers Detected</div>
    </div>
  </div>

  <h2>Failure Categories</h2>
  <table>
    <thead>
      <tr>
        <th>Category</th>
        <th style="text-align: right;">Count</th>
      </tr>
    </thead>
    <tbody>
      ${categoryRows}
    </tbody>
  </table>

  ${providerRows
    ? `
    <h2>Top Unsupported ATS Providers</h2>
    <p>These ATS systems appear most frequently in discovery failures, suggesting
    high impact for adapter development.</p>
    <table>
      <thead>
        <tr>
          <th>Provider</th>
          <th style="text-align: right;">Occurrences</th>
        </tr>
      </thead>
      <tbody>
        ${providerRows}
      </tbody>
    </table>
  `
    : ''
  }

  <h2>Recent Gaps (Last 50 Records)</h2>
  <table>
    <thead>
      <tr>
        <th style="min-width: 180px;">Timestamp</th>
        <th>Category</th>
        <th style="min-width: 150px;">Provider</th>
        <th style="min-width: 250px;">Redacted URL</th>
        <th>Failure Reason</th>
      </tr>
    </thead>
    <tbody>
      ${recentRecordsHtml}
    </tbody>
  </table>

  <h2>Methodology</h2>
  <ul>
    <li><strong>Discovery-time logging:</strong> Gaps are recorded during global remote discovery runs
      when sources fail to retrieve job listings.</li>
    <li><strong>Redaction:</strong> URLs are redacted to remove query strings and sensitive path segments.
      Only protocol, domain, and top-level path are retained.</li>
    <li><strong>Classification:</strong> Failures are categorized as unsupported (identifiable ATS),
      blocked (rate limit/auth), malformed (parsing error), empty (no results), or transient (network).</li>
    <li><strong>Bounded storage:</strong> Reports retain only the most recent 1000 records to limit
      local disk usage.</li>
    <li><strong>Aggregation:</strong> Top 50 providers by occurrence count are shown; categories are
      summed across all records.</li>
  </ul>

  <footer style="margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #d8dee4; font-size: 0.9rem; color: #5f6b76;">
    <p>Open Vacancy Radar &mdash; No telemetry sent off-device. This report aids local diagnostics and prioritizes future development.</p>
  </footer>
</body>
</html>`;
}

/**
 * Escapes HTML special characters to prevent injection.
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/gu, (char) => map[char] ?? char);
}

/**
 * Generates a plain-text summary of the gap report for console output.
 */
export function generateGapReportText(report: GapTelemetryReport): string {
  const lines: string[] = [
    '=== Source Gap Coverage Report ===',
    `Generated: ${report.generatedAt}`,
    '',
    'SUMMARY STATISTICS',
    `  Total Gap Records: ${report.totalRecords}`,
    `  Recent Records (capped): ${report.records.length}`,
    `  Unique Providers Detected: ${Object.keys(report.aggregatedByProvider).length}`,
    '',
    'FAILURE CATEGORIES',
  ];

  for (const [category, count] of Object.entries(report.aggregatedByCategory)) {
    lines.push(`  ${category}: ${count}`);
  }

  if (Object.keys(report.aggregatedByProvider).length > 0) {
    lines.push('');
    lines.push('TOP UNSUPPORTED ATS PROVIDERS');
    for (const [provider, count] of Object.entries(report.aggregatedByProvider)) {
      lines.push(`  ${provider}: ${count}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('Report intended for internal diagnostics and CI fixture verification.');

  return lines.join('\n');
}

export type GapTelemetryReportFiles = {
  html: string;
  text: string;
};

/**
 * Writes the rendered HTML and plain-text gap reports to disk, alongside the raw
 * `gap-telemetry.json` records `source-gap-telemetry.ts` already persists -- same
 * `reports/global-remote` directory `report.ts`'s `writeGlobalRemoteReport` uses for the rest of a
 * scan's local diagnostic output, so this is a bounded report file suitable for local diagnostics
 * and CI fixtures (issue #9), not a new UI surface or IPC route.
 */
export async function writeGapTelemetryReport(
  report: GapTelemetryReport,
  projectRoot: string,
): Promise<GapTelemetryReportFiles> {
  const output = path.resolve(projectRoot, 'reports', 'global-remote');
  const relative = path.relative(projectRoot, output);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Gap telemetry report path must remain inside the project root');
  }
  await mkdir(output, { recursive: true });
  const html = path.join(output, 'gap-report.html');
  const text = path.join(output, 'gap-report.txt');
  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  const files: [string, string, string][] = [
    [html, `${html}${suffix}`, generateGapReportHtml(report)],
    [text, `${text}${suffix}`, generateGapReportText(report)],
  ];
  try {
    await Promise.all(files.map(([, temporary, contents]) => writeFile(temporary, contents, 'utf8')));
    await Promise.all(files.map(([target, temporary]) => rename(temporary, target)));
  } finally {
    await Promise.all(files.map(([, temporary]) => rm(temporary, { force: true })));
  }
  return { html, text };
}
