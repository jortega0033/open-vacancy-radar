import { describe, expect, it } from 'vitest';

import { ATS_CAPABILITIES } from '../../src/ats/capabilities.js';
import {
  detectAtsSource,
  detectAshbySource,
  detectGreenhouseSource,
  detectLeverSource,
  detectRecruiteeSource,
  detectSmartRecruitersSource,
  detectTeamtailorSource,
  detectWorkdaySource,
  parseWorkdayBoard,
} from '../../src/ats/detection.js';

describe('ATS provider URL detection', () => {
  it('extracts only identifiers present in known provider URLs', () => {
    expect(detectAshbySource('https://jobs.ashbyhq.com/acme/job-1')).toEqual({
      provider: 'ashby',
      boardIdentifier: 'acme',
      baseUrl: 'https://jobs.ashbyhq.com',
    });
    expect(
      detectAshbySource('https://api.ashbyhq.com/posting-api/job-board/acme'),
    ).toMatchObject({ provider: 'ashby', boardIdentifier: 'acme' });
    expect(detectGreenhouseSource('https://job-boards.greenhouse.io/acme/jobs/1')).toMatchObject({
      provider: 'greenhouse',
      boardIdentifier: 'acme',
    });
    expect(detectGreenhouseSource('https://boards.greenhouse.io/embed/job_board/js?for=exact-token')).toMatchObject({
      boardIdentifier: 'exact-token',
    });
    expect(detectLeverSource('https://jobs.eu.lever.co/acme/lever-1')).toEqual({
      provider: 'lever',
      boardIdentifier: 'acme',
      baseUrl: 'https://jobs.eu.lever.co',
    });
    expect(detectRecruiteeSource('https://acme.recruitee.com/o/backend')).toMatchObject({
      provider: 'recruitee',
      boardIdentifier: 'acme',
    });
    expect(detectTeamtailorSource('https://acme.teamtailor.com/jobs?department=engineering')).toEqual({
      provider: 'teamtailor',
      boardIdentifier: 'https://acme.teamtailor.com/jobs.rss',
      baseUrl: 'https://acme.teamtailor.com',
    });
    expect(detectSmartRecruitersSource('https://careers.smartrecruiters.com/Acme')).toMatchObject({
      provider: 'smartrecruiters',
      boardIdentifier: 'Acme',
    });
    expect(
      detectWorkdaySource(
        'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Netherlands/Role_R-1',
      ),
    ).toEqual({
      provider: 'workday',
      boardIdentifier: 'External',
      baseUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/External',
    });
  });

  it('parses canonical Workday board, CXS list, and detail endpoint coordinates', () => {
    expect(
      parseWorkdayBoard(
        'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Netherlands/Role_R-1',
      ),
    ).toEqual({
      origin: 'https://acme.wd5.myworkdayjobs.com',
      tenant: 'acme',
      shard: 'wd5',
      locale: 'en-US',
      site: 'External',
      boardUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/External',
      listUrl: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
      detailPrefix: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External',
    });
    expect(
      parseWorkdayBoard(
        'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
      ),
    ).toMatchObject({ locale: null, site: 'External' });
    expect(
      detectAtsSource('https://acme.wd5.myworkdayjobs.com/External'),
    ).toMatchObject({ provider: 'workday', boardIdentifier: 'External' });
  });

  it('does not guess providers or custom-domain board identifiers', () => {
    expect(detectAtsSource('https://careers.example.com/jobs')).toBeNull();
    expect(detectTeamtailorSource('https://careers.example.com/jobs')).toBeNull();
    expect(detectRecruiteeSource('https://recruitee.com/acme')).toBeNull();
    expect(detectWorkdaySource('http://acme.wd5.myworkdayjobs.com/External')).toBeNull();
    expect(
      detectWorkdaySource(
        'https://acme.wd5.myworkdayjobs.com/wday/cxs/another-tenant/External/jobs',
      ),
    ).toBeNull();
    expect(detectWorkdaySource('https://careers.example.com/External')).toBeNull();
  });
});

describe('ATS capability metadata', () => {
  it('claims the official Ashby public posting API as production support', () => {
    expect(ATS_CAPABILITIES.find((capability) => capability.provider === 'ashby')).toMatchObject({
      status: 'supported',
      productionAdapter: true,
    });
  });

  it('claims the bounded official-site JSON-LD path as a production fallback', () => {
    expect(ATS_CAPABILITIES.find((capability) => capability.provider === 'json_ld')).toMatchObject({
      status: 'fallback',
      productionAdapter: true,
    });
  });

  it('claims the bounded public Workday CXS adapter as production support', () => {
    expect(ATS_CAPABILITIES.find((capability) => capability.provider === 'workday')).toMatchObject({
      status: 'supported',
      productionAdapter: true,
      retrieval: 'public Workday CXS listing and detail JSON endpoints',
    });
  });

  it('does not claim production adapters for researched experimental providers', () => {
    for (const provider of ['personio', 'successfactors']) {
      expect(ATS_CAPABILITIES.find((capability) => capability.provider === provider)).toMatchObject({
        status: 'experimental',
        productionAdapter: false,
      });
    }
  });
});
