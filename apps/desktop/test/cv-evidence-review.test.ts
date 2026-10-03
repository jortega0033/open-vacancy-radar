import { describe, expect, it } from 'vitest';
import {
  describeCvEvidenceOverlayGaps,
  describeCvRequirementGaps,
  describeCvRequirementGapRows,
  editCvWordingVariant,
  findCvFactConflicts,
  locateJdQuote,
  reconcileCvEvidence,
  requirementDedupeKeys,
  supersedeCvFact,
  unbackedNumbers,
  verifyCvRequirementQuotes,
} from '../electron/workspace/cv-evidence-schema.js';
import { FIXTURE_HASH, FIXTURE_JD, FIXTURE_REVISION_ID, makeFact, makeOverlay, makeRequirement, makeVariant } from './fixtures/cv-evidence.js';

const NOW = '2026-10-01T00:00:00.000Z';
const CONTEXT = { sourceCvContentHash: FIXTURE_HASH, now: NOW };

describe('locateJdQuote (#419, step 5)', () => {
  it('finds an exact passage and returns its half-open span', () => {
    const span = locateJdQuote(FIXTURE_JD, 'The team also values Angular');
    expect(span).toEqual({ start: FIXTURE_JD.indexOf('The team'), end: FIXTURE_JD.indexOf('The team') + 'The team also values Angular'.length });
  });

  it('refuses a paraphrase, a case change, a re-spaced quote and an empty quote', () => {
    expect(locateJdQuote(FIXTURE_JD, 'React experience is required')).toBeNull();
    expect(locateJdQuote(FIXTURE_JD, 'experience with react')).toBeNull();
    expect(locateJdQuote(FIXTURE_JD, 'Experience  with React')).toBeNull();
    expect(locateJdQuote(FIXTURE_JD, '   ')).toBeNull();
  });

  it('trims the quote edges only', () => {
    expect(locateJdQuote(FIXTURE_JD, '  Experience with React  ')).toEqual({ start: 0, end: 'Experience with React'.length });
  });

  it('prefers an occurrence not already taken, and falls back to the first when all are taken', () => {
    const text = 'Must know SQL. Also: must know SQL.';
    const first = locateJdQuote(text, 'must know SQL');
    expect(first?.start).toBe(text.indexOf('must know SQL'));
    expect(locateJdQuote(text, 'Must know SQL')?.start).toBe(0);
    const second = locateJdQuote(text, 'know SQL', new Set([text.indexOf('know SQL')]));
    expect(second?.start).toBe(text.lastIndexOf('know SQL'));
    expect(locateJdQuote(text, 'know SQL', new Set([text.indexOf('know SQL'), text.lastIndexOf('know SQL')]))?.start).toBe(
      text.indexOf('know SQL'),
    );
  });
});

describe('requirementDedupeKeys', () => {
  it('matches the same wording or the same quote regardless of case and spacing', () => {
    const a = requirementDedupeKeys({ text: 'React  experience', jdAnchor: 'Must know React' });
    const b = requirementDedupeKeys({ text: 'Knowledge of React', jdAnchor: 'must  know react' });
    expect(a.some((key) => b.includes(key))).toBe(true);
    const c = requirementDedupeKeys({ text: 'Other', jdAnchor: 'Different quote' });
    expect(a.some((key) => c.includes(key))).toBe(false);
  });
});

