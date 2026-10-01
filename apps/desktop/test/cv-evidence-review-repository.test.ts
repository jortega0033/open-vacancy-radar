// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import { editCvWordingVariant, proposeWordingFromFacts, supersedeCvFact } from '../electron/workspace/cv-evidence-schema.js';
import { EMPTY_CV_SOURCE, stableCvSourceJson, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import * as workspace from '../electron/workspace/repository.js';
import { parseCvEvidenceOverlayPatch } from '../electron/workspace/validate.js';
import { makeFact, makeRequirement, makeVariant } from './fixtures/cv-evidence.js';
import { FULL_JD } from './fixtures/job-description.js';

/**
 * Requirement and evidence review (#419, steps 5 to 7) against a real migrated database: the
 * main-process rules that hold whatever the renderer sends.
 */
let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-evidence-review-'));
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
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
    { id: 'experience-2', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2018 - 2021', engagement: 'employment', client: '', bullets: ['Built older things.'] },
  ],
};

const QUOTE_TS = 'You must have at least 4 years of experience building web applications with TypeScript.';
const QUOTE_SQL = 'Experience with relational databases and writing maintainable SQL is required.';
const COVERED = { requirementCoverage: { status: 'complete' as const, batches: 1 } };

function newCase() {
  const cv = workspace.createCvDocument(db, {
    name: 'Resume',
    kind: 'manual',
    profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    source: SOURCE,
  });
  const sourceHash = createHash('sha256').update(stableCvSourceJson(cv.source!)).digest('hex');
  const overlay = workspace.createCvEvidenceOverlay(db, {
    cvId: cv.id,
    vacancyKey: 'url:https://jobs.example.invalid/1',
    sourceCvContentHash: sourceHash,
    jdSnapshot: FULL_JD,
    jdSnapshotHash: 'b'.repeat(64),
  });
  return { cv, overlay, sourceHash };
}

const update = (id: string, patch: Parameters<typeof workspace.updateCvEvidenceOverlay>[2]) => workspace.updateCvEvidenceOverlay(db, id, patch);
const read = (id: string) => workspace.getCvEvidenceOverlayById(db, id);
const approve = (id: string) => workspace.approveCvEvidenceOverlay(db, id, read(id).caseRevision);

/** An approved fact, an approved variant on it, and everything else the overlay needs to be approved. */
function approvedCase() {
  const made = newCase();
  update(made.overlay.id, { facts: [makeFact()], ...COVERED });
  const variant = makeVariant({
    targetField: 'experience_bullet',
    parentId: 'experience-1',
    text: 'Built the booking screens, using Angular and RxJS',
    status: 'candidate_approved',
    approvedAt: '',
    sourceRevision: '',
  });
  update(made.overlay.id, { wordingVariants: [variant] });
  return { ...made, approved: approve(made.overlay.id) };
}

