import { describe, expect, it } from 'vitest';

import {
  ATS_ROSTER_PROVIDERS,
  atsRosterCsvUrl,
  parseAtsRosterCsv,
} from '../../src/companies/ats-roster-source.js';

describe('ATS_ROSTER_PROVIDERS', () => {
  it('is scoped to exactly the five providers issue #251 covers, excluding Rippling (#147)', () => {
    expect(ATS_ROSTER_PROVIDERS).toEqual(['greenhouse', 'lever', 'ashby', 'recruitee', 'personio']);
  });
});

describe('atsRosterCsvUrl', () => {
  it('builds the storage.stapply.ai mirror URL cited in issue #251', () => {
    expect(atsRosterCsvUrl('greenhouse')).toBe('https://storage.stapply.ai/jobhive/v1/greenhouse/companies.csv');
    expect(atsRosterCsvUrl('personio')).toBe('https://storage.stapply.ai/jobhive/v1/personio/companies.csv');
  });
});

describe('parseAtsRosterCsv', () => {
  it('parses a Greenhouse export, deriving boardIdentifier/baseUrl from the url column via detectGreenhouseSource', () => {
    const csv = [
      'name,slug,url',
      'Acme Corp,acme,https://job-boards.greenhouse.io/acme',
      'Widgets Inc,widgets,https://job-boards.greenhouse.io/widgets',
    ].join('\n');

    const result = parseAtsRosterCsv(csv, 'greenhouse');

    expect(result).toMatchObject({ rawRowCount: 2, invalidRowCount: 0, duplicateRowCount: 0 });
    expect(result.entries).toEqual([
      { provider: 'greenhouse', slug: 'acme', baseUrl: 'https://job-boards.greenhouse.io', company: 'Acme Corp' },
      { provider: 'greenhouse', slug: 'widgets', baseUrl: 'https://job-boards.greenhouse.io', company: 'Widgets Inc' },
    ]);
  });

  it('handles a quoted company name containing a comma, matching the observed source shape', () => {
    const csv = [
      'name,slug,url',
      '"ETCH, Inc",etchinc,https://job-boards.greenhouse.io/etchinc',
    ].join('\n');

    const result = parseAtsRosterCsv(csv, 'greenhouse');

    expect(result.entries).toEqual([
      { provider: 'greenhouse', slug: 'etchinc', baseUrl: 'https://job-boards.greenhouse.io', company: 'ETCH, Inc' },
    ]);
  });

  it('drops a row whose url does not match the provider (dead/malformed export row), counting it invalid', () => {
    const csv = [
      'name,slug,url',
      'Acme Corp,acme,https://job-boards.greenhouse.io/acme',
      'Bad Row,bad,not-a-url',
      'Wrong Provider,other,https://jobs.lever.co/other',
    ].join('\n');

    const result = parseAtsRosterCsv(csv, 'greenhouse');

    expect(result.entries).toHaveLength(1);
    expect(result.invalidRowCount).toBe(2);
  });

  it('deduplicates by the detected board identifier, not the raw slug column', () => {
    const csv = [
      'name,slug,url',
      'Acme Corp,acme,https://job-boards.greenhouse.io/acme',
      'Acme Corp Duplicate,ACME,https://job-boards.greenhouse.io/acme',
    ].join('\n');

    const result = parseAtsRosterCsv(csv, 'greenhouse');

    expect(result.entries).toHaveLength(1);
    expect(result.duplicateRowCount).toBe(1);
  });

  it('resolves the correct Lever region host (EU vs default) from the url column', () => {
    const csv = [
      'name,slug,url',
      'Acme Corp,acme,https://jobs.lever.co/acme',
      'Acme EU,acme-eu,https://jobs.eu.lever.co/acme-eu',
    ].join('\n');

    const result = parseAtsRosterCsv(csv, 'lever');

    expect(result.entries).toEqual([
      { provider: 'lever', slug: 'acme', baseUrl: 'https://jobs.lever.co', company: 'Acme Corp' },
      { provider: 'lever', slug: 'acme-eu', baseUrl: 'https://jobs.eu.lever.co', company: 'Acme EU' },
    ]);
  });

  it('resolves the correct Personio tenant host (.com vs .de) from the url column', () => {
    const csv = [
      'name,slug,url',
      'Acme Corp,acme,https://acme.jobs.personio.com',
      'Acme DE,acme-de,https://acme-de.jobs.personio.de',
    ].join('\n');

    const result = parseAtsRosterCsv(csv, 'personio');

    expect(result.entries).toEqual([
      { provider: 'personio', slug: 'acme', baseUrl: 'https://acme.jobs.personio.com', company: 'Acme Corp' },
      { provider: 'personio', slug: 'acme-de', baseUrl: 'https://acme-de.jobs.personio.de', company: 'Acme DE' },
    ]);
  });

  it('parses an Ashby export', () => {
    const csv = ['name,slug,url', 'OpenAI,openai,https://jobs.ashbyhq.com/openai'].join('\n');

    const result = parseAtsRosterCsv(csv, 'ashby');

    expect(result.entries).toEqual([
      { provider: 'ashby', slug: 'openai', baseUrl: 'https://jobs.ashbyhq.com', company: 'OpenAI' },
    ]);
  });

  it('parses a Recruitee export', () => {
    const csv = ['name,slug,url', 'Biovian,biovian,https://biovian.recruitee.com'].join('\n');

    const result = parseAtsRosterCsv(csv, 'recruitee');

    expect(result.entries).toEqual([
      { provider: 'recruitee', slug: 'biovian', baseUrl: 'https://biovian.recruitee.com', company: 'Biovian' },
    ]);
  });

  it('never produces an entry with a country field, by construction of AtsRosterEntry', () => {
    const csv = [
      'name,slug,url',
      'Acme Corp,acme,https://job-boards.greenhouse.io/acme',
    ].join('\n');

    const result = parseAtsRosterCsv(csv, 'greenhouse');

    expect(result.entries).toHaveLength(1);
    expect(Object.keys(result.entries[0]!).sort()).toEqual(['baseUrl', 'company', 'provider', 'slug']);
  });

  it('tolerates a header-less CSV body (defensive: only skips a recognized header row)', () => {
    const csv = 'Acme Corp,acme,https://job-boards.greenhouse.io/acme';

    const result = parseAtsRosterCsv(csv, 'greenhouse');

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ slug: 'acme' });
  });
});
