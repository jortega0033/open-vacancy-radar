import { describe, expect, it } from 'vitest';
import { CodexAppServerProtocolError, boundedUtf8, safeDisplay } from '../src/providers/codex/app-server/errors.js';

describe('CodexAppServerProtocolError', () => {
  it('constructs with every reason code and carries it, message, and name for callers to branch on', () => {
    const codes = [
      'closed',
      'forbidden_method',
      'frame_invalid',
      'frame_too_large',
      'interaction_invalid',
      'process_failed',
      'response_invalid',
      'state_invalid',
    ] as const;
    for (const code of codes) {
      const error = new CodexAppServerProtocolError(code, `boom: ${code}`);
      expect(error.code).toBe(code);
      expect(error.message).toBe(`boom: ${code}`);
      expect(error.name).toBe('CodexAppServerProtocolError');
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe('boundedUtf8', () => {
  it('returns the string unchanged when it already fits', () => {
    expect(boundedUtf8('hello', 100)).toBe('hello');
  });

  it('truncates to the exact byte cap for pure ASCII', () => {
    expect(boundedUtf8('abcdef', 3)).toBe('abc');
  });

  it('never splits a multi-byte character in half', () => {
    // Each euro sign is 3 UTF-8 bytes; a cap of 4 bytes must not emit a truncated 1- or 2-byte
    // fragment of the second character.
    const truncated = boundedUtf8('€€€', 4);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(4);
    expect(truncated).toBe('€');
  });
});

describe('safeDisplay', () => {
  it('returns the fallback for a non-string value', () => {
    expect(safeDisplay(undefined, 100, 'fallback')).toBe('fallback');
    expect(safeDisplay(42, 100, 'fallback')).toBe('fallback');
    expect(safeDisplay(null, 100, 'fallback')).toBe('fallback');
  });

  it('returns the fallback for an empty string', () => {
    expect(safeDisplay('', 100, 'fallback')).toBe('fallback');
  });

  it('replaces control characters with a space rather than passing them through', () => {
    const result = safeDisplay('before\x1bafter', 100, 'fallback');
    expect(result).not.toContain('\x1b');
    expect(result).toBe('before after');
  });

  it('replaces a fake-log-line newline/carriage-return with a space, defeating log forgery', () => {
    const result = safeDisplay('real message\nFAKE: injected line', 100, 'fallback');
    expect(result).not.toContain('\n');
  });

  it('applies the byte bound after sanitizing', () => {
    const result = safeDisplay('abcdefgh', 4, 'fallback');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(4);
  });
});
