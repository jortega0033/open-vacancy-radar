import { describe, expect, it } from 'vitest';

import {
  candidateCoversLanguage,
  canonicalLanguageName,
  detectLanguageRequirements,
  parseCandidateLanguages,
  uncoveredMandatoryLanguages,
} from '../../src/eligibility/language.js';

/**
 * A synthetic posting whose only language requirement is the very last line, after the kind of
 * closing boilerplate a reader stops reading at. Acceptance check 6 of issue #280: a requirement
 * buried late in the description has to be found, not just one in an obvious opening line.
 */
const LATE_REQUIREMENT_DESCRIPTION = `About Example Company
We are a distributed product team building tooling for other engineering teams.

What you will do
Build and own user-facing web applications.
Work with designers on a shared component library.
Review pull requests and mentor other engineers.

What we offer
A yearly learning budget.
Twenty-eight days of paid leave.
A home-office allowance.

Our process
A short intro call, a technical conversation, and a team session.
We aim to give a decision within two weeks of the final round.

Equal opportunity
Example Company is an equal opportunity employer and welcomes applicants from every background.

Please note: fluency in German is required for this role, as all client communication is in German.`;

describe('detectLanguageRequirements', () => {
  it('finds a mandatory language stated in the very last line of a long description', () => {
    const requirements = detectLanguageRequirements(LATE_REQUIREMENT_DESCRIPTION);

    expect(requirements).toEqual([
      {
        language: 'German',
        obligation: 'mandatory',
        quote: expect.stringContaining('fluency in German is required'),
      },
    ]);
  });

  it('distinguishes a mandatory language from a preferred one in the same posting', () => {
    const requirements = detectLanguageRequirements(
      `Requirements
      Professional working proficiency in English is required.
      Nice to have
      Dutch is a plus, but not a requirement.`,
    );

    expect(requirements).toEqual([
      { language: 'English', obligation: 'mandatory', quote: expect.any(String) },
      { language: 'Dutch', obligation: 'preferred', quote: expect.any(String) },
    ]);
  });

  it('reads a bare language bullet through the heading it sits under, in both directions', () => {
    const underRequirements = detectLanguageRequirements('Requirements\n- Spanish\n- 5 years of experience');
    const underNiceToHave = detectLanguageRequirements('Nice to have\n- Spanish\n- Open-source work');

    expect(underRequirements).toEqual([
      { language: 'Spanish', obligation: 'mandatory', quote: 'Spanish' },
    ]);
    expect(underNiceToHave).toEqual([
      { language: 'Spanish', obligation: 'preferred', quote: 'Spanish' },
    ]);
  });

  /**
   * Issue #713. The corpus body these mirror is `apps/desktop/test/role-scope-research/fixtures.ts`
   * (cases L05 and L06): the same unclear sentence, which states no obligation at all, before any
   * heading and then under a later "About us" heading. Both have to stay unreported, otherwise the
   * candidate gets an eligibility "no" and a 45 score cap for a requirement nobody wrote down.
   */
  it('does not carry a requirements heading past an unrelated section heading', () => {
    const body = `Responsibilities
Build and maintain accessible web applications in TypeScript.
Requirements
Strong TypeScript and modern frontend framework experience.`;

    // L05: the unclear sentence before any heading has never been reported.
    expect(
      detectLanguageRequirements(`Our team speaks German and English day to day.\n${body}`),
    ).toEqual([]);

    // L06: the same sentence under a later "About us" heading must not inherit "Requirements".
    expect(
      detectLanguageRequirements(
        `${body}\nAbout us\nOur team speaks German and English day to day.`,
      ),
    ).toEqual([]);
  });

  it('still reads a bare language bullet through its own heading after a section break', () => {
    // The reset ends a heading's reach; it must not stop a later heading from starting one.
    expect(
      detectLanguageRequirements(`Requirements\n- Spanish\nBenefits\nA learning budget.`),
    ).toEqual([{ language: 'Spanish', obligation: 'mandatory', quote: 'Spanish' }]);

    expect(
      detectLanguageRequirements(
        `Requirements\n- 5 years of experience\nAbout us\nWe are remote.\nNice to have\n- Spanish`,
      ),
    ).toEqual([{ language: 'Spanish', obligation: 'preferred', quote: 'Spanish' }]);
  });

  it('reads markdown headings the same way as plain ones, in both directions', () => {
    expect(
      detectLanguageRequirements(`## Requirements\n- Dutch\n## About us\nOur team speaks German daily.`),
    ).toEqual([{ language: 'Dutch', obligation: 'mandatory', quote: 'Dutch' }]);
    expect(
      detectLanguageRequirements(`### Nice to have\n- Spanish\n### Benefits\nFree German classes.`),
    ).toEqual([{ language: 'Spanish', obligation: 'preferred', quote: 'Spanish' }]);
  });

  it('keeps an in-sentence obligation marker working inside an unrelated section', () => {
    // Only bare mentions depend on heading context; a stated obligation is read wherever it is.
    expect(
      detectLanguageRequirements(`About us\nWe are a small team and fluent German is required.`),
    ).toEqual([
      { language: 'German', obligation: 'mandatory', quote: expect.stringContaining('required') },
    ]);
  });

  /**
   * Issue #713 decided not to narrow this. With no heading of any kind between the requirements
   * list and the sentence, the posting's own layout puts the sentence in the requirements section,
   * and removing that reading means dropping heading inheritance, which the bullet test above pins.
   * Documented as a known limitation on `detectLanguageRequirements`; revisit with fresh evidence.
   */
  it('still inherits a requirements heading for a sentence with no intervening heading (L03)', () => {
    expect(
      detectLanguageRequirements(
        `Requirements\nStrong TypeScript experience.\nOur team speaks German and English day to day.`,
      ),
    ).toEqual([
      // Vocabulary order, not posting order: `LANGUAGE_TERMS` is alphabetical.
      { language: 'English', obligation: 'mandatory', quote: expect.any(String) },
      { language: 'German', obligation: 'mandatory', quote: expect.any(String) },
    ]);
  });

  it('never invents a requirement from an incidental mention', () => {
    expect(
      detectLanguageRequirements('Our team is spread across France, and we love French food.'),
    ).toEqual([]);
    expect(detectLanguageRequirements(null)).toEqual([]);
    expect(detectLanguageRequirements('')).toEqual([]);
  });

  it('keeps the stronger obligation when one language is stated both ways', () => {
    const requirements = detectLanguageRequirements(
      `Nice to have
      Some Japanese is a plus.
      One more thing
      Japanese is mandatory for this role because the whole team works in it.`,
    );

    expect(requirements).toEqual([
      { language: 'Japanese', obligation: 'mandatory', quote: expect.stringContaining('mandatory') },
    ]);
  });

  it('reads endonyms and regional names as the same language', () => {
    expect(canonicalLanguageName('Nederlands')).toBe('Dutch');
    expect(canonicalLanguageName('Deutsch')).toBe('German');
    expect(canonicalLanguageName('Mandarin')).toBe('Chinese');
    expect(canonicalLanguageName('Klingon')).toBeNull();
    expect(
      detectLanguageRequirements('Requirements\n- Vloeiend Nederlands is required'),
    ).toMatchObject([{ language: 'Dutch', obligation: 'mandatory' }]);
  });
});

