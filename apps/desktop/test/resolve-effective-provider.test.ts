import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '@agent-dock/shared';
import { resolveEffectiveProvider } from '../src/resolve-effective-provider.js';

/** Minimal fixture: only the fields `resolveEffectiveProvider` (or its `ProviderStatus` type)
 * actually requires, matching this repo's own fixture convention elsewhere in this file. */
function status(id: ProviderStatus['id'], installed: boolean): ProviderStatus {
  return {
    id,
    name: id === 'claude' ? 'Claude Code' : 'Codex',
    installed,
    authenticated: installed ? 'authenticated' : 'unknown',
    capabilities: {},
  };
}

describe('resolveEffectiveProvider', () => {
  it('resolves to Claude when only Claude is installed, regardless of preference', () => {
    const providers = [status('claude', true), status('codex', false)];
    expect(resolveEffectiveProvider('claude', providers)).toBe('claude');
    expect(resolveEffectiveProvider('codex', providers)).toBe('claude');
  });

  it('resolves to Codex when only Codex is installed, regardless of preference', () => {
    const providers = [status('claude', false), status('codex', true)];
    expect(resolveEffectiveProvider('claude', providers)).toBe('codex');
    expect(resolveEffectiveProvider('codex', providers)).toBe('codex');
  });

  it('keeps the preference unchanged when both providers are installed', () => {
    const providers = [status('claude', true), status('codex', true)];
    expect(resolveEffectiveProvider('claude', providers)).toBe('claude');
    expect(resolveEffectiveProvider('codex', providers)).toBe('codex');
  });

  it('falls back to the preference when neither provider is installed', () => {
    const providers = [status('claude', false), status('codex', false)];
    expect(resolveEffectiveProvider('claude', providers)).toBe('claude');
    expect(resolveEffectiveProvider('codex', providers)).toBe('codex');
  });

  it('resolves to the one unambiguous installed alternative when the preference is missing from the list', () => {
    const providers = [status('codex', true)];
    expect(resolveEffectiveProvider('claude', providers)).toBe('codex');
  });
});
