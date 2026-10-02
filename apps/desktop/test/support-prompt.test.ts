import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from '../electron/external-url.js';
import {
  DEFAULT_SUPPORT_PROMPT,
  SUPPORT_SUCCESSES_BEFORE_REASK,
  isSupportDue,
  nextSupportState,
  parseSupportPromptStrict,
  readSupportPrompt,
  type SupportPromptState,
} from '../electron/workspace/support-prompt.js';
import { parseSettingsPatch } from '../electron/workspace/validate.js';
import { COFFEE_URL, REPOSITORY_URL } from '../src/support-links.js';

/** #503: the ask's frequency cap, its tolerant reader, its patch validation and its two links. */

const FRESH: SupportPromptState = { answered: false, asks: 0, successesSinceDismissal: 0 };

function state(asks: number, successesSinceDismissal: number, answered = false): SupportPromptState {
  return { answered, asks, successesSinceDismissal };
}

describe('nextSupportState', () => {
  it('a first success leaves the counters alone and makes the dialog due', () => {
    const next = nextSupportState(FRESH, 'success');
    expect(next).toEqual(FRESH);
    expect(isSupportDue(next)).toBe(true);
  });

  it('the first "Not now" counts one ask and restarts the success count', () => {
    expect(nextSupportState(state(0, 0), 'not_now')).toEqual(state(1, 0));
    expect(nextSupportState(state(0, 3), 'not_now')).toEqual(state(1, 0));
  });

  it('after one "Not now", successes count up and the dialog is due on the 5th', () => {
    let current = state(1, 0);
    for (let i = 1; i < SUPPORT_SUCCESSES_BEFORE_REASK; i += 1) {
      current = nextSupportState(current, 'success');
      expect(current).toEqual(state(1, i));
      expect(isSupportDue(current), `success ${i}`).toBe(false);
    }
    current = nextSupportState(current, 'success');
    expect(current).toEqual(state(1, 5));
    expect(isSupportDue(current)).toBe(true);
  });

  it('a second "Not now" ends the asks for good', () => {
    const ended = nextSupportState(state(1, 5), 'not_now');
    expect(ended).toEqual(state(2, 0));
    expect(isSupportDue(ended)).toBe(false);
    expect(nextSupportState(ended, 'success')).toEqual(ended);
    expect(nextSupportState(ended, 'not_now')).toEqual(ended);
  });

  it('answered ends the asks at any point and leaves the other counters alone', () => {
    for (const before of [state(0, 0), state(1, 2), state(1, 5), state(2, 0)]) {
      const next = nextSupportState(before, 'answered');
      expect(next).toEqual({ ...before, answered: true });
      expect(isSupportDue(next)).toBe(false);
    }
  });

  it('does nothing once answered, whatever happens next', () => {
    const answered = state(1, 4, true);
    expect(nextSupportState(answered, 'success')).toBe(answered);
    expect(nextSupportState(answered, 'not_now')).toBe(answered);
    expect(nextSupportState(answered, 'answered')).toBe(answered);
  });

  it('does not mutate the state it was given', () => {
    const before = Object.freeze(state(1, 2));
    expect(() => nextSupportState(before, 'success')).not.toThrow();
    expect(before).toEqual(state(1, 2));
  });
});

describe('reading the stored value', () => {
  it('reads a missing or malformed value as not answered with 0 asks', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'not json',
      '[]',
      42,
      [],
      {},
      { answered: 'yes', asks: 0, successesSinceDismissal: 0 },
      { answered: false, asks: -1, successesSinceDismissal: 0 },
      { answered: false, asks: 3, successesSinceDismissal: 0 },
      { answered: false, asks: 1.5, successesSinceDismissal: 0 },
      { answered: false, asks: 0, successesSinceDismissal: Number.NaN },
      { answered: false, asks: 0 },
    ]) {
      expect(readSupportPrompt(bad), JSON.stringify(bad)).toEqual(DEFAULT_SUPPORT_PROMPT);
    }
  });

  it('returns a fresh object for a bad value, never the shared default', () => {
    expect(readSupportPrompt(undefined)).not.toBe(DEFAULT_SUPPORT_PROMPT);
  });

  it('reads a valid value, as an object or as the JSON text of one', () => {
    const value = state(1, 3, false);
    expect(readSupportPrompt(value)).toEqual(value);
    expect(readSupportPrompt(JSON.stringify(value))).toEqual(value);
  });
});

describe('parseSettingsPatch and supportPrompt', () => {
  it('accepts a valid value', () => {
    expect(parseSettingsPatch({ supportPrompt: state(1, 2, true) })).toEqual({ supportPrompt: state(1, 2, true) });
  });

  it('rejects an invalid value', () => {
    for (const bad of [
      null,
      'yes',
      [],
      {},
      { answered: true },
      { answered: 'true', asks: 0, successesSinceDismissal: 0 },
      { answered: false, asks: 3, successesSinceDismissal: 0 },
      { answered: false, asks: 0, successesSinceDismissal: -1 },
      { answered: false, asks: 0, successesSinceDismissal: 2.5 },
    ]) {
      expect(() => parseSettingsPatch({ supportPrompt: bad }), JSON.stringify(bad)).toThrow(/supportPrompt/);
    }
  });

  it('strictly parses only valid values', () => {
    expect(parseSupportPromptStrict(state(2, 0, false))).toEqual(state(2, 0, false));
    expect(parseSupportPromptStrict({ answered: false, asks: 9, successesSinceDismissal: 0 })).toBeNull();
  });
});

describe('the Support links', () => {
  it('are the two fixed https addresses', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/jortega0033/open-vacancy-radar');
    expect(COFFEE_URL).toBe('https://buymeacoffee.com/jortega0033');
  });

  it('both pass isSafeExternalUrl, so the existing window-open handler opens them', () => {
    expect(isSafeExternalUrl(REPOSITORY_URL)).toBe(true);
    expect(isSafeExternalUrl(COFFEE_URL)).toBe(true);
  });
});
