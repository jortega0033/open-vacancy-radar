import { SaxesParser } from 'saxes';

import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import {
  discoveryAudit,
  isoPostedAtFromYyyyMmDd,
  sourceFailure,
  stringValue,
} from './discovery-shared.js';
import type {
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
} from './models.js';

/**
 * Taiwan Jobs (台灣就業通, https://job.taiwanjobs.gov.tw) -- the Ministry of Labor's Workforce
 * Development Agency official vacancy list, published under the Taiwan Open Government Data
 * License 1.0 (https://data.gov.tw/license) as dataset record 44062
 * (https://data.gov.tw/en/datasets/44062). Anonymous reads are free and unauthenticated; a live
 * request against the documented WebService succeeds with no API key.
 *
 * Three resources are published for this dataset: CSV/JSON bulk downloads through the generic
 * `apiservice.mol.gov.tw/OdService/download/{resourceID}` endpoint, and this dedicated WebService.
 * The bulk downloads were checked live (see docs/job-source-evidence.md) and turned out to be an
 * unbounded, unpartitioned full-table snapshot with no `count`/`city`/`zipno` query support at
 * all -- unusable for a bounded, deterministic per-run scan. The documented WebService
 * (https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx, confirmed live and described
 * in the linked "介接說明文件" PDF) is the one the ticket's "1,000-record cap" and "keyless XML
 * request" both describe, so it is the one this adapter uses, matching the ticket's "otherwise use
 * a strict streaming XML parser for the documented WebService" guidance. It has no `offset`/`page`
 * parameter at all -- the only way to see more than 1,000 records is to partition the query, so
 * this adapter partitions by the documented `city` parameter's 22 official county/city codes
 * (`TAIWAN_JOBS_CITY_CODES`) rather than looping pages that do not exist.
 *
 * A live check of the response also surfaced an undocumented quirk the ticket asked to watch for:
 * the XML element names are not the bare `OCCU_DESC`/`COMPNAME`/etc. tokens the field-mapping table
 * implies -- every element name is literally `OCCU_DESC（職務名稱）`, `COMPNAME（公司名稱）`, and so
 * on, with a parenthetical Chinese label appended directly onto the tag name (full-width
 * parentheses are valid XML NameChars, so this is well-formed XML, just an unusual contract). This
 * adapter matches on the leading ASCII field code only (see `TAIWAN_JOB_FIELD_CODES` below) so a
 * label-wording change does not break parsing, while still rejecting any element whose ASCII prefix
 * is not one of the 19 documented fields.
 *
 * `saxes` (already a `vacancy-engine` dependency, used the same way by `workable-feed.ts`) parses
 * the response body strictly: comments, processing instructions, and DOCTYPE are rejected, XML
 * declarations must claim UTF-8 when present, and only the exact `DataList > Data > FIELD`
 * structure the WebService documents is accepted. The whole response is handed to the parser in one
 * `write()` call rather than truly streamed chunk-by-chunk -- each partition is capped at 1,000
 * records by the service itself (a few MB at most), unlike Workable's up-to-2GB all-customer feed,
 * which is what makes chunked I/O necessary there.
 */
export const TAIWAN_JOBS_API_ORIGIN = 'https://free.taiwanjobs.gov.tw';
export const TAIWAN_JOBS_WEBSERVICE_URL = `${TAIWAN_JOBS_API_ORIGIN}/webservice_taipei/Webservice.ashx`;
/** Origin of the canonical per-listing apply/detail page published as `URL_QUERY`. */
export const TAIWAN_JOBS_APPLY_ORIGIN = 'https://job.taiwanjobs.gov.tw';
/** Documented hard ceiling ("最多回傳 1000 筆" / "maximum 1,000 records returned per query"). */
export const TAIWAN_JOBS_MAX_RECORDS_PER_PARTITION = 1_000;

/**
 * The 22 official county/city codes documented for the WebService's `city` parameter. Querying all
 * of them by default (see `config.discovery.taiwanJobsMaxCities`) gives every part of Taiwan equal
 * coverage; trimming the list is only ever a request-budget knob, never a region preference --
 * consistent with this project's rule against shipping any default country/location bias.
 */
