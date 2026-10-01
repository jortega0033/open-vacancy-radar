import { describe, expect, it } from 'vitest';
import { runPreSubmitGate, type PreSubmitGateInput } from '../electron/application-submit-gate.js';

function baseInput(overrides: Partial<PreSubmitGateInput> = {}): PreSubmitGateInput {
  return {
    attempt: {
      company: 'Redwood Software',
      role: 'Senior Frontend Engineer',
      sourceCvContentHash: 'cv-hash-1',
      jdSnapshotHash: 'jd-hash-1',
    },
    currentSourceCvContentHash: 'cv-hash-1',
    currentJdSnapshotHash: 'jd-hash-1',
    renderedCvText: 'Experienced engineer applying to Redwood Software for the Senior Frontend Engineer role.',
    renderedLetterText: 'Dear Redwood Software hiring team, I am excited about the Senior Frontend Engineer position.',
    ...overrides,
  };
}

describe('runPreSubmitGate', () => {
  it('passes a well-formed attempt whose documents genuinely mention the company and role', () => {
    expect(runPreSubmitGate(baseInput())).toEqual({ ok: true });
  });

  it('passes when there is no cover letter, as long as the CV alone covers company and role', () => {
    const result = runPreSubmitGate(baseInput({ renderedLetterText: null }));
    expect(result.ok).toBe(true);
  });

  it('refuses when the source CV has changed since the attempt was created', () => {
    const result = runPreSubmitGate(baseInput({ currentSourceCvContentHash: 'cv-hash-2' }));
    expect(result).toEqual({ ok: false, reason: 'source_cv_changed', detail: expect.stringContaining('source CV') });
  });

  it('refuses when the job description has changed since the attempt was created', () => {
    const result = runPreSubmitGate(baseInput({ currentJdSnapshotHash: 'jd-hash-2' }));
    expect(result.reason).toBe('jd_changed');
  });

  it('checks the CV/JD hashes before ever inspecting document text, so a stale attempt is refused even with garbage documents', () => {
    const result = runPreSubmitGate(
      baseInput({ currentSourceCvContentHash: 'cv-hash-2', renderedCvText: '', renderedLetterText: null }),
    );
    expect(result.reason).toBe('source_cv_changed');
  });

  it('refuses when the company name is absent from both documents', () => {
    const result = runPreSubmitGate(
      baseInput({ renderedCvText: 'A CV with no employer name at all.', renderedLetterText: 'A letter with no employer name either.' }),
    );
    expect(result).toEqual({ ok: false, reason: 'company_not_found_in_documents', detail: expect.stringContaining('Redwood Software') });
  });

  it('refuses when the role is absent, even though the company is present', () => {
    const result = runPreSubmitGate(
      baseInput({ renderedCvText: 'Applying to Redwood Software.', renderedLetterText: 'Dear Redwood Software team.' }),
    );
    expect(result.reason).toBe('role_not_found_in_documents');
  });

  it('matches company/role case-insensitively', () => {
    const result = runPreSubmitGate(
      baseInput({ renderedCvText: 'applying to REDWOOD SOFTWARE for senior frontend engineer', renderedLetterText: null }),
    );
    expect(result.ok).toBe(true);
  });

  it('finds the company/role when only the cover letter mentions them, not the CV', () => {
    const result = runPreSubmitGate(
      baseInput({ renderedCvText: 'A generic CV with no employer-specific text.' }),
    );
    expect(result.ok).toBe(true);
  });

  for (const [label, text] of [
    ['[Insert Company Name]', 'a bracketed insert-style placeholder'],
    ['[Your Name]', 'a bracketed your-X placeholder'],
    ['[Company Name]', 'a bracketed company placeholder'],
    ['[Role Title]', 'a bracketed role placeholder'],
    ['[Position]', 'a bracketed position placeholder'],
    ['{{company}}', 'a template-brace placeholder'],
    ['Lorem ipsum dolor sit amet', 'lorem ipsum filler text'],
    ['TODO: finish this paragraph', 'a TODO marker'],
  ] as const) {
    it(`refuses when the documents contain ${label} (${text})`, () => {
      const result = runPreSubmitGate(
        baseInput({ renderedCvText: `Applying to Redwood Software for Senior Frontend Engineer. ${label}`, renderedLetterText: null }),
      );
      expect(result.reason).toBe('placeholder_text_detected');
    });
  }

  it('does not flag ordinary English text that merely resembles a placeholder word', () => {
    // "to do" and "insert" are ordinary words; only the bracketed/braced/lorem-ipsum/TODO shapes
    // above are flagged, not every sentence containing one of their component words.
    const result = runPreSubmitGate(
      baseInput({
        renderedCvText: 'Applying to Redwood Software for Senior Frontend Engineer. I know what to do and how to insert myself into a new team.',
        renderedLetterText: null,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('checks hashes and company/role before placeholder text, refusing on the first violation only', () => {
    // A staleness violation is reported even when the text also has a placeholder -- the caller
    // should not have to fix a placeholder in content that is about to be thrown away anyway.
    const result = runPreSubmitGate(
      baseInput({ currentSourceCvContentHash: 'cv-hash-2', renderedCvText: '[Insert Company Name]' }),
    );
    expect(result.reason).toBe('source_cv_changed');
  });
});
