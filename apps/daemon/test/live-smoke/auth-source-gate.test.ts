import { describe, expect, it } from 'vitest';
import { checkAuthSourceSupportsAppServer } from '../../src/live-smoke/auth-source-gate.js';

describe('checkAuthSourceSupportsAppServer', () => {
  it('supports a chatgpt account', () => {
    expect(checkAuthSourceSupportsAppServer('chatgpt')).toEqual({ supported: true });
  });

  it('supports an unknown auth source (not a known-bad case, so not gated)', () => {
    expect(checkAuthSourceSupportsAppServer('unknown')).toEqual({ supported: true });
  });

  it('supports an undefined auth source (e.g. an unauthenticated/undetected account)', () => {
    expect(checkAuthSourceSupportsAppServer(undefined)).toEqual({ supported: true });
  });

  it('treats api_key auth as unsupported, never a false pass', () => {
    const result = checkAuthSourceSupportsAppServer('api_key');
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toContain('api_key');
  });
});
