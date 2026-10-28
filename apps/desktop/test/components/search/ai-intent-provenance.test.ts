import { describe, expect, it } from 'vitest';
import { describeAiIntentProvenance } from '../../../src/components/search/ai-intent-provenance.js';

const entry = (value: string | null, pushdown: string) =>
  value === null
    ? { requested: false, value: null, pushdown: 'not_requested', enforcedLocally: false }
    : { requested: true, value, pushdown, enforcedLocally: true };

const V1 = {
  intentVersion: 1,
  scanId: 'run-1',
  mode: 'query',
  criteria: {
    role: entry('UI engineer', 'prompt_guidance'),
    country: entry('Unspecified location', 'unsupported'),
    employment: entry(null, 'not_requested'),
    salary: entry('EUR 65,000; unknown salaries kept', 'unsupported'),
  },
  candidateContext: { skillCount: 3, experienceYearsIncluded: true, homeCountryIncluded: false, savedTargetRolesSearched: false },
};

describe('describeAiIntentProvenance', () => {
  it('describes a version 1 record, keeping guidance apart from local-only criteria', () => {
    expect(describeAiIntentProvenance(V1)).toBe(
      'AI search intent v1, run run-1: role "UI engineer" (sent to AI as guidance), country "Unspecified location" (not searchable, applied locally), salary "EUR 65,000; unknown salaries kept" (not searchable, applied locally); 3 saved skill(s) as background, saved target roles not searched',
    );
  });

  it('describes browse-all without criteria', () => {
    expect(
      describeAiIntentProvenance({
        ...V1,
        mode: 'browse_all',
        criteria: {
          role: entry(null, 'not_requested'),
          country: entry(null, 'not_requested'),
          employment: entry(null, 'not_requested'),
          salary: entry(null, 'not_requested'),
        },
      }),
    ).toContain('run run-1: browse all, no criteria;');
  });

  it('applies the redactor to the typed terms only, not to the run id', () => {
    const line = describeAiIntentProvenance(V1, (text) => text.replace(/UI engineer/u, '[x]'));
    expect(line).toContain('role "[x]"');
    expect(line).toContain('run run-1');
  });

  it('does not describe a version it does not know, and does not read its contents', () => {
    expect(describeAiIntentProvenance({ ...V1, intentVersion: 2, criteria: null })).toBe(
      'AI search intent v2 not shown (this version of the app reads v1)',
    );
    expect(describeAiIntentProvenance({ ...V1, intentVersion: '1' })).toBe('AI search intent not shown (unrecognised format)');
    expect(describeAiIntentProvenance({ criteria: V1.criteria })).toBe('AI search intent not shown (unrecognised format)');
  });

  it('never throws on a malformed record', () => {
    for (const malformed of [null, undefined, 'x', 7, [], {}, { intentVersion: 1 }, { ...V1, candidateContext: null }, { ...V1, scanId: 3 }]) {
      expect(() => describeAiIntentProvenance(malformed)).not.toThrow();
    }
    expect(describeAiIntentProvenance({ ...V1, criteria: { ...V1.criteria, role: null } })).toBe(
      'AI search intent v1 not shown (incomplete record)',
    );
    expect(describeAiIntentProvenance({ ...V1, criteria: { ...V1.criteria, role: { requested: true, value: 5 } } })).toBe(
      'AI search intent v1 not shown (incomplete record)',
    );
  });
});
