import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_CAPABILITIES } from '../src/providers/codex/capabilities.js';

describe('CODEX_CAPABILITIES.modelCatalog (ADI-22a)', () => {
  it('declares modelCatalog: true, matching the real fetchModelCatalog implementation', () => {
    expect(CODEX_CAPABILITIES.modelCatalog).toBe(true);
  });
});

/**
 * `CodexProvider.fetchModelCatalog()` (ADI-22a), tested at the same seam `codex-detect.test.ts`
 * already uses for `detectCodex`: `findExecutable` and the live RPC probe are both mocked (never a
 * real CLI or process spawn -- `../src/providers/codex/app-server/model-catalog.js`'s
 * `probeCodexModelCatalog` is exactly the function `codex-app-server-model-catalog.test.ts`
 * exercises end to end against the real fake-RPC fixture, so this file only has to prove the
 * adapter wires it correctly, not re-prove the RPC round trip itself).
 */
describe('CodexProvider.fetchModelCatalog', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolves to an empty catalog, never a rejection, when the codex executable cannot be found', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => null }));
    vi.doMock('../src/providers/codex/app-server/model-catalog.js', () => ({
      probeCodexModelCatalog: vi.fn(async () => {
        throw new Error('must not be called when the executable is missing');
      }),
    }));
    const { CodexProvider } = await import('../src/providers/codex/adapter.js');
    const provider = new CodexProvider();

    await expect(provider.fetchModelCatalog!({})).resolves.toEqual([]);
  });

  it('maps the live probe result to the shared ProviderModelV2 shape', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    const probe = vi.fn(async () => [
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
      { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', isDefault: false },
    ]);
    vi.doMock('../src/providers/codex/app-server/model-catalog.js', () => ({ probeCodexModelCatalog: probe }));
    const { CodexProvider } = await import('../src/providers/codex/adapter.js');
    const provider = new CodexProvider();

    const catalog = await provider.fetchModelCatalog!({ cwd: '/workspace/one' });

    expect(catalog).toEqual([
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
      { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', isDefault: false },
    ]);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ executable: '/usr/local/bin/codex', cwd: '/workspace/one' }));
  });

  it('defaults cwd to the OS temp directory when the caller supplies none', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    const probe = vi.fn(async (_options: { cwd: string }) => [] as const);
    vi.doMock('../src/providers/codex/app-server/model-catalog.js', () => ({ probeCodexModelCatalog: probe }));
    const { CodexProvider } = await import('../src/providers/codex/adapter.js');
    const provider = new CodexProvider();

    await provider.fetchModelCatalog!({});

    const call = probe.mock.calls[0]?.[0];
    expect(typeof call?.cwd).toBe('string');
    expect(call?.cwd.length).toBeGreaterThan(0);
  });

  it('propagates a live probe failure -- callers, not this method, decide how to degrade', async () => {
    vi.doMock('../src/detect-executable.js', () => ({ findExecutable: async () => '/usr/local/bin/codex' }));
    vi.doMock('../src/providers/codex/app-server/model-catalog.js', () => ({
      probeCodexModelCatalog: vi.fn(async () => {
        throw new Error('app-server probe timed out');
      }),
    }));
    const { CodexProvider } = await import('../src/providers/codex/adapter.js');
    const provider = new CodexProvider();

    await expect(provider.fetchModelCatalog!({})).rejects.toThrow('app-server probe timed out');
  });
});
