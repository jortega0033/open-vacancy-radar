import { describe, expect, it } from 'vitest';

import {
  createExcludedCompanyMatcher,
  domainAliasProblem,
  findExcludedCompany,
  normalizeCompanyName,
  normalizeDomainAlias,
  type ExcludedCompany,
  ATS_APEX_HOSTS,
} from '../../src/companies/excluded-companies.js';
import { FREEHIRE_ATS_HOSTS } from '../../src/global-remote/structured-discovery.js';

const ACME: ExcludedCompany = { name: 'Acme', domains: ['acme.com'] };

describe('excluded companies (#736): name matching', () => {
  it('is case-insensitive and ignores legal-form suffixes', () => {
    for (const spelling of ['Acme B.V.', 'Acme BV', 'ACME Inc.', 'acme inc', 'Acme GmbH', 'Acme S.r.l.', 'Acme SRL', 'Acme Ltd.', 'Acme LLC', 'Acme, Inc.']) {
      expect(findExcludedCompany({ company: spelling }, [ACME]), spelling).toEqual(ACME);
    }
  });

  it('matches when the person typed the suffix and the vacancy did not, and the other way round', () => {
    expect(findExcludedCompany({ company: 'Acme' }, [{ name: 'Acme B.V.', domains: [] }])).not.toBeNull();
    expect(findExcludedCompany({ company: 'Acme Pty Ltd' }, [{ name: 'acme', domains: [] }])).not.toBeNull();
  });

  it('strips compound and less common legal forms (review follow-up)', () => {
    for (const spelling of ['Acme GmbH & Co. KG', 'Acme & Co.', 'Acme SE', 'Acme S.A.S.', 'Acme KGaA', 'Acme Ltda', 'Acme LP']) {
      expect(normalizeCompanyName(spelling), spelling).toBe('acme');
    }
    expect(findExcludedCompany({ company: 'Zalando SE' }, [{ name: 'Zalando', domains: [] }])).not.toBeNull();
  });

  it('treats names that differ only by a legal form as one company, deliberately', () => {
    // Excluding "Jones & Co" also hides "Jones", and the reverse: an exclusion means every entity of that name.
    expect(findExcludedCompany({ company: 'Jones' }, [{ name: 'Jones & Co', domains: [] }])).not.toBeNull();
    expect(findExcludedCompany({ company: 'Jones & Co' }, [{ name: 'Jones', domains: [] }])).not.toBeNull();
  });

  it('never matches a substring or a longer name', () => {
    expect(findExcludedCompany({ company: 'Metaplanet' }, [{ name: 'Meta', domains: [] }])).toBeNull();
    expect(findExcludedCompany({ company: 'Acme Group' }, [ACME])).toBeNull();
    expect(findExcludedCompany({ company: 'Acme' }, [{ name: 'Acme Group', domains: [] }])).toBeNull();
  });

  it('folds diacritics, ampersands and punctuation', () => {
    expect(findExcludedCompany({ company: 'Müller & Söhne GmbH' }, [{ name: 'Muller and Sohne', domains: [] }])).not.toBeNull();
    expect(normalizeCompanyName('  North-Star   Tech., S.A. ')).toBe('north star tech');
  });

  it('keeps a name that is only a legal form, and strips at most two trailing tokens', () => {
    expect(normalizeCompanyName('BV')).toBe('bv');
    expect(normalizeCompanyName('Acme Pty Ltd')).toBe('acme');
    expect(normalizeCompanyName('Acme Holding B.V. Inc')).toBe('acme holding');
  });

  it('an entry whose name is only punctuation never matches by name', () => {
    expect(findExcludedCompany({ company: '' }, [{ name: '...', domains: [] }])).toBeNull();
    expect(findExcludedCompany({ company: 'Anything' }, [{ name: '!!', domains: [] }])).toBeNull();
  });
});

