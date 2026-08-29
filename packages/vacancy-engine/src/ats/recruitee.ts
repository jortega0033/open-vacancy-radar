import * as cheerio from 'cheerio';

import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
} from '../domain/models.js';
import type { AtsHttpClient } from './http.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import {
  decodeEscapedMarkup,
  htmlToText,
  httpUrl,
  joinNonEmpty,
  makeVacancy,
  normalizedSource,
  optionalString,
  parseBooleanText,
  parseDate,
  requireBoardIdentifier,
} from './shared.js';

const provider = 'recruitee' as const;
const validSubdomain = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

function offerFeedUrl(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (validSubdomain.test(trimmed)) return `https://${trimmed}.recruitee.com/api/offers.xml`;
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.toLowerCase().endsWith('/api/offers.xml')
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export class RecruiteeAdapter implements VacancyAdapter {
  public readonly provider = provider;

  public constructor(private readonly http: AtsHttpClient) {}

  public supports(source: CareerSourceDescriptor): boolean {
    return source.provider === provider && source.boardIdentifier !== null && offerFeedUrl(source.boardIdentifier) !== null;
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const boardIdentifier = requireBoardIdentifier(source, provider);
    const url = offerFeedUrl(boardIdentifier);
    if (url === null) throw new AtsResponseError(provider, 'boardIdentifier must be a tenant or exact offer feed URL');
    const response = await this.http.get(url);
    requireSuccessfulResponse(provider, response);
    const $ = cheerio.load(response.body, { xmlMode: true });
    const offers = $('offers').first();
    if (offers.length === 0) {
      throw new AtsResponseError(provider, 'offer feed has an unknown response shape');
    }
    const vacancies: NormalizedVacancy[] = [];
    let invalidCount = 0;
    for (const offer of offers.children('offer').toArray()) {
      const selection = $(offer);
      const childText = (name: string): string | null => optionalString(selection.children(name).first().text());
      const id = childText('id');
      const title = childText('title');
      const description = joinNonEmpty([childText('description'), childText('requirements')], '\n');
      const vacancyUrl = httpUrl(childText('careers-url'));
      if (id === null || title === null || description === null || vacancyUrl === null) {
        invalidCount += 1;
        continue;
      }
      const explicitlyRemote = parseBooleanText(childText('remote'));
      const explicitlyOnSite = parseBooleanText(childText('on-site'));
      const explicitlyHybrid = parseBooleanText(childText('hybrid'));
      const remote =
        explicitlyRemote === true
          ? true
          : explicitlyOnSite === true
            ? false
            : explicitlyHybrid === true
              ? null
              : explicitlyRemote;
      const workplaceMode =
        explicitlyRemote === true
          ? 'remote'
          : explicitlyHybrid === true
            ? 'hybrid'
            : explicitlyOnSite === true
              ? 'onsite'
              : 'unknown';
      const vacancy = makeVacancy({
        externalId: id,
        title,
        description: htmlToText(decodeEscapedMarkup(description)),
        location: joinNonEmpty([
          childText('location'),
          childText('city'),
          childText('state-name'),
          childText('country'),
        ]),
        remote,
        workplaceMode,
        url: vacancyUrl,
        postedAt: parseDate(childText('published-at')),
        employmentType: childText('employment-type-code'),
        source: normalizedSource(provider),
      });
      if (vacancy !== null) vacancies.push(vacancy);
      else invalidCount += 1;
    }
    return { vacancies, complete: invalidCount === 0, requestCount: 1, invalidCount };
  }
}
