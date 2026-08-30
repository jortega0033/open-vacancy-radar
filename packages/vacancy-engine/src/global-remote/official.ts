import * as cheerio from 'cheerio';

import {
  AshbyAdapter,
  AtsResponseError,
  GreenhouseAdapter,
  LeverAdapter,
  PersonioAdapter,
  RecruiteeAdapter,
  SmartRecruitersAdapter,
  SuccessFactorsAdapter,
  TeamtailorAdapter,
  WorkableAdapter,
  WorkdayAdapter,
  detectAtsSource,
  requireSuccessfulResponse,
  type AtsHttpClient,
} from '../ats/index.js';
import { isCrawlerHttpError } from '../crawler/index.js';
import {
  normalizedVacancySchema,
  type AdapterResult,
  type CareerSourceDescriptor,
  type NormalizedVacancy,
  type VacancyAdapter,
} from '../domain/models.js';
import { createVacancyContentHash } from '../vacancies/hash.js';
import { evaluateOfficialReview } from './evaluation.js';
import type {
  GlobalRemoteConfig,
  GlobalRemoteSource,
  OfficialSourceState,
  OfficialVacancyAudit,
} from './models.js';

type OfficialRun = { audits: OfficialVacancyAudit[]; requestCount: number };
type BoardScan =
  | { result: AdapterResult; error: null }
  | { result: null; error: unknown };

const CLOSED_TEXT = /\b(?:position (?:is )?(?:filled|closed)|not accepting applications|job (?:is )?no longer available|this role (?:is )?closed)\b/iu;
const ACCESS_CHALLENGE = /\b(?:just a moment|checking your browser|attention required|cf-chl-|cloudflare ray id)\b/iu;

function adapterFor(source: GlobalRemoteSource, http: AtsHttpClient): VacancyAdapter | null {
  switch (source.provider) {
    case 'ashby':
      return new AshbyAdapter(http);
    case 'greenhouse':
      return new GreenhouseAdapter(http);
    case 'lever':
      return new LeverAdapter(http);
    case 'personio':
      return new PersonioAdapter(http);
    case 'recruitee':
      return new RecruiteeAdapter(http);
    case 'smartrecruiters':
      return new SmartRecruitersAdapter(http);
    case 'successfactors':
      return new SuccessFactorsAdapter(http);
    case 'teamtailor':
      return new TeamtailorAdapter(http);
    case 'workable':
      return new WorkableAdapter(http);
    case 'workday':
      return new WorkdayAdapter(http);
    case 'html':
      return null;
  }
}

function descriptor(source: GlobalRemoteSource): CareerSourceDescriptor {
  const detected = source.provider === 'html' ? null : detectAtsSource(source.url);
  const reviewedSuccessFactorsOrigin = (() => {
    if (source.provider !== 'successfactors' || source.boardIdentifier === null) return null;
    const url = new URL(source.url);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && url.hostname.toLowerCase() === source.boardIdentifier.toLowerCase()
      ? `${url.origin}/`
      : null;
  })();
  return {
    id: source.id,
    companyId: source.id,
    companyName: source.company,
    provider: source.provider === 'html' ? 'html' : source.provider,
    baseUrl: reviewedSuccessFactorsOrigin
      ?? (detected?.provider === source.provider ? detected.baseUrl : source.url),
    boardIdentifier: source.boardIdentifier,
    lifecycleAuthoritative: true,
  };
}