describe('candidate language configuration', () => {
  it('reads the free-text professional-language field as a list', () => {
    expect(parseCandidateLanguages('English')).toEqual(['English']);
    expect(parseCandidateLanguages('English, Dutch')).toEqual(['English', 'Dutch']);
    expect(parseCandidateLanguages('English / German')).toEqual(['English', 'German']);
    expect(parseCandidateLanguages('English and Nederlands')).toEqual(['English', 'Dutch']);
    expect(parseCandidateLanguages('   ')).toEqual([]);
  });

  it('matches a candidate language against a requirement through the shared canonical name', () => {
    expect(candidateCoversLanguage(['Nederlands'], 'Dutch')).toBe(true);
    expect(candidateCoversLanguage(['English'], 'German')).toBe(false);
  });
});

describe('uncoveredMandatoryLanguages', () => {
  const requirements = detectLanguageRequirements(
    `Requirements
    Fluent German is required.
    Nice to have
    Italian is a plus.`,
  );

  it('reports only the mandatory requirements the candidate does not meet', () => {
    expect(uncoveredMandatoryLanguages(requirements, ['English'])).toMatchObject([
      { language: 'German', obligation: 'mandatory' },
    ]);
    expect(uncoveredMandatoryLanguages(requirements, ['English', 'German'])).toEqual([]);
  });

  it('never reports a preferred language, even when the candidate does not have it', () => {
    expect(
      uncoveredMandatoryLanguages(requirements, ['German']).map((item) => item.language),
    ).not.toContain('Italian');
  });

  it('reports nothing at all when no candidate language is configured', () => {
    // An unconfigured profile cannot fail a language check. It can only leave it unanswered, which
    // is what keeps this gate inert on a fresh install rather than defaulting to any language.
    expect(uncoveredMandatoryLanguages(requirements, [])).toEqual([]);
  });
});
