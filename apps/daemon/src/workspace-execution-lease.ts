import { randomUUID } from 'node:crypto';
import { runGit } from './workspace-identity.js';

/**
 * Reader/writer leases over a workspace, keyed on `workspaceId` (ADI-06).
 *
 * ## This module ships dormant, and that is the design
 *
 * **Nothing in this daemon calls `acquire()` today.** Leases only mean something at the moment a
 * session is created against a workspace, and this repo has no v2 session-creation path: `POST
 * /v2/sessions` is ADI-13's ticket, and v1's `POST /sessions` is explicitly out of scope for ADI-06
 * (it keeps its existing unvalidated-`cwd` behavior, untouched). Shipping the manager now, fully
 * unit-tested, means ADI-13 turns leasing on against already-reviewed concurrency rules instead of
 * writing them under deadline -- the same shipped-dormant pattern ADI-04's `FallbackGate` used, and
 * for the same reason. **ADI-13 is the ticket that gives this a caller.**
 *
 * ## Why `workspaceId` and not a path
 *
 * D1. A lease keyed on a path string hands out two exclusive write leases for `C:\PROGRA~1\x` and
 * `C:\Program Files\x`, which are one directory. Keying on the object identity (`dev`+`ino`, see
 * workspace-identity.ts) makes every spelling of a directory converge on one lease by construction.
 *
 * ## Why upstream's `workspaceLeaseMode(selection)` is not ported
 *
 * Upstream derives read-vs-write from a negotiated `CapabilitySelection` over an `Effect` catalog.
 * This repo has neither, and ADI-13 explicitly refused to invent them early. `workspaceLeaseModeFor`
 * below is the honest local derivation instead: over `legacy-one-shot` the CLI is unconstrained
 * (see `workspaceEffectsSchema`, D4), so every session is a **writer**. When ADI-08 lands a real
 * effect catalog, this function is the single place a real derivation replaces the literal.
 */

export type WorkspaceLeaseMode = 'read' | 'write';

export interface WorkspaceLease {
  leaseId: string;
  workspaceId: string;
  sessionId: string;
  mode: WorkspaceLeaseMode;
  acquiredAt: number;
}

/** Why a lease could not be taken. Closed set: these become user-visible refusals, not log lines. */
export type WorkspaceLeaseConflictReason =
  | 'writer_active'
  | 'reader_active'
  | 'workspace_dirty';

export class WorkspaceLeaseConflictError extends Error {
  readonly code = 'workspace_lease_conflict';

  constructor(
    readonly reason: WorkspaceLeaseConflictReason,
    readonly workspaceId: string,
  ) {
    super(`could not take a ${reason === 'workspace_dirty' ? 'read' : ''} lease on the workspace: ${reason}`);
    this.name = 'WorkspaceLeaseConflictError';
  }
}

export interface AcquireLeaseRequest {
  workspaceId: string;
  sessionId: string;
  mode: WorkspaceLeaseMode;
  /**
   * Needed only to run `git status`. It is a real path, and it stays inside the daemon: it is never
   * stored on the lease, never logged, and never returned.
   */
  canonicalPath: string;
  /**
   * Explicit opt-in to sharing a **dirty** workspace between two readers. Off by default: two agents
   * reading a tree with uncommitted changes see a state that neither can reproduce afterwards, and
   * neither can tell which of them (or which earlier writer) produced it.
   */
  allowDirtyRead?: boolean;
}

export interface WorkspaceExecutionLeaseOptions {
  /** Injection seam for tests. Defaults to a real `git status --porcelain` in `canonicalPath`. */
  isWorkspaceDirty?: (canonicalPath: string) => Promise<boolean>;
}

/**
 * True when the workspace has uncommitted changes **or when cleanliness cannot be proven**.
 *
 * The failure direction is the whole point. `git status` failing (not a repository, Git missing,
 * a timeout, a permission error) tells us nothing about the tree, and "we could not check" must
 * never be treated as "it is clean": that would let a failure *authorize* the read-sharing that a
 * clean tree earns. Failing to prove cleanliness is answered with `true`.
 */
export async function isWorkspaceDirty(canonicalPath: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain', '--untracked-files=normal'], canonicalPath);
  if (!result.ok) return true;
  return result.stdout.trim().length > 0;
}

/**
 * The local mode derivation that replaces upstream's capability-driven one.
 *
 * Returns `'write'` unconditionally, and the literal parameter type is what keeps that honest: the
 * day a second transport id exists, this stops compiling until someone decides what mode it takes.
 */
export function workspaceLeaseModeFor(transportId: 'legacy-one-shot'): WorkspaceLeaseMode {
  void transportId;
  return 'write';
}

interface WorkspaceLeaseSet {
  writer?: WorkspaceLease;
  readers: Map<string, WorkspaceLease>;
  /** Set while an `acquire()` for this workspace is between its synchronous check and its dirty
   * check. See `acquire` for why this exists. */
  pendingWriter?: string;
}

