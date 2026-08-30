import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { MappingConfidence, WorkplaceMode } from '../domain/models.js';

export type ReportStatistics = {
  sponsorsLoaded: number;
  activeSponsors: number;
  companiesMapped: number;
  careerSourcesDiscovered: number;
  careerSourcesScanned: number;
  incompleteSources: number;
  blockedSources: number;
  manualReviewSources: number;
  unsupportedSources: number;
  vacanciesDiscovered: number;
  vacanciesNew: number;
  vacanciesChanged: number;
  vacanciesInactive: number;
  staleVacanciesExcluded: number;
  duplicateVacanciesCollapsed: number;
  deterministicCandidates: number;
  semanticScored: number;
  relevantVacancies: number;
  excellentMatches: number;
  errorCount: number;
  requestCount: number;
  durationMs: number;
};

export type ReportVacancy = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: boolean | null;
  workplaceMode: WorkplaceMode;
  provider: string;
  url: string;
  score: number;
  technicalFit: number;
  roleFit: number;
  seniorityFit: number;
  languageFit: number;
  locationFit: number;
  dutchRequired: boolean;
  dutchPreferred: boolean;
  languageEvidence: string[];
  primaryFit: string;
  matchingSkills: string[];
  gaps: string[];
  reasons: string[];
  sponsorLegalNames: string[];
  mappingConfidence: MappingConfidence;
  firstSeenAt: string;
  lastSeenAt: string;
  postedAt: string | null;
  verifiedInRun: boolean;
  sourceOutcomeStatus:
    | 'succeeded'
    | 'blocked'
    | 'manual_review'
    | 'unsupported'
    | 'failed'
    | null;
};

export type JobRadarReport = {
  runId: string;
  scanStatus: 'running' | 'succeeded' | 'partial' | 'failed';
  generatedAt: string;
  candidateProfileVersion: string;
  deterministicScoringVersion: string;
  freshnessPolicy: {
    maximumPostingAgeDays: number;
    cutoff: string;
  };
  officialSponsorSource: {
    url: string;
    lastUpdated: string | null;
    retrievedAt: string | null;
  };
  statistics: ReportStatistics;
  vacancies: ReportVacancy[];
};

const safeUrlSchema = z.url().refine((input) => {
  const url = new URL(input);
  return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '';
});

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value: string | null): string {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return 'Unknown';
  return new Intl.DateTimeFormat('en-NL', { dateStyle: 'medium', timeZone: 'Europe/Amsterdam' }).format(parsed);
}

const MILLISECONDS_PER_DAY = 86_400_000;

export function postingFreshnessCutoff(generatedAt: Date, maximumPostingAgeDays: number): Date {
  if (Number.isNaN(generatedAt.valueOf())) throw new RangeError('Report generation date is invalid');
  if (!Number.isInteger(maximumPostingAgeDays) || maximumPostingAgeDays < 1) {
    throw new RangeError('Maximum posting age must be a positive integer');
  }
  return new Date(generatedAt.getTime() - maximumPostingAgeDays * MILLISECONDS_PER_DAY);
}

export function isPostingFresh(
  postedAt: Date | null,
  generatedAt: Date,
  maximumPostingAgeDays: number,
): boolean {
  return postedAt === null || postedAt >= postingFreshnessCutoff(generatedAt, maximumPostingAgeDays);
}

export function categoryForScore(score: number): 'Excellent match' | 'Strong match' | 'Worth reviewing' | null {
  if (score >= 90) return 'Excellent match';
  if (score >= 80) return 'Strong match';
  if (score >= 70) return 'Worth reviewing';
  return null;
}