describe('excluded companies (#736): which aliases may be stored', () => {
  it('accepts a company domain in any of the usual typed forms, path included', () => {
    for (const ok of ['acme.com', 'https://www.acme.com', 'careers.acme.co.uk', 'acme.com/', 'https://acme.com/careers']) {
      expect(domainAliasProblem(ok), ok).toBeNull();
    }
  });

  it('accepts an ATS tenant subdomain, which belongs to one company', () => {
    for (const ok of ['acme.recruitee.com', 'acme.teamtailor.com', 'acme.jobs.personio.de', 'acme.wd3.myworkdayjobs.com', 'acme.bamboohr.com']) {
      expect(domainAliasProblem(ok), ok).toBeNull();
    }
  });

  it('refuses what would match nothing or far too much', () => {
    expect(domainAliasProblem('acme')).toBe('not_a_domain');
    expect(domainAliasProblem('acme.com acme.nl')).toBe('not_a_domain');
    for (const shared of [
      'jobs.lever.co/acme',
      'https://boards.greenhouse.io/acme/jobs/1',
      'jobs.lever.co',
      'lever.co',
      'apply.workable.com',
      'career5.successfactors.eu',
      'fa-abcd.oraclecloud.com',
      'nl.linkedin.com',
      'jobs.personio.de',
      'jobs.personio.com',
      'wd3.myworkdayjobs.com',
      'eu.greenhouse.io',
      'myworkdaysite.com',
    ]) {
      expect(domainAliasProblem(shared), shared).toBe('shared_host');
    }
    expect(domainAliasProblem('co.uk')).toBe('public_suffix');
    expect(domainAliasProblem('com.au')).toBe('public_suffix');
  });

  it('refuses every bare ATS domain discovery knows about', () => {
    for (const host of FREEHIRE_ATS_HOSTS) {
      expect(ATS_APEX_HOSTS, host).toContain(host);
      expect(domainAliasProblem(host), host).toBe('shared_host');
    }
  });
});

describe('excluded companies (#736): domain aliases', () => {
  it('normalises what the person typed to a bare hostname', () => {
    expect(normalizeDomainAlias('https://www.Acme.com/jobs?x=1')).toBe('acme.com');
    expect(normalizeDomainAlias('careers.acme.com:443')).toBe('careers.acme.com');
    expect(normalizeDomainAlias('acme')).toBeNull();
    expect(normalizeDomainAlias('   ')).toBeNull();
  });

  it('handles long runs of dots in linear time (CodeQL js/polynomial-redos)', () => {
    const started = performance.now();
    expect(normalizeDomainAlias(`acme${'.'.repeat(100_000)}x`)).toBeNull();
    expect(normalizeDomainAlias(`acme.com${'.'.repeat(100_000)}`)).toBe('acme.com');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('matches the host and its subdomains, not an unrelated host that merely contains the alias', () => {
    const matcher = createExcludedCompanyMatcher([{ name: 'Northwind', domains: ['acme.com'] }]);
    expect(matcher({ company: 'Someone else', urls: ['https://careers.acme.com/jobs/1'] })).not.toBeNull();
    expect(matcher({ company: 'Someone else', urls: ['https://acme.com/jobs/1'] })).not.toBeNull();
    expect(matcher({ company: 'Someone else', urls: ['https://notacme.com/jobs/1'] })).toBeNull();
    expect(matcher({ company: 'Someone else', urls: ['https://acme.com.evil.example/jobs/1'] })).toBeNull();
  });

  it('does not treat an ATS host as the company, and ignores empty or unparsable URLs', () => {
    const matcher = createExcludedCompanyMatcher([ACME]);
    expect(matcher({ company: 'Other', urls: ['https://jobs.lever.co/acme/123'] })).toBeNull();
    expect(matcher({ company: 'Other', urls: [null, undefined, '', 'not a url'] })).toBeNull();
  });

  it('with an empty list, nothing is excluded', () => {
    expect(createExcludedCompanyMatcher([])({ company: 'Acme', urls: ['https://acme.com'] })).toBeNull();
  });
});
