import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  DiscoveryVacancyAudit,
  GlobalRemoteReport,
  OfficialVacancyAudit,
  SourceRegistryEntry,
} from './models.js';

export type GlobalRemoteReportFiles = {
  latestHtml: string;
  latestJson: string;
  latestAudit: string;
  timestampedHtml: string;
  timestampedJson: string;
  timestampedAudit: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function link(url: string, label: string): string {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return escapeHtml(label);
    return `<a href="${escapeHtml(parsed.toString())}" rel="noreferrer">${escapeHtml(label)}</a>`;
  } catch {
    return escapeHtml(label);
  }
}

function money(value: number | null): string {
  return value === null ? 'Unknown' : `$${Math.round(value).toLocaleString('en-US')}`;
}

function officialRows(vacancies: readonly OfficialVacancyAudit[]): string {
  if (vacancies.length === 0) return '<p>None.</p>';
  return `<table><thead><tr><th>Company / role</th><th>Decision</th><th>Base floor</th><th>Evidence</th></tr></thead><tbody>${vacancies.map((vacancy) => `
    <tr>
      <td>${link(vacancy.url, vacancy.company)}<br><strong>${escapeHtml(vacancy.title)}</strong><br><small>${escapeHtml(vacancy.provider)} · ${escapeHtml(vacancy.state)}</small></td>
      <td><code>${escapeHtml(vacancy.decision)}</code><br>${escapeHtml(vacancy.reasons.join(' '))}</td>
      <td>${money(vacancy.minimumAnnualBaseUsd)}</td>
      <td><ul>${vacancy.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></td>
    </tr>`).join('')}</tbody></table>`;
}

function discoveryRows(vacancies: readonly DiscoveryVacancyAudit[]): string {
  const candidates = vacancies.filter((vacancy) =>
    !['role_mismatch', 'non_vacancy'].includes(vacancy.decision));
  if (candidates.length === 0) return '<p>No title-matched discovery listings.</p>';
  return `<table><thead><tr><th>Discovery listing</th><th>Metadata</th><th>Preliminary decision</th></tr></thead><tbody>${candidates.map((vacancy) => `
    <tr>
      <td>${link(vacancy.url, vacancy.company)}<br><strong>${escapeHtml(vacancy.title)}</strong><br><small>${escapeHtml(vacancy.provider)}</small></td>
      <td>${escapeHtml(vacancy.location)}<br>${money(vacancy.annualizedMinimumUsd)} USD annualized minimum</td>
      <td><code>${escapeHtml(vacancy.decision)}</code><br>${escapeHtml(vacancy.reasons.join(' '))}</td>
    </tr>`).join('')}</tbody></table>`;
}

function registryRows(sources: readonly SourceRegistryEntry[]): string {
  return `<table><thead><tr><th>Source</th><th>Transport</th><th>State</th><th>Production decision</th></tr></thead><tbody>${sources.map((source) => `
    <tr>
      <td>${link(source.url, source.name)}<br><small>${escapeHtml(source.id)}</small></td>
      <td>${escapeHtml(source.transport)} · adapter ${escapeHtml(source.adapter)}</td>
      <td><code>${escapeHtml(source.state)}</code><br>${escapeHtml(source.ingestionMode)}</td>
      <td>${escapeHtml(source.reason)}</td>
    </tr>`).join('')}</tbody></table>`;
}

export function renderGlobalRemoteHtml(report: GlobalRemoteReport): string {
  const stats = report.statistics;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Global Remote Frontend Radar</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:1500px;margin:0 auto;padding:2rem;color:#17202a;background:#f7f9fb}h1,h2{line-height:1.2}a{color:#0757a6}code{font-size:.85rem}table{width:100%;border-collapse:collapse;background:white;margin:1rem 0 2rem}th,td{text-align:left;vertical-align:top;border:1px solid #d8dee4;padding:.65rem}th{background:#edf2f7}ul{margin:.25rem 0;padding-left:1.25rem}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.75rem}.card{background:white;border:1px solid #d8dee4;border-radius:8px;padding:1rem}.number{font-size:1.7rem;font-weight:700}.warning{background:#fff8dc;border-left:4px solid #d39e00;padding:1rem}small{color:#5f6b76}
</style></head><body>
<h1>Global Remote Frontend Radar</h1>
<p>Generated ${escapeHtml(report.generatedAt)} · Run ${escapeHtml(report.runId)}</p>
<p class="warning">A discovery-board label is never treated as final proof. Strict matches require a current official employer/ATS source, fully remote work from the Netherlands, no US-only authorization gate, and a guaranteed USD annual base floor of ${money(report.criteria.minimumAnnualBaseUsd)}.</p>
<div class="cards">
  <div class="card"><div class="number">${stats.strictMatches}</div>strict matches</div>
  <div class="card"><div class="number">${stats.manualReview}</div>manual checks</div>
  <div class="card"><div class="number">${stats.nearMisses}</div>near misses</div>
  <div class="card"><div class="number">${stats.discoveryUniqueListings}</div>unique discovery listings</div>
  <div class="card"><div class="number">${stats.officialRequests}</div>official requests</div>
  <div class="card"><div class="number">${stats.activeRegistrySources}/${stats.registrySources}</div>active / registered sources</div>
</div>
<h2>Strict matches</h2>${officialRows(report.strictMatches)}
<h2>Manual confirmation queue</h2>${officialRows(report.manualReview)}
<h2>Salary near misses</h2>${officialRows(report.nearMisses)}
<h2>Excluded or inactive official roles</h2>${officialRows(report.excludedOrInactive)}
<h2>Blocked or errored official sources</h2>${officialRows(report.blockedOrErrored)}
<h2>Discovery-board title matches</h2>
<p>The complete per-listing record, including role mismatches, is in <code>latest.audit.ndjson</code>.</p>
${discoveryRows(report.discoveryAudit)}
<h2>Source integration registry</h2>
<p>${stats.activeRegistrySources} active, ${stats.gatedRegistrySources} credential/partner/blocked, and ${stats.manualOrProhibitedRegistrySources} manual or prohibited. A registry entry is not counted as an active adapter unless the scan actually has a deterministic integration.</p>
${registryRows(report.sourceRegistry)}
<h2>Method</h2><ul>${report.methodology.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
<h2>Attribution</h2><ul>${report.attribution.map((item) => `<li>${link(item.url, item.name)}</li>`).join('')}</ul>
</body></html>`;
}

function safeOutputDirectory(projectRoot: string): string {
  const output = path.resolve(projectRoot, 'reports', 'global-remote');
  const relative = path.relative(projectRoot, output);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Global remote report path must remain inside the project root');
  }
  return output;
}

export async function writeGlobalRemoteReport(
  report: GlobalRemoteReport,
  projectRoot = process.cwd(),
): Promise<GlobalRemoteReportFiles> {
  const output = safeOutputDirectory(projectRoot);
  await mkdir(output, { recursive: true });
  const timestamp = report.generatedAt.replaceAll(':', '-').replaceAll('.', '-');
  const latestHtml = path.join(output, 'latest.html');
  const latestJson = path.join(output, 'latest.json');
  const latestAudit = path.join(output, 'latest.audit.ndjson');
  const timestampedHtml = path.join(output, `${timestamp}.html`);
  const timestampedJson = path.join(output, `${timestamp}.json`);
  const timestampedAudit = path.join(output, `${timestamp}.audit.ndjson`);
  const html = renderGlobalRemoteHtml(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const audit = [
    ...report.sourceRegistry.map((value) => JSON.stringify({ kind: 'source_registry', ...value })),
    ...report.discoverySources.map((value) => JSON.stringify({ kind: 'discovery_source', ...value })),
    ...report.discoveryAudit.map((value) => JSON.stringify({ kind: 'discovery_vacancy', ...value })),
    ...report.officialAudit.map((value) => JSON.stringify({ kind: 'official_vacancy', ...value })),
  ].join('\n').concat('\n');
  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  const files: [string, string, string][] = [
    [latestHtml, `${latestHtml}${suffix}`, html],
    [latestJson, `${latestJson}${suffix}`, json],
    [latestAudit, `${latestAudit}${suffix}`, audit],
    [timestampedHtml, `${timestampedHtml}${suffix}`, html],
    [timestampedJson, `${timestampedJson}${suffix}`, json],
    [timestampedAudit, `${timestampedAudit}${suffix}`, audit],
  ];
  try {
    await Promise.all(files.map(([, temporary, contents]) => writeFile(temporary, contents, 'utf8')));
    await Promise.all(files.slice(3).map(([target, temporary]) => rename(temporary, target)));
    for (const [target, temporary] of files.slice(0, 3)) await rename(temporary, target);
  } finally {
    await Promise.all(files.map(([, temporary]) => rm(temporary, { force: true })));
  }
  return { latestHtml, latestJson, latestAudit, timestampedHtml, timestampedJson, timestampedAudit };
}
