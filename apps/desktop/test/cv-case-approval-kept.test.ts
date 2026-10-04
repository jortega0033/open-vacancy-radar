// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { EMPTY_CV_SOURCE, stableCvSourceJson, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import { makeFact, makeRequirement } from './fixtures/cv-evidence.js';
import { FULL_JD } from './fixtures/job-description.js';

/**
 * #564: an approved case lost its approval with no change to the CV, the job description or any
 * requirement. The requirement panel re-saves the result of its last mapping run whenever the
 * vacancy object is replaced (a new scan, a re-render of the case), sending back exactly what is
 * stored. A write that changes no input must leave the approval standing; a real change still
 * drops it.
 */
let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-case-approval-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  summary: 'Original summary.',
  experience: [
    {
      id: 'experience-1',
      company: 'Redwood Software',
      title: 'Frontend Engineer',
      dates: '2021 - Present',
      engagement: 'employment',
      client: '',
      bullets: ['Built things.'],
    },
  ],
};

function approvedCase() {
  const cv = workspace.createCvDocument(db, {
    name: 'Resume',
    kind: 'manual',
    profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    source: SOURCE,
  });
  const sourceHash = createHash('sha256').update(stableCvSourceJson(cv.source!)).digest('hex');
  const overlay = workspace.createCvEvidenceOverlay(db, {
    cvId: cv.id,
    vacancyKey: 'url:https://jobs.example.invalid/564',
    sourceCvContentHash: sourceHash,
    jdSnapshot: FULL_JD,
    jdSnapshotHash: createHash('sha256').update(FULL_JD).digest('hex'),
  });
  workspace.updateCvEvidenceOverlay(db, overlay.id, {
    requirements: [makeRequirement({ text: 'TypeScript', jdAnchor: 'TypeScript' })],
    requirementCoverage: { status: 'complete', batches: 1 },
    facts: [makeFact()],
  });
  const approved = workspace.approveCvEvidenceOverlay(db, overlay.id, workspace.getCvEvidenceOverlayById(db, overlay.id).caseRevision);
  expect(approved.state).toBe('candidate_approved');
  return { approved, sourceHash };
}

describe('a write that changes no input keeps the approval (#564)', () => {
  it('keeps an approved case approved when the requirement mapping is saved again unchanged', () => {
    const { approved, sourceHash } = approvedCase();
    // The exact patch RequirementMapping sends when its completed-run effect fires again.
    const after = workspace.updateCvEvidenceOverlay(db, approved.id, {
      sourceCvContentHash: sourceHash,
      requirements: approved.requirements,
      requirementCoverage: { status: 'complete', batches: 1 },
    });
    expect(after.state).toBe('candidate_approved');
    expect(after.approvedResumeSnapshot).toEqual(approved.approvedResumeSnapshot);
  });

  it('keeps it approved when the same facts and wording are saved again', () => {
    const { approved } = approvedCase();
    const after = workspace.updateCvEvidenceOverlay(db, approved.id, {
      facts: approved.facts,
      wordingVariants: approved.wordingVariants,
    });
    expect(after.state).toBe('candidate_approved');
  });

  it('keeps it approved when the same job description text is sent again', () => {
    const { approved } = approvedCase();
    const after = workspace.updateCvEvidenceOverlay(db, approved.id, { jdSnapshot: FULL_JD });
    expect(after.state).toBe('candidate_approved');
    expect(after.requirements[0]?.reviewed).toBe(true);
  });

  it('still drops the approval when a requirement really changes', () => {
    const { approved } = approvedCase();
    const after = workspace.updateCvEvidenceOverlay(db, approved.id, {
      requirements: approved.requirements.map((requirement) => ({ ...requirement, classification: 'preferred' as const })),
    });
    expect(after.state).toBe('draft');
  });

  it('still drops the approval when the source hash changes', () => {
    const { approved } = approvedCase();
    const after = workspace.updateCvEvidenceOverlay(db, approved.id, { sourceCvContentHash: 'f'.repeat(64) });
    expect(after.state).toBe('draft');
  });
});
