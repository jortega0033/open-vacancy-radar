import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import { RevokedWorkspaceError, SessionManager } from '../src/session-manager.js';
import { WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import type { WorkspaceIdentity } from '../src/workspace-identity.js';

/**
 * The epoch-bracketed trust check, and the revocation ordering that makes it work.
 *
 * The property under test everywhere below is the same one: `workspaceIsTrusted` re-reads the
 * revocation epoch after **every** await, so a revocation landing in any gap is caught. Each race
 * test injects `blockWorkspace()` at a different one of those gaps, and the assertion is always
 * `false`.
 *
 * ## Why the answer alone does not pin any individual check
 *
 * Revocation state is monotonic -- both `blockWorkspace` and `allowWorkspace` only ever increment
 * the epoch -- so once a gap's revocation has happened, every later check sees it too. Asserting
 * only on the returned `false` therefore proves that *some* check caught it, never which one, and
 * an adversarial reviewer who deletes any single intermediate check will find these tests still
 * green. The `SHORT-CIRCUIT` tests below close that gap the only way it can be closed: by asserting
 * on the **work that must not happen** after a check fires (`revalidate` never called, `inspect`
 * never called). Those do fail when their check is deleted.
 *
 * The post-inspection re-check is the one exception and is documented as such in
 * `session-manager.ts`: nothing observable happens between it and the final comparison, so no test
 * can distinguish the two. It stays as defense-in-depth for the day something does.
 */

const WORKSPACE = 'a'.repeat(64);
const INCARNATION = 'b'.repeat(64);
const WORKSPACE_PATH = join('C:', 'workspaces', 'project');

function makeControllableSession() {
  const waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  let closed = false;
  let cancelled = false;

  async function* events(): AsyncGenerator<AgentEvent, void, void> {
    while (!closed) {
      const result = await new Promise<IteratorResult<AgentEvent>>((resolve) => waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }

  const handle: ProviderSessionHandle = {
    events: events(),
    cancel: async () => {
      cancelled = true;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
  };

  return { handle, isCancelled: () => cancelled };
}

class TestProvider implements AgentProvider {
  readonly id: ProviderId;
  readonly name = 'Test Provider';
  readonly sessions = new Map<string, ReturnType<typeof makeControllableSession>>();

  constructor(id: ProviderId = 'claude') {
    this.id = id;
  }

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    const session = makeControllableSession();
    this.sessions.set(options.sessionId, session);
    return session.handle;
  }
}

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-session-workspace-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function identity(): WorkspaceIdentity {
  return {
    workspaceId: WORKSPACE,
    incarnation: INCARNATION,
    canonicalPath: WORKSPACE_PATH,
    displayName: 'project',
    reusable: true,
  };
}

interface SetupOptions {
  revalidate?: (path: string, expected: { workspaceId: string; incarnation: string }) => Promise<boolean>;
}

async function setup(options: SetupOptions = {}) {
  const provider = new TestProvider();
  const otherProvider = new TestProvider('codex');
  const registry = new ProviderRegistry();
  registry.register(provider);
  registry.register(otherProvider);
  const trustStore = new WorkspaceTrustStore({ stateRoot });
  await trustStore.setTrusted(identity(), 'claude');

  const sessionManager = new SessionManager(registry, noopLogger, undefined, undefined, undefined, {
    trustStore,
    revalidate: options.revalidate ?? (async () => true),
  });
  return { provider, otherProvider, sessionManager, trustStore };
}

function check(sessionManager: SessionManager) {
  return {
    workspaceId: WORKSPACE,
    incarnation: INCARNATION,
    canonicalPath: WORKSPACE_PATH,
    expectedEpoch: sessionManager.workspaceEpoch(WORKSPACE),
  };
}

describe('workspaceIsTrusted: the happy path and the fail-closed defaults', () => {
  it('is true for a trusted, revalidating workspace at an unchanged epoch', async () => {
    const { sessionManager } = await setup();
    await expect(sessionManager.workspaceIsTrusted(check(sessionManager))).resolves.toBe(true);
  });

  it('is false with no trust store at all: absence of the store is not permission', async () => {
    const registry = new ProviderRegistry();
    registry.register(new TestProvider());
    const bare = new SessionManager(registry, noopLogger);
    await expect(
      bare.workspaceIsTrusted({
        workspaceId: WORKSPACE,
        incarnation: INCARNATION,
        canonicalPath: WORKSPACE_PATH,
        expectedEpoch: 0,
      }),
    ).resolves.toBe(false);
  });

  it('is false when the identity no longer revalidates, even though the store still says trusted', async () => {
    const { sessionManager } = await setup({ revalidate: async () => false });
    await expect(sessionManager.workspaceIsTrusted(check(sessionManager))).resolves.toBe(false);
  });

  it('is false when the trusted record names a DIFFERENT incarnation', async () => {
    const { sessionManager } = await setup();
    await expect(
      sessionManager.workspaceIsTrusted({ ...check(sessionManager), incarnation: 'c'.repeat(64) }),
    ).resolves.toBe(false);
  });

  it('is false when the caller`s epoch is already stale before the check begins', async () => {
    const { sessionManager } = await setup();
    const stale = check(sessionManager);
    sessionManager.blockWorkspace(WORKSPACE);
    sessionManager.allowWorkspace(WORKSPACE);
    await expect(sessionManager.workspaceIsTrusted(stale)).resolves.toBe(false);
  });
});

describe('workspaceIsTrusted: revocation racing each await (at least three distinct points)', () => {
  it('RACE POINT 1: revocation lands while the identity revalidation is in flight', async () => {
    // A holder rather than a forward-declared binding: the injected callback has to reach a manager
    // that does not exist until `setup()` returns, and it only ever runs later, inside the check.
    const holder: { manager?: SessionManager } = {};
    const { sessionManager } = await setup({
      revalidate: async () => {
        // Exactly the gap the post-revalidation re-check exists for.
        holder.manager?.blockWorkspace(WORKSPACE);
        return true;
      },
    });
    holder.manager = sessionManager;

    await expect(sessionManager.workspaceIsTrusted(check(sessionManager))).resolves.toBe(false);
  });

  it('RACE POINT 2: revocation lands while the trust-store inspection is in flight', async () => {
    const { sessionManager, trustStore } = await setup();
    const original = trustStore.inspect.bind(trustStore);
    trustStore.inspect = async (workspaceId: string) => {
      sessionManager.blockWorkspace(WORKSPACE);
      return original(workspaceId);
    };

    await expect(sessionManager.workspaceIsTrusted(check(sessionManager))).resolves.toBe(false);
  });

  it('RACE POINT 3: revocation lands after the inspection resolves, before the answer is returned', async () => {
    const { sessionManager, trustStore } = await setup();
    const original = trustStore.inspect.bind(trustStore);
    trustStore.inspect = async (workspaceId: string) => {
      const result = await original(workspaceId);
      // The block lands before this promise settles, so control returns to `workspaceIsTrusted`
      // with the revocation already visible: it is the **post-inspection** re-check that refuses
      // here, not the final comparison, which would only see the same thing a moment later. (An
      // earlier version of this comment named the final comparison; deleting the post-inspection
      // check and rerunning is what showed that to be wrong -- both catch it, and this one first.)
      sessionManager.blockWorkspace(WORKSPACE);
      return result;
    };

    await expect(sessionManager.workspaceIsTrusted(check(sessionManager))).resolves.toBe(false);
  });

  it('is false for a block-then-allow cycle that straddles the whole check, not just a net-zero change', async () => {
    // A boolean "is it blocked" flag would say "not blocked" at both ends and admit this. The
    // counter is what makes the intervening revocation visible.
    const holder: { manager?: SessionManager } = {};
    const { sessionManager } = await setup({
      revalidate: async () => {
        holder.manager?.blockWorkspace(WORKSPACE);
        holder.manager?.allowWorkspace(WORKSPACE);
        return true;
      },
    });
    holder.manager = sessionManager;

    await expect(sessionManager.workspaceIsTrusted(check(sessionManager))).resolves.toBe(false);
  });
});

describe('workspaceIsTrusted: each early re-check is pinned by the work it prevents', () => {
  /** A `setup()` whose revalidation is counted, so "never reached" is an assertion and not a hope. */
  async function setupCounting(revalidateResult = true) {
    const calls = { revalidate: 0, inspect: 0 };
    const harness = await setup({
      revalidate: async () => {
        calls.revalidate += 1;
        return revalidateResult;
      },
    });
    const original = harness.trustStore.inspect.bind(harness.trustStore);
    harness.trustStore.inspect = async (workspaceId: string) => {
      calls.inspect += 1;
      return original(workspaceId);
    };
    return { ...harness, calls };
  }

  it('SHORT-CIRCUIT 1: a blocked workspace never reaches the filesystem revalidation', async () => {
    const { sessionManager, calls } = await setupCounting();
    sessionManager.blockWorkspace(WORKSPACE);
    // The epoch is read *after* the block here, so it matches and the entry epoch check passes.
    // The entry `blockedWorkspaces` check is the only one that can refuse before the first await,
    // which is why deleting it shows up as a filesystem round trip that should never have happened.
    await expect(sessionManager.workspaceIsTrusted(check(sessionManager))).resolves.toBe(false);
    expect(calls.revalidate).toBe(0);
    expect(calls.inspect).toBe(0);
  });

  it('SHORT-CIRCUIT 2: a stale epoch never reaches the revalidation either, though nothing is blocked', async () => {
    const { sessionManager, calls } = await setupCounting();
    const stale = check(sessionManager);
    sessionManager.blockWorkspace(WORKSPACE);
    sessionManager.allowWorkspace(WORKSPACE);
    // Nothing is blocked now, so only the entry *epoch* check can refuse this one before the await.
    expect(sessionManager.isWorkspaceBlocked(WORKSPACE)).toBe(false);
    await expect(sessionManager.workspaceIsTrusted(stale)).resolves.toBe(false);
    expect(calls.revalidate).toBe(0);
  });

  it('SHORT-CIRCUIT 3: a revocation during revalidation never reaches the trust store', async () => {
    const calls = { revalidate: 0, inspect: 0 };
    const holder: { manager?: SessionManager } = {};
    const { sessionManager, trustStore } = await setup({
      revalidate: async () => {
        calls.revalidate += 1;
        holder.manager?.blockWorkspace(WORKSPACE);
        return true;
      },
    });
    holder.manager = sessionManager;
    const original = trustStore.inspect.bind(trustStore);
    trustStore.inspect = async (workspaceId: string) => {
      calls.inspect += 1;
      return original(workspaceId);
    };

    await expect(sessionManager.workspaceIsTrusted(check(sessionManager))).resolves.toBe(false);
    expect(calls.revalidate).toBe(1);
    // The post-revalidation re-check refused before the store was ever consulted. Without it the
    // answer would still be `false` (the later checks see the same revocation), so this call count
    // is the only thing that distinguishes that check from its successors.
    expect(calls.inspect).toBe(0);
  });
});

describe('revocation ordering', () => {
  it('blocks admission synchronously, before any persistence resolves', async () => {
    const { sessionManager, trustStore } = await setup();

    let writeResolved = false;
    const slowWrite = trustStore.setUntrusted(WORKSPACE).then(() => {
      writeResolved = true;
    });
    sessionManager.blockWorkspace(WORKSPACE);

    // The block is in effect in the same turn it was requested. Nothing awaited, nothing persisted.
    expect(sessionManager.isWorkspaceBlocked(WORKSPACE)).toBe(true);
    expect(writeResolved).toBe(false);
    await slowWrite;
  });

  it('still revokes live sessions when the trust-store write fails', async () => {
    const { provider, sessionManager, trustStore } = await setup();
    const session = sessionManager.create('claude', WORKSPACE_PATH, 'do the thing', undefined, undefined, 1, WORKSPACE);
    trustStore.setUntrusted = async () => {
      throw new Error('disk is full');
    };

    // The route pairs these two deliberately: a failing persistence must not skip the teardown.
    await Promise.all([
      trustStore.setUntrusted(WORKSPACE).catch(() => undefined),
      sessionManager.revokeWorkspace(WORKSPACE),
    ]);

    expect(sessionManager.isWorkspaceBlocked(WORKSPACE)).toBe(true);
    expect(provider.sessions.get(session.id)?.isCancelled()).toBe(true);
  });

  it('cancels every session in the workspace, and leaves other workspaces alone', async () => {
    const { provider, otherProvider, sessionManager } = await setup();
    const inWorkspace = [
      sessionManager.create('claude', WORKSPACE_PATH, 'a', undefined, undefined, 1, WORKSPACE),
      sessionManager.create('claude', WORKSPACE_PATH, 'b', undefined, undefined, 1, WORKSPACE),
    ];
    // A different provider, so this third session fits inside the per-provider active budget.
    const elsewhere = sessionManager.create('codex', '/other', 'c', undefined, undefined, 1, 'f'.repeat(64));

    const cancelled = await sessionManager.revokeWorkspace(WORKSPACE);

    expect(cancelled.sort()).toEqual(inWorkspace.map((session) => session.id).sort());
    for (const session of inWorkspace) {
      expect(provider.sessions.get(session.id)?.isCancelled()).toBe(true);
    }
    expect(otherProvider.sessions.get(elsewhere.id)?.isCancelled()).toBe(false);
  });

  it('refuses a new session in a blocked workspace, synchronously, with a distinct error', async () => {
    const { sessionManager } = await setup();
    sessionManager.blockWorkspace(WORKSPACE);
    expect(() =>
      sessionManager.create('claude', WORKSPACE_PATH, 'p', undefined, undefined, 1, WORKSPACE),
    ).toThrow(RevokedWorkspaceError);
  });

  it('admits again once the workspace is explicitly allowed', async () => {
    const { sessionManager } = await setup();
    sessionManager.blockWorkspace(WORKSPACE);
    sessionManager.allowWorkspace(WORKSPACE);
    expect(() =>
      sessionManager.create('claude', WORKSPACE_PATH, 'p', undefined, undefined, 1, WORKSPACE),
    ).not.toThrow();
  });
});

describe('the workspace session index', () => {
  it('drops a session from the index when it is removed, so revocation does not chase finished work', async () => {
    const { sessionManager } = await setup();
    const session = sessionManager.create('claude', WORKSPACE_PATH, 'p', undefined, undefined, 1, WORKSPACE);
    expect(sessionManager.sessionsInWorkspace(WORKSPACE)).toEqual([session.id]);

    await sessionManager.remove(session.id);
    expect(sessionManager.sessionsInWorkspace(WORKSPACE)).toEqual([]);
  });

  it('indexes nothing for a v1 session, which passes no workspace id at all', async () => {
    const { sessionManager } = await setup();
    sessionManager.create('claude', WORKSPACE_PATH, 'p');
    expect(sessionManager.sessionsInWorkspace(WORKSPACE)).toEqual([]);
  });
});

describe('create() stays synchronous', () => {
  it('has started the provider before the first microtask runs, even with the workspace guard wired', async () => {
    // The structural constraint ADI-05 pinned and this ticket must not break: everything from the
    // limiter reservation to `startSession` happens in one uninterrupted turn.
    const { provider, sessionManager } = await setup();
    const session = sessionManager.create('claude', WORKSPACE_PATH, 'p', undefined, undefined, 1, WORKSPACE);
    expect(provider.sessions.has(session.id)).toBe(true);
  });
});
