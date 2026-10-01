import { describe, expect, it } from 'vitest';
import { mergeRequirementMappings } from '../src/components/cv/requirement-mapping-merge.js';
import type { CvRequirementMapping } from '../src/window.js';
import { makeRequirement } from './fixtures/cv-evidence.js';

function requirement(partial: Partial<CvRequirementMapping> = {}): CvRequirementMapping {
  return makeRequirement({
    requirementId: 'requirement-1',
    text: 'React experience',
    jdAnchor: 'Must know React',
    evidenceClass: 'needs_verification',
    anchorParentId: '',
    reviewed: false,
    ...partial,
  });
}

describe('mergeRequirementMappings (#419)', () => {
  it('appends a genuinely new requirement', () => {
    const merged = mergeRequirementMappings([], [requirement()]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('React experience');
  });

  it('leaves an already-reviewed requirement with a candidate correction untouched', () => {
    const existing = requirement({
      requirementId: 'req-a',
      reviewed: true,
      classification: 'preferred', // the candidate downgraded this from the model's original 'required'
      evidenceClass: 'direct',
      anchorParentId: 'experience-1',
    });
    const reExtracted = requirement({ requirementId: 'requirement-1', classification: 'required', evidenceClass: 'needs_verification' });
    const merged = mergeRequirementMappings([existing], [reExtracted]);
    expect(merged).toEqual([existing]);
  });

  it('matches by normalized text: case and whitespace differences still count as the same requirement', () => {
    const existing = requirement({ requirementId: 'req-a', text: 'React  experience', jdAnchor: 'Other quote', reviewed: true });
    const reExtracted = requirement({ requirementId: 'requirement-1', text: 'react experience', jdAnchor: 'A third quote' });
    const merged = mergeRequirementMappings([existing], [reExtracted]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.requirementId).toBe('req-a');
  });

  it('dedupes by quote even when the model words the requirement differently', () => {
    const existing = requirement({ requirementId: 'req-a', text: 'React experience', jdAnchor: 'Must know React' });
    const reExtracted = requirement({ requirementId: 'requirement-1', text: 'Knowledge of React', jdAnchor: 'must know react' });
    expect(mergeRequirementMappings([existing], [reExtracted])).toHaveLength(1);
  });

  it('keeps an excluded requirement excluded when a later batch proposes it again', () => {
    const excluded = requirement({ requirementId: 'req-a', excluded: true, exclusionReason: 'Describes the company', reviewed: true });
    const merged = mergeRequirementMappings([excluded], [requirement()]);
    expect(merged).toEqual([excluded]);
  });

  it('never collides ids: an appended requirement gets a fresh id, not the parser placeholder', () => {
    const existing = requirement({ requirementId: 'requirement-1', text: 'Existing one', jdAnchor: 'Quote one' });
    const reExtracted = requirement({ requirementId: 'requirement-1', text: 'A different requirement', jdAnchor: 'Quote two' });
    const merged = mergeRequirementMappings([existing], [reExtracted]);
    expect(merged).toHaveLength(2);
    const ids = merged.map((r) => r.requirementId);
    expect(new Set(ids).size).toBe(2);
  });

  it('preserves a candidate-added requirement that extraction never produced', () => {
    const candidateAdded = requirement({ requirementId: 'req-manual', text: 'Onsite 2 days a week', candidateAdded: true, reviewed: true });
    const merged = mergeRequirementMappings([candidateAdded], []);
    expect(merged).toEqual([candidateAdded]);
  });
});
