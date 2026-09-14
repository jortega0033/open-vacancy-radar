import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeCodexModelCatalog } from '../src/providers/codex/app-server/model-catalog.js';
import { CodexAppServerProtocolError } from '../src/providers/codex/app-server/errors.js';

/**
 * ADI-22a. Reuses `scope-probe.test.ts`'s own fixture: a real newline-delimited JSON-RPC responder
 * standing in for `codex app-server --stdio`, configured via argv rather than environment (see the
 * fixture's own header for why). `probeCodexModelCatalog` never sends `account/read`, so only the
 * second argv config argument (the `model/list` response) is ever exercised here -- but the
 * fixture still requires both positional args, so a fixed, unused `account/read` response is
 * supplied for every call below.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-app-server-rpc.mjs', import.meta.url));
const UNUSED_ACCOUNT_RESPONSE = { requiresOpenaiAuth: true, account: { type: 'apiKey' } };

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-model-catalog-test-'));
});

afterEach(async () => {
  // Async with retries, not rmSync: see scope-probe.test.ts's own cleanup for why (a lingering
  // Windows child-process handle on this directory just after the probe settles).
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function run(modelResponse: unknown) {
  return probeCodexModelCatalog({
    executable: process.execPath,
    executableArgs: [FIXTURE, JSON.stringify(UNUSED_ACCOUNT_RESPONSE), JSON.stringify(modelResponse)],
    cwd,
    processPlatform: 'linux',
  });
}

describe('probeCodexModelCatalog', () => {
  it('parses a real model/list response into the catalog shape', async () => {
    const catalog = await run({
      data: [
        { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
        { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', isDefault: false },
      ],
    });
    expect(catalog).toEqual([
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true },
      { id: 'gpt-5-mini', displayName: 'GPT-5 Mini', isDefault: false },
    ]);
  }, 10_000);

  it('returns an empty catalog for an empty model/list response, without failing', async () => {
    await expect(run({ data: [] })).resolves.toEqual([]);
  }, 10_000);

  it('never sends account/read, thread/start, or turn/start -- only initialize/model/list', async () => {
    // The fixture errors on any method other than initialize/account/read/model/list (see its own
    // header); a successful call here is itself the proof this probe asked for nothing else, since
    // any other outgoing call would have surfaced as a rejected request and failed it.
    await expect(run({ data: [{ id: 'gpt-5-codex', isDefault: true }] })).resolves.toBeDefined();
  }, 10_000);

  it('rejects on an invalid model/list response rather than returning a partial or guessed catalog', async () => {
    await expect(run({ data: 'not-an-array' })).rejects.toThrow(CodexAppServerProtocolError);
  }, 10_000);

  it('rejects rather than hanging forever when the process never answers initialize', async () => {
    await expect(
      probeCodexModelCatalog({
        executable: process.execPath,
        executableArgs: [fileURLToPath(new URL('./fixtures/fake-hang.mjs', import.meta.url))],
        cwd,
        processPlatform: 'linux',
      }),
    ).rejects.toThrow(CodexAppServerProtocolError);
  }, 10_000);
});