export const TAIWAN_JOBS_CITY_CODES: readonly (readonly [code: string, name: string])[] = [
  ['01', 'Taipei City'],
  ['31', 'New Taipei City'],
  ['11', 'Keelung City'],
  ['33', 'Taoyuan City'],
  ['12', 'Hsinchu City'],
  ['34', 'Hsinchu County'],
  ['35', 'Miaoli County'],
  ['13', 'Taichung City'],
  ['38', 'Nantou County'],
  ['37', 'Changhua County'],
  ['39', 'Yunlin County'],
  ['14', 'Chiayi City'],
  ['40', 'Chiayi County'],
  ['15', 'Tainan City'],
  ['02', 'Kaohsiung City'],
  ['43', 'Pingtung County'],
  ['32', 'Yilan County'],
  ['45', 'Hualien County'],
  ['46', 'Taitung County'],
  ['44', 'Penghu County'],
  ['23', 'Kinmen County'],
  ['24', 'Lienchiang County'],
];

/**
 * ASCII prefix of every field element the documented WebService emits, keyed by the exact string
 * used below (the leading token before the parenthetical Chinese label, e.g. `OCCU_DESC` out of
 * `OCCU_DESC（職務名稱）`). Any element whose prefix is not in this set fails the parse -- see the
 * module doc comment for why matching is prefix-based rather than exact-string.
 */
const TAIWAN_JOB_FIELD_CODES = new Set([
  'OCCU_DESC',
  'WK_TYPE',
  'CJOB1_COUNT',
  'CJOB_NAME1',
  'CJOB2_COUNT',
  'CJOB_NAME2',
  'JOB_PERSON',
  'STOP_DATE',
  'JOB_DETAIL',
  'CITYNAME',
  'EXPERIENCE',
  'WKTIME',
  'SALARYCD',
  'NT_L',
  'NT_U',
  'EDGRDESC',
  'URL_QUERY',
  'COMPNAME',
  'TRANDATE',
]);

const FIELD_CODE_PATTERN = /^([A-Z][A-Z0-9_]*)/u;

export type TaiwanJobRow = Readonly<Record<string, string>>;

class TaiwanJobsXmlError extends Error {}

/**
 * Strictly parses one WebService response into raw field-code -> text rows. Throws
 * `TaiwanJobsXmlError` for anything outside the documented `DataList > Data > FIELD` shape: an
 * empty `<DataList></DataList>` (no `<Data>` children) is not an error, it is a valid zero-result
 * partition and returns `[]`.
 */
export function parseTaiwanJobsXml(body: string): TaiwanJobRow[] {
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  const rows: TaiwanJobRow[] = [];
  const stack: string[] = [];
  let currentRow: Record<string, string> | null = null;
  let currentFieldCode: string | null = null;
  let currentText = '';
  let sawRoot = false;

  const fail = (message: string): never => {
    throw new TaiwanJobsXmlError(message);
  };

  parser.on('xmldecl', (declaration) => {
    if (declaration.version !== undefined && declaration.version !== '1.0') {
      fail('only XML 1.0 is supported');
    }
    if (
      declaration.encoding !== undefined &&
      declaration.encoding.toLowerCase().replaceAll('_', '-') !== 'utf-8'
    ) {
      fail('only UTF-8 XML is supported');
    }
  });
  parser.on('processinginstruction', () => fail('processing instructions are forbidden'));
  parser.on('comment', () => fail('comments are forbidden'));
  parser.on('doctype', () => fail('DOCTYPE and entity declarations are forbidden'));
  parser.on('error', (error) => {
    throw new TaiwanJobsXmlError(`XML is malformed or truncated: ${error.message}`);
  });
  parser.on('text', (text) => {
    if (currentFieldCode !== null) currentText += text;
    else if (text.trim().length > 0) fail('text is only allowed inside a known field element');
  });
  parser.on('cdata', (text) => {
    if (currentFieldCode !== null) currentText += text;
  });
  parser.on('opentag', (tag) => {
    const depth = stack.length + 1;
    if (Object.keys(tag.attributes).length > 0) fail(`attributes are not allowed on <${tag.name}>`);
    if (depth === 1) {
      if (tag.name !== 'DataList') fail('root element must be <DataList>');
      sawRoot = true;
    } else if (depth === 2) {
      if (tag.name !== 'Data') fail(`unexpected <${tag.name}> under <DataList>`);
      currentRow = {};
    } else if (depth === 3) {
      if (currentRow === null) fail('field element opened outside <Data>');
      const code = FIELD_CODE_PATTERN.exec(tag.name)?.[1] ?? null;
      if (code === null || !TAIWAN_JOB_FIELD_CODES.has(code)) {
        fail(`unexpected field <${tag.name}>`);
      }
      currentFieldCode = code;
      currentText = '';
    } else {
      fail(`unexpected nested <${tag.name}>`);
    }
    stack.push(tag.name);
  });
  parser.on('closetag', () => {
    const depth = stack.length;
    if (depth === 3 && currentRow !== null && currentFieldCode !== null) {
      currentRow[currentFieldCode] = currentText.trim();
      currentFieldCode = null;
    } else if (depth === 2 && currentRow !== null) {
      rows.push(currentRow);
      currentRow = null;
    }
    stack.pop();
  });

  parser.write(body).close();
  if (!sawRoot) fail('response did not contain a <DataList> root element');
  return rows;
}

