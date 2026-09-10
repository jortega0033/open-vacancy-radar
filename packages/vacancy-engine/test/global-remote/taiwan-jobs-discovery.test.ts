import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import {
  discoverTaiwanJobs,
  normalizeTaiwanJob,
  parseTaiwanJobsXml,
  TAIWAN_JOBS_CITY_CODES,
  TAIWAN_JOBS_WEBSERVICE_URL,
  type TaiwanJobRow,
} from '../../src/global-remote/taiwan-jobs-discovery.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import { FixtureHttpClient } from '../ats/helpers.js';

function fixture(name: string): string {
  return readFileSync(
    path.resolve(process.cwd(), 'test/fixtures/global-remote/taiwan-jobs', name),
    'utf8',
  );
}

function profile(overrides: Partial<GlobalRemoteConfig['discovery']> = {}): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: 100_000,
    discovery: {
      roleQuery: '',
      himalayasQueries: ['frontend'],
      himalayasCountry: 'NL',
      himalayasMaxPagesPerQuery: 1,
      jobicyCount: 1,
      freehireLimit: 1,
      jobOpportunitiesLimit: 1,
      remoteLandersMaxPages: 1,
      jobgetherMaxPages: 1,
      remoteFirstMaxPages: 1,
      jobRemotelyMaxPages: 1,
      arbeitnowMaxPages: 1,
      diceMaxPages: 1,
      remooteRoleTitle: '',
      remooteCountry: '',
      remooteLimit: 10,
      aiDevJobsMaxPages: 1,
      taiwanJobsMaxCities: 1,
      museEnabled: false,
      museMaxPages: 1,
      adzunaAppId: '',
      adzunaAppKey: '',
      adzunaMaxPages: 1,
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
      navArbeidsplassenApiKey: 'test-nav-key',
      navArbeidsplassenMaxPages: 1,
      ...overrides,
    },
    officialSources: [],
  };
}

function cityUrl(code: string): string {
  return `${TAIWAN_JOBS_WEBSERVICE_URL}?city=${code}&count=1000`;
}

function generateCappedXml(count: number): string {
  const rows = Array.from({ length: count }, (_unused, index) => {
    const id = index + 1;
    return `<Data>
<OCCU_DESC（職務名稱）><![CDATA[測試職缺 ${id}]]></OCCU_DESC（職務名稱）>
<WK_TYPE（職務性質）><![CDATA[全職]]></WK_TYPE（職務性質）>
<CJOB1_COUNT（職務大類別代碼）><![CDATA[08]]></CJOB1_COUNT（職務大類別代碼）>
<CJOB_NAME1（職務大類別名稱）><![CDATA[資訊軟體]]></CJOB_NAME1（職務大類別名稱）>
<CJOB2_COUNT（職務小類別代碼）><![CDATA[080101]]></CJOB2_COUNT（職務小類別代碼）>
<CJOB_NAME2（職務小類別名稱）><![CDATA[軟體工程師]]></CJOB_NAME2（職務小類別名稱）>
<JOB_PERSON（雇用人數）><![CDATA[1]]></JOB_PERSON（雇用人數）>
<STOP_DATE（應徵截止日期）><![CDATA[20261231]]></STOP_DATE（應徵截止日期）>
<JOB_DETAIL（工作內容）><![CDATA[大量測試資料 ${id}。]]></JOB_DETAIL（工作內容）>
<CITYNAME（工作地點）><![CDATA[台北市信義區]]></CITYNAME（工作地點）>
<EXPERIENCE（工作經驗）><![CDATA[不拘]]></EXPERIENCE（工作經驗）>
<WKTIME（工作時間）><![CDATA[日班]]></WKTIME（工作時間）>
<SALARYCD（核薪方式）><![CDATA[月薪]]></SALARYCD（核薪方式）>
<NT_L（薪資範圍下限）><![CDATA[40000]]></NT_L（薪資範圍下限）>
<NT_U（薪資範圍上限）><![CDATA[50000]]></NT_U（薪資範圍上限）>
<EDGRDESC（最低學歷要求）><![CDATA[大學]]></EDGRDESC（最低學歷要求）>
<URL_QUERY（職缺資料URL）><![CDATA[https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=${id}&HIRE_ID=${id}]]></URL_QUERY（職缺資料URL）>
<COMPNAME（公司名稱）><![CDATA[範例科技股份有限公司]]></COMPNAME（公司名稱）>
<TRANDATE（職缺更新日期）><![CDATA[20260905]]></TRANDATE（職缺更新日期）>
</Data>`;
  }).join('\n');
  return `<?xml version='1.0' ?><DataList>\n${rows}\n</DataList>`;
}

