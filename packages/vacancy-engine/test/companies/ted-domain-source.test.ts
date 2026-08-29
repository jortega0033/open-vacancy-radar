import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildTedWinnerSearchRequest,
  fetchTedDomainEvidence,
  parseTedDomainPage,
  TED_SEARCH_URL,
} from '../../src/companies/ted-domain-source.js';
import { FixtureHttpClient, jsonPostFixtureKey } from '../ats/helpers.js';

async function fixture(name: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), `test/fixtures/companies/${name}`), 'utf8');
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('TED winner domain source', () => {
  it('only pairs a website when a notice identifies one exact Dutch KVK and legal name', async () => {
    const result = parseTedDomainPage(
      JSON.parse(await fixture('ted-winner-page-1.json')) as unknown,
    );

    expect(result).toMatchObject({
      noticeCount: 6,
      eligibleSingletonNoticeCount: 3,
      invalidIdentifierCount: 1,
      ambiguousPairingCount: 1,
      invalidUrlCount: 1,
      incompleteRecordCount: 1,
    });
    expect(result.evidence).toEqual([
      expect.objectContaining({
        source: 'ted',
        sourceRecordId: '1726-2024:winner:08053410',
        sourceName: 'Achmea Schadeverzekeringen N.V.',
        kvkNumber: '08053410',
        officialUrl: 'https://www.achmea.nl/',
        hostnameKey: 'achmea.nl',
        evidenceUrl: 'https://ted.europa.eu/en/notice/-/detail/1726-2024',
      }),
      expect.objectContaining({
        sourceRecordId: 'bare-url-2024:winner:01234567',
        kvkNumber: '01234567',
        officialUrl: 'https://www.acme.nl/',
      }),
    ]);
  });

  it('uses bounded year-partitioned page-number queries through the safe JSON POST seam', async () => {
    const firstRequest = buildTedWinnerSearchRequest(2024, 1, 6);
    const secondRequest = buildTedWinnerSearchRequest(2024, 2, 6);
    const http = new FixtureHttpClient(
      new Map([
        [jsonPostFixtureKey(TED_SEARCH_URL, firstRequest), await fixture('ted-winner-page-1.json')],
        [jsonPostFixtureKey(TED_SEARCH_URL, secondRequest), await fixture('ted-winner-page-2.json')],
      ]),
    );

    const result = await fetchTedDomainEvidence(http, {
      startYear: 2024,
      endYear: 2024,
      pageSize: 6,
      pageDelayMs: 0,
    });

    expect(result).toMatchObject({
      pagesFetched: 2,
      reportedNoticeCount: 7,
      noticeCount: 7,
      eligibleSingletonNoticeCount: 4,
    });
    expect(result.evidence).toHaveLength(3);
    expect(http.requestedUrls).toEqual([TED_SEARCH_URL, TED_SEARCH_URL]);
    expect(http.requestedJsonBodies).toEqual([firstRequest, secondRequest]);
    expect(http.requestedOptions).toEqual([
      { allowedOrigins: ['https://api.ted.europa.eu'] },
      { allowedOrigins: ['https://api.ted.europa.eu'] },
    ]);
  });

  it('reuses a fresh, validated snapshot without repeating the public API pages', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ind-job-radar-ted-'));
    temporaryDirectories.push(root);
    const snapshotPath = path.join(root, 'ted-snapshot.json');
    const firstRequest = buildTedWinnerSearchRequest(2024, 1, 6);
    const secondRequest = buildTedWinnerSearchRequest(2024, 2, 6);
    const liveHttp = new FixtureHttpClient(
      new Map([
        [jsonPostFixtureKey(TED_SEARCH_URL, firstRequest), await fixture('ted-winner-page-1.json')],
        [jsonPostFixtureKey(TED_SEARCH_URL, secondRequest), await fixture('ted-winner-page-2.json')],
      ]),
    );
    const common = {
      startYear: 2024,
      endYear: 2024,
      pageSize: 6,
      pageDelayMs: 0,
      snapshotPath,
    } as const;
    const live = await fetchTedDomainEvidence(liveHttp, {
      ...common,
      now: new Date('2026-08-28T18:00:00.000Z'),
    });

    const cachedHttp = new FixtureHttpClient(new Map());
    const cached = await fetchTedDomainEvidence(cachedHttp, {
      ...common,
      now: new Date('2026-08-29T18:00:00.000Z'),
    });

    expect(cached).toEqual(live);
    expect(cachedHttp.requestedUrls).toEqual([]);
  });

  it('rejects timed-out responses instead of accepting an incomplete bulk result', () => {
    expect(() =>
      parseTedDomainPage({
        notices: [],
        totalNoticeCount: 1,
        iterationNextToken: null,
        timedOut: true,
      }),
    ).toThrow(/search response timed out/u);
  });
});