describe('verifyCvRequirementQuotes', () => {
  const revisionId = FIXTURE_REVISION_ID;

  it('throws for a new requirement whose quote is not in the JD, naming the quote', () => {
    const invented = makeRequirement({ requirementId: 'r-new', jdAnchor: 'Must hold a security clearance', quoteStart: 0, quoteEnd: 5 });
    expect(() => verifyCvRequirementQuotes([invented], [], FIXTURE_JD, revisionId)).toThrow(/not an exact quote from the job description/);
  });

  it('computes the span and revision itself and ignores what the caller sent', () => {
    const claimed = makeRequirement({ requirementId: 'r-new', jdAnchor: 'The team also values Angular', quoteStart: 3, quoteEnd: 9, jdRevisionId: 'forged' });
    const [saved] = verifyCvRequirementQuotes([claimed], [], FIXTURE_JD, revisionId);
    expect(saved).toMatchObject({ quoteStart: FIXTURE_JD.indexOf('The team'), jdRevisionId: revisionId });
  });

  it('keeps the stored span of an unchanged requirement, whatever the caller sent back', () => {
    const stored = makeRequirement();
    const tampered = { ...stored, quoteStart: 40, quoteEnd: 44, jdRevisionId: 'forged' };
    const [saved] = verifyCvRequirementQuotes([tampered], [stored], FIXTURE_JD, revisionId);
    expect(saved).toMatchObject({ quoteStart: stored.quoteStart, quoteEnd: stored.quoteEnd, jdRevisionId: revisionId });
  });

  it('does not refuse an unchanged legacy requirement whose quote cannot be found, so the candidate can still fix it', () => {
    const legacy = makeRequirement({ jdAnchor: 'A section label', quoteStart: -1, quoteEnd: -1, reviewed: false });
    const [saved] = verifyCvRequirementQuotes([legacy], [legacy], FIXTURE_JD, revisionId);
    expect(saved?.quoteStart).toBe(-1);
  });

  it('gives two requirements that quote the same words different occurrences when the text has two', () => {
    const text = 'Must know SQL. Also: must know SQL.';
    const a = makeRequirement({ requirementId: 'a', text: 'SQL', jdAnchor: 'know SQL' });
    const b = makeRequirement({ requirementId: 'b', text: 'SQL again', jdAnchor: 'know SQL' });
    const saved = verifyCvRequirementQuotes([a, b], [], text, revisionId);
    expect(saved[0]?.quoteStart).not.toBe(saved[1]?.quoteStart);
  });

  it('lets an excluded requirement be saved without a findable quote', () => {
    const excluded = makeRequirement({ requirementId: 'r-x', jdAnchor: 'gone', excluded: true, exclusionReason: 'Not part of the posting', quoteStart: -1, quoteEnd: -1 });
    expect(() => verifyCvRequirementQuotes([excluded], [], FIXTURE_JD, revisionId)).not.toThrow();
  });
});