describe('Taiwan Jobs linked-index discovery', () => {
  it('normalizes a valid row, dropping a row with a missing title and a row with an off-origin apply URL', async () => {
    const routes = new Map([[cityUrl('01'), fixture('list-with-invalid-rows.xml')]]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverTaiwanJobs(http, profile());

    expect(http.requestedUrls).toEqual([cityUrl('01')]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: 'taiwan_jobs:city-01',
        provider: 'taiwan_jobs',
        requests: 1,
        listings: 1,
        status: 'success',
        error: null,
      }),
    ]);
    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]).toEqual(
      expect.objectContaining({
        key: 'taiwan_jobs:100003:200003',
        provider: 'taiwan_jobs',
        company: '範例軟體股份有限公司',
        title: '後端工程師',
        url: 'https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=100003&HIRE_ID=200003',
        location: '台中市西屯區',
        employmentType: '全職',
        currency: 'TWD',
        salaryPeriod: 'monthly',
        advertisedMinimum: 50_000,
        annualizedMinimumUsd: null,
        postedAt: '2026-09-02T00:00:00.000Z',
      }),
    );
    expect(result.vacancies[0]?.description).toContain('Occupation: 資訊軟體 / 後端工程師');
    expect(result.vacancies[0]?.description).toContain('Headcount: 1');
    expect(result.vacancies[0]?.description).toContain('Experience: 3年以上');
    expect(result.vacancies[0]?.description).toContain('Schedule: 日班');
    expect(result.vacancies[0]?.description).toContain('Education: 大學');
    expect(result.vacancies[0]?.description).toContain('Apply by: 2026-11-30');
    expect(result.vacancies[0]?.description).toContain('負責後端 API 開發。');
  });

  it('maps every documented field, including salary, deadline, and Traditional Chinese text, for a full valid row', async () => {
    const routes = new Map([[cityUrl('01'), fixture('list-valid.xml')]]);
    const result = await discoverTaiwanJobs(new FixtureHttpClient(routes), profile());

    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies[0]).toEqual(
      expect.objectContaining({
        key: 'taiwan_jobs:100001:200001',
        company: '範例科技股份有限公司',
        title: '前端工程師',
        location: '台北市信義區',
        employmentType: '全職',
        currency: 'TWD',
        salaryPeriod: 'monthly',
        advertisedMinimum: 45_000,
        postedAt: '2026-09-05T00:00:00.000Z',
      }),
    );
    expect(result.vacancies[0]?.description).toContain('使用 React 與 TypeScript');
    expect(result.vacancies[0]?.description).toContain('Apply by: 2026-12-31');

    // A negotiable-salary listing (blank NT_L/SALARYCD) survives normalization with a null salary
    // rather than a fabricated zero, and a part-time employment type passes through untranslated.
    expect(result.vacancies[1]).toEqual(
      expect.objectContaining({
        key: 'taiwan_jobs:100002:200002',
        company: '測試物流有限公司',
        employmentType: '兼職',
        location: '高雄市前鎮區',
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        annualizedMinimumUsd: null,
      }),
    );
  });

  it('covers all 22 documented city codes by default, giving every region equal, independent coverage', async () => {
    const routes = new Map(
      TAIWAN_JOBS_CITY_CODES.map(([code]) => [cityUrl(code), fixture('list-empty.xml')] as const),
    );
    const http = new FixtureHttpClient(routes);

    const result = await discoverTaiwanJobs(http, profile({ taiwanJobsMaxCities: 22 }));

    expect(TAIWAN_JOBS_CITY_CODES).toHaveLength(22);
    expect(http.requestedUrls).toEqual(TAIWAN_JOBS_CITY_CODES.map(([code]) => cityUrl(code)));
    expect(result.sources).toHaveLength(22);
    expect(result.sources.every((source) => source.status === 'success' && source.listings === 0)).toBe(
      true,
    );
    expect(result.vacancies).toEqual([]);
  });

  it('honors a configured partition budget smaller than the full city list', async () => {
    const routes = new Map(
      TAIWAN_JOBS_CITY_CODES.slice(0, 3).map(
        ([code]) => [cityUrl(code), fixture('list-empty.xml')] as const,
      ),
    );
    const http = new FixtureHttpClient(routes);

    const result = await discoverTaiwanJobs(http, profile({ taiwanJobsMaxCities: 3 }));

    expect(result.sources).toHaveLength(3);
    expect(http.requestedUrls).toEqual(TAIWAN_JOBS_CITY_CODES.slice(0, 3).map(([code]) => cityUrl(code)));
  });

  it('marks a partition partial when it reaches the documented 1,000-record cap, never treating it as complete', async () => {
    const routes = new Map([[cityUrl('01'), generateCappedXml(1_000)]]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverTaiwanJobs(http, profile());

    expect(result.sources).toEqual([
      expect.objectContaining({
        status: 'partial',
        listings: 1_000,
        error: expect.stringContaining('documented 1,000-record cap'),
      }),
    ]);
    expect(result.vacancies).toHaveLength(1_000);
  });

  it('treats an empty DataList as a valid, zero-result partition rather than an error', async () => {
    const routes = new Map([[cityUrl('01'), fixture('list-empty.xml')]]);

    const result = await discoverTaiwanJobs(new FixtureHttpClient(routes), profile());

    expect(result.sources).toEqual([
      expect.objectContaining({ requests: 1, listings: 0, status: 'success', error: null }),
    ]);
    expect(result.vacancies).toEqual([]);
  });

  it('isolates a malformed-XML partition as an errored source without blocking the other configured partitions', async () => {
    const routes = new Map([
      [cityUrl('01'), fixture('list-malformed.xml')],
      [cityUrl('31'), fixture('list-valid.xml')],
    ]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverTaiwanJobs(http, profile({ taiwanJobsMaxCities: 2 }));

    expect(result.sources).toEqual([
      expect.objectContaining({
        id: 'taiwan_jobs:city-01',
        status: 'error',
        listings: 0,
        error: expect.stringContaining('malformed or truncated'),
      }),
      expect.objectContaining({ id: 'taiwan_jobs:city-31', status: 'success', listings: 2 }),
    ]);
    expect(result.vacancies).toHaveLength(2);
  });

  it('isolates an hourly rate limit (429) partition as blocked without retrying', async () => {
    const response: AtsHttpResponse = {
      status: 429,
      finalUrl: cityUrl('01'),
      headers: { 'retry-after': '3600' },
      body: 'Too Many Requests',
    };
    const routes = new Map([[cityUrl('01'), response]]);
    const http = new FixtureHttpClient(routes);

    const result = await discoverTaiwanJobs(http, profile());

    expect(http.requestedUrls).toEqual([cityUrl('01')]);
    expect(result.sources).toEqual([
      expect.objectContaining({
        requests: 1,
        listings: 0,
        status: 'blocked',
        error: expect.stringContaining('HTTP 429'),
      }),
    ]);
  });

  it('de-duplicates an identical stable key seen twice within one partition', async () => {
    const routes = new Map([[cityUrl('01'), fixture('list-duplicate.xml')]]);

    const result = await discoverTaiwanJobs(new FixtureHttpClient(routes), profile());

    expect(result.sources[0]).toMatchObject({ listings: 1 });
    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]?.key).toBe('taiwan_jobs:100006:200006');
  });
});

