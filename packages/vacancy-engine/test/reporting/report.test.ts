import { describe, expect, it } from 'vitest';

import {
  categoryForScore,
  isPostingFresh,
  renderHtmlReport,
  type JobRadarReport,
} from '../../src/reporting/report.js';

function reportWithScore(score: number, overrides: Partial<JobRadarReport['vacancies'][number]> = {}): JobRadarReport {
  return {
    runId: 'run-1',
    scanStatus: 'succeeded',
    generatedAt: '2026-08-28T12:00:00.000Z',
    candidateProfileVersion: 'candidate-profile-v1',
    profileConfigured: true,
    indVerificationEnabled: true,
    deterministicScoringVersion: 'deterministic-v2',
    freshnessPolicy: {
      maximumPostingAgeDays: 365,
      cutoff: '2025-08-28T12:00:00.000Z',
    },
    officialSponsorSource: {
      url: 'https://ind.nl/en/public-register-recognised-sponsors/public-register-work',
      lastUpdated: '2026-08-03T00:00:00.000Z',
      retrievedAt: '2026-08-28T10:00:00.000Z',
    },
    statistics: {
      sponsorsLoaded: 1,
      activeSponsors: 1,
      companiesMapped: 1,
      careerSourcesDiscovered: 1,
      careerSourcesScanned: 1,
      incompleteSources: 0,
      blockedSources: 0,
      manualReviewSources: 0,
      unsupportedSources: 0,
      vacanciesDiscovered: 1,
      vacanciesNew: 1,
      vacanciesChanged: 0,
      vacanciesInactive: 0,
      staleVacanciesExcluded: 0,
      duplicateVacanciesCollapsed: 0,
      deterministicCandidates: 1,
      semanticScored: 0,
      relevantVacancies: 1,
      excellentMatches: score >= 90 ? 1 : 0,
      errorCount: 0,
      requestCount: 1,
      durationMs: 1000,
    },
    vacancies: [
      {
        id: 'job-1',
        title: 'Senior Frontend Engineer',
        description: 'We are looking for a senior frontend engineer to join our product team.',
        company: 'Example',
        location: null,
        remote: null,
        workplaceMode: 'unknown',
        provider: 'greenhouse',
        url: 'https://jobs.example.com/job-1',
        score,
        technicalFit: 95,
        roleFit: 95,
        seniorityFit: 90,
        languageFit: 100,
        locationFit: 80,
        dutchRequired: false,
        dutchPreferred: false,
        languageEvidence: [],
        primaryFit: 'Frontend product engineering',
        matchingSkills: ['Angular', 'TypeScript'],
        gaps: [],
        reasons: ['Strong frontend responsibilities'],
        sponsorLegalNames: ['Example B.V.'],
        mappingConfidence: 'high',
        firstSeenAt: '2026-08-28T10:00:00.000Z',
        lastSeenAt: '2026-08-28T11:00:00.000Z',
        postedAt: null,
        verifiedInRun: false,
        sourceOutcomeStatus: 'failed',
        ...overrides,
      },
    ],
  };
}

/** A report as returned when the candidate profile has no target roles/strongest skills: every
 * scoring field, including dutchRequired/dutchPreferred, is genuinely absent, not false. */
function unscoredReport(): JobRadarReport {
  const base = reportWithScore(0);
  return {
    ...base,
    profileConfigured: false,
    vacancies: [
      {
        id: base.vacancies[0]!.id,
        title: base.vacancies[0]!.title,
        description: base.vacancies[0]!.description,
        company: base.vacancies[0]!.company,
        location: base.vacancies[0]!.location,
        remote: base.vacancies[0]!.remote,
        workplaceMode: base.vacancies[0]!.workplaceMode,
        provider: base.vacancies[0]!.provider,
        url: base.vacancies[0]!.url,
        sponsorLegalNames: base.vacancies[0]!.sponsorLegalNames,
        mappingConfidence: base.vacancies[0]!.mappingConfidence,
        firstSeenAt: base.vacancies[0]!.firstSeenAt,
        lastSeenAt: base.vacancies[0]!.lastSeenAt,
        postedAt: base.vacancies[0]!.postedAt,
        verifiedInRun: base.vacancies[0]!.verifiedInRun,
        sourceOutcomeStatus: base.vacancies[0]!.sourceOutcomeStatus,
      },
    ],
  };
}

describe('report generation', () => {
  it.each([
    [90, 'Excellent match'],
    [89, 'Strong match'],
    [80, 'Strong match'],
    [79, 'Worth reviewing'],
    [70, 'Worth reviewing'],
    [69, null],
  ] as const)('places score %i in the correct category', (score, expected) => {
    expect(categoryForScore(score)).toBe(expected);
  });

  it('escapes vacancy content and withholds unsafe links', () => {
    const html = renderHtmlReport(
      reportWithScore(90, {
        title: '</a><script>alert(1)</script>',
        url: 'javascript:alert(1)',
      }),
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Official link withheld: unsafe URL');
  });

  it('renders null facts honestly and remains self-contained', () => {
    const html = renderHtmlReport(reportWithScore(80));
    expect(html).toContain('Location unknown');
    expect(html).toContain('Remote/hybrid status unknown');
    expect(html).toContain('Posted: Unknown');
    expect(html).not.toMatch(/<script\s+src=/);
    expect(html).toContain('OPEN OFFICIAL VACANCY');
    expect(html).toContain('does not guarantee');
    expect(html).toContain('Scoring deterministic-v2');
    expect(html).toContain('Run succeeded');
    expect(html).toContain('older than 365 days are excluded');
    expect(html).toContain('Not verified in this scan (failed)');
    expect(html).toContain('Last seen:');
  });

  it('warns that vacancies are unfiltered by sponsor recognition when IND verification is disabled', () => {
    const html = renderHtmlReport({ ...reportWithScore(80), indVerificationEnabled: false });
    expect(html).toContain('IND recognised sponsor verification is turned off');
    expect(html).toContain('not filtered by IND sponsor recognition');
    expect(html).not.toContain('Ranked official vacancies at mapped IND-recognised sponsors.');
  });

  it('says Dutch requirement was never evaluated for an unscored vacancy, not "no requirement"', () => {
    const html = renderHtmlReport(unscoredReport());
    expect(html).toContain('Dutch requirement not evaluated');
    expect(html).not.toContain('No Dutch requirement detected');
  });

  it('keeps unknown and boundary-age postings but rejects anything older', () => {
    const generatedAt = new Date('2026-08-28T12:00:00.000Z');
    expect(isPostingFresh(null, generatedAt, 365)).toBe(true);
    expect(isPostingFresh(new Date('2025-08-28T12:00:00.000Z'), generatedAt, 365)).toBe(true);
    expect(isPostingFresh(new Date('2025-08-28T11:59:59.999Z'), generatedAt, 365)).toBe(false);
  });
});
