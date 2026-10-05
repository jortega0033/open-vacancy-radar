import { describe, expect, it } from 'vitest';
import { classifyProviderError, redactHomePaths } from '../src/provider-error.js';

describe('classifyProviderError (#461)', () => {
  const now = new Date(2026, 9, 3, 9, 0, 0);

  it('recognises the Claude Code session limit and keeps the reset time as written', () => {
    const info = classifyProviderError("You've hit your session limit, resets 12:10pm (Europe/Amsterdam)", now);
    expect(info.kind).toBe('usage_limit');
    expect(info.resetLabel).toBe('12:10pm (Europe/Amsterdam)');
  });

  it('drops a sentence-ending dot after the time so "until X." never doubles it', () => {
    const info = classifyProviderError("You've hit your session limit · resets 11:59pm.", now);
    expect(info.resetLabel).toBe('11:59pm');
    expect(info.resetAt).toBe(new Date(2026, 9, 3, 23, 59).getTime());
  });

  it('places a reset time only when the zone is this machine\'s or unnamed', () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const same = classifyProviderError(`usage limit reached, resets 12:10pm (${local})`, now);
    expect(same.resetAt).toBe(new Date(2026, 9, 3, 12, 10).getTime());

    const unnamed = classifyProviderError('rate limit exceeded, resets at 5pm', now);
    expect(unnamed.resetAt).toBe(new Date(2026, 9, 3, 17, 0).getTime());

    const other = classifyProviderError('session limit, resets 12:10pm (Pacific/Auckland)', now);
    expect(other.resetLabel).toBe('12:10pm (Pacific/Auckland)');
    expect(other.resetAt).toBeUndefined();
  });

  it('rolls a reset time that has already passed today over to tomorrow', () => {
    const late = new Date(2026, 9, 3, 13, 0, 0);
    expect(classifyProviderError('session limit, resets 12:10pm', late).resetAt).toBe(new Date(2026, 9, 4, 12, 10).getTime());
  });

  it('does not guess a time from vague text', () => {
    for (const text of ['usage limit reached, resets soon', 'rate limit, try again later', 'session limit, resets 12']) {
      const info = classifyProviderError(text, now);
      expect(info.kind, text).toBe('usage_limit');
      expect(info.resetLabel, text).toBeUndefined();
      expect(info.resetAt, text).toBeUndefined();
    }
  });

  it('separates sign-in and unavailable failures from limits and from everything else', () => {
    expect(classifyProviderError('Not logged in. Please run claude login').kind).toBe('not_signed_in');
    expect(classifyProviderError('spawn codex ENOENT').kind).toBe('unavailable');
    expect(classifyProviderError('the agent finished without returning any text').kind).toBe('other');
  });

  it('shortens home-folder paths in the details', () => {
    expect(redactHomePaths('failed at /Users/jamie/projects/x and C:\\Users\\Jamie\\AppData\\y and /home/pat/z')).toBe(
      'failed at ~/projects/x and ~\\AppData\\y and ~/z',
    );
    expect(redactHomePaths('/Users/Jane Doe/x and C:\\Users\\Jane Doe\\y and /home/jane doe/z')).toBe('~/x and ~\\y and ~/z');
    expect(classifyProviderError('session limit at /home/pat/cv.pdf').details).toBe('session limit at ~/cv.pdf');
  });
});
