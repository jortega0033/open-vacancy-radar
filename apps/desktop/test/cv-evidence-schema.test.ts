import { describe, expect, it } from 'vitest';
import {
  deriveWordingFromFact,
  describeCvEvidenceOverlayGaps,
  invalidatedOverlayState,
  isCvEvidenceOverlayApprovable,
  proposeWordingFromFacts,
  withJdRevision,
  type CvApprovedWording,
  type CvEvidenceFact,
  type CvEvidenceOverlay,
  type CvRequirementMapping,
} from '../electron/workspace/cv-evidence-schema.js';
import { FIXTURE_HASH as HASH, makeFact, makeOverlay, makeRequirement, makeVariant } from './fixtures/cv-evidence.js';

function overlay(partial: Partial<CvEvidenceOverlay> = {}): CvEvidenceOverlay {
  return makeOverlay(partial);
}

function requirement(partial: Partial<CvRequirementMapping> = {}): CvRequirementMapping {
  return makeRequirement(partial);
}

function wording(partial: Partial<CvApprovedWording> = {}): CvApprovedWording {
  return makeVariant(partial);
}

describe('describeCvEvidenceOverlayGaps', () => {
  it('is clean for a freshly built, complete, unreviewed-nothing overlay', () => {
    expect(describeCvEvidenceOverlayGaps(overlay(), HASH)).toEqual([]);
  });

  it('flags a source CV that changed since this overlay was built', () => {
    expect(describeCvEvidenceOverlayGaps(overlay(), 'b'.repeat(64))).toEqual([
      'your CV changed since this draft was built, so update the tailoring',
    ]);
  });

  it('flags an incomplete JD read', () => {
    expect(describeCvEvidenceOverlayGaps(overlay({ jdComplete: false }), HASH)).toContain(
      'the job description was not read in full',
    );
  });

  it('flags any unreviewed requirement, even a preferred or candidate-added one', () => {
    const reasons = describeCvEvidenceOverlayGaps(
      overlay({ requirements: [requirement({ reviewed: false }), requirement({ requirementId: 'r-2', reviewed: true })] }),
      HASH,
    );
    expect(reasons).toContain('1 job requirement has not been reviewed');
  });

  it('never claims complete coverage while a required item still needs verification', () => {
    const reasons = describeCvEvidenceOverlayGaps(
      overlay({ requirements: [requirement({ classification: 'required', evidenceClass: 'needs_verification', reviewed: true })] }),
      HASH,
    );
    expect(reasons).toContain('1 job requirement still needs your answer');
  });

  it('does not block on a preferred item needing verification', () => {
    const reasons = describeCvEvidenceOverlayGaps(
      overlay({ requirements: [requirement({ classification: 'preferred', evidenceClass: 'needs_verification', reviewed: true })] }),
      HASH,
    );
    expect(reasons).not.toContain('1 job requirement still needs your answer');
  });

  it('flags an approved wording variant whose source revision no longer matches', () => {
    const reasons = describeCvEvidenceOverlayGaps(
      overlay({ sourceCvContentHash: HASH, wordingVariants: [wording({ sourceRevision: 'stale'.padEnd(64, '0') })] }),
      HASH,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('wording choice needs approving again because your CV changed')]),
    );
  });

  it('flags an approved wording variant that cites no fact', () => {
    const reasons = describeCvEvidenceOverlayGaps(overlay({ wordingVariants: [wording({ factIds: [] })] }), HASH);
    expect(reasons).toEqual(expect.arrayContaining([expect.stringContaining('not backed by a confirmed fact')]));
  });

  it('never flags a draft (not yet approved) wording variant for staleness or grounding', () => {
    const reasons = describeCvEvidenceOverlayGaps(
      overlay({ wordingVariants: [wording({ status: 'draft', factIds: [], sourceRevision: 'stale'.padEnd(64, '0') })] }),
      HASH,
    );
    expect(reasons).toEqual([]);
  });

  it('flags an overlay left in conflict', () => {
    expect(describeCvEvidenceOverlayGaps(overlay({ state: 'conflict' }), HASH)).toContain(
      'some of your corrections contradict each other',
    );
  });
});

describe('isCvEvidenceOverlayApprovable', () => {
  it('mirrors describeCvEvidenceOverlayGaps: true only when it returns no reasons', () => {
    expect(isCvEvidenceOverlayApprovable(overlay(), HASH)).toBe(true);
    expect(isCvEvidenceOverlayApprovable(overlay({ jdComplete: false }), HASH)).toBe(false);
  });
});

describe('invalidatedOverlayState', () => {
  it('drops an approved or QA-failed state back to draft', () => {
    expect(invalidatedOverlayState('candidate_approved')).toBe('draft');
    expect(invalidatedOverlayState('artifact_approved')).toBe('draft');
    expect(invalidatedOverlayState('qa_failed')).toBe('draft');
  });

  it('leaves every other state exactly as it was', () => {
    expect(invalidatedOverlayState('needs_input')).toBe('needs_input');
    expect(invalidatedOverlayState('conflict')).toBe('conflict');
    expect(invalidatedOverlayState('draft')).toBe('draft');
  });
});

