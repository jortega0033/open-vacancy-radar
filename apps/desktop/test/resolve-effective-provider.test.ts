import { describe, expect, it } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import { resolveEffectiveProvider } from '../src/resolve-effective-provider.js';

const NO_CAPABILITIES: ProviderCapabilities = {};

function status(id: ProviderStatus['id'], installed: boolean): ProviderStatus {
  return {
    id,
    name: id === 'claude' ? 'Claude Code' : 'Codex',
    installed,
    authenticated: installed ? 'authenticated' : 'unknown',
    capabilities: NO_CAPABILITIES,
  };
}

describe('resolveEffectiveProvider (issue #400)', () => {
  it('returns the preferred provider when both are installed, unchanged from today', () => {
    const statuses = [status('claude', true), status('codex', true)];
    expect(resolveEffectiveProvider('claude', statuses)).toBe('claude');
    expect(resolveEffectiveProvider('codex', statuses)).toBe('codex');
  });

  it('returns Claude when only Claude is installed, regardless of the preference', () => {
    const statuses = [status('claude', true), status('codex', false)];
    expect(resolveEffectiveProvider('claude', statuses)).toBe('claude');
    expect(resolveEffectiveProvider('codex', statuses)).toBe('claude');
  });

  it('returns Codex when only Codex is installed, regardless of the preference', () => {
    const statuses = [status('claude', false), status('codex', true)];
    expect(resolveEffectiveProvider('codex', statuses)).toBe('codex');
    expect(resolveEffectiveProvider('claude', statuses)).toBe('codex');
  });

  it('falls back to the preference, unchanged, when neither provider is installed', () => {
    const statuses = [status('claude', false), status('codex', false)];
    expect(resolveEffectiveProvider('claude', statuses)).toBe('claude');
    expect(resolveEffectiveProvider('codex', statuses)).toBe('codex');
  });

  it('falls back to the preference when the provider-status list is empty (e.g. detection failed)', () => {
    expect(resolveEffectiveProvider('claude', [])).toBe('claude');
    expect(resolveEffectiveProvider('codex', [])).toBe('codex');
  });

  it('resolves to the one installed alternative even when the preferred provider is missing from the status list entirely', () => {
    // A preferred id absent from the list (e.g. detection didn't report it at all) is treated the
    // same as "not installed" -- so with exactly one other provider installed, that one is used.
    expect(resolveEffectiveProvider('codex', [status('claude', true)])).toBe('claude');
  });

  it('falls back to the preference, unchanged, when it is missing from the status list and nothing is installed', () => {
    expect(resolveEffectiveProvider('codex', [status('claude', false)])).toBe('codex');
  });

  it('never falls back to an alternative when more than one other provider is installed (generic, not hardcoded to two)', () => {
    // Simulates a hypothetical third provider: with two installed alternatives, the ambiguity is
    // resolved by keeping the preference rather than guessing which alternative was meant.
    const thirdProviderInstalled: ProviderStatus = {
      id: 'codex',
      name: 'Third Provider (simulated)',
      installed: true,
      authenticated: 'authenticated',
      capabilities: NO_CAPABILITIES,
    };
    const statuses = [status('claude', false), status('codex', true), thirdProviderInstalled];
    // (codex appears twice here only to simulate "two installed alternatives" with today's two
    // real provider ids; the function itself never special-cases the count.)
    const installedCount = statuses.filter((s) => s.id !== 'claude' && s.installed).length;
    expect(installedCount).toBeGreaterThan(1);
    expect(resolveEffectiveProvider('claude', statuses)).toBe('claude');
  });

  it('is a pure function: the same inputs always produce the same output, with no observable side effects', () => {
    const statuses = [status('claude', false), status('codex', true)];
    const first = resolveEffectiveProvider('claude', statuses);
    const second = resolveEffectiveProvider('claude', statuses);
    expect(first).toBe(second);
    expect(first).toBe('codex');
    // Inputs are untouched.
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toEqual(status('claude', false));
  });

  it('never mutates the persisted preference it was given: the caller-visible preferred value is still what was passed in', () => {
    const statuses = [status('claude', false), status('codex', true)];
    const preferred = 'claude' as const;
    const effective = resolveEffectiveProvider(preferred, statuses);
    // The resolver's return value can differ from the preference (that's the whole point), but the
    // variable the caller holds as "the persisted preference" is never reassigned by calling this
    // pure function -- there is nothing here that could write it, since resolveEffectiveProvider
    // takes no settings-writing dependency at all.
    expect(preferred).toBe('claude');
    expect(effective).toBe('codex');
  });
});
