import { describe, expect, it } from 'vitest';

import {
  deriveWorkdayCareersFoundEvidence,
  WORKDAY_EVIDENCE_RECLASSIFICATION_POLICY_VERSION,
} from '../../src/companies/workday-backfill.js';

const candidate = {
  sponsorId: 'f57e4d45-5a2a-4756-ab94-68bbc86da291',
  legalName: 'Trafigura Beheer B.V.',
  officialUrl: 'https://www.trafigura.com/',
  officialHostname: 'www.trafigura.com',
  candidateSource: 'wikidata',
  candidateVersion: 'wikidata-kvk-domain-v1',
  candidateHash: 'a'.repeat(64),
  candidateVerifiedAt: new Date('2026-08-28T15:00:00.000Z'),
  confidence: 'high' as const,
  brandName: 'Trafigura Beheer B.V.',
  careersUrl: 'https://trafigura.wd3.myworkdayjobs.com/TrafiguraCareerSite',
  provider: 'workday',
};

function unsupportedAttempt(observedOnPage = 'https://www.trafigura.com/careers/') {
  return {
    id: 'afa8ec3c-0813-4f70-8fdb-4b19cf31e704',
    outcome: 'unsupported',
    officialUrl: candidate.officialUrl,
    candidateSource: candidate.candidateSource,
    candidateVersion: candidate.candidateVersion,
    candidateHash: candidate.candidateHash,
    inspectionPolicyVersion: 'official-company-discovery-v1',
    pagesInspected: 2,
    physicalRequestCount: 2,
    result: {
      status: 'unsupported',
      provider: 'workday',
      careersUrl: candidate.careersUrl,
      sourceBaseUrl: null,
      boardIdentifier: null,
      pagesInspected: 2,
      observations: [
        {
          element: 'anchor',
          provider: 'workday',
          observedUrl: candidate.careersUrl,
          observedOnPage,
          sourceBaseUrl: null,
          boardIdentifier: null,
        },
      ],
    },
    createdAt: new Date('2026-08-28T15:44:50.000Z'),
  };
}

describe('Workday evidence reclassification', () => {
  it('derives an exact promotable board while retaining the source attempt provenance', () => {
    const derived = deriveWorkdayCareersFoundEvidence(candidate, unsupportedAttempt());

    expect(derived.state).toMatchObject({
      provider: 'workday',
      sourceBaseUrl: 'https://trafigura.wd3.myworkdayjobs.com/TrafiguraCareerSite',
      boardIdentifier: 'TrafiguraCareerSite',
    });
    expect(derived.result).toMatchObject({
      status: 'careers_found',
      pagesInspected: 0,
      reclassification: {
        policyVersion: WORKDAY_EVIDENCE_RECLASSIFICATION_POLICY_VERSION,
        sourceAttemptId: 'afa8ec3c-0813-4f70-8fdb-4b19cf31e704',
        sourcePagesInspected: 2,
        sourcePhysicalRequestCount: 2,
        networkRequested: false,
      },
      observations: [
        {
          sourceBaseUrl: 'https://trafigura.wd3.myworkdayjobs.com/TrafiguraCareerSite',
          boardIdentifier: 'TrafiguraCareerSite',
        },
      ],
    });
  });

  it.each([
    {
      sponsorId: '1dcf7039-e012-43d9-8e9b-2e39075789d1',
      officialUrl: 'https://www.fugro.com/',
      officialHostname: 'www.fugro.com',
      observedOnPage: 'https://www.fugro.com/careers',
      careersUrl:
        'https://fugro.wd3.myworkdayjobs.com/en-US/Careers/login?redirect=%2Fen-US%2FCareers%2FjobAlerts',
      expectedBaseUrl: 'https://fugro.wd3.myworkdayjobs.com/en-US/Careers',
      expectedBoardIdentifier: 'Careers',
    },
    {
      sponsorId: '3ff7c959-35c4-4c99-a758-a6833f409d9a',
      officialUrl: 'https://www.artsenzondergrenzen.nl/',
      officialHostname: 'www.artsenzondergrenzen.nl',
      observedOnPage: 'https://www.artsenzondergrenzen.nl/werken-bij',
      careersUrl:
        'https://msfoca.wd103.myworkdayjobs.com/en-US/artsen_zonder_grenzen/job/Ebola-Emergency-Pool_JR826',
      expectedBaseUrl: 'https://msfoca.wd103.myworkdayjobs.com/en-US/artsen_zonder_grenzen',
      expectedBoardIdentifier: 'artsen_zonder_grenzen',
    },
  ])(
    'derives the preserved $careersUrl shape without fetching it',
    ({
      sponsorId,
      officialUrl,
      officialHostname,
      observedOnPage,
      careersUrl,
      expectedBaseUrl,
      expectedBoardIdentifier,
    }) => {
      const row = { ...candidate, sponsorId, officialUrl, officialHostname, careersUrl };
      const source = unsupportedAttempt(observedOnPage);
      const attempt = {
        ...source,
        officialUrl,
        result: {
          ...source.result,
          careersUrl,
          observations: [
            {
              element: 'anchor',
              provider: 'workday',
              observedUrl: careersUrl,
              observedOnPage,
              sourceBaseUrl: null,
              boardIdentifier: null,
            },
          ],
        },
      };

      expect(deriveWorkdayCareersFoundEvidence(row, attempt).state).toMatchObject({
        sourceBaseUrl: expectedBaseUrl,
        boardIdentifier: expectedBoardIdentifier,
      });
    },
  );

  it('rejects evidence that was not observed on the trusted official origin', () => {
    expect(() =>
      deriveWorkdayCareersFoundEvidence(
        candidate,
        unsupportedAttempt('https://unrelated.example/careers'),
      ),
    ).toThrow(/official origin/u);
  });
});
