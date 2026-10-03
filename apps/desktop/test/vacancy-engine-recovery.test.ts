import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyVacancyEngineError,
  describeVacancyEngineFailure,
  rebuildVacancyEngineDatabase,
} from '../electron/vacancy-engine-recovery.js';

describe('classifyVacancyEngineError (#441)', () => {
  it('calls a malformed database corrupt even when it surfaces during a migration', () => {
    const error = new Error('Failed to run the query CREATE INDEX discovery_runs_generated_at_idx ON ...', {
      cause: Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }),
    });
    expect(classifyVacancyEngineError(error, 'migrate')).toBe('corrupt');
  });

  it('recognises a file that is not a database', () => {
    expect(classifyVacancyEngineError(Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' }), 'open')).toBe('corrupt');
  });

  it('keeps a locked database on its own path', () => {
    expect(classifyVacancyEngineError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }), 'migrate')).toBe('locked');
  });

  it('separates a migration failure from an unrecognised one and never offers a rebuild for either', () => {
    expect(classifyVacancyEngineError(new Error('no such column: foo'), 'migrate')).toBe('migration_failed');
    expect(classifyVacancyEngineError(new Error('boom'), 'open')).toBe('unknown');
    expect(describeVacancyEngineFailure(new Error('no such column: foo'), 'migrate', []).canRebuild).toBe(false);
    expect(describeVacancyEngineFailure(new Error('boom'), 'open', []).canRebuild).toBe(false);
  });

  it('shows no SQL or path in the message and strips the data folder from the details', () => {
    const failure = describeVacancyEngineFailure(
      new Error('Failed to run the query CREATE INDEX x; SQLITE_CORRUPT at /home/u/data/vacancy-engine.db'),
      'migrate',
      ['/home/u/data'],
    );
    expect(failure.category).toBe('corrupt');
    expect(failure.canRebuild).toBe(true);
    expect(failure.message).not.toMatch(/CREATE INDEX|\/home|\.db|SQLITE/u);
    expect(failure.details).toContain('<data folder>/vacancy-engine.db');
    expect(failure.details).not.toContain('/home/u/data');
  });
});

describe('rebuildVacancyEngineDatabase (#441)', () => {
  let dir: string;
  let databasePath: string;
  const now = () => new Date('2026-10-03T12:00:00.000Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ovr-engine-recovery-'));
    databasePath = join(dir, 'vacancy-engine.db');
    writeFileSync(databasePath, 'DAMAGED-BYTES');
    writeFileSync(`${databasePath}-wal`, 'WAL');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fresh = () => async () => {
    writeFileSync(databasePath, 'FRESH');
  };
  const discard = () => async () => {
    rmSync(databasePath, { force: true });
  };

  it('renames the damaged file, creates a fresh one and keeps the damaged bytes', async () => {
    const outcome = await rebuildVacancyEngineDatabase({
      databasePath,
      now,
      createFresh: fresh(),
      discardFresh: discard(),
      refreshSponsors: async () => undefined,
    });
    expect(outcome).toMatchObject({ ok: true, sponsorRefresh: 'ok' });
    expect(readFileSync(databasePath, 'utf8')).toBe('FRESH');
    const retained = readdirSync(dir).filter((name) => name.includes('.damaged-'));
    expect(retained).toHaveLength(2);
    const main = retained.find((name) => !name.includes('-wal'))!;
    expect(readFileSync(join(dir, main), 'utf8')).toBe('DAMAGED-BYTES');
  });

  it('puts the damaged file back untouched when the fresh database cannot be built', async () => {
    const outcome = await rebuildVacancyEngineDatabase({
      databasePath,
      now,
      createFresh: async () => {
        writeFileSync(databasePath, 'PARTIAL');
        throw new Error('disk full');
      },
      discardFresh: discard(),
      refreshSponsors: async () => undefined,
    });
    expect(outcome.ok).toBe(false);
    expect(readFileSync(databasePath, 'utf8')).toBe('DAMAGED-BYTES');
    expect(readFileSync(`${databasePath}-wal`, 'utf8')).toBe('WAL');
    expect(readdirSync(dir).filter((name) => name.includes('.damaged-'))).toHaveLength(0);
  });

  it('keeps the fresh cache and the damaged copy when only the sponsor refresh fails', async () => {
    const outcome = await rebuildVacancyEngineDatabase({
      databasePath,
      now,
      createFresh: fresh(),
      discardFresh: discard(),
      refreshSponsors: async () => {
        throw new Error('offline');
      },
    });
    expect(outcome).toMatchObject({ ok: true, sponsorRefresh: 'failed', sponsorError: 'offline' });
    expect(existsSync(databasePath)).toBe(true);
    expect(readdirSync(dir).some((name) => name.includes('.damaged-'))).toBe(true);
  });

  it('never overwrites the first retained copy on a second rebuild', async () => {
    const run = () =>
      rebuildVacancyEngineDatabase({
        databasePath,
        now,
        createFresh: fresh(),
        discardFresh: discard(),
        refreshSponsors: async () => undefined,
      });
    const first = await run();
    writeFileSync(databasePath, 'DAMAGED-AGAIN');
    const second = await run();
    expect(first.ok && second.ok).toBe(true);
    const names = readdirSync(dir).filter((name) => name.includes('.damaged-') && !name.includes('-wal'));
    expect(names).toHaveLength(2);
    const contents = names.map((name) => readFileSync(join(dir, name), 'utf8')).sort();
    expect(contents).toEqual(['DAMAGED-AGAIN', 'DAMAGED-BYTES']);
  });
});

describe('against a real damaged SQLite file (#441)', () => {
  it('classifies the engine\'s own open/migrate failure as corrupt and then rebuilds to a working database', async () => {
    const { createDatabaseClient, migrateDatabase } = await import('@open-vacancy-radar/vacancy-engine');
    const { join: joinPath, resolve } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ovr-engine-real-'));
    const databasePath = join(dir, 'vacancy-engine.db');
    const migrations = resolve(__dirname, '../../../packages/vacancy-engine/drizzle');
    try {
      // A file of garbage is what a destroyed database looks like to SQLite.
      writeFileSync(databasePath, Buffer.alloc(8192, 0xab));

      let failure: unknown;
      let stage: 'open' | 'migrate' = 'open';
      try {
        const client = createDatabaseClient(databasePath);
        stage = 'migrate';
        await migrateDatabase(client.db, migrations);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      const described = describeVacancyEngineFailure(failure, stage, [dir]);
      expect(described.category).toBe('corrupt');
      expect(described.canRebuild).toBe(true);
      expect(described.message).not.toContain(dir);

      const outcome = await rebuildVacancyEngineDatabase({
        databasePath,
        now: () => new Date('2026-10-03T12:00:00.000Z'),
        createFresh: async () => {
          const client = createDatabaseClient(databasePath);
          await migrateDatabase(client.db, migrations);
          client.close();
        },
        discardFresh: async () => rmSync(databasePath, { force: true }),
        refreshSponsors: async () => undefined,
      });
      expect(outcome.ok).toBe(true);
      const retained = readdirSync(dir).filter((name) => name.includes('.damaged-'));
      expect(retained).toHaveLength(1);
      expect(readFileSync(joinPath(dir, retained[0]!)).equals(Buffer.alloc(8192, 0xab))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
