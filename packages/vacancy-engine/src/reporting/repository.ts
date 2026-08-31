import { and, desc, eq, exists, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { isCandidateProfileConfigured, loadCandidateProfile } from '../candidate/profile.js';
import type { Database } from '../db/client.js';
import {
  careerSources,
  companies,
  companySponsors,
  indSponsors,
  scanErrors,
  scanRuns,
  scanSourceOutcomes,
  vacancies,
  vacancyScores,
} from '../db/schema.js';
import { DETERMINISTIC_SCORING_VERSION, RELEVANCE_THRESHOLD } from '../filtering/index.js';
import { OFFICIAL_IND_WORK_REGISTER_URL } from '../ind/source.js';
import { createVacancySemanticFingerprint } from '../vacancies/hash.js';
import {
  type JobRadarReport,
  type ReportStatistics,
  type ReportVacancy,
  postingFreshnessCutoff,
  writeReportFiles,
} from './report.js';

export type BuildReportOptions = {
  scanRunId?: string;
  minimumScore?: number;
  statistics?: ReportStatistics;
  generatedAt?: Date;
  profilePath?: string;
  scanStatus?: JobRadarReport['scanStatus'];
  maximumPostingAgeDays?: number;
};

function emptyStatistics(): ReportStatistics {
  return {
    sponsorsLoaded: 0,
    activeSponsors: 0,
    companiesMapped: 0,
    careerSourcesDiscovered: 0,
    careerSourcesScanned: 0,
    incompleteSources: 0,
    blockedSources: 0,
    manualReviewSources: 0,
    unsupportedSources: 0,
    vacanciesDiscovered: 0,
    vacanciesNew: 0,
    vacanciesChanged: 0,
    vacanciesInactive: 0,
    staleVacanciesExcluded: 0,
    duplicateVacanciesCollapsed: 0,
    deterministicCandidates: 0,
    semanticScored: 0,
    relevantVacancies: 0,
    excellentMatches: 0,
    errorCount: 0,
    requestCount: 0,
    durationMs: 0,
  };
}

function numericCount(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function isSafeReportUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function statisticsFromStored(value: Record<string, unknown> | null): ReportStatistics {
  const defaults = emptyStatistics();
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, numericCount(value?.[key])]),
  ) as ReportStatistics;
}

async function resolveRun(
  database: Database,
  requestedId: string | undefined,
): Promise<{
  id: string;
  status: JobRadarReport['scanStatus'];
  statistics: Record<string, unknown>;
  startedAt: Date;
}> {
  const query = database
    .select({
      id: scanRuns.id,
      status: scanRuns.status,
      statistics: scanRuns.statistics,
      startedAt: scanRuns.startedAt,
    })
    .from(scanRuns)
    .where(isNotNull(scanRuns.finishedAt))
    .orderBy(desc(scanRuns.startedAt))
    .limit(1);
  const [run] = requestedId === undefined
    ? await query
    : await database
        .select({
          id: scanRuns.id,
          status: scanRuns.status,
          statistics: scanRuns.statistics,
          startedAt: scanRuns.startedAt,
        })
        .from(scanRuns)
        .where(eq(scanRuns.id, requestedId))
        .limit(1);
  if (!run) throw new Error('No scan run is available for reporting');
  return run;
}

