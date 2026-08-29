import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CompanyDomainCandidateFile } from '../../src/companies/domain-candidates.js';
import type { WikidataDomainOutcome } from '../../src/companies/wikidata-domain-source.js';
import {
  mergeWikidataCandidates,
  WIKIDATA_CANDIDATE_SOURCE,
  writeDomainCandidateCatalog,
} from '../../src/pipeline/company-domain-enrichment.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const current: CompanyDomainCandidateFile = {
  version: 'manual-v1',
  verifiedAt: '2026-08-20T00:00:00.000Z',
  candidates: [
    {
      legalName: 'Curated B.V.',
      kvkNumber: '11111111',
      brandName: 'Curated',
      officialUrl: 'https://curated.test/',
      confidence: 'high',
      source: 'manual-official-review',
      evidenceUrls: ['https://curated.test/legal'],
      priority: 90,
    },
  ],
};

function candidateOutcome(overrides: Partial<WikidataDomainOutcome> = {}): WikidataDomainOutcome {
  return {
    sponsorId: 'sponsor-2',
    status: 'candidate',
    reasonCode: 'wikidata_exact_kvk_single_official_host',
    candidate: {
      sponsorId: 'sponsor-2',
      legalName: 'Structured B.V.',
      kvkNumber: '22222222',
      officialUrl: 'https://structured.test/',
      wikidataItems: ['https://www.wikidata.org/entity/Q2'],
    },
    ...overrides,
  } as WikidataDomainOutcome;
}

describe('structured domain candidate catalog', () => {
  it('preserves manually reviewed entries and replaces generated entries by exact identity', () => {
    const withOldGenerated: CompanyDomainCandidateFile = {
      ...current,
      candidates: [
        ...current.candidates,
        {
          legalName: 'Old Generated B.V.',
          kvkNumber: '33333333',
          brandName: 'Old Generated',
          officialUrl: 'https://old.test/',
          confidence: 'high',
          source: WIKIDATA_CANDIDATE_SOURCE,
          evidenceUrls: ['https://www.wikidata.org/entity/Q3'],
          priority: 40,
        },
      ],
    };
    const merged = mergeWikidataCandidates(
      withOldGenerated,
      [candidateOutcome()],
      new Date('2026-08-28T12:00:00.000Z'),
    );

    expect(merged.candidates).toHaveLength(2);
    expect(merged.candidates.map(({ kvkNumber }) => kvkNumber)).toEqual(['11111111', '22222222']);
    expect(merged.candidates[1]).toMatchObject({
      source: WIKIDATA_CANDIDATE_SOURCE,
      confidence: 'high',
      priority: 40,
    });
  });

  it('never replaces a manually reviewed identity with a structured candidate', () => {
    const merged = mergeWikidataCandidates(
      current,
      [
        candidateOutcome({
          candidate: {
            sponsorId: 'sponsor-1',
            legalName: 'Curated B.V.',
            kvkNumber: '11111111',
            officialUrl: 'https://conflict.test/',
            wikidataItems: ['https://www.wikidata.org/entity/Q1'],
          },
        }),
      ],
      new Date('2026-08-28T12:00:00.000Z'),
    );

    expect(merged.candidates).toEqual(current.candidates);
  });

  it('writes a validated catalog atomically inside the project root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ind-job-radar-domain-'));
    temporaryDirectories.push(root);
    const merged = mergeWikidataCandidates(
      current,
      [candidateOutcome()],
      new Date('2026-08-28T12:00:00.000Z'),
    );
    const output = await writeDomainCandidateCatalog(merged, 'config/candidates.json', root);

    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(merged);
    await expect(writeDomainCandidateCatalog(merged, '../outside.json', root)).rejects.toThrow(
      'must remain inside',
    );
  });
});