describe('parseTaiwanJobsXml', () => {
  it('rejects a response whose root element is not DataList', () => {
    expect(() => parseTaiwanJobsXml("<?xml version='1.0' ?><NotDataList></NotDataList>")).toThrow(
      'root element must be <DataList>',
    );
  });

  it('rejects an unexpected field element under Data', () => {
    const xml =
      "<?xml version='1.0' ?><DataList><Data><UNKNOWN_FIELD（未知欄位）><![CDATA[x]]></UNKNOWN_FIELD（未知欄位）></Data></DataList>";
    expect(() => parseTaiwanJobsXml(xml)).toThrow('unexpected field');
  });

  it('rejects a comment anywhere in the document', () => {
    const xml = "<?xml version='1.0' ?><DataList><!-- hi --></DataList>";
    expect(() => parseTaiwanJobsXml(xml)).toThrow('comments are forbidden');
  });

  it('rejects attributes on any element', () => {
    const xml = "<?xml version='1.0' ?><DataList foo=\"bar\"></DataList>";
    expect(() => parseTaiwanJobsXml(xml)).toThrow('attributes are not allowed');
  });

  it('rejects a declared XML encoding other than UTF-8', () => {
    const xml = "<?xml version='1.0' encoding='big5' ?><DataList></DataList>";
    expect(() => parseTaiwanJobsXml(xml)).toThrow('only UTF-8 XML is supported');
  });

  it('accepts an explicit UTF-8 XML declaration', () => {
    const xml = "<?xml version='1.0' encoding='UTF-8' ?><DataList></DataList>";
    expect(parseTaiwanJobsXml(xml)).toEqual([]);
  });

  it('matches a field by its leading ASCII code even if the parenthetical label wording differs', () => {
    const xml =
      "<?xml version='1.0' ?><DataList><Data><OCCU_DESC（不同標籤）><![CDATA[前端工程師]]></OCCU_DESC（不同標籤）></Data></DataList>";
    expect(parseTaiwanJobsXml(xml)).toEqual([{ OCCU_DESC: '前端工程師' }]);
  });

  it('throws for truncated/unclosed XML', () => {
    expect(() => parseTaiwanJobsXml(fixture('list-malformed.xml'))).toThrow(
      'malformed or truncated',
    );
  });
});

