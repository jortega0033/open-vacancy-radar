import { describe, expect, it } from 'vitest';
import {
  deriveWordingFromFact,
  describeCvEvidenceOverlayGaps,
  EMPTY_CV_EVIDENCE_OVERLAY,
  invalidatedOverlayState,
  isCvEvidenceOverlayApprovable,
  proposeWordingFromFacts,
  type CvApprovedWording,
  type CvEvidenceFact,
  type CvEvidenceOverlay,
  type CvRequirementMapping,
} from '../electron/workspace/cv-evidence-schema.js';

const HASH = 'a'.repeat(64);

function overlay(partial: Partial<CvEvidenceOverlay> = {}): CvEvidenceOverlay {
  return { ...EMPTY_CV_EVIDENCE_OVERLAY, sourceCvContentHash: HASH, ...partial };
}

function requirement(partial: Partial<CvRequirementMapping> = {}): CvRequirementMapping {
  return {
    requirementId: 'r-1',
    text: 'Experience with React',
    jdAnchor: '',
    classification: 'required',
    evidenceClass: 'direct',
    anchorParentId: 'experience-1',
    candidateAdded: false,
    reviewed: true,
    ...partial,
  };
}

function wording(partial: Partial<CvApprovedWording> = {}): CvApprovedWording {
  return {
    variantId: 'v-1',
    targetField: 'summary',
    parentId: '',
    text: 'Approved wording.',
    factIds: ['fact-1'],
    status: 'candidate_approved',
    approvedAt: '2026-09-30T00:00:00.000Z',
    sourceRevision: HASH,
    ...partial,
  };
}

describe('describeCvEvidenceOverlayGaps', () => {
  it('is clean for a freshly built, complete, unreviewed-nothing overlay', () => {
    expect(describeCvEvidenceOverlayGaps(overlay(), HASH)).toEqual([]);
  });

  it('flags a source CV that changed since this overlay was built', () => {
    expect(describeCvEvidenceOverlayGaps(overlay(), 'b'.repeat(64))).toEqual([
      'the reviewed source CV has changed since this draft was built',
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
    expect(reasons).toContain('1 requirement(s) have not been reviewed');
  });

  it('never claims complete coverage while a required item still needs verification', () => {
    const reasons = describeCvEvidenceOverlayGaps(
      overlay({ requirements: [requirement({ classification: 'required', evidenceClass: 'needs_verification', reviewed: true })] }),
      HASH,
    );
    expect(reasons).toContain('1 required item(s) still need verification');
  });

  it('does not block on a preferred item needing verification', () => {
    const reasons = describeCvEvidenceOverlayGaps(
      overlay({ requirements: [requirement({ classification: 'preferred', evidenceClass: 'needs_verification', reviewed: true })] }),
      HASH,
    );
    expect(reasons).not.toContain('1 required item(s) still need verification');
  });

  it('flags an approved wording variant whose source revision no longer matches', () => {
    const reasons = describeCvEvidenceOverlayGaps(
      overlay({ sourceCvContentHash: HASH, wordingVariants: [wording({ sourceRevision: 'stale'.padEnd(64, '0') })] }),
      HASH,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('approved wording variant(s) were approved against a different source revision')]),
    );
  });

  it('flags an approved wording variant that cites no fact', () => {
    const reasons = describeCvEvidenceOverlayGaps(overlay({ wordingVariants: [wording({ factIds: [] })] }), HASH);
    expect(reasons).toEqual(expect.arrayContaining([expect.stringContaining('cite no supporting fact')]));
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
      'unresolved conflicting corrections remain',
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
  return {
    factId: 'fact-1',
    parentId: 'experience-1',
    parentType: 'experience',
    client: '',
    activity: 'Designed the GraphQL schema',
    mechanism: 'Apollo Server, schema-first',
    result: 'cut client-side overfetching',
    ownership: 'unknown',
    sourceKind: 'candidate_testimony',
    sourceReference: '',
    verification: 'self_reported',
    metricValue: '',
    metricUnit: '',
    metricBasis: '',
    supersedes: '',
    createdAt: '2026-09-30T00:00:00.000Z',
    ...partial,
  };
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
  it('proposes one candidate_approved variant per self-reported fact with no existing wording', () => {
    const proposed = proposeWordingFromFacts(overlay({ facts: [fact()] }), HASH);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      targetField: 'experience_bullet',
      parentId: 'experience-1',
      text: deriveWordingFromFact(fact()),
      factIds: ['fact-1'],
      status: 'candidate_approved',
      sourceRevision: HASH,
    });
    expect(proposed[0]?.approvedAt).not.toBe('');
  });

  it('targets project_description for a project-scoped fact', () => {
    const proposed = proposeWordingFromFacts(
      overlay({ facts: [fact({ parentId: 'project-1', parentType: 'project' })] }),
      HASH,
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
      HASH,
    );
    expect(proposed).toEqual([]);
  });

  it('never proposes wording twice for a fact that already backs an existing variant', () => {
    const existing = wording({ factIds: ['fact-1'] });
    const proposed = proposeWordingFromFacts(overlay({ facts: [fact()], wordingVariants: [existing] }), HASH);
    expect(proposed).toEqual([]);
  });
});
