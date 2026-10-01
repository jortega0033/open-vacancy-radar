import { describe, expect, it } from 'vitest';
import { composeApprovedTailoredResume } from '../electron/resume-source.js';
import { EMPTY_CV_EVIDENCE_OVERLAY, type CvApprovedWording, type CvEvidenceOverlay } from '../electron/workspace/cv-evidence-schema.js';
import { EMPTY_CV_SOURCE, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';

const HASH = 'a'.repeat(64);
const STALE_HASH = 'b'.repeat(64);

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  contact: { name: 'Jamie Rivera', title: 'Engineer', location: 'Amsterdam', email: 'jamie@example.invalid', phone: '', links: [] },
  summary: 'Original summary.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built the design system.'] },
  ],
  projects: [
    { id: 'project-1', name: 'Design System', role: 'Lead', dates: '2023', organization: '', description: 'Original description.', technologies: [], links: [], pinned: true },
  ],
};

function overlay(partial: Partial<CvEvidenceOverlay> = {}): CvEvidenceOverlay {
  return { ...EMPTY_CV_EVIDENCE_OVERLAY, sourceCvContentHash: HASH, jdSnapshot: 'A full job description.', ...partial };
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

describe('composeApprovedTailoredResume (#419, step 5-6)', () => {
  it('with no approved wording, composes exactly the unchanged-source resume', () => {
    const { resume, blockers } = composeApprovedTailoredResume(SOURCE, overlay(), HASH, ['TypeScript']);
    expect(resume.summary).toBe('Original summary.');
    expect(resume.experience[0]?.bullets).toEqual(['Built the design system.']);
    expect(resume.projects[0]?.description).toBe('Original description.');
    expect(resume.skills).toEqual(['TypeScript']);
    expect(blockers).toEqual([]);
  });

  it('an approved summary variant replaces the summary outright', () => {
    const { resume } = composeApprovedTailoredResume(
      SOURCE,
      overlay({ wordingVariants: [wording({ targetField: 'summary', text: 'New summary.' })] }),
      HASH,
      [],
    );
    expect(resume.summary).toBe('New summary.');
  });

  it('an approved skill variant is added, never duplicated if the skill is already present', () => {
    const { resume } = composeApprovedTailoredResume(
      SOURCE,
      overlay({ wordingVariants: [wording({ targetField: 'skill', text: 'TypeScript' })] }),
      HASH,
      ['TypeScript'],
    );
    expect(resume.skills).toEqual(['TypeScript']);
  });

  it('an approved experience_bullet variant is appended to the right entry by id, original bullets kept', () => {
    const { resume } = composeApprovedTailoredResume(
      SOURCE,
      overlay({ wordingVariants: [wording({ targetField: 'experience_bullet', parentId: 'experience-1', text: 'Scaled it to three teams.' })] }),
      HASH,
      [],
    );
    expect(resume.experience[0]?.bullets).toEqual(['Built the design system.', 'Scaled it to three teams.']);
  });

  it('an approved project_description variant replaces that project\'s description outright', () => {
    const { resume } = composeApprovedTailoredResume(
      SOURCE,
      overlay({ wordingVariants: [wording({ targetField: 'project_description', parentId: 'project-1', text: 'Rebuilt description.' })] }),
      HASH,
      [],
    );
    expect(resume.projects[0]?.description).toBe('Rebuilt description.');
  });

  it('ignores a draft (not yet approved) variant entirely', () => {
    const { resume } = composeApprovedTailoredResume(
      SOURCE,
      overlay({ wordingVariants: [wording({ targetField: 'summary', text: 'Draft summary.', status: 'draft' })] }),
      HASH,
      [],
    );
    expect(resume.summary).toBe('Original summary.');
  });

  it('excludes a variant approved against a stale source revision and reports why', () => {
    const { resume, blockers } = composeApprovedTailoredResume(
      SOURCE,
      overlay({ wordingVariants: [wording({ targetField: 'summary', text: 'Stale.', sourceRevision: STALE_HASH })] }),
      HASH,
      [],
    );
    expect(resume.summary).toBe('Original summary.');
    expect(blockers).toEqual(
      expect.arrayContaining([expect.stringContaining('no longer matches')]),
    );
  });

  it('excludes a variant whose anchor no longer exists in the source and reports why', () => {
    const { resume, blockers } = composeApprovedTailoredResume(
      SOURCE,
      overlay({
        wordingVariants: [wording({ targetField: 'experience_bullet', parentId: 'experience-deleted', text: 'Gone role.' })],
      }),
      HASH,
      [],
    );
    expect(resume.experience[0]?.bullets).toEqual(['Built the design system.']);
    expect(blockers).toEqual(
      expect.arrayContaining([expect.stringContaining('no longer exists')]),
    );
  });

  it('surfaces the overlay\'s own review-completeness gaps as blockers too', () => {
    const { blockers } = composeApprovedTailoredResume(
      SOURCE,
      overlay({
        requirements: [
          { requirementId: 'r-1', text: 'React', jdAnchor: '', classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '', candidateAdded: false, reviewed: true },
        ],
      }),
      HASH,
      [],
    );
    expect(blockers).toEqual(expect.arrayContaining([expect.stringContaining('required item(s) still need verification')]));
  });

  it('silently skips a description variant for a project the max-projects cap already excluded', () => {
    // Two projects, cap of 1, neither pinned: the second is excluded by selectSourceProjects.
    const twoProjects: CvSourceDocument = {
      ...SOURCE,
      maxProjects: 1,
      projects: [
        { id: 'project-1', name: 'Kept', role: '', dates: '', organization: '', description: 'Kept.', technologies: [], links: [], pinned: false },
        { id: 'project-2', name: 'Dropped', role: '', dates: '', organization: '', description: 'Dropped.', technologies: [], links: [], pinned: false },
      ],
    };
    const { resume, blockers } = composeApprovedTailoredResume(
      twoProjects,
      overlay({ wordingVariants: [wording({ targetField: 'project_description', parentId: 'project-2', text: 'New.' })] }),
      HASH,
      [],
    );
    expect(resume.projects).toHaveLength(1);
    expect(resume.projects[0]?.name).toBe('Kept');
    // Not a blocker: the variant's anchor is real, it is just not in this document's selection.
    expect(blockers).toEqual([]);
  });
});