describe('normalizeTaiwanJob', () => {
  function row(overrides: Partial<Record<string, string>> = {}): TaiwanJobRow {
    return {
      OCCU_DESC: '前端工程師',
      WK_TYPE: '全職',
      CJOB_NAME1: '資訊軟體',
      CJOB_NAME2: '軟體工程師',
      JOB_PERSON: '1',
      STOP_DATE: '20261231',
      JOB_DETAIL: '測試內容',
      CITYNAME: '台北市信義區',
      EXPERIENCE: '不拘',
      WKTIME: '日班',
      SALARYCD: '月薪',
      NT_L: '40000',
      NT_U: '50000',
      EDGRDESC: '大學',
      URL_QUERY:
        'https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=1&HIRE_ID=2',
      COMPNAME: '範例科技股份有限公司',
      TRANDATE: '20260905',
      ...overrides,
    };
  }

  it('drops a row whose URL_QUERY points outside the official apply origin', () => {
    expect(
      normalizeTaiwanJob(
        row({ URL_QUERY: 'https://evil.example.com/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=1&HIRE_ID=2' }),
        null,
      ),
    ).toBeNull();
  });

  it('drops a row missing a title or company', () => {
    expect(normalizeTaiwanJob(row({ OCCU_DESC: '' }), null)).toBeNull();
    expect(normalizeTaiwanJob(row({ COMPNAME: '' }), null)).toBeNull();
  });

  it.each([
    ['年薪', 'annual'],
    ['月薪', 'monthly'],
    ['週薪', 'weekly'],
    ['日薪', 'daily'],
    ['時薪', 'hourly'],
    ['論件計酬', null],
    ['', null],
  ])('maps SALARYCD %s to salaryPeriod %s', (salarycd, expected) => {
    const vacancy = normalizeTaiwanJob(row({ SALARYCD: salarycd }), null);
    expect(vacancy?.salaryPeriod).toBe(expected);
  });

  it('never reports a currency or period without a parsed salary minimum', () => {
    const vacancy = normalizeTaiwanJob(row({ NT_L: '', SALARYCD: '月薪' }), null);
    expect(vacancy?.currency).toBeNull();
    expect(vacancy?.salaryPeriod).toBeNull();
    expect(vacancy?.advertisedMinimum).toBeNull();
  });
});
