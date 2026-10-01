// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { EMPTY_CV_SOURCE, stableCvSourceJson, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import { describeCvEvidenceOverlayGaps, describeCvJdGaps } from '../electron/workspace/cv-evidence-schema.js';
import { makeFact, makeOverlay, makeRequirement } from './fixtures/cv-evidence.js';
import { parseCvEvidenceOverlayPatch } from '../electron/workspace/validate.js';
import { FULL_JD } from './fixtures/job-description.js';

/** JD completeness, revision metadata and the approval gate (#419, step 4), against a real
 * migrated database. */
let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-case-jd-'));
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
const HASH = 'a'.repeat(64);
const SHORT_JD = 'We need a frontend engineer who must know TypeScript.';
const TRUNCATED_JD = `${FULL_JD}\n\nRead more...`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let counter = 0;

function newCase(jd: string | undefined, extra: Partial<Parameters<typeof workspace.createCvEvidenceOverlay>[1]> = {}) {
  const cv = workspace.createCvDocument(db, {
    name: 'Resume',
    kind: 'manual',
    profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    source: SOURCE,
  });
  const sourceHash = createHash('sha256').update(stableCvSourceJson(cv.source!)).digest('hex');
  counter += 1;
  const overlay = workspace.createCvEvidenceOverlay(db, {
    cvId: cv.id,
    vacancyKey: `url:https://jobs.example.invalid/${counter}`,
    sourceCvContentHash: sourceHash,
    ...(jd === undefined ? {} : { jdSnapshot: jd }),
    jdSnapshotHash: HASH,
    ...extra,
  });
  return { cv, overlay, sourceHash };
}

describe('JD completeness is assessed and persisted', () => {
  it('records a complete JD with no warning, and computes the digest in the main process', () => {
    const { overlay } = newCase(FULL_JD);
    expect(overlay).toMatchObject({ jdComplete: true, jdIncompleteReasons: [], jdWarning: '', jdSnapshotHash: sha(FULL_JD) });
    expect(overlay.jdRevisions[0]).toMatchObject({ textHash: sha(FULL_JD), complete: true, incompleteReasons: [], warning: '' });
  });

  it('records a short JD as incomplete with a separate heuristic warning', () => {
    const { overlay } = newCase(SHORT_JD);
    expect(overlay.jdComplete).toBe(false);
    expect(overlay.jdIncompleteReasons).toEqual(['posting_text_too_thin']);
    expect(overlay.jdWarning).toMatch(/characters of posting text/u);
    expect(overlay.jdConfirmedComplete).toBe(false);
  });

  it('records an empty JD as having no posting text', () => {
    const { overlay } = newCase(undefined);
    expect(overlay).toMatchObject({ jdComplete: false, jdIncompleteReasons: ['no_posting_text'], jdRevisions: [] });
  });

  it('recognises a JD that still carries its source cut-off marker', () => {
    const { overlay } = newCase(TRUNCATED_JD);
    expect(overlay.jdIncompleteReasons).toContain('truncated_at_source');
  });

  it('treats a caller-reported source-side cut as truncation even when the text reads fine', () => {
    const { overlay } = newCase(FULL_JD, { jdComplete: false });
    expect(overlay.jdIncompleteReasons).toEqual(['truncated_at_source']);
    expect(overlay.jdComplete).toBe(false);
  });

  it('re-assesses when the JD text changes', () => {
    const { overlay } = newCase(SHORT_JD);
    const updated = workspace.updateCvEvidenceOverlay(db, overlay.id, { jdSnapshot: FULL_JD, jdSnapshotHash: HASH });
    expect(updated).toMatchObject({ jdComplete: true, jdIncompleteReasons: [], jdWarning: '' });
  });
});

