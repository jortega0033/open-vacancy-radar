// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');
const PRE_0015_TAGS = [
  '0000_familiar_giant_man', '0001_misty_hobgoblin', '0002_brainy_morgan_stark', '0003_curved_shotgun',
  '0004_damp_dust', '0005_lean_echo', '0006_old_karen_page', '0007_cheerful_talos', '0008_young_zemo',
  '0009_aspiring_rick_jones', '0010_smart_wolfsbane', '0011_mixed_darkstar', '0012_nosy_veda',
  '0013_soft_obadiah_stane', '0014_high_yellowjacket',
];
type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
}

function seedPre0015(root: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter((entry) => PRE_0015_TAGS.includes(entry.tag));
  const folder = join(root, 'drizzle-0014');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0015-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('migration 0015 records explicit application tailoring mode', () => {
  it('adds one non-null column without rebuilding the table', () => {
    const entry = readJournal().entries[PRE_0015_TAGS.length];
    expect(entry?.tag).toMatch(/^0015_/);
    const sql = readFileSync(join(REAL_MIGRATIONS, `${entry!.tag}.sql`), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `application_attempts` ADD `tailoring_mode` text DEFAULT 'ai' NOT NULL/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_|DROP TABLE/i);
  });

  it('keeps legacy attempts and defaults them to AI tailoring', () => {
    const databasePath = join(dir, 'workspace.db');
    const raw = new Database(databasePath);
    try {
      migrate(drizzle(raw), { migrationsFolder: seedPre0015(dir) });
      raw.prepare(`INSERT INTO application_attempts
        (id, company, role, source_cv_content_hash, jd_snapshot_hash, checkpoint, created_at, updated_at)
        VALUES ('legacy-attempt', 'Example BV', 'Engineer', ?, ?, 'needs_user', 1, 1)`).run('a'.repeat(64), 'b'.repeat(64));
    } finally {
      raw.close();
    }

    const opened = createWorkspaceDb(dir);
    try {
      expect(workspace.getApplicationAttempt(opened.db, 'legacy-attempt').tailoringMode).toBe('ai');
    } finally {
      opened.close();
    }
  });
});