function taiwanJobsUrl(cityCode: string): URL {
  const url = new URL(TAIWAN_JOBS_WEBSERVICE_URL);
  url.searchParams.set('city', cityCode);
  url.searchParams.set('count', String(TAIWAN_JOBS_MAX_RECORDS_PER_PARTITION));
  return url;
}

function positiveNumericText(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * `SALARYCD` ("核薪方式", pay basis) is a small closed vocabulary the posting form offers
 * employers, not free text. Mapped 1:1 onto this pipeline's period vocabulary; anything else (or
 * missing) is left `null` rather than guessed, matching every other worldwide source's fallback
 * behavior for an unrecognized period (see `parseSalaryText`).
 */
function taiwanSalaryPeriod(value: string | null): string | null {
  switch (value) {
    case '年薪':
      return 'annual';
    case '月薪':
      return 'monthly';
    case '週薪':
      return 'weekly';
    case '日薪':
      return 'daily';
    case '時薪':
      return 'hourly';
    default:
      return null;
  }
}

/**
 * The WebService's own `URL_QUERY` field is the canonical Taiwan Jobs apply/detail page for this
 * listing. Both the clickable link and a stable identity for `key` come from validating and parsing
 * this same value, rather than trusting a bare string: origin, path, and the two numeric
 * `EMPLOYER_ID`/`HIRE_ID` query parameters that together identify the posting are all checked, so a
 * malformed or unrelated URL is rejected (the row is dropped) instead of becoming a clickable link
 * to somewhere else, or a key collision with an unrelated posting.
 */
function taiwanJobDetail(value: string | null): { url: string; id: string } | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.origin !== TAIWAN_JOBS_APPLY_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/Internet/jobwanted/JobDetail.aspx'
  ) {
    return null;
  }
  const employerId = url.searchParams.get('EMPLOYER_ID');
  const hireId = url.searchParams.get('HIRE_ID');
  if (
    employerId === null ||
    !/^\d+$/u.test(employerId) ||
    hireId === null ||
    !/^\d+$/u.test(hireId)
  ) {
    return null;
  }
  url.hash = '';
  return { url: url.href, id: `${employerId}:${hireId}` };
}

/**
 * Normalizes one raw `Data` row into the shared discovery shape, or `null` when the row cannot be
 * trusted as an attributable vacancy (missing title/company, or an unusable `URL_QUERY`).
 *
 * The shared `DiscoveryVacancyAudit` shape has no dedicated slots for occupation classification,
 * headcount, experience, schedule, education, or application deadline -- exactly like AI Dev Jobs'
 * adapter folds its extra `level`/`tags` fields into `description` rather than dropping them, these
 * are folded into `description` too, ahead of the source's own `JOB_DETAIL` text. Source text (all
 * Traditional Chinese) is never translated or rewritten, only reformatted for the discovery report.
 */
