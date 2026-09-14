import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AtsResponseError } from '../../src/ats/http.js';
import {
  classifyAtsSourceFailure,
  emptyAtsSourceObservationFile,
  loadAtsSourceObservations,
  parseAtsSourceObservationImport,
  planAtsRosterScan,
  recordAtsSourceObservation,
  writeAtsSourceObservations,
  type AtsSourceObservation,
} from '../../src/companies/ats-source-observation-repository.js';
import type { AtsRosterEntry } from '../../src/companies/ats-roster-source.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'ats-source-observations-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function entry(slug: string): AtsRosterEntry {
  return {
    provider: 'greenhouse',
    slug,
    baseUrl: 'https://job-boards.greenhouse.io',
    company: `${slug} Inc`,
  };
}

function observation(
  slug: string,
  overrides: Partial<AtsSourceObservation> = {},
): AtsSourceObservation {
  return {
    provider: 'greenhouse',
    slug,
    company: `${slug} Inc`,
    canonicalBoardUrl: `https://job-boards.greenhouse.io/${slug}`,
    lastAttemptAt: '2026-01-01T00:00:00.000Z',
    lastSuccessAt: '2026-01-01T00:00:00.000Z',
    status: 'verified',
    errorCategory: null,
    vacancyCount: 1,
    observedCountries: ['Netherlands'],
    observedRemoteScopes: [],
    observedRoleFamilies: ['frontend'],
    evidence: ['fixture'],
    decisionReason: 'fixture',
    consecutiveEmptyOrFailureCount: 0,
    nextDueAt: '2026-01-02T00:00:00.000Z',
    refreshTier: 'hot',
    promotedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ATS source observation persistence', () => {
  it('round-trips observations and cursor state across process restarts', async () => {
    const state = {
      ...emptyAtsSourceObservationFile(new Date('2026-01-03T00:00:00.000Z')),
      cursor: { nextIndex: 17, generation: 2 },
      observations: [observation('acme')],
    };

    await writeAtsSourceObservations(projectRoot, state);

    await expect(loadAtsSourceObservations(projectRoot)).resolves.toEqual(state);
  });

  it('migrates the legacy cursor and observations to the version 1 store', async () => {
    const file = join(projectRoot, '.data', 'ats-source-observations-v1.json');
    await mkdir(join(projectRoot, '.data'), { recursive: true });
    const legacyObservation = observation('acme');
    const {
      evidence: _evidence,
      decisionReason: _decisionReason,
      ...legacyFields
    } = legacyObservation;
    void _evidence;
    void _decisionReason;
    await writeFile(
      file,
      JSON.stringify({
        version: 0,
        updatedAt: '2026-01-03T00:00:00.000Z',
        cursor: 9,
        observations: [legacyFields],
      }),
      'utf8',
    );

    const migrated = await loadAtsSourceObservations(projectRoot);

    expect(migrated).toMatchObject({
      version: 1,
      cursor: { nextIndex: 9, generation: 0 },
      observations: [
        expect.objectContaining({ slug: 'acme', evidence: [expect.stringContaining('version 0')] }),
      ],
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('prioritizes due focus matches while reserving exploration and skipping recent sources', () => {
    const state = {
      ...emptyAtsSourceObservationFile(new Date('2026-01-03T00:00:00.000Z')),
      cursor: { nextIndex: 2, generation: 0 },
      observations: [
        observation('acme'),
        observation('recent', { nextDueAt: '2026-01-10T00:00:00.000Z' }),
        observation('recent-empty', {
          status: 'empty',
          vacancyCount: 0,
          nextDueAt: '2026-01-10T00:00:00.000Z',
          refreshTier: 'warm',
        }),
        observation('backend', { observedRoleFamilies: ['backend'] }),
      ],
    };

    const plan = planAtsRosterScan(
      [
        entry('recent'),
        entry('recent-empty'),
        entry('backend'),
        entry('new-b'),
        entry('acme'),
        entry('new-a'),
      ],
      state,
      {
        roleQuery: 'Frontend Engineer',
        country: 'Netherlands',
        maxSources: 3,
        explorationBudget: 1,
        now: new Date('2026-01-03T00:00:00.000Z'),
      },
    );

    expect(plan.mode).toBe('incremental');
    expect(plan.entries[0]).toMatchObject({ entry: { slug: 'acme' }, reason: 'focused_due' });
    expect(plan.entries.filter((item) => item.reason === 'exploration')).toHaveLength(1);
    expect(plan.entries.map((item) => item.entry.slug)).not.toContain('recent');
    expect(plan.entries.map((item) => item.entry.slug)).not.toContain('recent-empty');
    expect(plan.skippedNotDue).toBe(2);
  });

  it('resumes exploration from the persisted cursor without repeating the previous batch', async () => {
    const first = planAtsRosterScan(
      [entry('a'), entry('b'), entry('c')],
      emptyAtsSourceObservationFile(new Date('2026-01-03T00:00:00.000Z')),
      {
        roleQuery: 'Frontend',
        country: 'Netherlands',
        maxSources: 1,
        explorationBudget: 1,
        now: new Date('2026-01-03T00:00:00.000Z'),
      },
    );
    await writeAtsSourceObservations(projectRoot, first.nextState);
    const restored = await loadAtsSourceObservations(projectRoot);
    const second = planAtsRosterScan([entry('a'), entry('b'), entry('c')], restored, {
      roleQuery: 'Frontend',
      country: 'Netherlands',
      maxSources: 1,
      explorationBudget: 1,
      now: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(first.entries[0]?.entry.slug).toBe('a');
    expect(second.entries[0]?.entry.slug).toBe('b');
  });

  it('records deterministic country, role, remote, refresh, and promotion evidence', () => {
    const state = recordAtsSourceObservation(emptyAtsSourceObservationFile(), {
      entry: entry('acme'),
      status: 'verified',
      errorCategory: null,
      attemptedAt: new Date('2026-01-03T00:00:00.000Z'),
      evidence: ['external scout sample'],
      vacancies: [
        {
          title: 'Senior Frontend Engineer',
          location: 'Remote, Netherlands',
          description: 'Remote across Europe.',
        },
      ],
    });

    expect(state.observations[0]).toMatchObject({
      observedCountries: ['Netherlands'],
      observedRoleFamilies: ['frontend'],
      observedRemoteScopes: ['europe', 'remote'],
      nextDueAt: '2026-01-04T00:00:00.000Z',
      refreshTier: 'hot',
      promotedAt: '2026-01-03T00:00:00.000Z',
    });
  });
});

describe('parseAtsSourceObservationImport', () => {
  it('canonicalizes supported sources and rejects unsupported providers and duplicates', () => {
    const result = parseAtsSourceObservationImport({
      version: 1,
      generatedAt: '2026-01-03T00:00:00.000Z',
      sources: [
        {
          company: 'Acme',
          url: 'https://job-boards.greenhouse.io/acme/jobs/1',
          evidence: 'live role',
        },
        {
          company: 'Acme duplicate',
          url: 'https://boards.greenhouse.io/acme',
          evidence: 'same board',
        },
        {
          company: 'Unsupported',
          url: 'https://apply.workable.com/example',
          evidence: 'unsupported here',
        },
      ],
    });

    expect(result.records).toEqual([
      {
        entry: {
          provider: 'greenhouse',
          slug: 'acme',
          baseUrl: 'https://job-boards.greenhouse.io',
          company: 'Acme',
        },
        evidence: 'live role',
      },
    ]);
    expect(result.duplicateCount).toBe(1);
    expect(result.invalidCount).toBe(1);
  });

  it('rejects malformed import documents before any roster mutation can occur', () => {
    expect(() => parseAtsSourceObservationImport({ version: 2, sources: [] })).toThrow();
    expect(() =>
      parseAtsSourceObservationImport({
        version: 1,
        generatedAt: '2026-01-03T00:00:00.000Z',
        sources: [{ company: 'Acme', url: 'file:///etc/passwd', evidence: 'bad target' }],
      }),
    ).toThrow();
  });
});

describe('classifyAtsSourceFailure', () => {
  it('uses structured ATS status evidence before message heuristics', () => {
    expect(classifyAtsSourceFailure(new AtsResponseError('greenhouse', 'gone', 404))).toBe(
      'not_found',
    );
    expect(classifyAtsSourceFailure(new AtsResponseError('greenhouse', 'limited', 429))).toBe(
      'rate_limited',
    );
    expect(classifyAtsSourceFailure(new Error('request timed out'))).toBe('timeout');
  });
});
