import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VACANCY_RUN_INTENT_VERSION,
  buildAiIntentProvenance,
  captureVacancyRunIntent,
  describeVacancyRunIntent,
  deterministicScanCriteria,
} from '../electron/vacancy-run-intent.js';
import { parseVacancyScanRequest } from '../electron/vacancy-scan-query.js';

const ELECTRON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron');
const CAPTURED_AT = new Date('2026-10-28T10:00:00.000Z');

function mainSource(): string {
  return readFileSync(join(ELECTRON_DIR, 'main.ts'), 'utf8');
}

describe('captureVacancyRunIntent', () => {
  it('captures the submitted criteria from the validated request, with a version and the scan id', () => {
    const request = parseVacancyScanRequest({
      mode: 'query',
      query: '  UI engineer  ',
      country: 'Germany',
      employment: 'full_time',
      salary: { minimumAnnual: '65000', currency: 'eur', includeUnknown: false },
      aiWebDiscovery: true,
    });
    const intent = captureVacancyRunIntent('scan-1', request, CAPTURED_AT);
    expect(intent).toEqual({
      version: VACANCY_RUN_INTENT_VERSION,
      scanId: 'scan-1',
      capturedAt: '2026-10-28T10:00:00.000Z',
      mode: 'query',
      query: 'UI engineer',
      country: 'Germany',
      employment: 'full_time',
      salary: { minimumAnnual: 65_000, currency: 'EUR', includeUnknown: false },
      aiWebDiscovery: true,
    });
  });

  it('keeps unsupplied criteria unknown instead of filling them in', () => {
    const intent = captureVacancyRunIntent('scan-2', parseVacancyScanRequest({ mode: 'query', query: 'UI engineer' }), CAPTURED_AT);
    expect(intent.country).toBeNull();
    expect(intent.employment).toBeNull();
    expect(intent.salary).toBeNull();
    expect(intent.aiWebDiscovery).toBe(false);
  });

  it('is deeply frozen, so neither the run nor a later edit can change it', () => {
    const request = parseVacancyScanRequest({
      mode: 'query',
      query: 'UI engineer',
      salary: { minimumAnnual: '65000', currency: 'EUR' },
    });
    const intent = captureVacancyRunIntent('scan-3', request, CAPTURED_AT);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.salary)).toBe(true);
    // Changing the request after capture does not reach the snapshot either.
    if (request.mode === 'query' && request.salary) request.salary.minimumAnnual = 1;
    expect(intent.salary?.minimumAnnual).toBe(65_000);
  });

  it('browse-all has no role, country, employment or salary', () => {
    const intent = captureVacancyRunIntent('scan-4', parseVacancyScanRequest({ mode: 'browse_all', aiWebDiscovery: true }), CAPTURED_AT);
    expect(intent).toMatchObject({ mode: 'browse_all', query: null, country: null, employment: null, salary: null, aiWebDiscovery: true });
  });

  it('caps the role phrase at the length the engine matches locally', () => {
    const intent = captureVacancyRunIntent('scan-5', parseVacancyScanRequest({ mode: 'query', query: 'a'.repeat(260) }), CAPTURED_AT);
    expect(intent.query).toHaveLength(200);
  });
});

describe('deterministicScanCriteria', () => {
  it('derives the deterministic branch criteria from the same snapshot', () => {
    const intent = captureVacancyRunIntent(
      'scan-6',
      parseVacancyScanRequest({
        mode: 'query',
        query: 'UI engineer',
        country: 'Germany',
        salary: { minimumAnnual: '65000', currency: 'EUR', includeUnknown: false },
      }),
      CAPTURED_AT,
    );
    expect(deterministicScanCriteria(intent, 5_000)).toEqual({
      query: 'UI engineer',
      country: 'Germany',
      salary: { minimumAnnual: 65_000, currency: 'EUR', includeUnknown: false },
    });
  });

  it('browse-all stays browse-all with the cap, whatever the saved profile holds', () => {
    const intent = captureVacancyRunIntent('scan-7', parseVacancyScanRequest({ mode: 'browse_all' }), CAPTURED_AT);
    expect(deterministicScanCriteria(intent, 5_000)).toEqual({ query: '', browseAll: true, browseAllResultCap: 5_000 });
  });
});

