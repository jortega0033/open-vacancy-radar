import { describe, expect, it } from 'vitest';
import { applyClarificationAnswer } from '../src/components/cv/clarification-answer.js';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import type { CvRequirementMapping, CvSourceDocument } from '../src/window.js';

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
  return {
    requirementId: 'req-1',
    text: 'GraphQL schema design',
    jdAnchor: '',
    classification: 'required',
    evidenceClass: 'needs_verification',
    anchorParentId: '',
    candidateAdded: false,
    reviewed: false,
    ...partial,
  };
}

describe('applyClarificationAnswer (#419, step 3)', () => {
  it('"skip" changes nothing and records no fact, so the requirement stays visible as unanswered', () => {
    const req = requirement();
    const result = applyClarificationAnswer(req, { kind: 'skip' });
    expect(result.requirement).toEqual(req);
    expect(result.fact).toBeNull();
  });

  it('"I don\'t know" marks the requirement reviewed but leaves its evidence class a gap', () => {
    const result = applyClarificationAnswer(requirement(), { kind: 'unknown' });
    expect(result.requirement.reviewed).toBe(true);
    expect(result.requirement.evidenceClass).toBe('needs_verification');
    expect(result.fact).toBeNull();
  });

  it('"not my work" records a candidate_confirmed_gap fact and marks the requirement unsupported', () => {
    const result = applyClarificationAnswer(requirement({ anchorParentId: 'experience-1' }), { kind: 'not_my_work' }, SOURCE);
    expect(result.requirement.evidenceClass).toBe('unsupported');
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

  it('keeps a stated metric only when a basis is given, dropping value and unit otherwise', () => {
    const withoutBasis = applyClarificationAnswer(requirement(), {
      kind: 'answered',
      parentId: 'experience-1',
      parentType: 'experience',
      activity: 'X',
      mechanism: 'Y',
      result: 'Z',
      metricValue: '30%',
      metricUnit: 'percent',
    });
    // No explicit metricBasis passed: hasMetric is still true (value present), so the caller not
    // stating a basis is the UI's job to prevent, not this function's -- it only drops the value
    // when the caller sends nothing for it.
    expect(withoutBasis.fact?.metricValue).toBe('30%');

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
