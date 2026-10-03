import { describe, expect, it } from 'vitest';
import { EMPTY_CV_SOURCE, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import { deriveCaseProgress, type CaseStepId } from '../src/components/cv/case-progress.js';
import type { CvEvidenceOverlayRecord } from '../src/window.js';
import { FIXTURE_JD, FIXTURE_REVISION_ID, makeFact, makeRequirement, makeRevision } from './fixtures/cv-evidence.js';

const REVIEWED: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  reviewedAt: '2026-09-30T00:00:00.000Z',
  summary: 'Original summary.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
  ],
};

function overlay(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'o-1',
    cvId: 'cv-1',
    vacancyKey: 'fields:Platform Engineer|Northwind',
    caseTitle: 'Platform Engineer',
    caseCompany: 'Northwind',
    sourceCvContentHash: 'h',
    jdSnapshot: FIXTURE_JD,
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    jdIncompleteReasons: [],
    jdWarning: '',
    jdConfirmedComplete: false,
    jdRevisions: [makeRevision()],
    listingStatus: 'unknown',
    state: 'draft',
    requirements: [],
    requirementCoverage: { status: 'not_run', revisionId: '', batches: 0 },
    facts: [],
    wordingVariants: [],
    origin: 'manual',
    caseRevision: '1',
    approvedResumeSnapshot: null,
    projectSelection: null,
    sourceBaseline: null,
    artifacts: [],
    legacyUnverifiedExport: false,
    capturedAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...partial,
  } as CvEvidenceOverlayRecord;
}

const states = (progress: ReturnType<typeof deriveCaseProgress>) =>
  Object.fromEntries(progress.steps.map((step) => [step.id, step.state])) as Record<CaseStepId, string>;

