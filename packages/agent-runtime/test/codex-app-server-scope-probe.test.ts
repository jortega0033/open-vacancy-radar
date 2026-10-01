import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeCodexAppServerScope } from '../src/providers/codex/app-server/scope-probe.js';
import { ProviderTransportStartupError } from '../src/providers/common/fallback-gate.js';
import { CodexAppServerProtocolError } from '../src/providers/codex/app-server/errors.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-app-server-rpc.mjs', import.meta.url));

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-scope-probe-test-'));
});

afterEach(async () => {
  // Async with retries, not rmSync: on Windows the just-torn-down child process's handle on this
  // directory can linger for a few milliseconds after the probe itself has resolved/rejected,
  // and a synchronous delete during that window fails with EPERM (see spawn-process.test.ts's
  // own cleanup, which uses this same retry pattern for the same reason).
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function run(accountResponse: unknown, modelResponse: unknown, detectedAuthSource: 'chatgpt' | 'api_key' | 'unknown' | undefined, pinnedModel?: string) {
  return probeCodexAppServerScope({
    executable: process.execPath,
    executableArgs: [FIXTURE, JSON.stringify(accountResponse), JSON.stringify(modelResponse)],
    cwd,
    processPlatform: 'linux',
    detectedAuthSource,
    pinnedModel,
  });
}

describe('probeCodexAppServerScope', () => {
  it('returns continuation evidence for a chatgpt account with an email, matching the detected auth source', async () => {
    const evidence = await run(
      { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'user@example.com' } },
      { data: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }] },
      'chatgpt',
    );
    expect(evidence).toBeDefined();
    expect(evidence!.selectedModel).toBe('gpt-5-codex');
    expect(evidence!.accountFingerprint).toHaveLength(64); // hex-encoded SHA-256
  }, 10_000);

  it('returns undefined for an api_key account -- no bindable continuation identity, not a failure', async () => {
    const evidence = await run({ requiresOpenaiAuth: false, account: { type: 'apiKey' } }, { data: [{ id: 'gpt-5-codex', isDefault: true }] }, 'api_key');
    expect(evidence).toBeUndefined();
  }, 10_000);

  it('resolves the pinned model over the default when one is supplied', async () => {
    const evidence = await run(
      { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'user@example.com' } },
      { data: [{ id: 'gpt-5-codex', isDefault: true }, { id: 'gpt-5-mini', isDefault: false }] },
      'chatgpt',
      'gpt-5-mini',
    );
    expect(evidence!.selectedModel).toBe('gpt-5-mini');
  }, 10_000);

  it('throws when the live account authSource disagrees with what detect() already reported', async () => {
    await expect(
      run({ requiresOpenaiAuth: false, account: { type: 'apiKey' } }, { data: [{ id: 'gpt-5-codex', isDefault: true }] }, 'chatgpt'),
    ).rejects.toThrow(CodexAppServerProtocolError);
  }, 10_000);

  it('throws when detectedAuthSource is undefined or unknown -- never trusts an unverified source', async () => {
    await expect(
      run({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'user@example.com' } }, { data: [{ id: 'gpt-5-codex', isDefault: true }] }, undefined),
    ).rejects.toThrow(CodexAppServerProtocolError);
    await expect(
      run({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'user@example.com' } }, { data: [{ id: 'gpt-5-codex', isDefault: true }] }, 'unknown'),
    ).rejects.toThrow(CodexAppServerProtocolError);
  }, 10_000);

  it('propagates codex_model_unavailable end to end when an operator pins a retired/renamed model', async () => {
    await expect(
      run(
        { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'user@example.com' } },
        { data: [{ id: 'gpt-5-codex', isDefault: true }] },
        'chatgpt',
        'gpt-4-retired',
      ),
    ).rejects.toMatchObject({ reasonCode: 'codex_model_unavailable', deliveryState: 'not_delivered' });
  }, 10_000);

  it('propagates a ProviderTransportStartupError from resolveCodexSelectedModel when the default is ambiguous', async () => {
    await expect(
      run(
        { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'user@example.com' } },
        { data: [{ id: 'a', isDefault: true }, { id: 'b', isDefault: true }] },
        'chatgpt',
      ),
    ).rejects.toThrow(ProviderTransportStartupError);
  }, 10_000);

  it('never sends thread/start or turn/start -- only initialize/account read/model list', async () => {
    // The fixture answers exactly initialize/account/read/model/list and errors on anything else
    // (see fake-app-server-rpc.mjs); a successful probe run here is itself the proof no other
    // method was ever called, since any other outgoing call would have surfaced as a rejected
    // request and failed the probe.
    await expect(
      run({ requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'user@example.com' } }, { data: [{ id: 'gpt-5-codex', isDefault: true }] }, 'chatgpt'),
    ).resolves.toBeDefined();
  }, 10_000);

  it('rejects rather than hanging forever when the process never gives a usable initialize response', async () => {
    // fake-hang.mjs writes one unrelated, malformed line then goes silent -- whether that surfaces
    // as an immediate protocol violation or (for a process that stayed truly silent) the 4s probe
    // timeout, both are real CodexAppServerProtocolError outcomes; what this test actually proves is
    // that the probe settles at all instead of hanging past its own timeout budget.
    await expect(
      probeCodexAppServerScope({
        executable: process.execPath,
        executableArgs: [fileURLToPath(new URL('./fixtures/fake-hang.mjs', import.meta.url))],
        cwd,
        processPlatform: 'linux',
        detectedAuthSource: 'chatgpt',
      }),
    ).rejects.toThrow(CodexAppServerProtocolError);
  }, 10_000);
});