describe('JD revision metadata', () => {
  it('stores origin, url, requisition, captured time and digest on the first revision', () => {
    const { overlay } = newCase(FULL_JD, { origin: 'manual', jdUrl: 'https://jobs.example.invalid/42', jdRequisition: 'REQ-42' });
    expect(overlay.origin).toBe('manual');
    expect(overlay.jdRevisions).toHaveLength(1);
    expect(overlay.jdRevisions[0]).toMatchObject({
      origin: 'manual',
      url: 'https://jobs.example.invalid/42',
      requisition: 'REQ-42',
      textHash: sha(FULL_JD),
    });
    expect(Number.isNaN(Date.parse(overlay.jdRevisions[0]!.capturedAt))).toBe(false);
  });

  it('defaults a found vacancy to origin found', () => {
    expect(newCase(FULL_JD).overlay.jdRevisions[0]?.origin).toBe('found');
  });

  it('adds a pasted revision on a text change, keeping the earlier one and its metadata', () => {
    const { overlay } = newCase(SHORT_JD, { jdUrl: 'https://jobs.example.invalid/7' });
    const updated = workspace.updateCvEvidenceOverlay(db, overlay.id, {
      jdSnapshot: FULL_JD,
      jdSnapshotHash: HASH,
      jdOrigin: 'pasted',
      jdRequisition: 'R-7',
    });
    expect(updated.jdRevisions).toHaveLength(2);
    expect(updated.jdRevisions[0]).toMatchObject({ text: SHORT_JD, origin: 'found', url: 'https://jobs.example.invalid/7' });
    expect(updated.jdRevisions[1]).toMatchObject({
      text: FULL_JD,
      origin: 'pasted',
      requisition: 'R-7',
      url: 'https://jobs.example.invalid/7',
      textHash: sha(FULL_JD),
    });
  });

  it('adds no revision when the same text is sent again', () => {
    const { overlay } = newCase(FULL_JD);
    const resent = workspace.updateCvEvidenceOverlay(db, overlay.id, { jdSnapshot: FULL_JD, jdSnapshotHash: HASH });
    expect(resent.jdRevisions).toHaveLength(1);
  });
});

describe('candidate confirmation of a short JD', () => {
  it('is stored separately from the heuristic result', () => {
    const { overlay } = newCase(SHORT_JD);
    const confirmed = workspace.updateCvEvidenceOverlay(db, overlay.id, { jdConfirmedComplete: true });
    expect(confirmed.jdConfirmedComplete).toBe(true);
    expect(confirmed.jdComplete).toBe(false);
    expect(confirmed.jdIncompleteReasons).toEqual(['posting_text_too_thin']);
    expect(confirmed.jdWarning).not.toBe('');
  });

  it('resets when the JD text changes', () => {
    const { overlay } = newCase(SHORT_JD);
    workspace.updateCvEvidenceOverlay(db, overlay.id, { jdConfirmedComplete: true });
    const changed = workspace.updateCvEvidenceOverlay(db, overlay.id, { jdSnapshot: `${SHORT_JD} Also React.`, jdSnapshotHash: HASH });
    expect(changed.jdConfirmedComplete).toBe(false);
  });

  it('is refused for an empty JD', () => {
    const { overlay } = newCase(undefined);
    expect(() => workspace.updateCvEvidenceOverlay(db, overlay.id, { jdConfirmedComplete: true })).toThrow(/cannot be confirmed/u);
  });

  it('is refused for a known-truncated JD', () => {
    const { overlay } = newCase(TRUNCATED_JD);
    expect(() => workspace.updateCvEvidenceOverlay(db, overlay.id, { jdConfirmedComplete: true })).toThrow(/cannot be confirmed/u);
  });

  it('is accepted by the patch validator as a boolean only', () => {
    expect(parseCvEvidenceOverlayPatch({ jdConfirmedComplete: true })).toEqual({ jdConfirmedComplete: true });
    expect(() => parseCvEvidenceOverlayPatch({ jdConfirmedComplete: 'yes' })).toThrow();
  });
});

