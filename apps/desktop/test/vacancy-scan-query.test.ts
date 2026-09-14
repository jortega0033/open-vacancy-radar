import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { describe, expect, it } from 'vitest';
import { parseVacancyScanRequest, requiredScanQuery, scheduledScanQueryFromProfile } from '../electron/vacancy-scan-query.js';

const ELECTRON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron');

function source(file: string): string {
  return readFileSync(join(ELECTRON_DIR, file), 'utf8');
}

const EMPTY_PROFILE: CandidateProfile = {
  profileVersion: 'test',
  candidateName: '',
  currentRole: '',
  location: '',
  experienceYears: 0,
  strongestSkills: [],
  additionalSkills: [],
  targetRoles: [],
  consideredRoles: [],
  excludedRoleFamilies: [],
  constraints: {
    professionalLanguage: '',
    dutchRequired: false,
    primaryCountry: '',
    allowRemoteEuSupportingNetherlands: false,
    minimumMonthlyBaseEur: 0,
  },
};

describe('requiredScanQuery', () => {
  it('rejects blank, whitespace-only, and non-string values', () => {
    for (const input of ['', '   ', null, undefined, 42, { query: 'frontend' }, ['frontend']]) {
      expect(() => requiredScanQuery(input)).toThrow('Add a role or keyword before starting a new worldwide scan.');
    }
  });

  it('trims valid queries before vacancy discovery receives them', () => {
    expect(requiredScanQuery('  frontend engineer  ')).toBe('frontend engineer');
  });

  it('guards the IPC argument before main process scan setup can initialize the engine', () => {
    expect(source('main.ts')).toMatch(
      /guardedIpc\.handle\(\s*'vacancy:run-scan'[\s\S]*runVacancyScan\(parseVacancyScanRequest\(request\)\)/,
    );
  });

  it('parses focused criteria and rejects malformed IPC payloads before scanning', () => {
    expect(parseVacancyScanRequest({
      mode: 'query', query: '  frontend  ', country: ' Netherlands ', employment: ' full_time ',
    })).toEqual({ mode: 'query', query: 'frontend', country: 'Netherlands', employment: 'full_time' });
    expect(parseVacancyScanRequest({ mode: 'browse_all' })).toEqual({ mode: 'browse_all' });
    expect(() => parseVacancyScanRequest({ mode: 'query', query: 'frontend', country: 42 })).toThrow('Country must be a string.');
    expect(parseVacancyScanRequest({
      mode: 'query', query: 'frontend', salary: { minimumAnnual: '60 000', currency: 'eur' },
    })).toEqual({
      mode: 'query', query: 'frontend', salary: { minimumAnnual: 60_000, currency: 'EUR', includeUnknown: true },
    });
    expect(() => parseVacancyScanRequest({
      mode: 'query', query: 'frontend', salary: { minimumAnnual: '1,234', currency: 'EUR' },
    })).toThrow();
  });
});

describe('scheduledScanQueryFromProfile', () => {
  it('uses the first saved target role as the upstream narrowing signal', () => {
    expect(
      scheduledScanQueryFromProfile({
        ...EMPTY_PROFILE,
        targetRoles: ['  Frontend Engineer  ', 'Backend Engineer'],
        strongestSkills: ['React'],
      }),
    ).toBe('Frontend Engineer');
  });

  it('falls back to the first saved strongest skill when no target role is set', () => {
    expect(
      scheduledScanQueryFromProfile({
        ...EMPTY_PROFILE,
        strongestSkills: ['  TypeScript  ', 'React'],
      }),
    ).toBe('TypeScript');
  });

  it('skips safely when the saved profile has no role or keyword', () => {
    expect(
      scheduledScanQueryFromProfile({
        ...EMPTY_PROFILE,
        currentRole: 'Staff Engineer',
        consideredRoles: ['Engineering Manager'],
      }),
    ).toBeNull();
  });

  it('keeps scheduled scans wired when a saved role or keyword exists', () => {
    expect(source('main.ts')).toMatch(
      /scheduledScanQueryFromProfile\(profile\)[\s\S]*runVacancyScan\(\{ mode: 'query', query \}\)[\s\S]*isExpectedScanBusyError\(error\)/,
    );
  });
});
