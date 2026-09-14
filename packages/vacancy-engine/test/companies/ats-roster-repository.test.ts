import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  atsRosterFilePath,
  loadAtsRoster,
  readAtsRosterStatus,
  writeAtsRoster,
} from '../../src/companies/ats-roster-repository.js';
import type { AtsRosterEntry } from '../../src/companies/ats-roster-source.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'ats-roster-repository-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

const entryA: AtsRosterEntry = {
  provider: 'greenhouse',
  slug: 'acme',
  baseUrl: 'https://job-boards.greenhouse.io',
  company: 'Acme Corp',
};
const entryB: AtsRosterEntry = {
  provider: 'lever',
  slug: 'widgets',
  baseUrl: 'https://jobs.lever.co',
  company: 'Widgets Inc',
};

describe('loadAtsRoster', () => {
  it('returns an empty roster when the file has never been imported, rather than throwing', async () => {
    await expect(loadAtsRoster(projectRoot)).resolves.toEqual([]);
  });

  it('round-trips exactly what writeAtsRoster wrote, sorted by provider then slug', async () => {
    await writeAtsRoster(projectRoot, [entryB, entryA], { greenhouse: 1, lever: 1 }, new Date('2026-01-01T00:00:00.000Z'));

    await expect(loadAtsRoster(projectRoot)).resolves.toEqual([entryA, entryB]);
  });

  it('throws on a corrupted roster file rather than silently discarding it', async () => {
    await mkdir(join(projectRoot, '.data'), { recursive: true });
    await writeFile(join(projectRoot, '.data', 'ats-roster-v1.json'), '{"not":"a roster"}', 'utf8');

    await expect(loadAtsRoster(projectRoot)).rejects.toThrow('does not contain a valid entries array');
  });
});

describe('writeAtsRoster', () => {
  it('writes to .data/ats-roster-v1.json, gitignored like the embedded SQLite store', async () => {
    const file = await writeAtsRoster(projectRoot, [entryA], { greenhouse: 1 });

    expect(file).toBe(atsRosterFilePath(projectRoot));
    expect(file.replaceAll('\\', '/')).toMatch(/\.data\/ats-roster-v1\.json$/u);
  });
});

describe('readAtsRosterStatus', () => {
  it('returns null when the roster has never been imported, rather than throwing', async () => {
    await expect(readAtsRosterStatus(projectRoot)).resolves.toBeNull();
  });

  it('reports the summary fields without requiring the caller to load every roster row', async () => {
    await writeAtsRoster(projectRoot, [entryB, entryA], { greenhouse: 1, lever: 1 }, new Date('2026-01-01T00:00:00.000Z'));

    await expect(readAtsRosterStatus(projectRoot)).resolves.toEqual({
      importedAt: '2026-01-01T00:00:00.000Z',
      totalEntries: 2,
      sourceCounts: { greenhouse: 1, lever: 1 },
    });
  });

  it('throws on a corrupted roster file rather than silently reporting no status', async () => {
    await mkdir(join(projectRoot, '.data'), { recursive: true });
    await writeFile(join(projectRoot, '.data', 'ats-roster-v1.json'), '{"not":"a roster"}', 'utf8');

    await expect(readAtsRosterStatus(projectRoot)).rejects.toThrow('does not contain a valid status');
  });
});
