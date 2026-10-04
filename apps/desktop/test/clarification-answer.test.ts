import { describe, expect, it } from 'vitest';
import { applyClarificationAnswer, metricBasisProblem } from '../src/components/cv/clarification-answer.js';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import type { CvRequirementMapping, CvSourceDocument } from '../src/window.js';
import { makeRequirement } from './fixtures/cv-evidence.js';

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: [] },
  ],
  projects: [
    { id: 'project-1', name: 'Design System', role: 'Lead', dates: '2023', organization: '', description: '', technologies: [], links: [], pinned: false },
  ],
};

function requirement(partial: Partial<CvRequirementMapping> = {}): CvRequirementMapping {
  return makeRequirement({
    requirementId: 'req-1',
    text: 'GraphQL schema design',
    jdAnchor: '',
    evidenceClass: 'needs_verification',
    anchorParentId: '',
    reviewed: false,
    quoteStart: -1,
    quoteEnd: -1,
    ...partial,
  });
}

describe('applyClarificationAnswer (#419, step 3)', () => {
  it('"skip" changes nothing and records no fact, so the requirement stays visible as unanswered', () => {
    const req = requirement();
    const result = applyClarificationAnswer(req, { kind: 'skip' });
    expect(result.requirement).toEqual(req);
    expect(result.fact).toBeNull();
  });

  it('"I don\'t know" marks the requirement a confirmed gap and reviewed, with no fact', () => {
    const result = applyClarificationAnswer(requirement(), { kind: 'unknown' });
    expect(result.requirement.reviewed).toBe(true);
    expect(result.requirement.evidenceClass).toBe('candidate_confirmed_gap');
    expect(result.fact).toBeNull();
  });

  it('"not my work" records a candidate_confirmed_gap fact and marks the requirement a confirmed gap', () => {
    const result = applyClarificationAnswer(requirement({ anchorParentId: 'experience-1' }), { kind: 'not_my_work' }, SOURCE);
    expect(result.requirement.evidenceClass).toBe('candidate_confirmed_gap');
    expect(result.requirement.anchorParentId).toBe('');
    expect(result.requirement.reviewed).toBe(true);
    expect(result.fact).toMatchObject({ verification: 'candidate_confirmed_gap', activity: '', parentType: 'experience', parentId: 'experience-1' });
  });

  it('"not my work" resolves an anchored project id to parentType "project", not the "experience" default', () => {
    const result = applyClarificationAnswer(requirement({ anchorParentId: 'project-1' }), { kind: 'not_my_work' }, SOURCE);
    expect(result.fact).toMatchObject({ parentType: 'project', parentId: 'project-1' });
  });

  it('"not my work" carries no parent scope when the requirement was never anchored (the common needs_verification case)', () => {
    const result = applyClarificationAnswer(requirement({ anchorParentId: '' }), { kind: 'not_my_work' }, SOURCE);
    expect(result.fact?.parentId).toBe('');
  });

  it('"not my work" never trusts an anchor id that no longer resolves in the current source', () => {
    const result = applyClarificationAnswer(requirement({ anchorParentId: 'deleted-role' }), { kind: 'not_my_work' }, SOURCE);
    expect(result.fact?.parentId).toBe('');
  });

  it('"not my work" is safe with no source supplied at all', () => {
    const result = applyClarificationAnswer(requirement({ anchorParentId: 'experience-1' }), { kind: 'not_my_work' });
    expect(result.fact?.parentId).toBe('');
  });

  it('a real answer creates a self-reported fact and flips evidence class to direct', () => {
    const result = applyClarificationAnswer(requirement(), {
      kind: 'answered',
      parentId: 'experience-1',
      parentType: 'experience',
      activity: 'Designed the GraphQL schema for the checkout service',
      mechanism: 'Apollo Server, schema-first, federated across two services',
      result: 'cut client-side overfetching',
    });
    expect(result.requirement).toMatchObject({ anchorParentId: 'experience-1', evidenceClass: 'direct', reviewed: true });
    // The answer links the new fact, but the fact itself is only proposed until the candidate
    // approves it field by field.
    expect(result.requirement.factIds).toEqual([result.fact?.factId]);
    expect(result.fact?.approval).toBe('proposed');
    expect(result.fact).toMatchObject({
      parentId: 'experience-1',
      parentType: 'experience',
      activity: 'Designed the GraphQL schema for the checkout service',
      mechanism: 'Apollo Server, schema-first, federated across two services',
      result: 'cut client-side overfetching',
      verification: 'self_reported',
      metricValue: '',
    });
  });

  it('refuses a stated metric with no basis, and keeps one that has a basis', () => {
    const base = {
      kind: 'answered' as const,
      parentId: 'experience-1',
      parentType: 'experience' as const,
      activity: 'X',
      mechanism: 'Y',
      result: 'Z',
      metricValue: '30%',
      metricUnit: 'percent',
    };
    expect(() => applyClarificationAnswer(requirement(), base)).toThrow(/needs a stated source/);
    const withBasis = applyClarificationAnswer(requirement(), { ...base, metricBasis: 'a report the team sent me' });
    expect(withBasis.fact).toMatchObject({ metricValue: '30%', metricBasis: 'a report the team sent me' });

    const noMetricAtAll = applyClarificationAnswer(requirement(), {
      kind: 'answered',
      parentId: 'experience-1',
      parentType: 'experience',
      activity: 'X',
      mechanism: 'Y',
      result: 'Z',
    });
    expect(noMetricAtAll.fact?.metricValue).toBe('');
    expect(noMetricAtAll.fact?.metricUnit).toBe('');
  });

  it('never asks about ownership: every fact defaults it to unknown', () => {
    const answered = applyClarificationAnswer(requirement(), {
      kind: 'answered',
      parentId: 'experience-1',
      parentType: 'experience',
      activity: 'X',
      mechanism: 'Y',
      result: 'Z',
    });
    expect(answered.fact?.ownership).toBe('unknown');
  });
});

describe('metricBasisProblem (#419, step 6)', () => {
  it('refuses a basis that infers a result from test counts, commits or a deployed address', () => {
    expect(metricBasisProblem('counted from the number of tests')).not.toBeNull();
    expect(metricBasisProblem('inferred from the commit history')).not.toBeNull();
    expect(metricBasisProblem('the site is deployed at the live URL')).not.toBeNull();
  });

  it('accepts a basis that says where the figure came from, and refuses an empty one', () => {
    expect(metricBasisProblem('a figure my manager sent in a report')).toBeNull();
    expect(metricBasisProblem('   ')).not.toBeNull();
  });
});