function fact(partial: Partial<CvEvidenceFact> = {}): CvEvidenceFact {
  return makeFact({
    activity: 'Designed the GraphQL schema',
    mechanism: 'Apollo Server, schema-first',
    result: 'cut client-side overfetching',
    ownership: 'unknown',
    ...partial,
  });
}

describe('deriveWordingFromFact (#419, step 4)', () => {
  it('joins activity, mechanism and result using only the fact\'s own words', () => {
    expect(deriveWordingFromFact(fact())).toBe(
      'Designed the GraphQL schema, using Apollo Server, schema-first, cut client-side overfetching',
    );
  });

  it('omits the mechanism/result clauses when the fact does not state them', () => {
    expect(deriveWordingFromFact(fact({ mechanism: '', result: '' }))).toBe('Designed the GraphQL schema');
  });
});

describe('proposeWordingFromFacts (#419, step 4)', () => {
  it('proposes one draft variant per approved self-reported fact with no existing wording', () => {
    const proposed = proposeWordingFromFacts(overlay({ facts: [fact()] }));
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      targetField: 'experience_bullet',
      parentId: 'experience-1',
      text: deriveWordingFromFact(fact()),
      factIds: ['fact-1'],
      status: 'draft',
      approvedAt: '',
    });
  });

  it('proposes nothing for a fact the candidate has not approved or that is rejected', () => {
    expect(proposeWordingFromFacts(overlay({ facts: [fact({ approval: 'proposed' })] }))).toEqual([]);
    expect(proposeWordingFromFacts(overlay({ facts: [fact({ approval: 'rejected' })] }))).toEqual([]);
  });

  it('never re-proposes wording the candidate rejected', () => {
    const rejected = wording({ status: 'rejected', rejectedAt: '2026-10-01T00:00:00.000Z' });
    expect(proposeWordingFromFacts(overlay({ facts: [fact()], wordingVariants: [rejected] }))).toEqual([]);
  });

  it('targets project_description for a project-scoped fact', () => {
    const proposed = proposeWordingFromFacts(
      overlay({ facts: [fact({ parentId: 'project-1', parentType: 'project' })] }),
    );
    expect(proposed[0]?.targetField).toBe('project_description');
    expect(proposed[0]?.parentId).toBe('project-1');
  });

  it('never proposes wording for a candidate_confirmed_gap or corroborated fact', () => {
    const proposed = proposeWordingFromFacts(
      overlay({
        facts: [
          fact({ factId: 'fact-2', verification: 'candidate_confirmed_gap' }),
          fact({ factId: 'fact-3', verification: 'corroborated' }),
        ],
      }),
    );
    expect(proposed).toEqual([]);
  });

  it('never proposes wording twice for a fact that already backs an existing variant', () => {
    const existing = wording({ factIds: ['fact-1'] });
    const proposed = proposeWordingFromFacts(overlay({ facts: [fact()], wordingVariants: [existing] }));
    expect(proposed).toEqual([]);
  });
});

describe('withJdRevision (#421)', () => {
  it('appends a new revision when the JD text actually changes', () => {
    const base = overlay({ jdSnapshot: 'v1', jdSnapshotHash: 'h1', jdComplete: true, jdRevisions: [] });
    const revisions = withJdRevision(base, 'v2', 'h2', true, '2026-10-01T00:00:00.000Z');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ text: 'v2', textHash: 'h2', complete: true, capturedAt: '2026-10-01T00:00:00.000Z' });
  });

  it('does not pad the history when the write resends the exact current text, hash and completeness', () => {
    const base = overlay({ jdSnapshot: 'v1', jdSnapshotHash: 'h1', jdComplete: true, jdRevisions: [] });
    const revisions = withJdRevision(base, 'v1', 'h1', true, '2026-10-01T00:00:00.000Z');
    expect(revisions).toBe(base.jdRevisions);
  });

  it('treats only jdComplete flipping as a change too, even with identical text', () => {
    const base = overlay({ jdSnapshot: 'v1', jdSnapshotHash: 'h1', jdComplete: false, jdRevisions: [] });
    const revisions = withJdRevision(base, 'v1', 'h1', true, '2026-10-01T00:00:00.000Z');
    expect(revisions).toHaveLength(1);
  });

  it('preserves earlier revisions rather than replacing them', () => {
    const earlier = { revisionId: 'r-1', text: 'v1', textHash: 'h1', complete: true, capturedAt: '2026-09-30T00:00:00.000Z', origin: 'found' as const, url: '', requisition: '', incompleteReasons: [], warning: '' };
    const base = overlay({ jdSnapshot: 'v1', jdSnapshotHash: 'h1', jdComplete: true, jdRevisions: [earlier] });
    const revisions = withJdRevision(base, 'v2', 'h2', true, '2026-10-01T00:00:00.000Z');
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toEqual(earlier);
  });
});