describe('exact quote verification on save (#419, step 5)', () => {
  it('refuses a requirement whose quote is not an exact passage of the stored JD', () => {
    const { overlay } = newCase();
    const invented = makeRequirement({ jdAnchor: 'You must hold a security clearance.' });
    expect(() => update(overlay.id, { requirements: [invented] })).toThrow(/not an exact quote from the job description/);
    expect(read(overlay.id).requirements).toEqual([]);
  });

  it('refuses a paraphrase of a real line, never silently accepting it', () => {
    const { overlay } = newCase();
    const paraphrase = makeRequirement({ jdAnchor: 'You need 4 years of TypeScript web experience.' });
    expect(() => update(overlay.id, { requirements: [paraphrase] })).toThrow(/not an exact quote/);
  });

  it('stores the span and the JD revision it was verified against, computed in the main process', () => {
    const { overlay } = newCase();
    const forged = makeRequirement({ jdAnchor: QUOTE_TS, quoteStart: 1, quoteEnd: 2, jdRevisionId: 'forged' });
    const saved = update(overlay.id, { requirements: [forged] }).requirements[0];
    expect(saved).toMatchObject({
      quoteStart: FULL_JD.indexOf(QUOTE_TS),
      quoteEnd: FULL_JD.indexOf(QUOTE_TS) + QUOTE_TS.length,
      jdRevisionId: overlay.jdRevisions[0]?.revisionId,
    });
    expect(FULL_JD.slice(saved?.quoteStart, saved?.quoteEnd)).toBe(QUOTE_TS);
  });

  it('refuses a candidate-added requirement that has no quote from the frozen text', () => {
    const { overlay } = newCase();
    const added = makeRequirement({ candidateAdded: true, jdAnchor: '' });
    expect(() => update(overlay.id, { requirements: [added] })).toThrow(/not an exact quote/);
  });

  it('is enforced when a client proposal is accepted too, including duplicates', () => {
    const { overlay } = newCase();
    update(overlay.id, { requirements: [makeRequirement({ requirementId: 'r-ts', text: 'TypeScript', jdAnchor: QUOTE_TS })] });
    const bad = workspace.createCvTailoringProposal(db, {
      caseId: overlay.id,
      grantId: '',
      payload: { kind: 'requirement', data: { text: 'Kubernetes', jdAnchor: 'You run Kubernetes clusters', classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '' } },
    });
    expect(() => workspace.acceptCvTailoringProposal(db, bad.id)).toThrow(/not in the job description/);

    const duplicate = workspace.createCvTailoringProposal(db, {
      caseId: overlay.id,
      grantId: '',
      payload: { kind: 'requirement', data: { text: 'TypeScript again', jdAnchor: QUOTE_TS, classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '' } },
    });
    expect(() => workspace.acceptCvTailoringProposal(db, duplicate.id)).toThrow(/already on the list/);

    const good = workspace.createCvTailoringProposal(db, {
      caseId: overlay.id,
      grantId: '',
      payload: { kind: 'requirement', data: { text: 'SQL', jdAnchor: QUOTE_SQL, classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '' } },
    });
    const { overlay: updated } = workspace.acceptCvTailoringProposal(db, good.id);
    expect(updated.requirements.at(-1)).toMatchObject({ text: 'SQL', reviewed: false, candidateAdded: true, quoteStart: FULL_JD.indexOf(QUOTE_SQL) });
  });
});

describe('exclusion (#419, step 5)', () => {
  it('persists a requirement marked as not a requirement, with its reason, and keeps it in the list', () => {
    const { overlay } = newCase();
    const list = [
      makeRequirement({ requirementId: 'r-1', text: 'TypeScript', jdAnchor: QUOTE_TS }),
      makeRequirement({ requirementId: 'r-2', text: 'English', jdAnchor: 'Fluent English is essential because the team works across time zones.', excluded: true, exclusionReason: 'Describes the team setting', reviewed: true }),
    ];
    update(overlay.id, { requirements: list });
    const reread = read(overlay.id).requirements;
    expect(reread).toHaveLength(2);
    expect(reread[1]).toMatchObject({ excluded: true, exclusionReason: 'Describes the team setting' });
  });

  it('refuses an exclusion with no reason at the validation boundary', () => {
    expect(() => parseCvEvidenceOverlayPatch({ requirements: [{ ...makeRequirement(), excluded: true, exclusionReason: '  ' }] })).toThrow(/exclusionReason/);
    expect(
      parseCvEvidenceOverlayPatch({ requirements: [{ ...makeRequirement(), excluded: true, exclusionReason: 'Not the role' }] }).requirements?.[0],
    ).toMatchObject({ excluded: true, exclusionReason: 'Not the role' });
  });

  it('does not count an excluded requirement toward approval, and an excluded one needs no quote', () => {
    const { overlay } = newCase();
    update(overlay.id, {
      requirements: [makeRequirement({ jdAnchor: 'text that is nowhere', excluded: true, exclusionReason: 'Not a requirement', reviewed: false })],
      ...COVERED,
    });
    expect(approve(overlay.id).state).toBe('candidate_approved');
  });
});

