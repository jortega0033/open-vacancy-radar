import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderTransportStartupError } from '../src/providers/common/fallback-gate.js';
import { CodexAppServerProtocolError } from '../src/providers/codex/app-server/errors.js';
import {
  parseCodexAccountScope,
  parseCodexModelCatalog,
  resolveCodexSelectedModel,
  toCodexContinuationEvidence,
} from '../src/providers/codex/app-server/scope-evidence.js';

describe('parseCodexAccountScope', () => {
  it('returns api_key with no fingerprint for an API-key account', () => {
    expect(parseCodexAccountScope({ requiresOpenaiAuth: false, account: { type: 'apiKey' } })).toEqual({ authSource: 'api_key' });
  });

  it('returns chatgpt with a SHA-256 fingerprint of the normalized email, never the raw address', () => {
    const result = parseCodexAccountScope({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'User@Example.com ' } });
    expect(result.authSource).toBe('chatgpt');
    expect(result.fingerprint).toBe(createHash('sha256').update('user@example.com', 'utf8').digest('hex'));
    expect(result.fingerprint).not.toContain('user@example.com');
    expect(result.fingerprint).not.toContain('User@Example.com');
  });

  it('returns chatgpt with no fingerprint when the account has no email', () => {
    expect(parseCodexAccountScope({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email: null } })).toEqual({ authSource: 'chatgpt' });
  });

  it('throws ProviderTransportStartupError with deliveryState not_delivered when no account is authenticated', () => {
    expect(() => parseCodexAccountScope({ requiresOpenaiAuth: true, account: null })).toThrow(ProviderTransportStartupError);
    try {
      parseCodexAccountScope({ requiresOpenaiAuth: true, account: undefined });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderTransportStartupError);
      expect((error as ProviderTransportStartupError).deliveryState).toBe('not_delivered');
      expect((error as ProviderTransportStartupError).reasonCode).toBe('codex_auth_scope_changed');
    }
  });

  it('throws ProviderTransportStartupError for an unsupported account type', () => {
    expect(() => parseCodexAccountScope({ requiresOpenaiAuth: true, account: { type: 'somethingElse' } })).toThrow(ProviderTransportStartupError);
  });

  it('throws CodexAppServerProtocolError (a protocol error, not a startup error) for a structurally malformed response', () => {
    expect(() => parseCodexAccountScope({ account: {} })).toThrow(CodexAppServerProtocolError);
    expect(() => parseCodexAccountScope('not an object')).toThrow(CodexAppServerProtocolError);
  });
});

describe('parseCodexModelCatalog', () => {
  it('parses a well-formed catalog', () => {
    const catalog = parseCodexModelCatalog({ data: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }] });
    expect(catalog).toEqual([{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }]);
  });

  it('falls back displayName to a safe default when missing/invalid', () => {
    const catalog = parseCodexModelCatalog({ data: [{ id: 'gpt-5-codex', isDefault: false }] });
    expect(catalog[0]!.displayName).toBe('Codex model');
  });

  it('throws on a non-array data field', () => {
    expect(() => parseCodexModelCatalog({ data: 'not an array' })).toThrow(CodexAppServerProtocolError);
  });

  it('throws on an oversized model id (bounds enforcement)', () => {
    expect(() => parseCodexModelCatalog({ data: [{ id: 'x'.repeat(300) }] })).toThrow(CodexAppServerProtocolError);
  });
});

describe('resolveCodexSelectedModel', () => {
  const catalog = [
    { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
    { id: 'gpt-5-mini', displayName: 'GPT-5 mini', isDefault: false },
  ];

  it('returns the single default model when no pin is supplied', () => {
    expect(resolveCodexSelectedModel(catalog)).toBe('gpt-5-codex');
  });

  it('returns the pinned model when it exists in the catalog', () => {
    expect(resolveCodexSelectedModel(catalog, 'gpt-5-mini')).toBe('gpt-5-mini');
  });

  it('throws codex_model_unavailable for a pinned model not in the catalog', () => {
    try {
      resolveCodexSelectedModel(catalog, 'nonexistent-model');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderTransportStartupError);
      expect((error as ProviderTransportStartupError).reasonCode).toBe('codex_model_unavailable');
      expect((error as ProviderTransportStartupError).deliveryState).toBe('not_delivered');
    }
  });

  it('throws codex_model_unverified when zero or more than one default exists', () => {
    expect(() => resolveCodexSelectedModel([])).toThrow(ProviderTransportStartupError);
    expect(() => resolveCodexSelectedModel([{ id: 'a', displayName: 'A', isDefault: true }, { id: 'b', displayName: 'B', isDefault: true }])).toThrow(
      ProviderTransportStartupError,
    );
    try {
      resolveCodexSelectedModel([]);
      expect.unreachable();
    } catch (error) {
      expect((error as ProviderTransportStartupError).reasonCode).toBe('codex_model_unverified');
    }
  });
});

describe('toCodexContinuationEvidence', () => {
  it('returns evidence when the account has a fingerprint', () => {
    expect(toCodexContinuationEvidence({ authSource: 'chatgpt', fingerprint: 'abc' }, 'gpt-5-codex')).toEqual({
      accountFingerprint: 'abc',
      selectedModel: 'gpt-5-codex',
    });
  });

  it('returns undefined when the account has no fingerprint (api_key, or chatgpt with no email)', () => {
    expect(toCodexContinuationEvidence({ authSource: 'api_key' }, 'gpt-5-codex')).toBeUndefined();
    expect(toCodexContinuationEvidence({ authSource: 'chatgpt' }, 'gpt-5-codex')).toBeUndefined();
  });
});
