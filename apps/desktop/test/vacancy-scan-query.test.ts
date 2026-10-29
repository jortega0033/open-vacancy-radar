import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { describe, expect, it } from 'vitest';
import { parseVacancyScanRequest, requiredScanQuery, scheduledScanQueryFromProfile, selectBackgroundScan } from '../electron/vacancy-scan-query.js';

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

  it('parses aiWebDiscovery on both the query and browse_all arms, omitting it entirely by default (issue #398)', () => {
    // Omitted (or absent) -- the true no-op shape: identical to a request from before this feature
    // existed, protecting every scan test that never mentions this field.
    expect(parseVacancyScanRequest({ mode: 'query', query: 'frontend' })).toEqual({
      mode: 'query', query: 'frontend',
    });
    expect(parseVacancyScanRequest({ mode: 'browse_all' })).toEqual({ mode: 'browse_all' });

    expect(parseVacancyScanRequest({ mode: 'query', query: 'frontend', aiWebDiscovery: true })).toEqual({
      mode: 'query', query: 'frontend', aiWebDiscovery: true,
    });
    expect(parseVacancyScanRequest({ mode: 'query', query: 'frontend', aiWebDiscovery: false })).toEqual({
      mode: 'query', query: 'frontend', aiWebDiscovery: false,
    });
    expect(parseVacancyScanRequest({ mode: 'browse_all', aiWebDiscovery: true })).toEqual({
      mode: 'browse_all', aiWebDiscovery: true,
    });
    expect(() => parseVacancyScanRequest({ mode: 'query', query: 'frontend', aiWebDiscovery: 'yes' })).toThrow(
      'AI web discovery must be a boolean.',
    );
    expect(() => parseVacancyScanRequest({ mode: 'browse_all', aiWebDiscovery: 'yes' })).toThrow(
      'AI web discovery must be a boolean.',
    );
  });

  it('runs the AI web discovery pass only inside the already-acquired scan guard, and never at all unless explicitly requested (issue #398)', () => {
    // The AI branch is reached only through `runVacancyScanBranches`, which skips it unless the run
    // asked for it (executed in vacancy-scan-orchestration.test.ts). Since #685 the run lifecycle
    // lives in vacancy-scan-run.ts (executed in vacancy-scan-run.test.ts): that call sits inside
    // `runExclusiveScan`'s own callback, never wrapping or preceding the acquisition of that guard,
    // and main.ts only supplies the AI client to it.
    expect(source('vacancy-scan-run.ts')).toMatch(
      /deps\.runExclusiveScan\(async \(\) => \{[\s\S]*runVacancyScanBranches\(/,
    );
    expect(source('main.ts')).toMatch(
      /createVacancyScanRunner\(\{[\s\S]*runExclusiveScan: \(run\) => runExclusiveScan\(run, \{ takeAdvisoryLock: true \}\)[\s\S]*runAiWebDiscovery: \(options\) => runAiWebDiscovery\(client, options\)/,
    );
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
      /backgroundScanSelection\(\)[\s\S]*runVacancyScan\(\{[\s\S]*query: selection\.query,[\s\S]*useSearchPlan: true[\s\S]*isExpectedScanBusyError\(error\)/,
    );
  });
});

describe('search plan request and background selection (#686)', () => {
  it('keeps useSearchPlan only when it is explicitly true, so a literal request is unchanged', () => {
    expect(parseVacancyScanRequest({ mode: 'query', query: 'UI engineer', useSearchPlan: true })).toEqual({
      mode: 'query',
      query: 'UI engineer',
      useSearchPlan: true,
    });
    expect(parseVacancyScanRequest({ mode: 'query', query: 'UI engineer', useSearchPlan: false })).toEqual({
      mode: 'query',
      query: 'UI engineer',
    });
    expect(() => parseVacancyScanRequest({ mode: 'query', query: 'UI engineer', useSearchPlan: 'yes' })).toThrow('Search plan must be a boolean.');
    expect(parseVacancyScanRequest({ mode: 'browse_all', ...({ useSearchPlan: true } as object) })).toEqual({ mode: 'browse_all' });
  });

  it('selects the first approved plan title for the one background scan, else the first saved role', () => {
    const profile = { ...EMPTY_PROFILE, targetRoles: ['Backend Engineer', 'Data Engineer'] };
    const variant = (title: string) => ({ id: title, title, language: '', origin: 'user' as const });
    expect(selectBackgroundScan(profile, { variants: [variant('  React developer '), variant('UI engineer')] })).toEqual({
      query: 'React developer',
      useSearchPlan: true,
    });
    expect(selectBackgroundScan(profile, { variants: [] })).toEqual({ query: 'Backend Engineer', useSearchPlan: false });
    expect(selectBackgroundScan(profile, null)).toEqual({ query: 'Backend Engineer', useSearchPlan: false });
    expect(selectBackgroundScan(EMPTY_PROFILE, null)).toBeNull();
  });
});