describe('requirement coverage and batching gate (#419, step 5)', () => {
  it('refuses approval while extraction is partial, and records the batches read', () => {
    const { overlay } = newCase();
    const partial = update(overlay.id, { requirements: [makeRequirement({ jdAnchor: QUOTE_TS })], requirementCoverage: { status: 'partial', batches: 3 } });
    expect(partial.requirementCoverage).toEqual({ status: 'partial', revisionId: partial.jdRevisions[0]?.revisionId, batches: 3 });
    expect(() => approve(overlay.id)).toThrow(/requirement list is partial/);
  });

  it('refuses approval when extraction never ran, even with no requirements at all', () => {
    const { overlay } = newCase();
    expect(() => approve(overlay.id)).toThrow(/not been extracted and confirmed/);
  });

  it('keeps an unreviewed material item blocking after the candidate confirmed coverage', () => {
    const { overlay } = newCase();
    update(overlay.id, { requirements: [makeRequirement({ jdAnchor: QUOTE_TS, reviewed: false })], ...COVERED });
    expect(() => approve(overlay.id)).toThrow(/have not been reviewed/);
  });

  it('cannot confirm coverage of an empty job description', () => {
    const cv = workspace.createCvDocument(db, { name: 'R', kind: 'manual', profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' } });
    const empty = workspace.createCvEvidenceOverlay(db, { cvId: cv.id, vacancyKey: 'v-empty', sourceCvContentHash: 'a'.repeat(64), jdSnapshotHash: 'b'.repeat(64) });
    expect(() => update(empty.id, COVERED)).toThrow(/no job description text/);
  });

  it('resets coverage for a new JD revision: the old confirmation does not carry over', () => {
    const { overlay } = newCase();
    update(overlay.id, COVERED);
    update(overlay.id, { jdSnapshot: `${FULL_JD}\nAlso: GraphQL is required.`, jdSnapshotHash: 'c'.repeat(64) });
    expect(() => approve(overlay.id)).toThrow(/not been extracted and confirmed/);
  });
});

describe('links, confirmed gaps and unknown ids (#419, step 6)', () => {
  it('stores several source and fact links and a candidate-confirmed gap', () => {
    const { overlay } = newCase();
    update(overlay.id, { facts: [makeFact({ factId: 'fact-a' }), makeFact({ factId: 'fact-b', activity: 'Wrote tests' })] });
    const saved = update(overlay.id, {
      requirements: [
        makeRequirement({ requirementId: 'r-1', jdAnchor: QUOTE_TS, sourceIds: ['experience-1', 'experience-2'], factIds: ['fact-a', 'fact-b'] }),
        makeRequirement({ requirementId: 'r-2', text: 'SQL', jdAnchor: QUOTE_SQL, evidenceClass: 'candidate_confirmed_gap', anchorParentId: '' }),
      ],
    }).requirements;
    expect(saved[0]).toMatchObject({ sourceIds: ['experience-1', 'experience-2'], factIds: ['fact-a', 'fact-b'] });
    expect(saved[1]?.evidenceClass).toBe('candidate_confirmed_gap');
  });

  it('refuses a link to a fact the case does not have, or to a role the source does not have', () => {
    const { overlay } = newCase();
    expect(() => update(overlay.id, { requirements: [makeRequirement({ jdAnchor: QUOTE_TS, factIds: ['fact-made-up'] })] })).toThrow(/fact that does not exist/);
    expect(() => update(overlay.id, { requirements: [makeRequirement({ jdAnchor: QUOTE_TS, sourceIds: ['experience-99'] })] })).toThrow(/does not exist in the reviewed source/);
  });

  it('blocks approval while a linked fact is only proposed', () => {
    const { overlay } = newCase();
    update(overlay.id, { facts: [makeFact({ approval: 'proposed' })] });
    update(overlay.id, { requirements: [makeRequirement({ jdAnchor: QUOTE_TS, factIds: ['fact-1'] })], ...COVERED });
    expect(() => approve(overlay.id)).toThrow(/link to a fact that is not approved/);
  });
});

describe('fact approval and correction (#419, step 7)', () => {
  it('revokes every wording variant that cites a corrected fact and drops the case out of approved', () => {
    const { overlay, approved } = approvedCase();
    expect(approved.state).toBe('candidate_approved');
    expect(approved.wordingVariants[0]?.status).toBe('candidate_approved');

    // A second approved wording on the same fact, to prove every dependent variant is revoked.
    const second = makeVariant({ variantId: 'v-2', targetField: 'experience_bullet', parentId: 'experience-1', text: 'Maintained the booking screens', approvedAt: '', sourceRevision: '' });
    const withSecond = update(overlay.id, { wordingVariants: [...approved.wordingVariants, second] });
    const reapproved = approve(overlay.id);
    expect(withSecond.wordingVariants).toHaveLength(2);
    expect(reapproved.state).toBe('candidate_approved');

    const next = supersedeCvFact(reapproved, 'fact-1', { activity: 'Rebuilt the booking screens' }, new Date().toISOString());
    const corrected = update(overlay.id, { facts: next.facts, wordingVariants: next.wordingVariants });

    expect(corrected.wordingVariants.map((variant) => variant.status)).toEqual(['superseded', 'superseded']);
    expect(corrected.facts.find((fact) => fact.factId === 'fact-1')?.approval).toBe('superseded');
    expect(corrected.facts.find((fact) => fact.supersedes === 'fact-1')?.approval).toBe('proposed');
    expect(corrected.state).toBe('draft');
    // Re-approval now composes none of the withdrawn wording.
    update(overlay.id, COVERED);
    const again = approve(overlay.id);
    expect(again.approvedResumeSnapshot?.resume.experience[0]?.bullets).toEqual(['Built things.']);
  });

  it('revokes dependent wording even when only a fact edit is sent (the caller forgot to withdraw it)', () => {
    const { overlay, approved } = approvedCase();
    const edited = approved.facts.map((fact) => ({ ...fact, activity: 'Something else entirely' }));
    const after = update(overlay.id, { facts: edited });
    expect(after.wordingVariants[0]?.status).toBe('superseded');
    expect(after.facts[0]?.approval).toBe('proposed');
    expect(after.state).toBe('draft');
  });

  it('revokes wording when its fact is rejected', () => {
    const { overlay, approved } = approvedCase();
    const after = update(overlay.id, { facts: approved.facts.map((fact) => ({ ...fact, approval: 'rejected' as const })) });
    expect(after.wordingVariants[0]?.status).toBe('superseded');
    expect(after.state).toBe('draft');
  });

  it('never lets a rejected or replaced fact come back as approved', () => {
    const { overlay } = newCase();
    update(overlay.id, { facts: [makeFact({ approval: 'rejected' })] });
    expect(() => update(overlay.id, { facts: [makeFact({ approval: 'approved' })] })).toThrow(/cannot be reused/);
  });
});

describe('contradictions block use (#419, step 7)', () => {
  const sole = makeFact({ factId: 'fact-1', ownership: 'sole', timePhase: '2021' });
  const shared = makeFact({ factId: 'fact-2', ownership: 'shared', timePhase: '2021' });

  it('puts the case in conflict, blocks approval, and lifts when one fact is rejected', () => {
    const { overlay } = newCase();
    update(overlay.id, COVERED);
    const conflicted = update(overlay.id, { facts: [sole, shared] });
    expect(conflicted.state).toBe('conflict');
    expect(() => approve(overlay.id)).toThrow(/contradict each other/);

    const resolved = update(overlay.id, { facts: [sole, { ...shared, approval: 'rejected' }] });
    expect(resolved.state).toBe('draft');
    expect(approve(overlay.id).state).toBe('candidate_approved');
  });

  it('withdraws already approved wording when a contradicting fact arrives', () => {
    const { overlay, approved } = approvedCase();
    const rival = makeFact({ factId: 'fact-2', ownership: 'shared', approval: 'proposed' });
    const after = update(overlay.id, { facts: [...approved.facts, rival] });
    expect(after.state).toBe('conflict');
    expect(after.wordingVariants[0]?.status).toBe('superseded');
  });

  it('does not approve wording on a contradicted fact', () => {
    const { overlay } = newCase();
    update(overlay.id, { facts: [sole, shared] });
    const draft = makeVariant({ status: 'candidate_approved', approvedAt: '' });
    expect(() => update(overlay.id, { wordingVariants: [draft] })).toThrow(/not approved or is in a contradiction/);
  });
});

describe('per-variant wording review (#419, step 7)', () => {
  it('proposes drafts that approving the whole CV never approves', () => {
    const { overlay } = newCase();
    const facts = update(overlay.id, { facts: [makeFact()], ...COVERED });
    const drafts = proposeWordingFromFacts(facts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.status).toBe('draft');
    update(overlay.id, { wordingVariants: drafts });
    const approved = approve(overlay.id);
    expect(approved.wordingVariants[0]?.status).toBe('draft');
    expect(approved.approvedResumeSnapshot?.resume.experience[0]?.bullets).toEqual(['Built things.']);
  });

  it('approves one exact displayed wording at a time, stamping the approval in the main process', () => {
    const { overlay } = newCase();
    const facts = update(overlay.id, { facts: [makeFact()], ...COVERED });
    const [draft] = proposeWordingFromFacts(facts);
    update(overlay.id, { wordingVariants: [draft!] });
    const approvedOne = update(overlay.id, { wordingVariants: [{ ...draft!, status: 'candidate_approved', approvedAt: '1999-01-01T00:00:00.000Z' }] });
    expect(approvedOne.wordingVariants[0]?.status).toBe('candidate_approved');
    expect(approvedOne.wordingVariants[0]?.approvedAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(approvedOne.wordingVariants[0]?.sourceRevision).toBe(approvedOne.sourceCvContentHash);
    expect(approve(overlay.id).approvedResumeSnapshot?.resume.experience[0]?.bullets).toContain(draft?.text);
  });

  it('editing creates a new variant, keeps the old one superseded in history, and the new one starts as a draft', () => {
    const { overlay, approved } = approvedCase();
    const edit = editCvWordingVariant(approved.wordingVariants, approved.wordingVariants[0]!.variantId, 'Built the booking screens for 2 regions');
    const edited = update(overlay.id, { wordingVariants: edit.wordingVariants });
    expect(edited.wordingVariants).toHaveLength(2);
    expect(edited.wordingVariants[0]?.status).toBe('superseded');
    expect(edited.wordingVariants[1]).toMatchObject({ status: 'draft', supersedes: approved.wordingVariants[0]?.variantId });
    expect(edited.state).toBe('draft');
  });

  it('refuses an in-place edit of an approved wording', () => {
    const { overlay, approved } = approvedCase();
    const tampered = approved.wordingVariants.map((variant) => ({ ...variant, text: 'Sneaked in after approval' }));
    expect(() => update(overlay.id, { wordingVariants: tampered })).toThrow(/editing creates a new variant/);
  });

  it('refuses to approve an edit that introduces a number no fact states', () => {
    const { overlay, approved } = approvedCase();
    const edit = editCvWordingVariant(approved.wordingVariants, approved.wordingVariants[0]!.variantId, 'Built the booking screens used by 40000 people');
    update(overlay.id, { wordingVariants: edit.wordingVariants });
    const asked = edit.wordingVariants.map((variant) => (variant.status === 'draft' ? { ...variant, status: 'candidate_approved' as const } : variant));
    expect(() => update(overlay.id, { wordingVariants: asked })).toThrow(/number \(40000\)/);
  });

  it('records a rejection and never uses or revives the rejected wording', () => {
    const { overlay } = newCase();
    const facts = update(overlay.id, { facts: [makeFact()], ...COVERED });
    const [draft] = proposeWordingFromFacts(facts);
    const rejected = update(overlay.id, { wordingVariants: [{ ...draft!, status: 'rejected' }] });
    expect(rejected.wordingVariants[0]).toMatchObject({ status: 'rejected' });
    expect(rejected.wordingVariants[0]?.rejectedAt).not.toBe('');
    expect(() => update(overlay.id, { wordingVariants: [{ ...rejected.wordingVariants[0]!, status: 'candidate_approved' }] })).toThrow(/cannot be reused/);
    expect(approve(overlay.id).approvedResumeSnapshot?.resume.experience[0]?.bullets).toEqual(['Built things.']);
    // And it is not proposed a second time.
    expect(proposeWordingFromFacts(read(overlay.id))).toEqual([]);
  });
});

describe('what a model can emit never becomes approved (#419, step 7)', () => {
  it('refuses wording approved against a plausible fact id nobody created', () => {
    const { overlay } = newCase();
    update(overlay.id, { facts: [makeFact()], ...COVERED });
    const forged = makeVariant({ factIds: ['fact-7c1f0a52'], status: 'candidate_approved', approvedAt: '', text: 'Led the migration of the booking platform' });
    expect(() => update(overlay.id, { wordingVariants: [forged] })).toThrow(/does not exist on this case/);
    expect(read(overlay.id).wordingVariants).toEqual([]);
  });

  it('refuses a wording proposal that cites an unknown fact id before it is even staged', () => {
    const { overlay } = newCase();
    expect(() =>
      workspace.createCvTailoringProposal(db, {
        caseId: overlay.id,
        grantId: '',
        payload: { kind: 'wording', data: { targetField: 'experience_bullet', parentId: 'experience-1', text: 'Invented', factIds: ['fact-7c1f0a52'] } },
      }),
    ).toThrow(/fact id that does not exist/);
  });

  it('keeps an accepted client fact proposed and its wording a draft, so neither reaches the CV', () => {
    const { overlay } = newCase();
    update(overlay.id, COVERED);
    const factProposal = workspace.createCvTailoringProposal(db, {
      caseId: overlay.id,
      grantId: '',
      payload: { kind: 'fact', data: { parentId: 'experience-1', parentType: 'experience', client: '', activity: 'Shipped the thing', mechanism: '', result: '', ownership: 'sole', sourceReference: '', metricValue: '', metricUnit: '', metricBasis: '' } },
    });
    const { overlay: withFact } = workspace.acceptCvTailoringProposal(db, factProposal.id);
    const factId = withFact.facts[0]!.factId;
    expect(withFact.facts[0]?.approval).toBe('proposed');
    const wordingProposal = workspace.createCvTailoringProposal(db, {
      caseId: overlay.id,
      grantId: '',
      payload: { kind: 'wording', data: { targetField: 'experience_bullet', parentId: 'experience-1', text: 'Shipped the thing', factIds: [factId] } },
    });
    const { overlay: withWording } = workspace.acceptCvTailoringProposal(db, wordingProposal.id);
    expect(withWording.wordingVariants[0]?.status).toBe('draft');
    // Approving the wording is refused until the fact itself is approved.
    expect(() =>
      update(overlay.id, { wordingVariants: [{ ...withWording.wordingVariants[0]!, status: 'candidate_approved' }] }),
    ).toThrow(/not approved or is in a contradiction/);
    expect(approve(overlay.id).approvedResumeSnapshot?.resume.experience[0]?.bullets).toEqual(['Built things.']);
  });

  it('puts the case in conflict when an accepted client fact contradicts an existing one', () => {
    const { overlay } = newCase();
    update(overlay.id, { facts: [makeFact({ factId: 'fact-1', activity: 'Shipped the thing', ownership: 'sole' })] });
    const proposal = workspace.createCvTailoringProposal(db, {
      caseId: overlay.id,
      grantId: '',
      payload: { kind: 'fact', data: { parentId: 'experience-1', parentType: 'experience', client: '', activity: 'Shipped the thing', mechanism: '', result: '', ownership: 'shared', sourceReference: '', metricValue: '', metricUnit: '', metricBasis: '' } },
    });
    const { overlay: after } = workspace.acceptCvTailoringProposal(db, proposal.id);
    expect(after.state).toBe('conflict');
  });
});

describe('same employer and title, two roles (#419 acceptance)', () => {
  it('keeps facts attached to separate stable ids, so a fact never moves to the other role', () => {
    const { overlay, cv } = newCase();
    expect(cv.source?.experience.map((entry) => entry.id)).toEqual(['experience-1', 'experience-2']);
    const facts = [
      makeFact({ factId: 'fact-a', parentId: 'experience-1', activity: 'Built the booking screens' }),
      makeFact({ factId: 'fact-b', parentId: 'experience-2', activity: 'Built the booking screens', ownership: 'shared' }),
    ];
    // The same words in two different roles are not a contradiction.
    const saved = update(overlay.id, { facts });
    expect(saved.state).not.toBe('conflict');
    expect(saved.facts.map((fact) => fact.parentId)).toEqual(['experience-1', 'experience-2']);
  });
});

describe('patch validation for the review fields', () => {
  it('starts a fact with no stated approval as proposed, and refuses an unknown approval value', () => {
    const { approval: _approval, ...withoutApproval } = makeFact();
    expect(parseCvEvidenceOverlayPatch({ facts: [withoutApproval] }).facts?.[0]).toMatchObject({ approval: 'proposed', timePhase: '' });
    expect(() => parseCvEvidenceOverlayPatch({ facts: [{ ...makeFact(), approval: 'confirmed' }] })).toThrow(/approval/);
  });

  it('accepts only partial or complete as a coverage a caller can set', () => {
    expect(parseCvEvidenceOverlayPatch({ requirementCoverage: { status: 'complete', batches: 2 } }).requirementCoverage).toEqual({ status: 'complete', batches: 2 });
    expect(() => parseCvEvidenceOverlayPatch({ requirementCoverage: { status: 'not_run', batches: 0 } })).toThrow();
  });

  it('defaults a requirement with none of the new fields to a verified-nothing record the repository then checks', () => {
    const parsed = parseCvEvidenceOverlayPatch({
      requirements: [{ requirementId: 'r-1', text: 'TypeScript', classification: 'required', evidenceClass: 'candidate_confirmed_gap' }],
    }).requirements?.[0];
    expect(parsed).toMatchObject({ quoteStart: -1, quoteEnd: -1, jdRevisionId: '', excluded: false, sourceIds: [], factIds: [], evidenceClass: 'candidate_confirmed_gap' });
  });

  it('keeps a fact with a number but no basis out, as before', () => {
    expect(() => parseCvEvidenceOverlayPatch({ facts: [{ ...makeFact(), metricValue: '30', metricUnit: '%', metricBasis: '' }] })).toThrow(/metricBasis/);
  });
});
