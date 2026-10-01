import * as cheerio from 'cheerio';

import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
  WorkplaceMode,
} from '../domain/models.js';
import type { AtsHttpClient } from './http.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import {
  htmlToText,
  httpUrl,
  joinNonEmpty,
  makeVacancy,
  normalizedSource,
  optionalString,
  parseDate,
  requireBoardIdentifier,
} from './shared.js';

const provider = 'personio' as const;
const validTenant = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const personioHostname = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.jobs\.personio\.(?:de|com)$/iu;

function exactFeedUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    !personioHostname.test(url.hostname) ||
    (path !== '' && path !== '/xml') ||
    url.hash !== ''
  ) {
    return null;
  }
  url.pathname = '/xml';
  url.search = '';
  url.searchParams.set('language', 'en');
  return url;
}

function feedUrl(identifier: string, baseUrl: string): string | null {
  const trimmed = identifier.trim();
  if (validTenant.test(trimmed)) {
    const tenant = trimmed.toLowerCase();
    const validatedBase = exactFeedUrl(baseUrl);
    if (validatedBase === null) return null;
    const baseTenant = personioHostname.exec(validatedBase.hostname)?.[1]?.toLowerCase();
    return baseTenant === tenant ? validatedBase.toString() : null;
  }
  return exactFeedUrl(trimmed)?.toString() ?? null;
}

function observedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      personioHostname.test(url.hostname)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function workplace(location: string | null): {
  remote: boolean | null;
  workplaceMode: WorkplaceMode;
} {
  const normalized = location?.toLowerCase() ?? '';
  if (normalized.includes('hybrid')) return { remote: null, workplaceMode: 'hybrid' };
  if (normalized.includes('remote')) return { remote: true, workplaceMode: 'remote' };
  if (/on[ -]?site/u.test(normalized)) return { remote: false, workplaceMode: 'onsite' };
  return { remote: null, workplaceMode: 'unknown' };
}

export class PersonioAdapter implements VacancyAdapter {
  public readonly provider = provider;

  public constructor(private readonly http: AtsHttpClient) {}

  public supports(source: CareerSourceDescriptor): boolean {
    return (
      source.provider === provider &&
      source.boardIdentifier !== null &&
      feedUrl(source.boardIdentifier, source.baseUrl) !== null
    );
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const boardIdentifier = requireBoardIdentifier(source, provider);
    const url = feedUrl(boardIdentifier, source.baseUrl);
    if (url === null) {
      throw new AtsResponseError(
        provider,
        'boardIdentifier must be a tenant or Personio career feed URL',
      );
    }

    const tenant = personioHostname.exec(new URL(url).hostname)?.[1]?.toLowerCase();
    if (tenant === undefined) throw new AtsResponseError(provider, 'feed tenant is invalid');
    const response = await this.http.get(url, {
      allowedOrigins: [`https://${tenant}.jobs.personio.de`, `https://${tenant}.jobs.personio.com`],
    });
    requireSuccessfulResponse(provider, response);
    const origin = observedOrigin(response.finalUrl);
    if (origin === null) {
      throw new AtsResponseError(provider, 'feed response URL is not a Personio career origin');
    }

    const $ = cheerio.load(response.body, { xmlMode: true });
    const root = $.root().children('workzag-jobs').first();
    if (root.length === 0) {
      throw new AtsResponseError(provider, 'position feed has an unknown response shape');
    }

    const vacancies: NormalizedVacancy[] = [];
    let invalidCount = 0;
    for (const position of root.children('position').toArray()) {
      const selection = $(position);
      const childText = (name: string): string | null =>
        optionalString(selection.children(name).first().text());
      const id = childText('id');
      const title = childText('name');

      const sections: string[] = [];
      for (const description of selection
        .children('jobDescriptions')
        .first()
        .children('jobDescription')
        .toArray()) {
        const descriptionSelection = $(description);
        const value = optionalString(descriptionSelection.children('value').first().text());
        if (value === null) continue;
        const body = optionalString(htmlToText(value));
        if (body === null) continue;
        const heading = optionalString(descriptionSelection.children('name').first().text());
        sections.push(joinNonEmpty([heading, body], '\n') ?? body);
      }
      const description = joinNonEmpty(sections, '\n\n');

      const locations = [childText('office')];
      for (const office of selection
        .children('additionalOffices')
        .first()
        .children('office')
        .toArray()) {
        locations.push(optionalString($(office).text()));
      }
      const location = joinNonEmpty(locations, ' | ');
      const vacancyUrl = id === null || !/^\d+$/u.test(id) ? null : httpUrl(`/job/${id}`, origin);
      if (id === null || title === null || description === null || vacancyUrl === null) {
        invalidCount += 1;
        continue;
      }

      const mode = workplace(location);
      const vacancy = makeVacancy({
        externalId: id,
        title,
        description,
        location,
        remote: mode.remote,
        workplaceMode: mode.workplaceMode,
        url: vacancyUrl,
        postedAt: parseDate(childText('createdAt')),
        employmentType: childText('employmentType') ?? childText('schedule'),
        source: normalizedSource(provider),
      });
      if (vacancy !== null) vacancies.push(vacancy);
      else invalidCount += 1;
    }

    return { vacancies, complete: invalidCount === 0, requestCount: 1, invalidCount };
  }
}
