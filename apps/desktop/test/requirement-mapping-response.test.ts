import { describe, expect, it } from 'vitest';
import { CV_REQUIREMENT_BATCH_SIZE } from '../electron/workspace/cv-evidence-schema.js';
import { parseRequirementMappingResponse } from '../src/components/cv/requirement-mapping-response.js';

const JD = 'Must know React. GraphQL a plus. Fluent English is essential. Onsite two days a week.';

function parse(payload: unknown, jd = JD) {
  return parseRequirementMappingResponse(JSON.stringify(payload), jd);
}

describe('parseRequirementMappingResponse (#419)', () => {
  it('parses a well-formed answer, assigning positional ids and verified quote spans', () => {
    const { accepted, rejected, hasMore } = parse({
      requirements: [
        { text: 'React experience', jdAnchor: 'Must know React', classification: 'required', evidenceClass: 'direct', anchorParentId: 'experience-1' },
        { text: 'GraphQL', jdAnchor: 'GraphQL a plus', classification: 'preferred', evidenceClass: 'needs_verification', anchorParentId: '' },
      ],
    });
    expect(rejected).toEqual([]);
    expect(hasMore).toBe(false);
    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toMatchObject({
      requirementId: 'requirement-1',
      text: 'React experience',
      jdAnchor: 'Must know React',
      classification: 'required',
      evidenceClass: 'direct',
      anchorParentId: 'experience-1',
      candidateAdded: false,
      reviewed: false,
      quoteStart: JD.indexOf('Must know React'),
      quoteEnd: JD.indexOf('Must know React') + 'Must know React'.length,
      excluded: false,
      sourceIds: [],
      factIds: [],
    });
    expect(accepted[1]?.quoteStart).toBe(JD.indexOf('GraphQL a plus'));
  });

  it('rejects a proposal whose quote is not an exact passage of the JD, and says why', () => {
    const { accepted, rejected } = parse({
      requirements: [
        { text: 'Kubernetes', jdAnchor: 'Must know Kubernetes' },
        { text: 'Paraphrase', jdAnchor: 'must know react' },
        { text: 'No quote at all', jdAnchor: '' },
        { text: 'Real one', jdAnchor: 'Fluent English is essential' },
      ],
    });
    expect(accepted.map((r) => r.text)).toEqual(['Real one']);
    expect(rejected.map((r) => r.text)).toEqual(['Kubernetes', 'Paraphrase', 'No quote at all']);
    expect(rejected[0]?.reason).toMatch(/could not be found in the job description/);
    expect(rejected[2]?.reason).toMatch(/did not say where/);
  });

  it('drops a repeated proposal (same wording or same quote) from one answer', () => {
    const { accepted } = parse({
      requirements: [
        { text: 'React', jdAnchor: 'Must know React' },
        { text: 'react', jdAnchor: 'Must know React' },
        { text: 'Knows React well', jdAnchor: 'Must know React' },
      ],
    });
    expect(accepted).toHaveLength(1);
  });

  it('drops an entry with no text rather than keeping an empty requirement', () => {
    const { accepted } = parse({ requirements: [{ text: '' }, { text: 'Real one', jdAnchor: 'GraphQL a plus' }] });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.text).toBe('Real one');
  });

  it('coerces an unknown classification to "unclear" rather than dropping the requirement', () => {
    const { accepted } = parse({ requirements: [{ text: 'X', jdAnchor: 'GraphQL a plus', classification: 'mandatory' }] });
    expect(accepted[0]?.classification).toBe('unclear');
  });

  it('coerces an unknown evidence class to "needs_verification" rather than dropping the requirement', () => {
    const { accepted } = parse({ requirements: [{ text: 'X', jdAnchor: 'GraphQL a plus', evidenceClass: 'probably' }] });
    expect(accepted[0]?.evidenceClass).toBe('needs_verification');
  });

  it('never accepts "candidate_confirmed_gap" from a model: only the candidate can say that', () => {
    const { accepted } = parse({ requirements: [{ text: 'X', jdAnchor: 'GraphQL a plus', evidenceClass: 'candidate_confirmed_gap' }] });
    expect(accepted[0]?.evidenceClass).toBe('needs_verification');
  });

  it('strips an anchorParentId the model attached to an unsupported requirement, since the two contradict', () => {
    const { accepted } = parse({
      requirements: [{ text: 'X', jdAnchor: 'GraphQL a plus', evidenceClass: 'unsupported', anchorParentId: 'experience-1' }],
    });
    expect(accepted[0]?.anchorParentId).toBe('');
  });

  it('never marks a freshly parsed requirement as reviewed, excluded or candidate-added, even if the model said so', () => {
    const { accepted } = parse({
      requirements: [{ text: 'X', jdAnchor: 'GraphQL a plus', reviewed: true, candidateAdded: true, excluded: true, factIds: ['fact-1'] }],
    });
    expect(accepted[0]).toMatchObject({ reviewed: false, candidateAdded: false, excluded: false, factIds: [] });
  });

  it('reports more to come when the model says so, or when the batch is full (a possible output cap)', () => {
    expect(parse({ requirements: [{ text: 'X', jdAnchor: 'GraphQL a plus' }], hasMore: true }).hasMore).toBe(true);
    const full = Array.from({ length: CV_REQUIREMENT_BATCH_SIZE }, (_, index) => ({ text: `Item ${index}`, jdAnchor: 'GraphQL a plus' }));
    expect(parse({ requirements: full, hasMore: false }).hasMore).toBe(true);
    expect(parse({ requirements: [{ text: 'X', jdAnchor: 'GraphQL a plus' }], hasMore: false }).hasMore).toBe(false);
  });

  it('throws a user-facing message on invalid JSON', () => {
    expect(() => parseRequirementMappingResponse('not json', JD)).toThrow(/not valid JSON/);
  });

  it('returns an empty batch rather than throwing when "requirements" is missing or not an array', () => {
    expect(parse({}).accepted).toEqual([]);
    expect(parse({ requirements: 'nope' }).accepted).toEqual([]);
  });
});
