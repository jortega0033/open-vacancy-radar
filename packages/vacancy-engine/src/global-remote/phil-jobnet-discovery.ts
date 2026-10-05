import * as cheerio from 'cheerio';

import type { AtsHttpClient, AtsHttpResponse } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import { normalizeCountry } from '../geo/countries.js';
import {
  attributeNetworkRequests,
  networkAttemptFields,
  newNetworkAttemptCounters,
} from './discovery-attribution.js';
import {
  completeAudit,
  discoveryAudit,
  incompleteAudit,
  sourceFailure,
} from './discovery-shared.js';
import type {
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
} from './models.js';

/**
 * PhilJobNet (https://philjobnet.gov.ph), the Department of Labor and Employment / Bureau of Local
 * Employment vacancy portal. Reviewed as `linked_index` in docs/job-source-evidence.md: the vacancy
 * index and detail pages are public and anonymous, no robots policy is published (the endpoint
 * returns 404), and the only terms-of-service page sits behind the login wall, so scheduled
 * enablement stays opt-in (`philJobNetEnabled`) until a human confirms the terms.
 *
 * Contract used (all anonymous, read-only):
 * - `GET /job-vacancies/0/{term}/0` renders the first result page for a search term (the same URL
 *   shape the site links from its own "Top job openings" list).
 * - Later pages are ASP.NET Web Forms postbacks: the hidden `__VIEWSTATE`-family fields from the
 *   previous response are posted back verbatim with `__EVENTTARGET`/`__EVENTARGUMENT=Page$N`.
 * - `GET /job-vacancies/job/{slug}-{id}` renders one vacancy. A removed vacancy still answers 200
 *   with a placeholder page ("Position not specified"), which is treated as closed.
 *
 * The "Apply now" button leads to the portal login. This adapter never follows it: the canonical
 * detail page is both the listing and the apply link, and applying stays a human action.
 */
export const PHIL_JOBNET_ORIGIN = 'https://philjobnet.gov.ph';
const PROVIDER = 'phil_jobnet';
const GRID_TARGET = 'ctl00$BodyContentPlaceHolder$GridView1';
const SEARCH_FIELD = 'ctl00$BodyContentPlaceHolder$searchterm';
const FORM_STATE_FIELDS = [
  '__VIEWSTATE',
  '__VIEWSTATEGENERATOR',
  '__VIEWSTATEENCRYPTED',
  '__EVENTVALIDATION',
] as const;
const MAX_SEARCH_TERM_LENGTH = 100;
export const PHIL_JOBNET_DEFAULT_MAX_PAGES = 2;
export const PHIL_JOBNET_DEFAULT_MAX_DETAILS = 20;

export function philJobNetSearchUrl(term: string): string {
  return `${PHIL_JOBNET_ORIGIN}/job-vacancies/0/${encodeURIComponent(term)}/0`;
}

const NOT_SPECIFIED = /\bnot specified\b/iu;

function cleaned(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
  return text.length === 0 || NOT_SPECIFIED.test(text) ? null : text;
}

export type PhilJobNetLocation = {
  display: string;
  country: string | null;
  region: string | null;
  province: string | null;
  city: string | null;
};

const LOWERCASE_WORDS = new Set(['del', 'de', 'ng', 'y', 'of']);

