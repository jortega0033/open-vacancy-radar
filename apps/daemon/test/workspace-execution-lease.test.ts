import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkspaceExecutionLeaseManager,
  WorkspaceLeaseConflictError,
  isWorkspaceDirty,
  workspaceLeaseModeFor,
} from '../src/workspace-execution-lease.js';

/**
 * Unit tests only, deliberately.
 *
 * Nothing in the daemon calls `acquire()` yet: leases only mean something at v2 session creation,
 * which is ADI-13's ticket (see the module docstring). So there is no integration test to write
 * here, and writing one against a fabricated caller would test the fabrication. What these do cover
 * is every rule the manager will be relied on for the day it is wired in.
 */

const WORKSPACE = 'a'.repeat(64);
const OTHER_WORKSPACE = 'b'.repeat(64);

function manager(dirty = false): WorkspaceExecutionLeaseManager {
  return new WorkspaceExecutionLeaseManager({ isWorkspaceDirty: async () => dirty });
}

describe('lease exclusion rules', () => {
  it('refuses a second writer while a writer holds the workspace', async () => {
    const leases = manager();
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'write', canonicalPath: '/w' });

    await expect(
      leases.acquire({ workspaceId: WORKSPACE, sessionId: 's2', mode: 'write', canonicalPath: '/w' }),
    ).rejects.toBeInstanceOf(WorkspaceLeaseConflictError);
  });

  it('refuses a reader while a writer holds the workspace', async () => {
    const leases = manager();
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'write', canonicalPath: '/w' });

    const err = await leases
      .acquire({ workspaceId: WORKSPACE, sessionId: 's2', mode: 'read', canonicalPath: '/w' })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(WorkspaceLeaseConflictError);
    expect((err as WorkspaceLeaseConflictError).reason).toBe('writer_active');
  });

  it('refuses a writer while a reader holds the workspace', async () => {
    const leases = manager();
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'read', canonicalPath: '/w' });

    const err = await leases
      .acquire({ workspaceId: WORKSPACE, sessionId: 's2', mode: 'write', canonicalPath: '/w' })
      .catch((error: unknown) => error);
    expect((err as WorkspaceLeaseConflictError).reason).toBe('reader_active');
  });

  it('lets two readers share a CLEAN workspace', async () => {
    const leases = manager(false);
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'read', canonicalPath: '/w' });
    await expect(
      leases.acquire({ workspaceId: WORKSPACE, sessionId: 's2', mode: 'read', canonicalPath: '/w' }),
    ).resolves.toMatchObject({ mode: 'read' });
    expect(leases.leasesFor(WORKSPACE)).toHaveLength(2);
  });

  it('refuses a second reader on a DIRTY workspace without an explicit opt-in', async () => {
    const leases = manager(true);
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'read', canonicalPath: '/w' });

    const err = await leases
      .acquire({ workspaceId: WORKSPACE, sessionId: 's2', mode: 'read', canonicalPath: '/w' })
      .catch((error: unknown) => error);
    expect((err as WorkspaceLeaseConflictError).reason).toBe('workspace_dirty');

    // With the opt-in, the same call succeeds: the caller has said it accepts a state neither
    // reader can reproduce afterwards.
    await expect(
      leases.acquire({
        workspaceId: WORKSPACE,
        sessionId: 's2',
        mode: 'read',
        canonicalPath: '/w',
        allowDirtyRead: true,
      }),
    ).resolves.toMatchObject({ mode: 'read' });
  });

  it('does not consult Git for the FIRST reader: it is not sharing the workspace with anyone', async () => {
    let checks = 0;
    const leases = new WorkspaceExecutionLeaseManager({
      isWorkspaceDirty: async () => {
        checks += 1;
        return true;
      },
    });
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'read', canonicalPath: '/w' });
    expect(checks).toBe(0);
  });

  it('keys leases on workspaceId, so two different workspaces never contend', async () => {
    const leases = manager();
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'write', canonicalPath: '/a' });
    await expect(
      leases.acquire({ workspaceId: OTHER_WORKSPACE, sessionId: 's2', mode: 'write', canonicalPath: '/b' }),
    ).resolves.toMatchObject({ mode: 'write' });
  });
});

