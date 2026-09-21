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

  it('never mutates or returns anything other than the preference argument itself when falling back to it', () => {
    // The resolver is a pure read over `providerStatuses`; it has no settings/DB access at all,
    // so "the persisted preference is never auto-rewritten" holds structurally here, not just by
    // convention -- confirmed by asserting the exact same `preferred` value/reference comes back
    // in every fallback branch (issue #400's "never silently rewrite the preference" guarantee).
    const preferred = 'claude';
    expect(resolveEffectiveProvider(preferred, [status('claude', false), status('codex', false)])).toBe(preferred);
    expect(resolveEffectiveProvider(preferred, [status('claude', true), status('codex', true)])).toBe(preferred);
  });

  it('resolves the same way each time a manually-chosen preference is re-evaluated across its executable disappearing and reappearing', () => {
    // Simulates the CLI vanishing (a PATH issue, a reinstall in progress) and coming back, calling
    // the resolver fresh each time exactly as `useEffectiveProvider` would on a new `listProviders()`
    // read -- the preference passed in is never itself changed by a prior call, so a temporarily
    // missing executable can never leave behind a silently "switched" preference once it returns.
    const preferred = 'claude';
    const installed = [status('claude', true), status('codex', true)];
    const claudeMissing = [status('claude', false), status('codex', true)];

    expect(resolveEffectiveProvider(preferred, installed)).toBe('claude');
    expect(resolveEffectiveProvider(preferred, claudeMissing)).toBe('codex');
    expect(resolveEffectiveProvider(preferred, installed)).toBe('claude');
    // The preference itself was never reassigned across the sequence above.
    expect(preferred).toBe('claude');
  });
});