export function normalizeTaiwanJob(
  raw: TaiwanJobRow,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit | null {
  const title = stringValue(raw.OCCU_DESC);
  const company = stringValue(raw.COMPNAME);
  const detail = taiwanJobDetail(stringValue(raw.URL_QUERY));
  if (title === null || company === null || detail === null) return null;

  // NT_L/NT_U ("薪資範圍下限/上限") are explicitly New Taiwan Dollar amounts -- there is no other
  // currency this field could mean, and no separate currency field to read instead (matching how
  // AI Dev Jobs' adapter hard-codes USD from its own equally explicit OpenAPI salary contract).
  const advertisedMinimum = positiveNumericText(stringValue(raw.NT_L));
  const currency = advertisedMinimum === null ? null : 'TWD';
  const salaryPeriod = advertisedMinimum === null ? null : taiwanSalaryPeriod(stringValue(raw.SALARYCD));

  const occupation = [stringValue(raw.CJOB_NAME1), stringValue(raw.CJOB_NAME2)]
    .filter((value): value is string => value !== null)
    .join(' / ');
  const deadline = isoPostedAtFromYyyyMmDd(stringValue(raw.STOP_DATE));
  const headcount = stringValue(raw.JOB_PERSON);
  const experience = stringValue(raw.EXPERIENCE);
  const schedule = stringValue(raw.WKTIME);
  const education = stringValue(raw.EDGRDESC);
  const description = [
    occupation.length === 0 ? null : `Occupation: ${occupation}`,
    headcount === null ? null : `Headcount: ${headcount}`,
    experience === null ? null : `Experience: ${experience}`,
    schedule === null ? null : `Schedule: ${schedule}`,
    education === null ? null : `Education: ${education}`,
    deadline === null ? null : `Apply by: ${deadline.slice(0, 10)}`,
    stringValue(raw.JOB_DETAIL),
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join('\n');

  return discoveryAudit({
    key: `taiwan_jobs:${detail.id}`,
    provider: 'taiwan_jobs',
    company,
    title,
    url: detail.url,
    location: stringValue(raw.CITYNAME) ?? 'Unknown',
    employmentType: stringValue(raw.WK_TYPE),
    currency,
    salaryPeriod,
    advertisedMinimum,
    description: description.length === 0 ? null : description,
    postedAt: isoPostedAtFromYyyyMmDd(stringValue(raw.TRANDATE)),
    raw,
    minimumAnnualBaseUsd,
  });
}

/**
 * Scans Taiwan Jobs one city/county partition at a time (see the module doc comment for why: the
 * WebService has no `offset`/`page` parameter, so partitioning by the documented `city` codes is
 * the only bounded way to see more than the 1,000-record-per-query cap). Each partition gets its
 * own `DiscoverySourceAudit` entry, mirroring `discoverHimalayas`'s one-entry-per-query pattern, so
 * a single blocked or malformed partition is isolated and reported without hiding the other 21.
 */
export async function discoverTaiwanJobs(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const sources: DiscoverySourceAudit[] = [];
  const vacancies: DiscoveryVacancyAudit[] = [];
  const seenKeys = new Set<string>();
  const cityCodes = TAIWAN_JOBS_CITY_CODES.slice(0, config.discovery.taiwanJobsMaxCities);

  for (const [cityCode, cityName] of cityCodes) {
    const url = taiwanJobsUrl(cityCode);
    let requests = 0;
    let listings = 0;
    let status: DiscoverySourceAudit['status'] = 'success';
    let errorMessage: string | null = null;
    try {
      requests += 1;
      const response = await http.get(url.toString());
      requireSuccessfulResponse('taiwan_jobs', response);
      let rows: TaiwanJobRow[];
      try {
        rows = parseTaiwanJobsXml(response.body);
      } catch (error) {
        throw new AtsResponseError(
          'taiwan_jobs',
          error instanceof Error ? error.message : String(error),
          response.status,
          { cause: error },
        );
      }
      // The service never signals "more records exist" itself: a partition that comes back at
      // exactly the documented cap must be reported as partial rather than silently trusted as
      // complete, per the ticket's acceptance criteria.
      if (rows.length >= TAIWAN_JOBS_MAX_RECORDS_PER_PARTITION) {
        status = 'partial';
        errorMessage = `Reached the documented ${TAIWAN_JOBS_MAX_RECORDS_PER_PARTITION.toLocaleString('en-US')}-record cap for ${cityName} (city=${cityCode}); this partition may have more unseen vacancies.`;
      }
      for (const row of rows) {
        const vacancy = normalizeTaiwanJob(row, config.minimumAnnualBaseUsd);
        if (vacancy === null) continue;
        // Defensive de-duplication only: the service documents one city per record, so a key
        // should never repeat across partitions, but a vacancy is only ever emitted once per run
        // either way.
        if (seenKeys.has(vacancy.key)) continue;
        seenKeys.add(vacancy.key);
        vacancies.push(vacancy);
        listings += 1;
      }
    } catch (error) {
      const failure = sourceFailure(error);
      status = failure.status;
      errorMessage = failure.error;
    }
    sources.push({
      id: `taiwan_jobs:city-${cityCode}`,
      provider: 'taiwan_jobs',
      url: url.toString(),
      requests,
      listings,
      status,
      error: errorMessage,
    });
  }
  return { sources, vacancies };
}
