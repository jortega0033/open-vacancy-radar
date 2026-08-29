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
  htmlToText,
  httpUrl,
  joinNonEmpty,
  makeVacancy,
  normalizedSource,
  optionalString,
  parseDate,
  requireBoardIdentifier,
  validPaginationOptions,
  type PaginationOptions,
} from './shared.js';

const provider = 'teamtailor' as const;

type TeamtailorAdapterOptions = Partial<PaginationOptions>;

function feedUrl(identifier: string, page: number, pageSize: number): URL {
  let url: URL;
  try {
    url = new URL(identifier);
  } catch {
    throw new AtsResponseError(provider, 'boardIdentifier must be the exact RSS feed URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.toLowerCase().endsWith('.rss')) {
    throw new AtsResponseError(provider, 'boardIdentifier must be the exact RSS feed URL');
  }
  url.searchParams.set('offset', String(page * pageSize));
  url.searchParams.set('per_page', String(pageSize));
  return url;
}

export class TeamtailorAdapter implements VacancyAdapter {
  public readonly provider = provider;
  readonly #pagination: PaginationOptions;

  public constructor(
    private readonly http: AtsHttpClient,
    options: TeamtailorAdapterOptions = {},
  ) {
    this.#pagination = validPaginationOptions(provider, options, { pageSize: 100, maxPages: 100 }, 200);
  }

  public supports(source: CareerSourceDescriptor): boolean {
    return source.provider === provider && Boolean(source.boardIdentifier?.trim());
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const boardIdentifier = requireBoardIdentifier(source, provider);
    const byId = new Map<string, NormalizedVacancy>();
    const signatures = new Set<string>();
    let requestCount = 0;
    let invalidCount = 0;
    let complete = false;

    for (let page = 0; page < this.#pagination.maxPages; page += 1) {
      const url = feedUrl(boardIdentifier, page, this.#pagination.pageSize);
      requestCount += 1;
      const response = await this.http.get(url.toString());
      requireSuccessfulResponse(provider, response);
      const $ = cheerio.load(response.body, { xmlMode: true });
      const channel = $('rss > channel').first();
      if (channel.length === 0) {
        throw new AtsResponseError(provider, 'RSS feed has an unknown response shape');
      }
      const items = channel.children('item').toArray();
      const signature = items
        .map((item) => {
          const selection = $(item);
          const guid = optionalString(selection.children('guid').first().text());
          const link = optionalString(selection.children('link').first().text());
          return guid ?? link ?? '?';
        })
        .join('\u0000');
      if (signatures.has(signature)) break;
      signatures.add(signature);
      for (const item of items) {
        const selection = $(item);
        const title = optionalString(selection.children('title').first().text());
        const descriptionHtml = optionalString(selection.children('description').first().text());
        const link = httpUrl(selection.children('link').first().text(), response.finalUrl);
        const guid = optionalString(selection.children('guid').first().text()) ?? link;
        if (title === null || descriptionHtml === null || link === null || guid === null) {
          invalidCount += 1;
          continue;
        }
        const remoteStatus = optionalString(selection.children('remoteStatus').first().text())?.toLowerCase() ?? null;
        const workplaceMode =
          remoteStatus === 'remote'
            ? 'remote'
            : remoteStatus === 'hybrid'
              ? 'hybrid'
              : ['on-site', 'onsite'].includes(remoteStatus ?? '')
                ? 'onsite'
                : 'unknown';
        const remote = workplaceMode === 'remote' ? true : workplaceMode === 'onsite' ? false : null;
        const locations = selection
          .find('tt\\:name')
          .map((_index, location) => $(location).text().trim())
          .get()
          .filter((location) => location.length > 0);
        const vacancy = makeVacancy({
          externalId: guid,
          title,
          description: htmlToText(descriptionHtml),
          location: joinNonEmpty(locations),
          remote,
          workplaceMode,
          url: link,
          postedAt: parseDate(selection.children('pubDate').first().text()),
          employmentType: optionalString(selection.children('tt\\:employmentType').first().text()),
          source: normalizedSource(provider),
        });
        if (vacancy !== null) byId.set(vacancy.externalId, vacancy);
        else invalidCount += 1;
      }
      if (items.length < this.#pagination.pageSize) {
        complete = true;
        break;
      }
    }

    return {
      vacancies: [...byId.values()],
      complete: complete && invalidCount === 0,
      requestCount,
      invalidCount,
    };
  }
}