function renderList(items: string[], emptyLabel = 'None identified'): string {
  if (items.length === 0) return `<span class="muted">${escapeHtml(emptyLabel)}</span>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderVacancy(vacancy: ReportVacancy): string {
  const safeUrl = safeUrlSchema.safeParse(vacancy.url);
  const officialLink = safeUrl.success
    ? `<a class="open" href="${escapeHtml(safeUrl.data)}" rel="noopener noreferrer" target="_blank">OPEN OFFICIAL VACANCY</a>`
    : '<span class="unsafe">Official link withheld: unsafe URL</span>';
  const remoteLabel =
    vacancy.workplaceMode === 'remote'
      ? 'Remote'
      : vacancy.workplaceMode === 'hybrid'
        ? 'Hybrid'
        : vacancy.workplaceMode === 'onsite'
          ? 'On-site'
          : 'Remote/hybrid status unknown';
  const languageFlag = vacancy.dutchRequired
    ? '<strong class="danger">Dutch required</strong>'
    : vacancy.dutchPreferred
      ? '<strong class="warning">Dutch preferred</strong>'
      : '<span>No Dutch requirement detected</span>';
  const verificationFlag = vacancy.verifiedInRun
    ? '<span>Verified in this scan</span>'
    : `<strong class="warning">Not verified in this scan${
        vacancy.sourceOutcomeStatus === null
          ? ''
          : ` (${escapeHtml(vacancy.sourceOutcomeStatus.replaceAll('_', ' '))})`
      }</strong>`;

  return `<article class="job">
    <div class="score" aria-label="Score ${vacancy.score}">${vacancy.score}</div>
    <div class="job-body">
      <p class="eyebrow">${escapeHtml(vacancy.company)} · ${escapeHtml(vacancy.provider)}</p>
      <h3>${escapeHtml(vacancy.title)}</h3>
      <p>${escapeHtml(vacancy.location ?? 'Location unknown')} · ${escapeHtml(remoteLabel)}</p>
      <p>${languageFlag}</p>
      <p>${verificationFlag}</p>
      <p><strong>Primary fit:</strong> ${escapeHtml(vacancy.primaryFit)}</p>
      <div class="dimensions">
        <span>Technical ${vacancy.technicalFit}</span><span>Role ${vacancy.roleFit}</span><span>Seniority ${vacancy.seniorityFit}</span><span>Language ${vacancy.languageFit}</span><span>Location ${vacancy.locationFit}</span>
      </div>
      <details><summary>Why it ranked here</summary>${renderList(vacancy.reasons)}</details>
      <details><summary>Matching skills</summary>${renderList(vacancy.matchingSkills)}</details>
      <details><summary>Gaps</summary>${renderList(vacancy.gaps)}</details>
      <p class="meta">IND sponsor legal entity: ${escapeHtml(vacancy.sponsorLegalNames.join(', ') || 'Mapping unavailable')} · Mapping confidence: ${escapeHtml(vacancy.mappingConfidence)} · First seen: ${escapeHtml(formatDate(vacancy.firstSeenAt))} · Last seen: ${escapeHtml(formatDate(vacancy.lastSeenAt))} · Posted: ${escapeHtml(formatDate(vacancy.postedAt))}</p>
      ${officialLink}
    </div>
  </article>`;
}

function renderStatistics(statistics: ReportStatistics): string {
  const entries: [string, number][] = [
    ['IND sponsors loaded', statistics.sponsorsLoaded],
    ['Active sponsors', statistics.activeSponsors],
    ['Companies mapped', statistics.companiesMapped],
    ['Career sources discovered', statistics.careerSourcesDiscovered],
    ['Career sources scanned', statistics.careerSourcesScanned],
    ['Incomplete source responses', statistics.incompleteSources],
    ['Blocked sources', statistics.blockedSources],
    ['Manual-review sources', statistics.manualReviewSources],
    ['Unsupported sources', statistics.unsupportedSources],
    ['Vacancies discovered', statistics.vacanciesDiscovered],
    ['New', statistics.vacanciesNew],
    ['Changed', statistics.vacanciesChanged],
    ['Inactive', statistics.vacanciesInactive],
    ['Known stale postings excluded', statistics.staleVacanciesExcluded],
    ['Duplicate reposts collapsed', statistics.duplicateVacanciesCollapsed],
    ['Passed deterministic filter', statistics.deterministicCandidates],
    ['Semantically scored', statistics.semanticScored],
    ['Relevant', statistics.relevantVacancies],
    ['Excellent matches', statistics.excellentMatches],
    ['Errors', statistics.errorCount],
    ['HTTP requests', statistics.requestCount],
    ['Duration (seconds)', Math.round(statistics.durationMs / 1000)],
  ];
  return `<dl class="stats">${entries
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`)
    .join('')}</dl>`;
}

export function renderHtmlReport(report: JobRadarReport): string {
  const sorted = [...report.vacancies].sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  const categories = ['Excellent match', 'Strong match', 'Worth reviewing'] as const;
  const sections = categories
    .map((category) => {
      const matching = sorted.filter((vacancy) => categoryForScore(vacancy.score) === category);
      return `<section><h2>${category} <span>${matching.length}</span></h2>${
        matching.length > 0 ? matching.map(renderVacancy).join('') : '<p class="muted">No vacancies in this category.</p>'
      }</section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open Vacancy Radar — ${escapeHtml(formatDate(report.generatedAt))}</title>
<style>
:root{color-scheme:light;--ink:#17211d;--muted:#617069;--line:#d9e1dc;--surface:#f4f7f5;--green:#0b6e4f;--red:#a51d2d;--amber:#855f00}*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--ink);background:#fff}main{width:min(1100px,calc(100% - 32px));margin:48px auto 96px}h1{font-size:clamp(2rem,6vw,4.5rem);line-height:1;margin:.2em 0}h2{border-bottom:2px solid var(--ink);padding-bottom:.4rem;margin-top:3rem}h2 span{color:var(--muted);font-size:.8em}.lede{max-width:75ch}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:2rem 0}.stats div{background:#fff;padding:12px}.stats dt{color:var(--muted);font-size:.8rem}.stats dd{font-size:1.5rem;font-weight:700;margin:0}.job{display:grid;grid-template-columns:72px 1fr;gap:20px;padding:24px 0;border-bottom:1px solid var(--line)}.score{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;background:var(--ink);color:#fff;font-size:1.5rem;font-weight:800}.job h3{font-size:1.5rem;margin:.15rem 0}.eyebrow,.meta,.muted{color:var(--muted)}.eyebrow{text-transform:uppercase;letter-spacing:.05em;font-size:.8rem}.meta{font-size:.82rem}.dimensions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.dimensions span{background:var(--surface);padding:4px 8px;border-radius:4px}details{margin:.5rem 0}details ul{margin:.5rem 0}.open{display:inline-block;background:var(--green);color:#fff;font-weight:800;text-decoration:none;padding:12px 18px;border-radius:5px;margin-top:8px}.open:focus,.open:hover{outline:3px solid #8dd7bd;outline-offset:2px}.danger,.unsafe{color:var(--red)}.warning{color:var(--amber)}@media(max-width:600px){.job{grid-template-columns:1fr}.score{width:52px;height:52px}}
</style></head><body><main>
<p class="eyebrow">Candidate ${escapeHtml(report.candidateProfileVersion)} · Scoring ${escapeHtml(report.deterministicScoringVersion)} · Run ${escapeHtml(report.scanStatus)}</p><h1>Open Vacancy Radar</h1>
<p class="lede">Ranked official vacancies at mapped IND-recognised sponsors. Sponsor recognition does not guarantee that a particular vacancy offers sponsorship; always verify the vacancy and employment terms manually.</p>
<p class="lede">Known posting dates older than ${report.freshnessPolicy.maximumPostingAgeDays} days are excluded. Vacancies without a posting date remain eligible and require manual freshness verification.</p>
<p>Generated ${escapeHtml(formatDate(report.generatedAt))}. Official register update: ${escapeHtml(formatDate(report.officialSponsorSource.lastUpdated))}.</p>
${renderStatistics(report.statistics)}${sections}
</main></body></html>`;
}

function safeOutputDirectory(projectRoot: string, outputDirectory: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedOutput = path.resolve(resolvedRoot, outputDirectory);
  const relative = path.relative(resolvedRoot, resolvedOutput);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Report output must remain inside the project');
  return resolvedOutput;
}

export async function writeReportFiles(
  report: JobRadarReport,
  options: { projectRoot?: string; outputDirectory?: string } = {},
): Promise<{ latestHtml: string; latestJson: string; timestampedHtml: string; timestampedJson: string }> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const outputDirectory = safeOutputDirectory(projectRoot, options.outputDirectory ?? 'reports');
  await mkdir(outputDirectory, { recursive: true });
  const timestamp = report.generatedAt.replaceAll(':', '-').replaceAll('.', '-');
  const latestHtml = path.join(outputDirectory, 'latest.html');
  const latestJson = path.join(outputDirectory, 'latest.json');
  const timestampedHtml = path.join(outputDirectory, `${timestamp}.html`);
  const timestampedJson = path.join(outputDirectory, `${timestamp}.json`);
  const html = renderHtmlReport(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const temporarySuffix = `.tmp-${process.pid}-${randomUUID()}`;
  const temporaryLatestHtml = `${latestHtml}${temporarySuffix}`;
  const temporaryLatestJson = `${latestJson}${temporarySuffix}`;
  const temporaryTimestampedHtml = `${timestampedHtml}${temporarySuffix}`;
  const temporaryTimestampedJson = `${timestampedJson}${temporarySuffix}`;
  const temporaryFiles = [
    temporaryLatestHtml,
    temporaryLatestJson,
    temporaryTimestampedHtml,
    temporaryTimestampedJson,
  ];
  try {
    await Promise.all([
      writeFile(temporaryLatestHtml, html, 'utf8'),
      writeFile(temporaryLatestJson, json, 'utf8'),
      writeFile(temporaryTimestampedHtml, html, 'utf8'),
      writeFile(temporaryTimestampedJson, json, 'utf8'),
    ]);
    await Promise.all([
      rename(temporaryTimestampedHtml, timestampedHtml),
      rename(temporaryTimestampedJson, timestampedJson),
    ]);
    await rename(temporaryLatestHtml, latestHtml);
    await rename(temporaryLatestJson, latestJson);
  } finally {
    await Promise.all(temporaryFiles.map((file) => rm(file, { force: true })));
  }
  return { latestHtml, latestJson, timestampedHtml, timestampedJson };
}