describe('the acquire critical section', () => {
  it('refuses a second writer that arrives during the first one`s dirty check', async () => {
    // The naive implementation (check, await, mutate) admits both. The pending-writer marker is
    // what closes it, and this is the test that would fail without it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leases = new WorkspaceExecutionLeaseManager({
      isWorkspaceDirty: async () => {
        await gate;
        return false;
      },
    });

    // A first reader, so the second reader's acquire actually reaches the dirty check.
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 'r1', mode: 'read', canonicalPath: '/w' });
    const slowReader = leases.acquire({
      workspaceId: WORKSPACE,
      sessionId: 'r2',
      mode: 'read',
      canonicalPath: '/w',
    });

    // A writer arriving while the reader is parked is refused on the reader, as it must be.
    await expect(
      leases.acquire({ workspaceId: WORKSPACE, sessionId: 'w1', mode: 'write', canonicalPath: '/w' }),
    ).rejects.toBeInstanceOf(WorkspaceLeaseConflictError);

    release();
    await expect(slowReader).resolves.toMatchObject({ mode: 'read' });
  });

  it('leaves the workspace leasable after a failed acquire, rather than wedging it', async () => {
    const leases = manager(true);
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'read', canonicalPath: '/w' });
    await expect(
      leases.acquire({ workspaceId: WORKSPACE, sessionId: 's2', mode: 'read', canonicalPath: '/w' }),
    ).rejects.toBeInstanceOf(WorkspaceLeaseConflictError);

    leases.releaseForSession('s1');
    await expect(
      leases.acquire({ workspaceId: WORKSPACE, sessionId: 's3', mode: 'write', canonicalPath: '/w' }),
    ).resolves.toMatchObject({ mode: 'write' });
  });
});

describe('release', () => {
  it('is idempotent, so a double cleanup cannot free a lease a later session took', async () => {
    const leases = manager();
    const first = await leases.acquire({
      workspaceId: WORKSPACE,
      sessionId: 's1',
      mode: 'write',
      canonicalPath: '/w',
    });
    leases.release(first.leaseId);
    const second = await leases.acquire({
      workspaceId: WORKSPACE,
      sessionId: 's2',
      mode: 'write',
      canonicalPath: '/w',
    });

    // The stale second release must not touch s2's lease.
    leases.release(first.leaseId);
    expect(leases.leasesFor(WORKSPACE).map((lease) => lease.leaseId)).toEqual([second.leaseId]);
  });

  it('holds a write lease until it is explicitly released', async () => {
    const leases = manager();
    const lease = await leases.acquire({
      workspaceId: WORKSPACE,
      sessionId: 's1',
      mode: 'write',
      canonicalPath: '/w',
    });
    expect(leases.activeLeaseCount).toBe(1);

    // Nothing expires a lease on a timer: a lease is held for as long as the session owns the
    // workspace, and terminal cleanup is the only thing that ends it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(leases.activeLeaseCount).toBe(1);

    leases.release(lease.leaseId);
    expect(leases.activeLeaseCount).toBe(0);
  });

  it('releases every lease a session holds at once', async () => {
    const leases = manager();
    await leases.acquire({ workspaceId: WORKSPACE, sessionId: 's1', mode: 'read', canonicalPath: '/w' });
    await leases.acquire({ workspaceId: OTHER_WORKSPACE, sessionId: 's1', mode: 'write', canonicalPath: '/x' });
    leases.releaseForSession('s1');
    expect(leases.activeLeaseCount).toBe(0);
  });
});

describe('isWorkspaceDirty fails closed', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-dock-lease-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports dirty when `git status` itself fails, not only when it reports changes', async () => {
    // A temp directory is not a Git repository, so the real `git status` exits non-zero. "We could
    // not check" must answer `true`: treating it as clean would let a failure AUTHORIZE the
    // read-sharing that only a provably clean tree earns.
    await expect(isWorkspaceDirty(dir)).resolves.toBe(true);
  });

  it('reports dirty for a path that does not exist at all', async () => {
    await expect(isWorkspaceDirty(join(dir, 'gone'))).resolves.toBe(true);
  });
});

describe('the local mode derivation', () => {
  it('treats every legacy-one-shot session as a writer', () => {
    // Over this transport the CLI is unconstrained (D4), so calling any session a reader would be a
    // claim the runtime cannot keep. ADI-13 replaces this with a real derivation.
    expect(workspaceLeaseModeFor('legacy-one-shot')).toBe('write');
  });
});
