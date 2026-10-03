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
import { describeCvEvidenceOverlayGaps } from '../electron/workspace/cv-evidence-schema.js';
import * as workspace from '../electron/workspace/repository.js';

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** Every migration before 0026, so a database can be seeded the way an install from before
 * requirement coverage left it. */
function seedPre0026MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 26);
  expect(journal.entries[26]?.tag).toMatch(/^0026_/);

  const folder = join(root, 'drizzle-0025');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0026-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const JD = 'Experience with React is required. Familiarity with GraphQL is a plus.';
const HASH = 'a'.repeat(64);

/** A requirement, fact and variant exactly as an install from before #419 step 2 stored them:
 * none of the new fields exist. */
const LEGACY_REQUIREMENT = {
  requirementId: 'r-1',
  text: 'React',
  jdAnchor: 'Experience with React',
  classification: 'required',
  evidenceClass: 'direct',
  anchorParentId: 'experience-1',
  candidateAdded: false,
  reviewed: true,
};
const LEGACY_FACT = {
  factId: 'fact-1',
  parentId: 'experience-1',
  parentType: 'experience',
  client: '',
  activity: 'Built the booking screens',
  mechanism: 'React',
  result: '',
  ownership: 'sole',
  sourceKind: 'candidate_testimony',
  sourceReference: '',
  verification: 'self_reported',
  metricValue: '',
  metricUnit: '',
  metricBasis: '',
  supersedes: '',
  createdAt: '2026-09-01T00:00:00.000Z',
};
const LEGACY_OTHER_FACT = { ...LEGACY_FACT, factId: 'fact-2', activity: 'Wrote the release notes' };
const LEGACY_GAP_FACT = { ...LEGACY_FACT, factId: 'fact-3', activity: '', verification: 'candidate_confirmed_gap' };
const LEGACY_VARIANT = {
  variantId: 'v-1',
  targetField: 'experience_bullet',
  parentId: 'experience-1',
  text: 'Built the booking screens, using React',
  factIds: ['fact-1'],
  status: 'candidate_approved',
  approvedAt: '2026-09-02T00:00:00.000Z',
  sourceRevision: HASH,
};

function insertOverlay(connection: Database.Database, id: string, state: string): void {
  connection
    .prepare(
      `INSERT INTO cv_evidence_overlays
         (id, cv_id, vacancy_key, source_cv_content_hash, jd_snapshot, jd_snapshot_hash, jd_revisions, state,
          requirements, facts, wording_variants, captured_at, updated_at)
       VALUES (?, 'cv-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1788000000000, 1788000000000)`,
    )
    .run(
      id,
      `url:https://jobs.example.invalid/${id}`,
      HASH,
      JD,
      'b'.repeat(64),
      JSON.stringify([{ revisionId: 'rev-legacy', text: JD, textHash: 'b'.repeat(64), complete: true, capturedAt: '2026-09-01T00:00:00.000Z' }]),
      state,
      JSON.stringify([LEGACY_REQUIREMENT]),
      JSON.stringify([LEGACY_FACT, LEGACY_OTHER_FACT, LEGACY_GAP_FACT]),
      JSON.stringify([LEGACY_VARIANT]),
    );
}

describe('migration 0026 adds requirement coverage and keeps older rows meaningful (#419)', () => {
  function seed(): void {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0026MigrationsFolder(dir) });
      seeded
        .prepare(
          `INSERT INTO cv_documents (id, name, kind, text, profile, source_cv, uploaded_at, updated_at)
           VALUES ('cv-1', 'Synthetic CV', 'manual', 'text', '{}', NULL, 1788000000000, 1788000000000)`,
        )
        .run();
      insertOverlay(seeded, 'overlay-approved', 'candidate_approved');
      insertOverlay(seeded, 'overlay-draft', 'draft');
    } finally {
      seeded.close();
    }
  }

  it('keeps an already approved case approved: its coverage is carried over for its own JD revision', () => {
    seed();
    const { db, close } = createWorkspaceDb(dir);
    try {
      const overlay = workspace.getCvEvidenceOverlayById(db, 'overlay-approved');
      expect(overlay.state).toBe('candidate_approved');
      expect(overlay.requirementCoverage).toEqual({ status: 'complete', revisionId: 'rev-legacy', batches: 0 });
      expect(overlay.wordingVariants[0]).toMatchObject({ variantId: 'v-1', status: 'candidate_approved', supersedes: '', rejectedAt: '' });
      // The quote was located in the JD on read, so the old requirement still verifies.
      expect(overlay.requirements[0]).toMatchObject({
        quoteStart: 0,
        quoteEnd: 'Experience with React'.length,
        jdRevisionId: 'rev-legacy',
        excluded: false,
        sourceIds: [],
        factIds: [],
      });
      expect(describeCvEvidenceOverlayGaps(overlay, HASH)).toEqual([]);
    } finally {
      close();
    }
  });

  it('gives an unapproved case no coverage, so nothing is claimed that was never confirmed', () => {
    seed();
    const { db, close } = createWorkspaceDb(dir);
    try {
      const overlay = workspace.getCvEvidenceOverlayById(db, 'overlay-draft');
      expect(overlay.requirementCoverage).toEqual({ status: 'not_run', revisionId: '', batches: 0 });
      expect(describeCvEvidenceOverlayGaps(overlay, HASH)).toEqual(
        expect.arrayContaining([expect.stringContaining('not been read and confirmed')]),
      );
    } finally {
      close();
    }
  });

  it('maps old facts to approval only where the candidate already approved something built on them', () => {
    seed();
    const { db, close } = createWorkspaceDb(dir);
    try {
      for (const id of ['overlay-approved', 'overlay-draft']) {
        const byId = new Map(workspace.getCvEvidenceOverlayById(db, id).facts.map((fact) => [fact.factId, fact]));
        // Backs a wording variant the candidate approved, so it stays usable.
        expect(byId.get('fact-1')?.approval).toBe('approved');
        // Nothing approved stands on it, so it needs the candidate's review.
        expect(byId.get('fact-2')?.approval).toBe('proposed');
        // The candidate's own "not my work" claims nothing.
        expect(byId.get('fact-3')?.approval).toBe('approved');
        expect(byId.get('fact-1')?.timePhase).toBe('');
      }
    } finally {
      close();
    }
  });

  it('keeps the approved state through the next unrelated write', () => {
    seed();
    const { db, close } = createWorkspaceDb(dir);
    try {
      const updated = workspace.updateCvEvidenceOverlay(db, 'overlay-approved', { listingStatus: 'open' });
      expect(updated.state).toBe('candidate_approved');
      expect(updated.wordingVariants[0]?.status).toBe('candidate_approved');
      expect(updated.facts.find((fact) => fact.factId === 'fact-1')?.approval).toBe('approved');
    } finally {
      close();
    }
  });
});
