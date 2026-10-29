import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  approveSearchPlanDraft,
  captureSearchPlanSnapshot,
  EMPTY_SEARCH_PLAN,
  searchPlanDraftSchema,
} from '@open-vacancy-radar/vacancy-engine';
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
      searchPlan: null,
      searchPlanStatus: null,
    });
    // Version 2: the intent shape gained the plan and its status (#686).
    expect(intent.version).toBe(2);
  });

  it('records why a run that asked for the plan ran without one, and passes it to the engine (#686)', () => {
    const status = { state: 'empty_at_start' as const, message: 'Your search plan had no approved titles when this search started.' };
    const asked = captureVacancyRunIntent(
      'scan-empty',
      parseVacancyScanRequest({ mode: 'query', query: 'React developer', useSearchPlan: true }),
      CAPTURED_AT,
      null,
      status,
    );
    expect(asked.searchPlanStatus).toEqual(status);
    expect(Object.isFrozen(asked.searchPlanStatus)).toBe(true);
    expect(deterministicScanCriteria(asked, 5_000)).toEqual({ query: 'React developer', searchPlanStatus: status });
    expect(describeVacancyRunIntent(asked)).toBe('Role: React developer · Search plan: not used (see the notice on the results)');
    // A run that never asked for the plan never carries a plan status.
    const literal = captureVacancyRunIntent('scan-lit', parseVacancyScanRequest({ mode: 'query', query: 'React developer' }), CAPTURED_AT, null, status);
    expect(literal.searchPlanStatus).toBeNull();
  });

  it('carries the search plan only for a run that asked for it, and the plan is frozen with the intent (#686)', () => {
    const snapshot = captureSearchPlanSnapshot(
      approveSearchPlanDraft(
        EMPTY_SEARCH_PLAN,
        searchPlanDraftSchema.parse({ variants: [{ title: 'React developer' }, { title: 'UI engineer' }] }),
        CAPTURED_AT,
      ),
    );
    const asked = captureVacancyRunIntent(
      'scan-plan',
      parseVacancyScanRequest({ mode: 'query', query: 'React developer', useSearchPlan: true }),
      CAPTURED_AT,
      snapshot,
    );
    expect(asked.searchPlan).toBe(snapshot);
    expect(describeVacancyRunIntent(asked)).toBe('Role: React developer · Search plan: 2 approved titles (revision 1)');
    expect(deterministicScanCriteria(asked, 5_000)).toMatchObject({ query: 'React developer', searchPlan: snapshot });

    // A literal run never picks up a plan, even if one is passed in; browse-all never has one.
    const literal = captureVacancyRunIntent('scan-literal', parseVacancyScanRequest({ mode: 'query', query: 'React developer' }), CAPTURED_AT, snapshot);
    expect(literal.searchPlan).toBeNull();
    expect(Object.keys(deterministicScanCriteria(literal, 5_000))).not.toContain('searchPlan');
    expect(captureVacancyRunIntent('scan-all', parseVacancyScanRequest({ mode: 'browse_all' }), CAPTURED_AT, snapshot).searchPlan).toBeNull();
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

describe('unspecified-location country (#684)', () => {
  const provenanceFor = (country: string) =>
    buildAiIntentProvenance(
      captureVacancyRunIntent('scan-12', parseVacancyScanRequest({ mode: 'query', query: 'UI engineer', country }), CAPTURED_AT),
      { skillCount: 0, experienceYearsIncluded: false, homeCountryIncluded: false },
    ).criteria.country;

  it.each(['Unspecified location', 'unspecified location', '  UNSPECIFIED Location '])(
    'records %j as a local-only criterion, not prompt guidance',
    (country) => {
      expect(provenanceFor(country)).toMatchObject({ requested: true, pushdown: 'unsupported', enforcedLocally: true });
    },
  );

  it('keeps an ordinary country as prompt guidance', () => {
    expect(provenanceFor('Germany')).toEqual({ requested: true, value: 'Germany', pushdown: 'prompt_guidance', enforcedLocally: true });
    expect(provenanceFor('Unspecified')).toMatchObject({ pushdown: 'prompt_guidance' });
  });
});

describe('main process wiring (#684, #685)', () => {
  // The behaviour is covered by vacancy-scan-orchestration.test.ts and vacancy-scan-run.test.ts,
  // which run the real run lifecycle with fakes. This only checks that main.ts still routes every
  // scan through that lifecycle, which captures the snapshot.
  it('routes every scan through the run lifecycle that captures the intent snapshot', () => {
    const main = mainSource();
    expect(main).toMatch(/async function runVacancyScan\(request: ParsedVacancyScanRequest\)[^{]*\{\s*return vacancyScanRunner\.run\(request\);/u);
    expect(main).toMatch(/const vacancyScanRunner = createVacancyScanRunner\(/u);
    expect(main).not.toContain('runVacancyScanBranches(');
  });
});
