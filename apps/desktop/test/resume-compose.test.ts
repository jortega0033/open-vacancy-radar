import { describe, expect, it } from 'vitest';
import { composeApprovedTailoredResume } from '../electron/resume-source.js';
import type { CvApprovedWording, CvEvidenceOverlay } from '../electron/workspace/cv-evidence-schema.js';
import { EMPTY_CV_SOURCE, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import { FIXTURE_HASH as HASH, makeFact, makeOverlay, makeRequirement, makeVariant } from './fixtures/cv-evidence.js';

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

/** Includes one approved fact, since every variant here cites `fact-1`. */
function overlay(partial: Partial<CvEvidenceOverlay> = {}): CvEvidenceOverlay {
  return makeOverlay({ facts: [makeFact()], ...partial });
}

function wording(partial: Partial<CvApprovedWording> = {}): CvApprovedWording {
  return makeVariant(partial);
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
        requirements: [makeRequirement({ evidenceClass: 'needs_verification', anchorParentId: '' })],
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

describe('composeApprovedTailoredResume: facts and variants must both be approved (#419, step 7)', () => {
  const draft = (text: string) => wording({ status: 'draft', approvedAt: '', text });

  it('never composes a draft sentence, a rejected variant or a superseded variant', () => {
    const { resume } = composeApprovedTailoredResume(
      SOURCE,
      overlay({
        wordingVariants: [
          draft('An unapproved sentence a model emitted.'),
          wording({ variantId: 'v-2', status: 'rejected', text: 'Rejected sentence.' }),
          wording({ variantId: 'v-3', status: 'superseded', text: 'Replaced sentence.' }),
        ],
      }),
      HASH,
      [],
    );
    expect(resume.summary).toBe('Original summary.');
  });

  it('never composes a variant that cites a plausible fact id the case does not have', () => {
    const { resume } = composeApprovedTailoredResume(
      SOURCE,
      overlay({ wordingVariants: [wording({ factIds: ['fact-made-up'], text: 'Fake-backed sentence.' })] }),
      HASH,
      [],
    );
    expect(resume.summary).toBe('Original summary.');
  });

  it('never composes a variant whose fact is proposed, rejected or superseded', () => {
    for (const approval of ['proposed', 'rejected', 'superseded'] as const) {
      const { resume } = composeApprovedTailoredResume(
        SOURCE,
        overlay({ facts: [makeFact({ approval })], wordingVariants: [wording({ text: 'Backed by a dead fact.' })] }),
        HASH,
        [],
      );
      expect(resume.summary, approval).toBe('Original summary.');
    }
  });

  it('blocks use of wording whose facts contradict each other, and reports the contradiction', () => {
    const facts = [
      makeFact({ factId: 'fact-1', activity: 'Built the booking screens', ownership: 'sole' }),
      makeFact({ factId: 'fact-2', activity: 'Built the booking screens', ownership: 'shared' }),
    ];
    const { resume, blockers } = composeApprovedTailoredResume(
      SOURCE,
      overlay({ facts, wordingVariants: [wording({ text: 'Contradicted sentence.' })] }),
      HASH,
      [],
    );
    expect(resume.summary).toBe('Original summary.');
    expect(blockers).toEqual(expect.arrayContaining([expect.stringContaining('contradict each other')]));
  });
});