function errorState(error: unknown): { state: Extract<OfficialSourceState, 'blocked' | 'error'>; httpStatus: number | null; reason: string } {
  if (error instanceof AtsResponseError) {
    const blocked = error.status !== null && [401, 403, 406, 407, 429, 451].includes(error.status);
    return { state: blocked ? 'blocked' : 'error', httpStatus: error.status, reason: error.message };
  }
  if (isCrawlerHttpError(error)) {
    const blocked = ['blocked', 'rate_limited'].includes(error.category);
    return {
      state: blocked ? 'blocked' : 'error',
      httpStatus: error.status ?? null,
      reason: error.message,
    };
  }
  return {
    state: 'error',
    httpStatus: null,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function auditFromVacancy(
  source: GlobalRemoteSource,
  vacancy: NormalizedVacancy | null,
  state: OfficialSourceState,
  requestCount: number,
  httpStatus: number | null,
  minimumAnnualBaseUsd: number,
  extraEvidence: string[] = [],
): OfficialVacancyAudit {
  const hash = vacancy === null ? null : createVacancyContentHash(vacancy);
  const evaluation = evaluateOfficialReview({
    source,
    state,
    currentTitle: vacancy?.title ?? source.expectedTitle,
    contentHash: hash,
    minimumAnnualBaseUsd,
  });
  const evidence = [
    ...(vacancy === null ? [] : [
      `Official title: ${vacancy.title}`,
      `Official location: ${vacancy.location ?? 'not stated'}`,
      `Official workplace mode: ${vacancy.workplaceMode}`,
    ]),
    `Reviewed base floor: ${source.review.minimumAnnualBaseUsd === null ? 'not advertised' : `$${source.review.minimumAnnualBaseUsd.toLocaleString('en-US')} USD`}`,
    ...source.review.notes,
    ...extraEvidence,
  ];
  return {
    id: source.id,
    company: source.company,
    title: vacancy?.title ?? source.expectedTitle,
    url: vacancy?.url ?? source.url,
    provider: source.provider,
    state,
    decision: evaluation.decision,
    reasons: evaluation.reasons,
    evidence,
    minimumAnnualBaseUsd: source.review.minimumAnnualBaseUsd,
    contentHash: hash,
    reviewedContentHash: source.reviewedContentHash,
    reviewedAt: source.reviewedAt,
    requestCount,
    httpStatus,
  };
}

function errorAudit(
  source: GlobalRemoteSource,
  error: unknown,
  requestCount: number,
  minimumAnnualBaseUsd: number,
): OfficialVacancyAudit {
  const failure = errorState(error);
  const audit = auditFromVacancy(
    source,
    null,
    failure.state,
    requestCount,
    failure.httpStatus,
    minimumAnnualBaseUsd,
    [failure.reason],
  );
  return { ...audit, reasons: [failure.reason] };
}

function htmlVacancy(source: GlobalRemoteSource, body: string): { state: OfficialSourceState; vacancy: NormalizedVacancy | null; evidence: string[] } {
  if (ACCESS_CHALLENGE.test(body)) {
    return { state: 'blocked', vacancy: null, evidence: ['Recognizable access challenge returned.'] };
  }
  const dom = cheerio.load(body);
  dom('script, style, nav, footer, noscript, svg').remove();
  const pageTitle = dom('title').first().text().replace(/\s+/gu, ' ').trim();
  const root = dom('main').first().length > 0 ? dom('main').first() : dom('body');
  const text = root.text().replace(/\s+/gu, ' ').trim();
  const searchable = `${pageTitle}\n${text}`;
  if (CLOSED_TEXT.test(searchable) || !searchable.toLowerCase().includes(source.expectedTitle.toLowerCase())) {
    return {
      state: 'inactive',
      vacancy: null,
      evidence: [pageTitle.length === 0 ? 'Expected vacancy title is absent.' : `Page title: ${pageTitle}`],
    };
  }
  const vacancy = normalizedVacancySchema.parse({
    externalId: source.externalId,
    title: source.expectedTitle,
    description: text,
    location: null,
    remote: null,
    workplaceMode: 'unknown',
    url: source.url,
    postedAt: null,
    employmentType: null,
    source: 'html',
  });
  return { state: 'active', vacancy, evidence: [`Page title: ${pageTitle}`] };
}

export async function runOfficialGlobalRemoteSources(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<OfficialRun> {
  const boardScans = new Map<string, Promise<BoardScan>>();
  let requestCount = 0;

  function boardScan(source: GlobalRemoteSource): Promise<BoardScan> {
    const key = `${source.provider}:${source.boardIdentifier ?? ''}:${new URL(source.url).origin}`;
    const existing = boardScans.get(key);
    if (existing !== undefined) return existing;
    const adapter = adapterFor(source, http);
    const promise = (async (): Promise<BoardScan> => {
      if (adapter === null || source.boardIdentifier === null) {
        return { result: null, error: new Error(`Invalid ${source.provider} source configuration`) };
      }
      try {
        const result = await adapter.listVacancies(descriptor(source));
        requestCount += result.requestCount;
        return { result, error: null };
      } catch (error) {
        requestCount += 1;
        return { result: null, error };
      }
    })();
    boardScans.set(key, promise);
    return promise;
  }

  const audits = await Promise.all(config.officialSources.map(async (source): Promise<OfficialVacancyAudit> => {
    if (source.provider === 'html') {
      requestCount += 1;
      try {
        const response = await http.get(source.url);
        requireSuccessfulResponse('html', response);
        const parsed = htmlVacancy(source, response.body);
        return auditFromVacancy(
          source,
          parsed.vacancy,
          parsed.state,
          1,
          response.status,
          config.minimumAnnualBaseUsd,
          parsed.evidence,
        );
      } catch (error) {
        return errorAudit(source, error, 1, config.minimumAnnualBaseUsd);
      }
    }
    const scan = await boardScan(source);
    if (scan.error !== null || scan.result === null) {
      return errorAudit(source, scan.error, 1, config.minimumAnnualBaseUsd);
    }
    const vacancy = scan.result.vacancies.find((item) => item.externalId === source.externalId) ?? null;
    if (vacancy === null && !scan.result.complete) {
      return auditFromVacancy(
        source,
        null,
        'error',
        0,
        200,
        config.minimumAnnualBaseUsd,
        ['Board scan was incomplete, so absence cannot prove this vacancy is inactive.'],
      );
    }
    return auditFromVacancy(
      source,
      vacancy,
      vacancy === null ? 'inactive' : 'active',
      0,
      200,
      config.minimumAnnualBaseUsd,
    );
  }));
  return { audits, requestCount };
}
