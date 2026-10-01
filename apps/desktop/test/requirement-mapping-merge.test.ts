import { describe, expect, it } from 'vitest';
import { mergeRequirementMappings } from '../src/components/cv/requirement-mapping-merge.js';
import type { CvRequirementMapping } from '../src/window.js';

function requirement(partial: Partial<CvRequirementMapping> = {}): CvRequirementMapping {
  return {
    requirementId: 'requirement-1',
    text: 'React experience',
    jdAnchor: '',
    classification: 'required',
    evidenceClass: 'needs_verification',
    anchorParentId: '',
    candidateAdded: false,
    reviewed: false,
    ...partial,
  };
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
    const existing = requirement({ requirementId: 'req-a', text: 'React  experience', reviewed: true });
    const reExtracted = requirement({ requirementId: 'requirement-1', text: 'react experience' });
    const merged = mergeRequirementMappings([existing], [reExtracted]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.requirementId).toBe('req-a');
  });

  it('never collides ids: an appended requirement gets a fresh id, not the parser\'s positional placeholder', () => {
    const existing = requirement({ requirementId: 'requirement-1', text: 'Existing one' });
    const reExtracted = requirement({ requirementId: 'requirement-1', text: 'A different requirement' });
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