describe('a JD change invalidates earlier review', () => {
  it('clears requirement reviews and drops an approved state back to draft', () => {
    const { overlay } = newCase(FULL_JD);
    const requirement = makeRequirement({ text: 'TypeScript', jdAnchor: 'TypeScript' });
    workspace.updateCvEvidenceOverlay(db, overlay.id, {
      requirements: [requirement],
      requirementCoverage: { status: 'complete', batches: 1 },
      state: 'draft',
    });
    const approved = workspace.approveCvEvidenceOverlay(
      db,
      overlay.id,
      workspace.getCvEvidenceOverlayById(db, overlay.id).caseRevision,
    );
    expect(approved.state).toBe('candidate_approved');

    const changed = workspace.updateCvEvidenceOverlay(db, overlay.id, {
      jdSnapshot: `${FULL_JD}\nAlso: GraphQL is required.`,
      jdSnapshotHash: HASH,
    });
    expect(changed.state).toBe('draft');
    expect(changed.requirements[0]?.reviewed).toBe(false);
    expect(changed.jdRevisions).toHaveLength(2);
  });

  it('marks the requirement mapping stale: coverage and every requirement belong to the older revision', () => {
    const { overlay, sourceHash } = newCase(FULL_JD);
    const approved = workspace.updateCvEvidenceOverlay(db, overlay.id, {
      requirements: [makeRequirement({ text: 'TypeScript', jdAnchor: 'TypeScript' })],
      requirementCoverage: { status: 'complete', batches: 1 },
    });
    const firstRevisionId = approved.jdRevisions[0]?.revisionId;
    expect(approved.requirements[0]?.jdRevisionId).toBe(firstRevisionId);
    expect(describeCvEvidenceOverlayGaps(approved, sourceHash)).not.toEqual(expect.arrayContaining([expect.stringContaining('older job description')]));

    const changed = workspace.updateCvEvidenceOverlay(db, overlay.id, {
      jdSnapshot: `${FULL_JD}
Also: GraphQL is required.`,
      jdSnapshotHash: HASH,
    });
    const gaps = describeCvEvidenceOverlayGaps(changed, sourceHash);
    expect(changed.requirements[0]?.jdRevisionId).toBe(firstRevisionId);
    expect(gaps).toEqual(
      expect.arrayContaining([
        expect.stringContaining('have not been extracted and confirmed'),
        expect.stringContaining('older job description'),
        expect.stringContaining('have not been reviewed'),
      ]),
    );
  });

  it('keeps reviewed facts reusable across a JD edit', () => {
    const { overlay } = newCase(FULL_JD);
    workspace.updateCvEvidenceOverlay(db, overlay.id, { facts: [makeFact()] });
    const changed = workspace.updateCvEvidenceOverlay(db, overlay.id, {
      jdSnapshot: `${FULL_JD}
Also: GraphQL is required.`,
      jdSnapshotHash: HASH,
    });
    expect(changed.facts[0]).toMatchObject({ factId: 'fact-1', approval: 'approved' });
  });

  it('re-verifies a requirement quote against the new text when the candidate reviews it again', () => {
    const { overlay, sourceHash } = newCase(FULL_JD);
    workspace.updateCvEvidenceOverlay(db, overlay.id, {
      requirements: [makeRequirement({ text: 'TypeScript', jdAnchor: 'TypeScript' })],
      requirementCoverage: { status: 'complete', batches: 1 },
    });
    const changed = workspace.updateCvEvidenceOverlay(db, overlay.id, {
      jdSnapshot: `${FULL_JD}
Also: GraphQL is required.`,
      jdSnapshotHash: HASH,
    });
    const rereviewed = workspace.updateCvEvidenceOverlay(db, overlay.id, {
      requirements: changed.requirements.map((requirement) => ({ ...requirement, reviewed: true })),
      requirementCoverage: { status: 'complete', batches: 1 },
    });
    expect(rereviewed.requirements[0]?.jdRevisionId).toBe(changed.jdRevisions.at(-1)?.revisionId);
    expect(describeCvEvidenceOverlayGaps(rereviewed, sourceHash)).toEqual([]);

    // A quote that the new text no longer contains cannot be reviewed again.
    const replaced = workspace.updateCvEvidenceOverlay(db, overlay.id, {
      jdSnapshot: 'A different short posting that must be read again.',
      jdSnapshotHash: HASH,
    });
    expect(() =>
      workspace.updateCvEvidenceOverlay(db, overlay.id, {
        requirements: replaced.requirements.map((requirement) => ({ ...requirement, reviewed: true })),
      }),
    ).toThrow(/no longer in the job description/u);
  });
});