describe('describeCvRequirementGaps (#419, steps 5 and 6)', () => {
  const gaps = (overrides = {}) => describeCvRequirementGaps(makeOverlay(overrides));

  it('is clean for a reviewed, verified list with confirmed coverage', () => {
    expect(gaps({ requirements: [makeRequirement()] })).toEqual([]);
  });

  it('never claims coverage while extraction is partial or was never run', () => {
    expect(gaps({ requirementCoverage: { status: 'partial', revisionId: FIXTURE_REVISION_ID, batches: 1 } })).toEqual([
      expect.stringContaining('job requirements may be missing'),
    ]);
    expect(gaps({ requirementCoverage: { status: 'not_run', revisionId: '', batches: 0 } })).toEqual([
      expect.stringContaining('not been read and confirmed'),
    ]);
  });

  it('treats coverage recorded for an older JD revision as not run', () => {
    expect(gaps({ requirementCoverage: { status: 'complete', revisionId: 'older', batches: 1 } })).toEqual([
      expect.stringContaining('not been read and confirmed'),
    ]);
  });

  it('names the requirements behind each reason so the review screen can link to them', () => {
    const rows = describeCvRequirementGapRows(
      makeOverlay({
        requirements: [
          makeRequirement({ requirementId: 'open-1', reviewed: false }),
          makeRequirement({ requirementId: 'open-2', reviewed: false }),
          makeRequirement({ requirementId: 'fine' }),
          makeRequirement({ requirementId: 'excluded', reviewed: false, excluded: true, exclusionReason: 'Not part of the posting' }),
        ],
        requirementCoverage: { status: 'partial', revisionId: FIXTURE_REVISION_ID, batches: 1 },
      }),
    );
    expect(rows).toEqual([
      { reason: expect.stringContaining('job requirements may be missing'), requirementIds: [] },
      { reason: expect.stringContaining('2 job requirements have not been reviewed'), requirementIds: ['open-1', 'open-2'] },
    ]);
  });

  it('keeps an unreviewed material item blocking even when coverage is complete', () => {
    expect(gaps({ requirements: [makeRequirement({ reviewed: false })] })).toEqual([expect.stringContaining('not been reviewed')]);
  });

  it('reports requirements read against an older JD and ones with no quote in the JD', () => {
    const reasons = gaps({
      requirements: [
        makeRequirement({ requirementId: 'old', jdRevisionId: 'older' }),
        makeRequirement({ requirementId: 'quoteless', quoteStart: -1, quoteEnd: -1 }),
      ],
    });
    expect(reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('older job description'), expect.stringContaining('could not be found in the job description')]),
    );
  });

  it('leaves an excluded requirement out of every count and still lists it on the overlay', () => {
    const excluded = makeRequirement({
      requirementId: 'x',
      excluded: true,
      exclusionReason: 'Describes the company',
      reviewed: false,
      jdRevisionId: 'older',
      quoteStart: -1,
      quoteEnd: -1,
      evidenceClass: 'needs_verification',
    });
    const overlay = makeOverlay({ requirements: [excluded, makeRequirement()] });
    expect(describeCvRequirementGaps(overlay)).toEqual([]);
    expect(overlay.requirements).toHaveLength(2);
    expect(overlay.requirements[0]).toMatchObject({ excluded: true, exclusionReason: 'Describes the company' });
  });

  it('accepts a candidate-confirmed gap as resolved, and flags one that also links a fact', () => {
    const gap = makeRequirement({ evidenceClass: 'candidate_confirmed_gap', anchorParentId: '' });
    expect(gaps({ requirements: [gap] })).toEqual([]);
    const contradictory = makeRequirement({ evidenceClass: 'candidate_confirmed_gap', factIds: ['fact-1'] });
    expect(gaps({ requirements: [contradictory], facts: [makeFact()] })).toEqual([expect.stringContaining('also links a fact')]);
  });

  it('flags a requirement linking a fact that is not approved or does not exist', () => {
    const linked = makeRequirement({ factIds: ['fact-1'] });
    expect(gaps({ requirements: [linked], facts: [makeFact({ approval: 'proposed' })] })).toEqual([expect.stringContaining('not approved')]);
    expect(gaps({ requirements: [linked], facts: [] })).toEqual([expect.stringContaining('not approved')]);
    expect(gaps({ requirements: [linked], facts: [makeFact()] })).toEqual([]);
  });
});