export class WorkspaceExecutionLeaseManager {
  readonly #byWorkspace = new Map<string, WorkspaceLeaseSet>();
  readonly #byLeaseId = new Map<string, WorkspaceLease>();
  readonly #isDirty: (canonicalPath: string) => Promise<boolean>;

  constructor(options: WorkspaceExecutionLeaseOptions = {}) {
    this.#isDirty = options.isWorkspaceDirty ?? isWorkspaceDirty;
  }

  /**
   * Takes a lease, or throws `WorkspaceLeaseConflictError`.
   *
   * The rules:
   *
   * - a writer excludes everything, including other writers;
   * - a reader is refused while a writer holds the workspace;
   * - two readers share a **clean** workspace freely;
   * - two readers share a **dirty** workspace only with an explicit `allowDirtyRead`.
   *
   * The dirty check is the only `await` in this method, and it is deliberately fenced. The
   * synchronous conflict check runs first and, for a writer, immediately publishes a
   * `pendingWriter` marker -- so a second writer arriving during the first one's `git status` is
   * refused rather than admitted, which is what a naive check-then-await would do. The marker is
   * cleared in a `finally`, so a failed acquire never leaves the workspace permanently unleasable.
   */
  async acquire(request: AcquireLeaseRequest): Promise<WorkspaceLease> {
    const set: WorkspaceLeaseSet = this.#byWorkspace.get(request.workspaceId) ?? {
      readers: new Map<string, WorkspaceLease>(),
    };
    this.#byWorkspace.set(request.workspaceId, set);

    if (set.writer || set.pendingWriter) {
      throw new WorkspaceLeaseConflictError('writer_active', request.workspaceId);
    }
    if (request.mode === 'write' && set.readers.size > 0) {
      throw new WorkspaceLeaseConflictError('reader_active', request.workspaceId);
    }

    const marker = randomUUID();
    if (request.mode === 'write') set.pendingWriter = marker;

    try {
      // Only a *second* reader has anything to prove: the first reader of a workspace is not
      // sharing it with anyone, so its cleanliness is nobody's business. This ordering also means
      // the common single-session case never shells out to Git at all.
      if (request.mode === 'read' && set.readers.size > 0 && request.allowDirtyRead !== true) {
        if (await this.#isDirty(request.canonicalPath)) {
          throw new WorkspaceLeaseConflictError('workspace_dirty', request.workspaceId);
        }
      }

      const lease: WorkspaceLease = {
        leaseId: randomUUID(),
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        mode: request.mode,
        acquiredAt: Date.now(),
      };
      if (request.mode === 'write') set.writer = lease;
      else set.readers.set(lease.leaseId, lease);
      this.#byLeaseId.set(lease.leaseId, lease);
      return lease;
    } finally {
      if (set.pendingWriter === marker) set.pendingWriter = undefined;
      this.#pruneIfEmpty(request.workspaceId, set);
    }
  }

  /**
   * Releases one lease. Idempotent: releasing an unknown or already-released lease is a no-op, so a
   * terminal-cleanup path that runs twice (a cancel racing a provider's own exit) cannot free a
   * lease a *different* session has since taken.
   */
  release(leaseId: string): void {
    const lease = this.#byLeaseId.get(leaseId);
    if (!lease) return;
    this.#byLeaseId.delete(leaseId);
    const set = this.#byWorkspace.get(lease.workspaceId);
    if (!set) return;
    if (set.writer?.leaseId === leaseId) set.writer = undefined;
    set.readers.delete(leaseId);
    this.#pruneIfEmpty(lease.workspaceId, set);
  }

  /** Every lease a session holds, released together. The shape a terminal-cleanup caller wants. */
  releaseForSession(sessionId: string): void {
    for (const lease of [...this.#byLeaseId.values()]) {
      if (lease.sessionId === sessionId) this.release(lease.leaseId);
    }
  }

  /** Current leases on one workspace. Reading state, never a promise about the next moment. */
  leasesFor(workspaceId: string): WorkspaceLease[] {
    const set = this.#byWorkspace.get(workspaceId);
    if (!set) return [];
    return [...(set.writer ? [set.writer] : []), ...set.readers.values()];
  }

  get activeLeaseCount(): number {
    return this.#byLeaseId.size;
  }

  /** Same fail-closed dirty check `acquire` uses, exposed for callers that want to warn first. */
  isWorkspaceDirty(canonicalPath: string): Promise<boolean> {
    return this.#isDirty(canonicalPath);
  }

  #pruneIfEmpty(workspaceId: string, set: WorkspaceLeaseSet): void {
    if (!set.writer && set.readers.size === 0 && !set.pendingWriter) this.#byWorkspace.delete(workspaceId);
  }
}