describe('approval gate for the JD', () => {
  /** The candidate has confirmed the requirement list for whatever JD text there is. */
  function covered(overlayId: string) {
    if (workspace.getCvEvidenceOverlayById(db, overlayId).jdSnapshot.trim()) {
      workspace.updateCvEvidenceOverlay(db, overlayId, { requirementCoverage: { status: 'complete', batches: 1 } });
    }
  }

  function approve(overlayId: string) {
    covered(overlayId);
    return workspace.approveCvEvidenceOverlay(db, overlayId, workspace.getCvEvidenceOverlayById(db, overlayId).caseRevision);
  }

  it('approves a complete JD', () => {
    const { overlay } = newCase(FULL_JD);
    expect(approve(overlay.id).state).toBe('candidate_approved');
  });

  it('refuses an empty JD', () => {
    const { overlay } = newCase(undefined);
    expect(() => approve(overlay.id)).toThrow(/no job description text/u);
  });

  it('refuses a known-truncated JD, and confirming it is not an escape', () => {
    const { overlay } = newCase(TRUNCATED_JD);
    expect(() => approve(overlay.id)).toThrow(/cut off/u);
    expect(() => workspace.updateCvEvidenceOverlay(db, overlay.id, { jdConfirmedComplete: true })).toThrow();
    expect(() => approve(overlay.id)).toThrow(/cut off/u);
  });

  it('refuses a short JD until the candidate confirms it after reading, then approves', () => {
    const { overlay } = newCase(SHORT_JD);
    expect(() => approve(overlay.id)).toThrow(/not confirmed/u);
    workspace.updateCvEvidenceOverlay(db, overlay.id, { jdConfirmedComplete: true });
    expect(approve(overlay.id).state).toBe('candidate_approved');
  });

  it('stops approving again once a confirmed short JD is replaced by another short one', () => {
    const { overlay } = newCase(SHORT_JD);
    workspace.updateCvEvidenceOverlay(db, overlay.id, { jdConfirmedComplete: true });
    workspace.updateCvEvidenceOverlay(db, overlay.id, {
      jdSnapshot: 'A different short posting that must be read again.',
      jdSnapshotHash: HASH,
    });
    expect(() => approve(overlay.id)).toThrow(/not confirmed/u);
  });
});

describe('describeCvJdGaps', () => {
  const base = { jdSnapshot: FULL_JD, jdComplete: true, jdIncompleteReasons: [] as never[], jdConfirmedComplete: false };

  it('reports nothing for a complete JD', () => {
    expect(describeCvJdGaps(base)).toEqual([]);
  });

  it('keeps the legacy not-read-in-full reason for a row with no assessment', () => {
    expect(describeCvJdGaps({ ...base, jdComplete: false })).toEqual(['the job description was not read in full']);
  });

  it('is part of the overlay gap list', () => {
    const gaps = describeCvEvidenceOverlayGaps(
      makeOverlay({ ...base, jdSnapshot: '', sourceCvContentHash: HASH, jdRevisions: [], requirementCoverage: { status: 'not_run', revisionId: '', batches: 0 } }),
      HASH,
    );
    expect(gaps.some((gap) => /no job description text/u.test(gap))).toBe(true);
  });
});
