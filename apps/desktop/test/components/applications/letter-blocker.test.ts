import { describe, expect, it } from 'vitest';
import { describeLetterBlocker } from '../../../src/components/applications/letter-blocker.js';

const TAIL = '. Use Generate letter to create and review one, then return here, or provide one on the employer site.';

describe('describeLetterBlocker (#565)', () => {
  it('returns null when the detail has no blocker', () => {
    expect(describeLetterBlocker('Your application documents are ready.')).toBeNull();
  });

  it('keeps only the reason between the marker and the pipeline instruction', () => {
    const result = describeLetterBlocker(`Your CV is ready. Cover letter blocker: the cover letter could not be produced: render timed out${TAIL}`);
    expect(result).toEqual({
      message: 'The cover letter file could not be made.',
      detail: 'the cover letter could not be produced: render timed out',
    });
  });

  it('reads a usage limit with its reset time placed from updatedAt', () => {
    const updatedAt = new Date(2026, 9, 4, 10, 0).toISOString();
    const result = describeLetterBlocker(
      `Cover letter blocker: automatic cover letter generation stopped: You've hit your session limit · resets 3pm${TAIL}`,
      updatedAt,
    );
    expect(result?.message).toBe('Claude has reached its usage limit until 3pm, so the cover letter was not written.');
    expect(result?.limit?.resetAt).toBe(new Date(2026, 9, 4, 15, 0).getTime());
  });

  it('names a sign-in problem', () => {
    const result = describeLetterBlocker(
      `Cover letter blocker: automatic cover letter generation stopped: Invalid API key · Please run /login${TAIL}`,
    );
    expect(result?.message).toBe('Claude Code is not signed in, so the cover letter was not written.');
  });

  it('names an empty saved letter', () => {
    const result = describeLetterBlocker(`Cover letter blocker: the requested cover letter has no final content${TAIL}`);
    expect(result?.message).toBe('The letter saved for this job is empty.');
  });

  it('falls back to a plain sentence for anything else', () => {
    expect(describeLetterBlocker('Cover letter blocker: unsupported source facts.')?.message).toBe(
      'The cover letter could not be written.',
    );
  });
});
