import { describe, expect, it } from 'vitest';
import { parseRequirementMappingResponse } from '../src/components/cv/requirement-mapping-response.js';

describe('parseRequirementMappingResponse (#419)', () => {
  it('parses a well-formed answer, assigning positional ids the model was never asked for', () => {
    const parsed = parseRequirementMappingResponse(
      JSON.stringify({
        requirements: [
          { text: 'React experience', jdAnchor: 'Must know React', classification: 'required', evidenceClass: 'direct', anchorParentId: 'experience-1' },
          { text: 'GraphQL', jdAnchor: 'GraphQL a plus', classification: 'preferred', evidenceClass: 'needs_verification', anchorParentId: '' },
        ],
      }),
    );
    expect(parsed).toEqual([
      { requirementId: 'requirement-1', text: 'React experience', jdAnchor: 'Must know React', classification: 'required', evidenceClass: 'direct', anchorParentId: 'experience-1', candidateAdded: false, reviewed: false },
      { requirementId: 'requirement-2', text: 'GraphQL', jdAnchor: 'GraphQL a plus', classification: 'preferred', evidenceClass: 'needs_verification', anchorParentId: '', candidateAdded: false, reviewed: false },
    ]);
  });

  it('drops an entry with no text rather than keeping an empty requirement', () => {
    const parsed = parseRequirementMappingResponse(JSON.stringify({ requirements: [{ text: '' }, { text: 'Real one' }] }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.text).toBe('Real one');
  });

  it('coerces an unknown classification to "unclear" rather than dropping the requirement', () => {
    const parsed = parseRequirementMappingResponse(JSON.stringify({ requirements: [{ text: 'X', classification: 'mandatory' }] }));
    expect(parsed[0]?.classification).toBe('unclear');
  });

  it('coerces an unknown evidence class to "needs_verification" rather than dropping the requirement', () => {
    const parsed = parseRequirementMappingResponse(JSON.stringify({ requirements: [{ text: 'X', evidenceClass: 'probably' }] }));
    expect(parsed[0]?.evidenceClass).toBe('needs_verification');
  });

  it('strips an anchorParentId the model attached to an unsupported requirement, since the two contradict', () => {
    const parsed = parseRequirementMappingResponse(
      JSON.stringify({ requirements: [{ text: 'X', evidenceClass: 'unsupported', anchorParentId: 'experience-1' }] }),
    );
    expect(parsed[0]?.anchorParentId).toBe('');
  });

  it('never marks a freshly parsed requirement as reviewed or candidate-added, even if the model said so', () => {
    const parsed = parseRequirementMappingResponse(JSON.stringify({ requirements: [{ text: 'X', reviewed: true, candidateAdded: true }] }));
    expect(parsed[0]?.reviewed).toBe(false);
    expect(parsed[0]?.candidateAdded).toBe(false);
  });

  it('throws a user-facing message on invalid JSON', () => {
    expect(() => parseRequirementMappingResponse('not json')).toThrow(/not valid JSON/);
  });

  it('returns an empty array rather than throwing when "requirements" is missing or not an array', () => {
    expect(parseRequirementMappingResponse(JSON.stringify({}))).toEqual([]);
    expect(parseRequirementMappingResponse(JSON.stringify({ requirements: 'nope' }))).toEqual([]);
  });
});