describe('findCvFactConflicts (#419, step 7)', () => {
  const a = makeFact({ factId: 'a', activity: 'Built the booking screens', ownership: 'sole', timePhase: '2021' });

  it('flags the same work stated as sole and as shared in the same phase', () => {
    const conflicts = findCvFactConflicts([a, makeFact({ factId: 'b', activity: 'Built the booking screens', ownership: 'shared', timePhase: '2021' })]);
    expect(conflicts).toEqual([{ factIds: ['a', 'b'], reason: expect.stringContaining('alone') }]);
  });

  it('flags different numbers for the same work', () => {
    const conflicts = findCvFactConflicts([
      makeFact({ factId: 'a', metricValue: '30', metricUnit: '%', metricBasis: 'report' }),
      makeFact({ factId: 'b', metricValue: '45', metricUnit: '%', metricBasis: 'report' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toMatch(/different numbers/);
  });

  it('does not flag different time phases, different roles, different work, or facts already rejected or replaced', () => {
    expect(findCvFactConflicts([a, makeFact({ factId: 'b', ownership: 'shared', timePhase: '2023' })])).toEqual([]);
    expect(findCvFactConflicts([a, makeFact({ factId: 'b', ownership: 'shared', timePhase: '2021', parentId: 'experience-2' })])).toEqual([]);
    expect(findCvFactConflicts([a, makeFact({ factId: 'b', activity: 'Wrote the release notes', ownership: 'shared', timePhase: '2021' })])).toEqual([]);
    expect(findCvFactConflicts([a, makeFact({ factId: 'b', ownership: 'shared', timePhase: '2021', approval: 'rejected' })])).toEqual([]);
    expect(findCvFactConflicts([a, makeFact({ factId: 'b', ownership: 'shared', timePhase: '2021', approval: 'superseded' })])).toEqual([]);
  });

  it('never treats a confirmed gap as contradicting a claim about different work', () => {
    const gap = makeFact({ factId: 'g', activity: '', verification: 'candidate_confirmed_gap', ownership: 'unknown' });
    expect(findCvFactConflicts([a, gap])).toEqual([]);
  });

  it('adds a gap reason to the overlay while a contradiction stands', () => {
    const facts = [a, makeFact({ factId: 'b', activity: 'Built the booking screens', ownership: 'shared', timePhase: '2021' })];
    expect(describeCvEvidenceOverlayGaps(makeOverlay({ facts }), FIXTURE_HASH)).toEqual([expect.stringContaining('contradict each other')]);
  });
});

describe('supersedeCvFact', () => {
  it('keeps the old fact as superseded, adds a corrected proposed fact linked back to it, and revokes the wording that cited it', () => {
    const overlay = makeOverlay({
      facts: [makeFact({ timePhase: 'first year' })],
      wordingVariants: [makeVariant(), makeVariant({ variantId: 'v-other', factIds: ['fact-other'] }), makeVariant({ variantId: 'v-draft', status: 'draft' })],
    });
    const next = supersedeCvFact(overlay, 'fact-1', { activity: 'Rebuilt the booking screens' }, NOW);

    expect(next.facts.find((fact) => fact.factId === 'fact-1')?.approval).toBe('superseded');
    expect(next.replacement).toMatchObject({ supersedes: 'fact-1', approval: 'proposed', activity: 'Rebuilt the booking screens', createdAt: NOW });
    // The correction keeps the time phase unless the candidate changes it.
    expect(next.replacement.timePhase).toBe('first year');
    expect(next.replacement.factId).not.toBe('fact-1');
    const status = (id: string) => next.wordingVariants.find((variant) => variant.variantId === id)?.status;
    expect(status('v-1')).toBe('superseded');
    expect(status('v-other')).toBe('candidate_approved');
    expect(status('v-draft')).toBe('draft');
  });

  it('refuses to replace a fact that was already replaced or rejected, or does not exist', () => {
    const overlay = makeOverlay({ facts: [makeFact({ approval: 'rejected' })] });
    expect(() => supersedeCvFact(overlay, 'fact-1', {}, NOW)).toThrow(/already replaced or rejected/);
    expect(() => supersedeCvFact(overlay, 'missing', {}, NOW)).toThrow(/does not exist/);
  });
});

describe('editCvWordingVariant (#419, step 7)', () => {
  it('creates a new draft variant, keeps the old one as superseded, and links the two', () => {
    const base = [makeVariant()];
    const { wordingVariants, replacement } = editCvWordingVariant(base, 'v-1', '  A different sentence.  ');
    expect(wordingVariants).toHaveLength(2);
    expect(wordingVariants[0]).toMatchObject({ variantId: 'v-1', status: 'superseded', text: 'Approved wording.' });
    expect(replacement).toMatchObject({ status: 'draft', text: 'A different sentence.', supersedes: 'v-1', approvedAt: '', factIds: ['fact-1'] });
    expect(replacement.variantId).not.toBe('v-1');
  });

  it('refuses to edit a rejected or already replaced variant', () => {
    expect(() => editCvWordingVariant([makeVariant({ status: 'rejected' })], 'v-1', 'x')).toThrow(/already rejected or replaced/);
  });
});

describe('unbackedNumbers', () => {
  const facts = [makeFact({ activity: 'Cut load time', metricValue: '30', metricUnit: '%', metricBasis: 'a report' })];

  it('accepts numbers that a cited fact states and reports ones it does not', () => {
    expect(unbackedNumbers('Cut load time by 30%', facts)).toEqual([]);
    expect(unbackedNumbers('Cut load time by 45%', facts)).toEqual(['45']);
    expect(unbackedNumbers('Led 12 engineers', [makeFact()])).toEqual(['12']);
  });
});

describe('reconcileCvEvidence', () => {
  const fact = makeFact();

  it('stamps approval time and source revision itself, ignoring what the caller sent', () => {
    const draft = makeVariant({ status: 'draft', approvedAt: '', sourceRevision: '' });
    const asked = { ...draft, status: 'candidate_approved' as const, approvedAt: '1999-01-01T00:00:00.000Z', sourceRevision: 'forged' };
    const { wordingVariants } = reconcileCvEvidence({ facts: [fact], wordingVariants: [draft] }, { facts: [fact], wordingVariants: [asked] }, CONTEXT);
    expect(wordingVariants[0]).toMatchObject({ status: 'candidate_approved', approvedAt: NOW, sourceRevision: FIXTURE_HASH });
  });

  it('refuses to approve wording that cites a plausible fact id the case does not have', () => {
    const draft = makeVariant({ status: 'draft', approvedAt: '', factIds: ['fact-plausible-but-fake'] });
    expect(() =>
      reconcileCvEvidence({ facts: [fact], wordingVariants: [draft] }, { facts: [fact], wordingVariants: [{ ...draft, status: 'candidate_approved' }] }, CONTEXT),
    ).toThrow(/does not exist on this case/);
  });

  it('refuses to approve wording that cites no fact at all', () => {
    const draft = makeVariant({ status: 'draft', approvedAt: '', factIds: [] });
    expect(() =>
      reconcileCvEvidence({ facts: [fact], wordingVariants: [draft] }, { facts: [fact], wordingVariants: [{ ...draft, status: 'candidate_approved' }] }, CONTEXT),
    ).toThrow(/does not exist on this case/);
  });

  it('refuses to approve wording on a fact that is proposed, rejected, superseded or contradicted', () => {
    for (const approval of ['proposed', 'rejected', 'superseded'] as const) {
      const dead = makeFact({ approval });
      const draft = makeVariant({ status: 'draft', approvedAt: '' });
      expect(() =>
        reconcileCvEvidence({ facts: [dead], wordingVariants: [draft] }, { facts: [dead], wordingVariants: [{ ...draft, status: 'candidate_approved' }] }, CONTEXT),
      ).toThrow(/not approved or is in a contradiction/);
    }
    const left = makeFact({ factId: 'fact-1', ownership: 'sole' });
    const right = makeFact({ factId: 'fact-2', ownership: 'shared' });
    const draft = makeVariant({ status: 'draft', approvedAt: '' });
    expect(() =>
      reconcileCvEvidence({ facts: [left, right], wordingVariants: [draft] }, { facts: [left, right], wordingVariants: [{ ...draft, status: 'candidate_approved' }] }, CONTEXT),
    ).toThrow(/contradiction/);
  });

  it('refuses a number the cited facts do not state', () => {
    const draft = makeVariant({ status: 'draft', approvedAt: '', text: 'Built the booking screens used by 40000 people' });
    expect(() =>
      reconcileCvEvidence({ facts: [fact], wordingVariants: [draft] }, { facts: [fact], wordingVariants: [{ ...draft, status: 'candidate_approved' }] }, CONTEXT),
    ).toThrow(/number \(40000\)/);
  });

  it('never lets a rejected or superseded wording or fact come back', () => {
    const rejected = makeVariant({ status: 'rejected', rejectedAt: NOW });
    expect(() =>
      reconcileCvEvidence({ facts: [fact], wordingVariants: [rejected] }, { facts: [fact], wordingVariants: [{ ...rejected, status: 'candidate_approved' }] }, CONTEXT),
    ).toThrow(/cannot be reused/);
    const superseded = makeFact({ approval: 'superseded' });
    expect(() =>
      reconcileCvEvidence({ facts: [superseded], wordingVariants: [] }, { facts: [{ ...superseded, approval: 'approved' }], wordingVariants: [] }, CONTEXT),
    ).toThrow(/cannot be reused/);
  });

  it('lets a rejected fact or wording return only to not approved yet, never straight to approved', () => {
    const rejectedFact = makeFact({ approval: 'rejected' });
    const restoredFact = reconcileCvEvidence({ facts: [rejectedFact], wordingVariants: [] }, { facts: [{ ...rejectedFact, approval: 'proposed' }], wordingVariants: [] }, CONTEXT);
    expect(restoredFact.facts[0]).toEqual({ ...rejectedFact, approval: 'proposed' });
    expect(() =>
      reconcileCvEvidence({ facts: [rejectedFact], wordingVariants: [] }, { facts: [{ ...rejectedFact, approval: 'approved' }], wordingVariants: [] }, CONTEXT),
    ).toThrow(/cannot be reused/);

    const rejected = makeVariant({ status: 'rejected', approvedAt: '', rejectedAt: NOW });
    const restored = reconcileCvEvidence({ facts: [fact], wordingVariants: [rejected] }, { facts: [fact], wordingVariants: [{ ...rejected, status: 'draft' }] }, CONTEXT);
    expect(restored.wordingVariants[0]).toMatchObject({ status: 'draft', approvedAt: '', rejectedAt: '', text: rejected.text, factIds: rejected.factIds });

    const superseded = makeVariant({ status: 'superseded' });
    expect(() =>
      reconcileCvEvidence({ facts: [fact], wordingVariants: [superseded] }, { facts: [fact], wordingVariants: [{ ...superseded, status: 'draft' }] }, CONTEXT),
    ).toThrow(/cannot be reused/);
    const supersededFact = makeFact({ approval: 'superseded' });
    expect(() =>
      reconcileCvEvidence({ facts: [supersededFact], wordingVariants: [] }, { facts: [{ ...supersededFact, approval: 'proposed' }], wordingVariants: [] }, CONTEXT),
    ).toThrow(/cannot be reused/);
  });

  it('refuses to edit an approved wording in place', () => {
    const approved = makeVariant();
    expect(() =>
      reconcileCvEvidence({ facts: [fact], wordingVariants: [approved] }, { facts: [fact], wordingVariants: [{ ...approved, text: 'Quietly changed.' }] }, CONTEXT),
    ).toThrow(/editing creates a new variant/);
  });

  it('records a rejection with its time', () => {
    const draft = makeVariant({ status: 'draft', approvedAt: '' });
    const { wordingVariants } = reconcileCvEvidence({ facts: [fact], wordingVariants: [draft] }, { facts: [fact], wordingVariants: [{ ...draft, status: 'rejected' }] }, CONTEXT);
    expect(wordingVariants[0]).toMatchObject({ status: 'rejected', rejectedAt: NOW });
  });

  it('revokes every approved wording that cites a fact whose content was changed', () => {
    const approved = makeVariant();
    const other = makeVariant({ variantId: 'v-2', factIds: ['fact-2'] });
    const secondFact = makeFact({ factId: 'fact-2' });
    const edited = { ...fact, activity: 'Something quite different' };
    const result = reconcileCvEvidence(
      { facts: [fact, secondFact], wordingVariants: [approved, other] },
      { facts: [edited, secondFact], wordingVariants: [approved, other] },
      CONTEXT,
    );
    // The edited fact drops back to proposed, and the wording standing on it is withdrawn.
    expect(result.facts.find((candidate) => candidate.factId === 'fact-1')?.approval).toBe('proposed');
    expect(result.wordingVariants.find((variant) => variant.variantId === 'v-1')?.status).toBe('superseded');
    expect(result.wordingVariants.find((variant) => variant.variantId === 'v-2')?.status).toBe('candidate_approved');
  });

  it('revokes wording when its fact is rejected or becomes part of a contradiction', () => {
    const approved = makeVariant();
    const rejectedFact = { ...fact, approval: 'rejected' as const };
    const afterReject = reconcileCvEvidence({ facts: [fact], wordingVariants: [approved] }, { facts: [rejectedFact], wordingVariants: [approved] }, CONTEXT);
    expect(afterReject.wordingVariants[0]?.status).toBe('superseded');

    const rival = makeFact({ factId: 'fact-2', ownership: 'shared' });
    const sole = makeFact({ ownership: 'sole' });
    const afterConflict = reconcileCvEvidence({ facts: [sole], wordingVariants: [approved] }, { facts: [sole, rival], wordingVariants: [approved] }, CONTEXT);
    expect(afterConflict.wordingVariants[0]?.status).toBe('superseded');
  });
});