describe('describeVacancyRunIntent', () => {
  it('lists only what was submitted', () => {
    const intent = captureVacancyRunIntent(
      'scan-8',
      parseVacancyScanRequest({
        mode: 'query',
        query: 'UI engineer',
        country: 'Germany',
        salary: { minimumAnnual: '65000', currency: 'EUR', includeUnknown: false },
      }),
      CAPTURED_AT,
    );
    expect(describeVacancyRunIntent(intent)).toBe(
      'Role: UI engineer · Country: Germany · Minimum salary: EUR 65,000 a year, unknown salaries hidden',
    );
    expect(describeVacancyRunIntent(captureVacancyRunIntent('scan-9', parseVacancyScanRequest({ mode: 'query', query: 'UI engineer' }), CAPTURED_AT))).toBe(
      'Role: UI engineer',
    );
    expect(describeVacancyRunIntent(captureVacancyRunIntent('scan-10', parseVacancyScanRequest({ mode: 'browse_all' }), CAPTURED_AT))).toBe(
      'Browse all roles',
    );
  });
});

describe('buildAiIntentProvenance', () => {
  it('marks salary as unsupported pushdown and everything requested as locally enforced', () => {
    const intent = captureVacancyRunIntent(
      'scan-11',
      parseVacancyScanRequest({
        mode: 'query',
        query: 'UI engineer',
        employment: 'contract',
        salary: { minimumAnnual: '65000', currency: 'EUR' },
      }),
      CAPTURED_AT,
    );
    const provenance = buildAiIntentProvenance(intent, { skillCount: 3, experienceYearsIncluded: true, homeCountryIncluded: true });
    expect(provenance.criteria.role).toEqual({ requested: true, value: 'UI engineer', pushdown: 'prompt_guidance', enforcedLocally: true });
    expect(provenance.criteria.country).toEqual({ requested: false, value: null, pushdown: 'not_requested', enforcedLocally: false });
    expect(provenance.criteria.employment.pushdown).toBe('prompt_guidance');
    expect(provenance.criteria.salary).toMatchObject({ pushdown: 'unsupported', enforcedLocally: true });
    expect(provenance.candidateContext).toEqual({
      skillCount: 3,
      experienceYearsIncluded: true,
      homeCountryIncluded: true,
      savedTargetRolesSearched: false,
    });
  });
});

describe('main process wiring (#684)', () => {
  it('captures the intent before any saved profile is read and hands the same snapshot to both branches', () => {
    const main = mainSource();
    const capture = main.indexOf('captureVacancyRunIntent(scanId, request)');
    const profileRead = main.indexOf('await loadCandidateProfile(await candidateProfilePath())', capture);
    const aiCall = main.indexOf('runAiWebDiscovery(client, {');
    const deterministic = main.indexOf('...deterministicScanCriteria(intent, BROWSE_ALL_RESULT_CAP)');
    expect(capture).toBeGreaterThan(-1);
    expect(profileRead).toBeGreaterThan(capture);
    // The profile read that feeds the AI branch is the one right after the capture, inside this run.
    expect(main.slice(capture, aiCall)).toContain('await loadCandidateProfile(await candidateProfilePath())');
    expect(aiCall).toBeGreaterThan(profileRead);
    expect(deterministic).toBeGreaterThan(aiCall);
    expect(main).toMatch(/runAiWebDiscovery\(client, \{\s*profile,\s*intent,/u);
    // The AI gate reads the snapshot, not the raw request, and the request's criteria are no longer
    // read again after capture.
    expect(main).toContain('if (intent.aiWebDiscovery) {');
    expect(main).not.toMatch(/request\.(query|country|employment|salary)\b/u);
  });
});
