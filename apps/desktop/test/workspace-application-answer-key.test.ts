// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applicationAnswerKey, normalizeAnswerLabel } from '../electron/workspace/application-answer-key.js';

/**
 * #372's answer-library lookup key, tested on its own because it is pure string work shared by
 * both the repository (this package) and the separately-implemented review-flow confirm code.
 */

describe('normalizeAnswerLabel', () => {
  it('treats different casing, incidental whitespace and diacritics as the same label', () => {
    const base = normalizeAnswerLabel('Why do you want to work here?');
    expect(normalizeAnswerLabel('why do you want to work here?')).toBe(base);
    expect(normalizeAnswerLabel('  Why   do you want to work here?  ')).toBe(base);
    expect(normalizeAnswerLabel('Why dó yóu want tó wórk hére?')).toBe(base);
  });

  it('does not fold away genuinely different wording', () => {
    expect(normalizeAnswerLabel('Why do you want to work here?')).not.toBe(
      normalizeAnswerLabel('Why do you want to work with us?'),
    );
    expect(normalizeAnswerLabel('Describe a challenge you overcame')).not.toBe(
      normalizeAnswerLabel('Describe a time you failed'),
    );
  });
});

describe('applicationAnswerKey', () => {
  it('is stable across casing/whitespace/diacritic differences in the same label and control type', () => {
    const key = applicationAnswerKey('Why do you want to work here?', 'textarea');
    expect(applicationAnswerKey('  WHY DO YOU WANT TO WORK HERE?  ', 'textarea')).toBe(key);
  });

  it('gives genuinely different labels different keys', () => {
    expect(applicationAnswerKey('Why do you want to work here?', 'text')).not.toBe(
      applicationAnswerKey('Why do you want to work with us?', 'text'),
    );
  });

  it('gives the same label a different key for a different control type', () => {
    const label = 'Why do you want to work here?';
    expect(applicationAnswerKey(label, 'text')).not.toBe(applicationAnswerKey(label, 'textarea'));
  });

  it('embeds the control type as a fixed prefix, not just a distinguishing suffix', () => {
    expect(applicationAnswerKey('Why do you want to work here?', 'text')).toBe(
      'text::why do you want to work here?',
    );
  });
});