function titleCase(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .split(/\s+/u)
    .map((word, index) => {
      if (index > 0 && LOWERCASE_WORDS.has(word)) return word;
      return word.replace(/(^|[-'(])(\p{L})/gu, (_match, lead: string, letter: string) => `${lead}${letter.toLocaleUpperCase('en-US')}`);
    })
    .join(' ');
}

function cleanPlace(part: string): string {
  return part
    .replace(/\((?:capital|provincial capital)\)/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function cityName(part: string): string {
  const match = /^city of\s+(.+)$/iu.exec(part);
  return match?.[1] === undefined ? titleCase(part) : `${titleCase(match[1])} City`;
}

const PH_PROVINCES = new Set([
  'abra', 'agusan del norte', 'agusan del sur', 'aklan', 'albay', 'antique', 'apayao', 'aurora',
  'basilan', 'bataan', 'batanes', 'batangas', 'benguet', 'biliran', 'bohol', 'bukidnon', 'bulacan',
  'cagayan', 'camarines norte', 'camarines sur', 'camiguin', 'capiz', 'catanduanes', 'cavite', 'cebu',
  'cotabato', 'davao de oro', 'davao del norte', 'davao del sur', 'davao occidental', 'davao oriental',
  'dinagat islands', 'eastern samar', 'guimaras', 'ifugao', 'ilocos norte', 'ilocos sur', 'iloilo',
  'isabela', 'kalinga', 'la union', 'laguna', 'lanao del norte', 'lanao del sur', 'leyte', 'maguindanao',
  'maguindanao del norte', 'maguindanao del sur', 'marinduque', 'masbate', 'misamis occidental',
  'misamis oriental', 'mountain province', 'negros occidental', 'negros oriental', 'northern samar',
  'nueva ecija', 'nueva vizcaya', 'occidental mindoro', 'oriental mindoro', 'palawan', 'pampanga',
  'pangasinan', 'quezon', 'quirino', 'rizal', 'romblon', 'samar', 'sarangani', 'siquijor', 'sorsogon',
  'south cotabato', 'southern leyte', 'sultan kudarat', 'sulu', 'surigao del norte', 'surigao del sur',
  'tarlac', 'tawi-tawi', 'zambales', 'zamboanga del norte', 'zamboanga del sur', 'zamboanga sibugay',
  'metro manila', 'ncr', 'national capital region', 'car', 'armm', 'barmm', 'caraga', 'calabarzon',
  'mimaropa', 'bicol region', 'ilocos region', 'cagayan valley', 'central luzon', 'western visayas',
  'central visayas', 'eastern visayas', 'davao region', 'soccsksargen', 'northern mindanao',
  'zamboanga peninsula', 'cordillera administrative region',
]);

function isKnownPhilippinePlace(part: string): boolean {
  const lowered = part.toLocaleLowerCase('en-US');
  return PH_PROVINCES.has(lowered) || /^city of\s+\S/u.test(lowered) || /\S\s+city$/u.test(lowered);
}

/**
 * Normalizes the portal's location text. Philippine postings read `CITY, PROVINCE` or
 * `CITY, NCR, DISTRICT`; overseas postings carry only a country name. NCR maps to Metro Manila and
 * the district suffix is dropped. Philippines is only asserted when a part matches a known
 * Philippine city, province or region; an unrecognised place keeps its raw text with no country, and
 * a recognised foreign country is kept as such so overseas roles are never presented as Manila.
 */
export function normalizePhilJobNetLocation(raw: string | null): PhilJobNetLocation | null {
  const text = cleaned(raw ?? undefined);
  if (text === null) return null;
  const parts = text
    .split(',')
    .map(cleanPlace)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1] ?? '';
  const foreign = normalizeCountry(last);
  if (foreign !== null && foreign !== 'Philippines') {
    return {
      display: parts.length === 1 ? foreign : `${parts.map(titleCase).slice(0, -1).join(', ')}, ${foreign}`,
      country: foreign,
      region: null,
      province: null,
      city: null,
    };
  }
  const places = parts.filter((part) => !/^philippines$/iu.test(part) && !/\bdistrict$/iu.test(part));
  if (places.length === 0) return null;
  const ncrIndex = places.findIndex((part) => /^(?:ncr|metro manila|national capital region)$/iu.test(part));
  if (ncrIndex >= 0) {
    const city = places.find((_part, index) => index !== ncrIndex);
    const cityText = city === undefined ? null : cityName(city);
    return {
      display: [cityText, 'Metro Manila', 'Philippines'].filter((value): value is string => value !== null).join(', '),
      country: 'Philippines',
      region: 'NCR',
      province: null,
      city: cityText,
    };
  }
  if (!places.some(isKnownPhilippinePlace)) {
    return { display: places.map(titleCase).join(', '), country: null, region: null, province: null, city: null };
  }
  const city = cityName(places[0] ?? '');
  const province = places.length > 1 ? titleCase(places[places.length - 1] ?? '') : null;
  return {
    display: [city, province, 'Philippines'].filter((value): value is string => value !== null).join(', '),
    country: 'Philippines',
    region: null,
    province,
    city,
  };
}

export type PhilJobNetSalary = {
  minimum: number | null;
  currency: 'PHP' | null;
};

/**
 * Salary text is a bare peso amount or range (for example `₱22,000.00`). The portal does not state
 * a pay period, so none is invented, and no conversion is applied.
 */
export function parsePhilJobNetSalary(raw: string | null): PhilJobNetSalary {
  const text = cleaned(raw ?? undefined);
  if (text === null || !/₱|\bphp\b/iu.test(text)) return { minimum: null, currency: null };
  const amounts = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/gu)]
    .map((match) => Number(`${(match[1] ?? '').replace(/,/gu, '')}${match[2] === undefined ? '' : `.${match[2]}`}`))
    .filter((value) => Number.isFinite(value) && value > 0);
  const minimum = amounts.length === 0 ? null : Math.min(...amounts);
  return minimum === null ? { minimum: null, currency: null } : { minimum, currency: 'PHP' };
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function isoDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCMonth() === month - 1 ? parsed.toISOString() : null;
}

/**
 * Detail pages print `5 October 2026`; listing cards print a numeric `10/5/2026` whose field order is
 * not documented. A numeric date is only trusted when it is unambiguous (one part above 12, or both
 * parts equal), otherwise it is dropped rather than guessed. Dates in the future are rejected.
 */
export function parsePhilJobNetDate(raw: string | null, now: Date = new Date()): string | null {
  const text = cleaned(raw ?? undefined);
  if (text === null) return null;
  let iso: string | null = null;
  const long = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/u.exec(text);
  if (long !== null) {
    const month = MONTHS.indexOf((long[2] ?? '').toLocaleLowerCase('en-US')) + 1;
    iso = month === 0 ? null : isoDay(Number(long[3]), month, Number(long[1]));
  } else {
    const short = /(\d{1,2})\/(\d{1,2})\/(\d{4})/u.exec(text);
    if (short !== null) {
      const first = Number(short[1]);
      const second = Number(short[2]);
      const year = Number(short[3]);
      if (first === second) iso = isoDay(year, first, second);
      else if (first > 12 && second <= 12) iso = isoDay(year, second, first);
      else if (second > 12 && first <= 12) iso = isoDay(year, first, second);
    }
  }
  if (iso === null) return null;
  // One day of slack covers the portal's own timezone being ahead of UTC.
  return Date.parse(iso) > now.getTime() + 24 * 60 * 60 * 1000 ? null : iso;
}

export type PhilJobNetCard = {
  id: string;
  slug: string;
  url: string;
  title: string;
  company: string;
  salaryText: string | null;
  locationText: string | null;
  educationText: string | null;
  employmentType: string | null;
  postedText: string | null;
};

export type PhilJobNetListing = {
  cards: PhilJobNetCard[];
  invalidCards: number;
  totalText: string | null;
  totalCount: number | null;
  currentPage: number | null;
  nextPage: number | null;
  formState: Record<string, string> | null;
};

/** Raised when a 200 response no longer looks like the markup this adapter was built against. */
export class PhilJobNetDriftError extends Error {
  public constructor(message: string) {
    super(`parser drift: ${message}`);
    this.name = 'PhilJobNetDriftError';
  }
}

function jobIdentity(href: string): { id: string; slug: string; url: string } | null {
  let url: URL;
  try {
    url = new URL(href, PHIL_JOBNET_ORIGIN);
  } catch {
    return null;
  }
  const match = /^\/job-vacancies\/job\/([a-z0-9][a-z0-9-]*-(\d+))\/?$/iu.exec(url.pathname);
  if (url.origin !== PHIL_JOBNET_ORIGIN || match === null) return null;
  const slug = (match[1] ?? '').toLocaleLowerCase('en-US');
  return { id: match[2] ?? '', slug, url: `${PHIL_JOBNET_ORIGIN}/job-vacancies/job/${slug}` };
}

/** Parses one rendered result page (first GET or a postback response). */
export function parsePhilJobNetListing(html: string): PhilJobNetListing {
  const $ = cheerio.load(html);
  const grid = $('table[id$="_GridView1"]').first();
  if (grid.length === 0) throw new PhilJobNetDriftError('result grid (GridView1) not found');
  const totalText = cleaned($('div.label').filter((_i, el) => /job openings?/iu.test($(el).text())).first().text());

  const cards: PhilJobNetCard[] = [];
  let invalidCards = 0;
  grid.find('a.nolink').each((_i, element) => {
    const anchor = $(element);
    const identity = jobIdentity(anchor.attr('href') ?? '');
    const title = cleaned(anchor.find('.jobtitle').first().text());
    const company = cleaned(anchor.find('.companytitle').first().text());
    if (identity === null || title === null || company === null) {
      invalidCards += 1;
      return;
    }
    const info = anchor.find('.jobinfo .col-sm-12').map((_j, el) => cleaned($(el).text())).get();
    cards.push({
      ...identity,
      title,
      company,
      salaryText: cleaned(anchor.find('.salary').first().text()),
      locationText: info[0] ?? null,
      educationText: info[1] ?? null,
      employmentType: info[2] ?? null,
      postedText: cleaned(anchor.find('span.jobinfo').first().text()),
    });
  });
  if (cards.length === 0 && invalidCards === 0 && !/\b0\s+job openings?/iu.test(totalText ?? '')) {
    // An empty grid is only legitimate when the site itself states an explicit zero count.
    throw new PhilJobNetDriftError('result grid holds no vacancy cards and the site does not report zero openings');
  }
  const countMatch = /(\d[\d,]*)\s+job openings?/iu.exec(totalText ?? '');
  const totalCount = countMatch === null ? null : Number((countMatch[1] ?? '').replace(/,/gu, ''));

  const pager = grid.find('tr.pagination-vs, tr:has(td > table)').last();
  const currentText = cleaned(pager.find('span').first().text());
  const currentPage = currentText !== null && /^\d+$/u.test(currentText) ? Number(currentText) : null;
  const targets = new Set(
    [...html.matchAll(/GridView1&#39;,&#39;Page\$(\d+)&#39;|GridView1','Page\$(\d+)'/gu)].map((match) => Number(match[1] ?? match[2])),
  );
  const nextPage = currentPage !== null && targets.has(currentPage + 1) ? currentPage + 1 : null;

  const state: Record<string, string> = {};
  for (const name of FORM_STATE_FIELDS) {
    const field = $(`input[type="hidden"][name="${name}"]`).first();
    if (field.length > 0) state[name] = field.attr('value') ?? '';
  }
  const formState =
    state['__VIEWSTATE'] !== undefined && state['__EVENTVALIDATION'] !== undefined ? state : null;
  return { cards, invalidCards, totalText, totalCount, currentPage, nextPage, formState };
}

export type PhilJobNetDetail = {
  closed: boolean;
  title: string | null;
  company: string | null;
  salaryText: string | null;
  locationText: string | null;
  educationText: string | null;
  employmentType: string | null;
  postedText: string | null;
  description: string | null;
  qualifications: string | null;
  remarks: string | null;
  industry: string | null;
};

function sectionText($: cheerio.CheerioAPI, heading: string): string | null {
  const title = $('h3.jobdesctitle')
    .filter((_i, el) => $(el).text().trim().toLocaleLowerCase('en-US') === heading)
    .first();
  if (title.length === 0) return null;
  const block = title.closest('.row').next();
  block.find('br').replaceWith('\n');
  const text = block.text().replace(/\u00a0/gu, ' ').replace(/[ \t]+/gu, ' ').replace(/\n\s*\n+/gu, '\n').trim();
  return text.length === 0 || NOT_SPECIFIED.test(text) || /^no additional remarks$/iu.test(text) ? null : text;
}

/** Parses one vacancy detail page. A removed vacancy is reported as `closed`, not an error. */
export function parsePhilJobNetDetail(html: string): PhilJobNetDetail {
  const $ = cheerio.load(html);
  const box = $('.job_box').first();
  if (box.length === 0) throw new PhilJobNetDriftError('detail header (job_box) not found');
  const titleNode = box.find('h1.jobtitle').first();
  if (titleNode.length === 0) throw new PhilJobNetDriftError('detail title not found');
  const title = cleaned(titleNode.text());
  const info = box.find('.jobinfo .col-sm-12').map((_i, el) => cleaned($(el).text())).get();
  const industryHeading = $('h5').filter((_i, el) => $(el).text().trim().toLocaleLowerCase('en-US') === 'industry').first();
  return {
    closed: title === null,
    title,
    company: cleaned(box.find('.companytitle').first().text()),
    salaryText: cleaned(box.find('.salary').first().text()),
    locationText: info[0] ?? null,
    educationText: info[1] ?? null,
    employmentType: info[2] ?? null,
    postedText: cleaned($('.postdate').first().text().replace(/^\s*posted on/iu, '')),
    description: sectionText($, 'job description') ?? cleaned($('.jobdescription').first().text()),
    qualifications: sectionText($, 'qualifications/requirements'),
    remarks: sectionText($, 'remarks'),
    industry: industryHeading.length === 0 ? null : cleaned(industryHeading.next().text()),
  };
}

export function normalizePhilJobNetVacancy(
  card: PhilJobNetCard,
  detail: PhilJobNetDetail | null,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit {
  const salary = parsePhilJobNetSalary(detail?.salaryText ?? card.salaryText);
  const location = normalizePhilJobNetLocation(detail?.locationText ?? card.locationText);
  const education = detail?.educationText ?? card.educationText;
  const description = [
    education === null ? null : `Education: ${education}`,
    detail?.industry == null ? null : `Industry: ${detail.industry}`,
    detail?.description ?? null,
    detail?.qualifications == null ? null : `Qualifications: ${detail.qualifications}`,
    detail?.remarks == null ? null : `Remarks: ${detail.remarks}`,
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join('\n');
  return discoveryAudit({
    key: `${PROVIDER}:${card.id}`,
    provider: PROVIDER,
    company: detail?.company ?? card.company,
    title: detail?.title ?? card.title,
    url: card.url,
    location: location?.display ?? 'Unknown',
    employmentType: cleaned(detail?.employmentType ?? card.employmentType ?? undefined),
    currency: salary.currency,
    // The portal states no pay period, so none is recorded and nothing is annualized.
    salaryPeriod: null,
    advertisedMinimum: salary.minimum,
    salaryProvenance: 'reviewed_structured',
    description: description.length === 0 ? null : description,
    postedAt: parsePhilJobNetDate(detail?.postedText ?? null) ?? parsePhilJobNetDate(card.postedText),
    raw: { card, detail },
    minimumAnnualBaseUsd,
  });
}

function requirePostForm(http: AtsHttpClient): NonNullable<AtsHttpClient['postForm']> {
  const postForm = http.postForm;
  if (postForm === undefined) {
    throw new AtsResponseError(PROVIDER, 'HTTP client cannot submit the Web Forms pagination postback');
  }
  return postForm.bind(http);
}

const BLOCKED_STATUSES = [401, 403, 406, 407, 429, 451];

function loginWall(response: AtsHttpResponse): boolean {
  try {
    return /\/login(?:\.aspx)?\/?$/iu.test(new URL(response.finalUrl, PHIL_JOBNET_ORIGIN).pathname);
  } catch {
    return false;
  }
}

/** The portal stopping anonymous access (status block or login redirect) must end the run, not be retried around. */
function blockedStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  const typed = error instanceof AtsResponseError || (error instanceof Error && error.name === 'CrawlerHttpError');
  return typed && typeof status === 'number' && BLOCKED_STATUSES.includes(status) ? status : null;
}

function body(response: AtsHttpResponse): string {
  if (loginWall(response)) {
    throw new AtsResponseError(PROVIDER, 'redirected to the login page (login wall); stopping', 401);
  }
  requireSuccessfulResponse(PROVIDER, response);
  return response.body;
}

/**
 * Runs one bounded PhilJobNet search. Nothing is requested unless the source is explicitly enabled
 * and a role query is present, so a profile without a target role never crawls the portal.
 */
export async function discoverPhilJobNet(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const term = config.discovery.roleQuery.trim().slice(0, MAX_SEARCH_TERM_LENGTH);
  if (config.discovery.philJobNetEnabled !== true || term.length === 0) {
    return { sources: [], vacancies: [] };
  }
  const maxPages = config.discovery.philJobNetMaxPages ?? PHIL_JOBNET_DEFAULT_MAX_PAGES;
  const maxDetails = config.discovery.philJobNetMaxDetails ?? PHIL_JOBNET_DEFAULT_MAX_DETAILS;
  const counters = newNetworkAttemptCounters();
  const client = attributeNetworkRequests(http, counters);
  const options = { allowedOrigins: [PHIL_JOBNET_ORIGIN] } as const;
  const url = philJobNetSearchUrl(term);

  let requests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let complete = true;
  let continuationCursor: string | null = null;
  const notes: string[] = [];
  const cards: PhilJobNetCard[] = [];
  const seen = new Set<string>();
  const vacancies: DiscoveryVacancyAudit[] = [];

  try {
    requests += 1;
    let listing = parsePhilJobNetListing(body(await client.get(url, options)));
    let page = 1;
    let invalid = listing.invalidCards;
    let rawCards = 0;
    for (;;) {
      rawCards += listing.cards.length;
      for (const card of listing.cards) {
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        cards.push(card);
      }
      if (listing.nextPage === null) {
        const accountedFor = listing.totalCount !== null && listing.totalCount <= rawCards;
        if (listing.currentPage === null && listing.cards.length > 0 && !accountedFor) {
          throw new PhilJobNetDriftError('result cards present but the pager was not found');
        }
        if (listing.totalCount !== null && listing.totalCount > rawCards) {
          complete = false;
          notes.push(
            `The portal reports ${listing.totalCount} openings but only ${rawCards} listings were collected (pager markup may have changed).`,
          );
        }
        break;
      }
      if (page >= maxPages) {
        complete = false;
        continuationCursor = String(listing.nextPage);
        notes.push(`Stopped after the configured ${maxPages}-page budget; more result pages exist.`);
        break;
      }
      if (listing.formState === null) {
        throw new PhilJobNetDriftError('pagination state fields (__VIEWSTATE/__EVENTVALIDATION) missing');
      }
      const postForm = requirePostForm(client);
      requests += 1;
      const next: PhilJobNetListing = parsePhilJobNetListing(
        body(
          await postForm(
            url,
            {
              ...listing.formState,
              [SEARCH_FIELD]: term,
              __EVENTTARGET: GRID_TARGET,
              __EVENTARGUMENT: `Page$${listing.nextPage}`,
            },
            options,
          ),
        ),
      );
      if (next.currentPage !== listing.nextPage) {
        throw new PhilJobNetDriftError(`postback for page ${listing.nextPage} did not return that page`);
      }
      invalid += next.invalidCards;
      page = listing.nextPage;
      listing = next;
    }
    if (invalid > 0) {
      if (cards.length === 0) throw new PhilJobNetDriftError(`${invalid} listing cards could not be parsed`);
      complete = false;
      notes.push(`${invalid} listing cards could not be parsed (possible markup drift).`);
    }

    const toHydrate = cards.slice(0, maxDetails);
    if (cards.length > toHydrate.length) {
      complete = false;
      notes.push(`Detail pages fetched for ${toHydrate.length} of ${cards.length} listings (budget ${maxDetails}).`);
    }
    let closed = 0;
    let detailFailures = 0;
    for (const card of cards) {
      let detail: PhilJobNetDetail | null = null;
      if (toHydrate.includes(card)) {
        try {
          requests += 1;
          detail = parsePhilJobNetDetail(body(await client.get(card.url, options)));
        } catch (error) {
          if (blockedStatus(error) !== null) throw error;
          detailFailures += 1;
        }
        if (detail?.closed === true) {
          closed += 1;
          continue;
        }
      }
      vacancies.push(normalizePhilJobNetVacancy(card, detail, config.minimumAnnualBaseUsd));
    }
    if (closed > 0) notes.push(`${closed} closed or missing detail pages were skipped.`);
    if (detailFailures > 0) {
      complete = false;
      notes.push(`${detailFailures} detail pages could not be read; those listings keep listing-level data only.`);
    }
  } catch (error) {
    const blocked = blockedStatus(error);
    const failure = sourceFailure(
      blocked !== null && !(error instanceof AtsResponseError)
        ? new AtsResponseError(PROVIDER, error instanceof Error ? error.message : 'blocked', blocked)
        : error,
    );
    status = failure.status;
    errorMessage = failure.error;
    complete = false;
  }

  if (status === 'success' && !complete) {
    status = 'partial';
    errorMessage = notes.join(' ');
  } else if (status === 'success' && notes.length > 0) {
    errorMessage = notes.join(' ');
  }
  const source: DiscoverySourceAudit = {
    id: `${PROVIDER}:search`,
    provider: PROVIDER,
    url,
    requests,
    listings: vacancies.length,
    status,
    error: errorMessage,
    ...networkAttemptFields(counters),
    ...(complete ? completeAudit() : incompleteAudit(errorMessage ?? 'incomplete', continuationCursor)),
  };
  return { sources: [source], vacancies };
}