describe('deriveCaseProgress (#446)', () => {
  it('always lists the seven steps in order', () => {
    const progress = deriveCaseProgress({ overlay: null, sourceCv: REVIEWED, cvChanged: false });
    expect(progress.steps.map((step) => `${step.number} ${step.label}`)).toEqual([
      '1 Job description',
      '2 Requirements',
      '3 Your answers',
      '4 Facts and wording',
      '5 Projects',
      '6 Approve CV',
      '7 Files',
    ]);
  });

  it('a case with no stored record starts at the job description', () => {
    const progress = deriveCaseProgress({ overlay: null, sourceCv: REVIEWED, cvChanged: false });
    expect(progress.next).toBe('Next: add the job description');
    expect(states(progress).job).toBe('needs_you');
  });

  it('with only a job description, the requirements are the one thing to do and later steps wait', () => {
    const progress = deriveCaseProgress({ overlay: overlay(), sourceCv: REVIEWED, cvChanged: false });
    expect(states(progress)).toMatchObject({ job: 'done', requirements: 'needs_you', answers: 'blocked', facts: 'blocked', approve: 'blocked', files: 'blocked' });
    expect(progress.next).toBe('Next: map the requirements');
  });

  it('names exactly one action, with the count, for requirements waiting on review', () => {
    const progress = deriveCaseProgress({
      overlay: overlay({
        requirementCoverage: { status: 'complete', revisionId: FIXTURE_REVISION_ID, batches: 1 },
        requirements: [
          makeRequirement({ requirementId: 'a', reviewed: false }),
          makeRequirement({ requirementId: 'b', reviewed: false }),
          makeRequirement({ requirementId: 'c', reviewed: false }),
          makeRequirement({ requirementId: 'd', reviewed: false }),
        ],
      }),
      sourceCv: REVIEWED,
      cvChanged: false,
    });
    expect(progress.next).toBe('Next: review 4 requirements');
    expect(states(progress).requirements).toBe('needs_you');
  });

  it('does not show requirements as done when they were reviewed against an older job description', () => {
    const progress = deriveCaseProgress({
      overlay: overlay({
        jdRevisions: [makeRevision({ revisionId: 'rev-1' }), makeRevision({ revisionId: 'rev-2', text: `${FIXTURE_JD} More.` })],
        requirementCoverage: { status: 'complete', revisionId: 'rev-1', batches: 1 },
        requirements: [makeRequirement({ jdRevisionId: 'rev-1' })],
      }),
      sourceCv: REVIEWED,
      cvChanged: false,
    });
    expect(states(progress).requirements).not.toBe('done');
    expect(progress.next).toBe('Next: map the requirements');
  });

  it('asks for the answers before facts, then approval, and names the project approval before approving', () => {
    const base = {
      requirementCoverage: { status: 'complete' as const, revisionId: FIXTURE_REVISION_ID, batches: 1 },
    };
    const question = deriveCaseProgress({
      overlay: overlay({ ...base, requirements: [makeRequirement({ evidenceClass: 'needs_verification' })] }),
      sourceCv: REVIEWED,
      cvChanged: false,
    });
    expect(question.next).toBe('Next: answer 1 question');
    expect(states(question).answers).toBe('needs_you');

    const proposed = deriveCaseProgress({
      overlay: overlay({ ...base, requirements: [makeRequirement()], facts: [makeFact({ approval: 'proposed' })] }),
      sourceCv: REVIEWED,
      cvChanged: false,
    });
    expect(proposed.next).toBe('Next: review 1 fact');

    const withProject: CvSourceDocument = {
      ...REVIEWED,
      projects: [{ id: 'project-1', name: 'Booking', role: '', dates: '', organization: '', description: 'x', technologies: [], links: [], pinned: false }],
    };
    const approve = deriveCaseProgress({ overlay: overlay({ ...base, requirements: [makeRequirement()], facts: [makeFact()] }), sourceCv: withProject, cvChanged: false });
    expect(states(approve).projects).toBe('needs_you');
    expect(approve.next).toBe('Next: approve the project selection');
  });

  it('puts the source review first when the reviewed source blocks approval', () => {
    const unreviewed: CvSourceDocument = { ...REVIEWED, reviewedAt: '' };
    const progress = deriveCaseProgress({
      overlay: overlay({
        requirementCoverage: { status: 'complete', revisionId: FIXTURE_REVISION_ID, batches: 1 },
        requirements: [makeRequirement()],
        facts: [makeFact()],
      }),
      sourceCv: unreviewed,
      cvChanged: false,
    });
    expect(states(progress)).toMatchObject({ job: 'done', requirements: 'done', answers: 'done', facts: 'done', projects: 'done', approve: 'blocked', files: 'blocked' });
    expect(progress.next).toBe('Next: review this CV’s source');
  });

  it('holds approval and names the CV change when the CV changed after the case started', () => {
    const progress = deriveCaseProgress({
      overlay: overlay({
        requirementCoverage: { status: 'complete', revisionId: FIXTURE_REVISION_ID, batches: 1 },
        requirements: [makeRequirement()],
      }),
      sourceCv: REVIEWED,
      cvChanged: true,
    });
    expect(states(progress).approve).toBe('blocked');
    expect(progress.next).toBe('Next: review what changed in your CV');
  });

  it('says the CV is approved, and which action is left, rather than inventing one', () => {
    const approvedOverlay = overlay({
      requirementCoverage: { status: 'complete', revisionId: FIXTURE_REVISION_ID, batches: 1 },
      requirements: [makeRequirement()],
      facts: [makeFact()],
      state: 'candidate_approved',
      projectSelection: { projectIds: [], maxProjects: 0, approvedAt: '2026-09-30T00:00:00.000Z' },
    });
    const progress = deriveCaseProgress({ overlay: approvedOverlay, sourceCv: REVIEWED, cvChanged: false });
    expect(states(progress)).toMatchObject({ approve: 'done' });
    expect(progress.next).toMatch(/^Next: /);
    expect(progress.complete).toBe(false);
  });
});