export async function buildJobRadarReport(
  database: Database,
  options: BuildReportOptions = {},
): Promise<JobRadarReport> {
  const minimumScore = options.minimumScore ?? 70;
  if (!Number.isInteger(minimumScore) || minimumScore < 70 || minimumScore > 100) {
    throw new RangeError('Report minimum score must be an integer from 70 through 100');
  }
  const profile = await loadCandidateProfile(options.profilePath);
  const profileConfigured = isCandidateProfileConfigured(profile);
  const run = await resolveRun(database, options.scanRunId);
  const generatedAt = options.generatedAt ?? new Date();
  const maximumPostingAgeDays = options.maximumPostingAgeDays ?? 365;
  const freshnessCutoff = postingFreshnessCutoff(generatedAt, maximumPostingAgeDays);
  const hasActiveSponsorRelationship = exists(
    database
      .select({ companyId: companySponsors.companyId })
      .from(companySponsors)
      .innerJoin(indSponsors, eq(companySponsors.sponsorId, indSponsors.id))
      .where(
        and(
          eq(companySponsors.companyId, vacancies.companyId),
          eq(indSponsors.active, true),
        ),
      ),
  );

  const [
    sponsorCounts,
    companyCount,
    sourceCount,
    sourceOutcomes,
    errorCountRows,
    sourceSnapshot,
    deterministicCandidateCounts,
    staleVacancyCounts,
  ] =
    await Promise.all([
      database
        .select({
          total: sql<number>`count(*)`,
          active: sql<number>`count(*) filter (where ${indSponsors.active} = true)`,
        })
        .from(indSponsors),
      database
        .select({ count: sql<number>`count(distinct ${companies.id})` })
        .from(companies)
        .innerJoin(companySponsors, eq(companies.id, companySponsors.companyId)),
      database
        .select({ count: sql<number>`count(*)` })
        .from(careerSources)
        .where(isNull(careerSources.retiredAt)),
      database
        .select({
          careerSourceId: scanSourceOutcomes.careerSourceId,
          status: scanSourceOutcomes.status,
          complete: scanSourceOutcomes.complete,
          vacanciesSeen: scanSourceOutcomes.vacanciesSeen,
          requestCount: scanSourceOutcomes.requestCount,
        })
        .from(scanSourceOutcomes)
        .where(eq(scanSourceOutcomes.scanRunId, run.id)),
      database
        .select({ count: sql<number>`count(*)` })
        .from(scanErrors)
        .where(eq(scanErrors.scanRunId, run.id)),
      database
        .select({
          sourceUrl: indSponsors.sourceUrl,
          lastUpdated: indSponsors.sourceLastUpdated,
          retrievedAt: indSponsors.sourceRetrievedAt,
        })
        .from(indSponsors)
        .orderBy(desc(indSponsors.sourceRetrievedAt))
        .limit(1),
      // "Passed deterministic filter": meaningless when scoring never ran (no profile
      // configured), since there is no threshold to have passed. Skip the query entirely rather
      // than joining against a vacancyScores table that has no rows for this profile version.
      profileConfigured
        ? database
            .select({ count: sql<number>`count(*)` })
            .from(vacancies)
            .innerJoin(companies, eq(vacancies.companyId, companies.id))
            .innerJoin(
              vacancyScores,
              and(
                eq(vacancyScores.vacancyId, vacancies.id),
                eq(vacancyScores.contentHash, vacancies.contentHash),
                eq(vacancyScores.candidateProfileVersion, profile.profileVersion),
                eq(vacancyScores.scoringVersion, DETERMINISTIC_SCORING_VERSION),
              ),
            )
            .where(
              and(
                eq(vacancies.active, true),
                eq(companies.scanEnabled, true),
                hasActiveSponsorRelationship,
                gte(vacancyScores.finalScore, RELEVANCE_THRESHOLD),
              ),
            )
        : Promise.resolve([{ count: 0 }]),
      // "Known stale postings excluded": with no scores, there's no score-passing candidate to
      // have excluded for staleness, so this becomes a plain freshness count with no score join.
      profileConfigured
        ? database
            .select({ count: sql<number>`count(*)` })
            .from(vacancies)
            .innerJoin(companies, eq(vacancies.companyId, companies.id))
            .innerJoin(
              vacancyScores,
              and(
                eq(vacancyScores.vacancyId, vacancies.id),
                eq(vacancyScores.contentHash, vacancies.contentHash),
                eq(vacancyScores.candidateProfileVersion, profile.profileVersion),
                eq(vacancyScores.scoringVersion, DETERMINISTIC_SCORING_VERSION),
              ),
            )
            .where(
              and(
                eq(vacancies.active, true),
                eq(companies.scanEnabled, true),
                hasActiveSponsorRelationship,
                gte(vacancyScores.finalScore, minimumScore),
                lt(vacancies.postedAt, freshnessCutoff),
              ),
            )
        : database
            .select({ count: sql<number>`count(*)` })
            .from(vacancies)
            .innerJoin(companies, eq(vacancies.companyId, companies.id))
            .where(
              and(
                eq(vacancies.active, true),
                eq(companies.scanEnabled, true),
                hasActiveSponsorRelationship,
                lt(vacancies.postedAt, freshnessCutoff),
              ),
            ),
    ]);

  const vacancyRows = await database
    .select({
      id: vacancies.id,
      companyId: companies.id,
      careerSourceId: careerSources.id,
      title: vacancies.title,
      description: vacancies.description,
      company: companies.brandName,
      location: vacancies.location,
      remote: vacancies.remote,
      workplaceMode: vacancies.workplaceMode,
      provider: careerSources.provider,
      url: vacancies.url,
      score: vacancyScores.finalScore,
      technicalFit: vacancyScores.technicalFit,
      roleFit: vacancyScores.roleFit,
      seniorityFit: vacancyScores.seniorityFit,
      languageFit: vacancyScores.languageFit,
      locationFit: vacancyScores.locationFit,
      dutchRequired: vacancyScores.dutchRequired,
      dutchPreferred: vacancyScores.dutchPreferred,
      languageEvidence: vacancyScores.languageEvidence,
      primaryFit: vacancyScores.primaryFit,
      matchingSkills: vacancyScores.matchingSkills,
      gaps: vacancyScores.gaps,
      reasons: vacancyScores.reasons,
      mappingConfidence: companies.mappingConfidence,
      firstSeenAt: vacancies.firstSeenAt,
      lastSeenAt: vacancies.lastSeenAt,
      postedAt: vacancies.postedAt,
    })
    .from(vacancies)
    .innerJoin(companies, eq(vacancies.companyId, companies.id))
    .innerJoin(careerSources, eq(vacancies.careerSourceId, careerSources.id))
    // Left, not inner: with no profile configured there are no vacancyScores rows for this
    // profile version at all, and an inner join would silently return zero vacancies -- exactly
    // the "looks like nothing matched" bug this whole change exists to fix. A left join degrades
    // to a uniformly-null score for every row, which the minimumScore filter below (skipped when
    // unconfigured) and the mapping further down both already treat as "not scored" rather than
    // "failed to score".
    .leftJoin(
      vacancyScores,
      and(
        eq(vacancyScores.vacancyId, vacancies.id),
        eq(vacancyScores.contentHash, vacancies.contentHash),
        eq(vacancyScores.candidateProfileVersion, profile.profileVersion),
        eq(vacancyScores.scoringVersion, DETERMINISTIC_SCORING_VERSION),
      ),
    )
    .where(
      and(
        eq(vacancies.active, true),
        eq(companies.scanEnabled, true),
        hasActiveSponsorRelationship,
        ...(profileConfigured ? [gte(vacancyScores.finalScore, minimumScore)] : []),
        or(isNull(vacancies.postedAt), gte(vacancies.postedAt, freshnessCutoff)),
      ),
    )
    .orderBy(desc(vacancyScores.finalScore), vacancies.title);

  const sponsorRows = await database
    .select({ companyId: companySponsors.companyId, legalName: indSponsors.legalName })
    .from(companySponsors)
    .innerJoin(indSponsors, eq(companySponsors.sponsorId, indSponsors.id))
    .where(eq(indSponsors.active, true));
  const sponsorsByCompany = new Map<string, string[]>();
  for (const sponsor of sponsorRows) {
    const names = sponsorsByCompany.get(sponsor.companyId) ?? [];
    if (!names.includes(sponsor.legalName)) names.push(sponsor.legalName);
    sponsorsByCompany.set(sponsor.companyId, names);
  }
  const sourceOutcomeById = new Map(
    sourceOutcomes.map((outcome) => [outcome.careerSourceId, outcome] as const),
  );

  const seenFingerprints = new Set<string>();
  const safeVacancyRows = vacancyRows.filter((vacancy) => isSafeReportUrl(vacancy.url));
  const deduplicatedVacancyRows = [...safeVacancyRows]
    .sort(
      (left, right) =>
        (right.score ?? -1) - (left.score ?? -1) ||
        (right.postedAt?.getTime() ?? 0) - (left.postedAt?.getTime() ?? 0) ||
        right.firstSeenAt.getTime() - left.firstSeenAt.getTime() ||
        left.id.localeCompare(right.id),
    )
    .filter((vacancy) => {
      const fingerprint = `${vacancy.companyId}:${createVacancySemanticFingerprint(vacancy)}`;
      if (seenFingerprints.has(fingerprint)) return false;
      seenFingerprints.add(fingerprint);
      return true;
    });
  const reportVacancies: ReportVacancy[] = deduplicatedVacancyRows.map((vacancy) => {
    // Left-joined scoring columns: null (no matching vacancyScores row -- either an unconfigured
    // profile or a genuinely stale cache) means the whole scoring group is omitted from the
    // object, not assigned `undefined` -- `exactOptionalPropertyTypes` treats those differently,
    // and "not scored" must mean the key is absent, never a fake 0 or an explicit undefined.
    const scoring = vacancy.score === null
      ? {}
      : {
          // Non-null assertions: these columns all come from the same joined vacancyScores row
          // `vacancy.score === null` already ruled out being absent -- they're all-or-nothing
          // together, never independently null.
          score: vacancy.score,
          technicalFit: vacancy.technicalFit!,
          roleFit: vacancy.roleFit!,
          seniorityFit: vacancy.seniorityFit!,
          languageFit: vacancy.languageFit!,
          locationFit: vacancy.locationFit!,
          dutchRequired: vacancy.dutchRequired!,
          dutchPreferred: vacancy.dutchPreferred!,
          languageEvidence: vacancy.languageEvidence!,
          primaryFit: vacancy.primaryFit!,
          matchingSkills: vacancy.matchingSkills!,
          gaps: vacancy.gaps!,
          reasons: vacancy.reasons!,
        };
    return {
      id: vacancy.id,
      title: vacancy.title,
      company: vacancy.company,
      location: vacancy.location,
      remote: vacancy.remote,
      workplaceMode: vacancy.workplaceMode,
      provider: vacancy.provider,
      url: vacancy.url,
      ...scoring,
      mappingConfidence: vacancy.mappingConfidence,
      sponsorLegalNames: sponsorsByCompany.get(vacancy.companyId) ?? [],
      firstSeenAt: vacancy.firstSeenAt.toISOString(),
      postedAt: vacancy.postedAt?.toISOString() ?? null,
      lastSeenAt: vacancy.lastSeenAt.toISOString(),
      verifiedInRun:
        sourceOutcomeById.get(vacancy.careerSourceId)?.status === 'succeeded' &&
        sourceOutcomeById.get(vacancy.careerSourceId)?.complete === true &&
        vacancy.lastSeenAt >= run.startedAt,
      sourceOutcomeStatus: sourceOutcomeById.get(vacancy.careerSourceId)?.status ?? null,
    };
  });

  const baseStatistics = options.statistics ?? statisticsFromStored(run.statistics);
  const [sponsorCountRow] = sponsorCounts;
  const [companyCountRow] = companyCount;
  const [sourceCountRow] = sourceCount;
  const [errorCountRow] = errorCountRows;
  const [deterministicCandidateCount] = deterministicCandidateCounts;
  const [staleVacancyCount] = staleVacancyCounts;
  const outcomeScanned = sourceOutcomes.filter(
    (outcome) => outcome.status === 'succeeded' && outcome.complete,
  ).length;
  const outcomeIncomplete = sourceOutcomes.filter(
    (outcome) =>
      !outcome.complete &&
      (outcome.status === 'succeeded' ||
        (outcome.status === 'manual_review' && outcome.vacanciesSeen > 0)),
  ).length;
  const outcomeBlocked = sourceOutcomes.filter((outcome) => outcome.status === 'blocked').length;
  const outcomeManualReview = sourceOutcomes.filter(
    (outcome) => outcome.status === 'manual_review',
  ).length;
  const outcomeUnsupported = sourceOutcomes.filter((outcome) => outcome.status === 'unsupported').length;
  const statistics: ReportStatistics = {
    ...baseStatistics,
    sponsorsLoaded: baseStatistics.sponsorsLoaded || numericCount(sponsorCountRow?.total),
    activeSponsors: baseStatistics.activeSponsors || numericCount(sponsorCountRow?.active),
    companiesMapped: baseStatistics.companiesMapped || numericCount(companyCountRow?.count),
    careerSourcesDiscovered:
      baseStatistics.careerSourcesDiscovered || numericCount(sourceCountRow?.count),
    careerSourcesScanned: baseStatistics.careerSourcesScanned || outcomeScanned,
    incompleteSources: baseStatistics.incompleteSources || outcomeIncomplete,
    blockedSources: baseStatistics.blockedSources || outcomeBlocked,
    manualReviewSources: baseStatistics.manualReviewSources || outcomeManualReview,
    unsupportedSources: baseStatistics.unsupportedSources || outcomeUnsupported,
    deterministicCandidates: numericCount(deterministicCandidateCount?.count),
    staleVacanciesExcluded: numericCount(staleVacancyCount?.count),
    duplicateVacanciesCollapsed: safeVacancyRows.length - reportVacancies.length,
    semanticScored: 0,
    relevantVacancies: reportVacancies.length,
    excellentMatches: reportVacancies.filter((vacancy) => (vacancy.score ?? 0) >= 90).length,
    errorCount: Math.max(baseStatistics.errorCount, numericCount(errorCountRow?.count)),
    requestCount:
      baseStatistics.requestCount ||
      sourceOutcomes.reduce((total, outcome) => total + outcome.requestCount, 0),
  };
  const [snapshot] = sourceSnapshot;

  return {
    runId: run.id,
    scanStatus: options.scanStatus ?? run.status,
    generatedAt: generatedAt.toISOString(),
    candidateProfileVersion: profile.profileVersion,
    profileConfigured,
    deterministicScoringVersion: DETERMINISTIC_SCORING_VERSION,
    freshnessPolicy: {
      maximumPostingAgeDays,
      cutoff: freshnessCutoff.toISOString(),
    },
    officialSponsorSource: {
      url: snapshot?.sourceUrl ?? OFFICIAL_IND_WORK_REGISTER_URL,
      lastUpdated: snapshot?.lastUpdated?.toISOString() ?? null,
      retrievedAt: snapshot?.retrievedAt.toISOString() ?? null,
    },
    statistics,
    vacancies: reportVacancies,
  };
}

export async function generateJobRadarReport(
  database: Database,
  options: BuildReportOptions = {},
): Promise<{
  report: JobRadarReport;
  files: Awaited<ReturnType<typeof writeReportFiles>>;
}> {
  const report = await buildJobRadarReport(database, options);
  const files = await writeReportFiles(report);
  return { report, files };
}
