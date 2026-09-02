import { randomBytes } from 'node:crypto';
import type { ProviderId, WorkspaceTrustView } from '@agent-dock/shared';
import type { WorkspaceConfirmInput, WorkspaceGrantEffects } from './workspace-confirm.js';

/**
 * The workspace **grant** state machine (ADI-06), and this repo's answer to a gap upstream leaves
 * open.
 *
 * Upstream lets the renderer assert trust: it sends `{ cwd, incarnation, state: 'trusted' }` and the
 * daemon writes it. That makes a compromised renderer able to grant itself access to any directory
 * it can name. Here the renderer can name nothing. A grant is minted in this process, in main, only
 * after a native folder picker and a native confirmation dialog the user personally answered, and
 * what crosses to the renderer is an opaque 43-character handle plus a bounded folder name. The
 * path stays here, in `GrantRecord.canonicalPath`, and is never serialized to the renderer or to
 * disk.
 *
 * ## The ten-step contract
 *
 * 1. the renderer asks for a grant, naming only a provider;
 * 2. main opens the native directory picker, so only the user can choose the folder;
 * 3. main asks the daemon to inspect that path (identity, Git binding, dirty state, trust state);
 * 4. main shows the native confirmation dialog, defaulting to Cancel;
 * 5. main mints a 32-random-byte handle and records the grant in memory, bound to the requesting
 *    `WebContents` and to the daemon instance that answered step 3;
 * 6. the daemon records `grant.issued` in its audit log, durably, before main returns anything;
 * 7. main returns only `{ grantHandle, display }` to the renderer, never the path;
 * 8. any of navigation, `WebContents` destruction, a daemon restart, a trust revocation, or the
 *    5-minute TTL expires the grant;
 * 9. consumption deletes the record **synchronously, before any await**, so exactly one caller can
 *    ever win;
 * 10. the daemon re-resolves the identity from the path, refuses on any drift, and only then marks
 *     the workspace trusted, atomically with the audit write.
 *
 * ## Step 9 is the single-use enforcement
 *
 * `consumeGrant` looks the record up and deletes it in one uninterrupted turn of the event loop,
 * before the first `await`. Two concurrent consumptions of the same handle therefore cannot both
 * find it: the second sees an empty map and is denied `unknown_handle`. This mirrors
 * `ActiveSessionLimiter.reserve()`'s await-free critical section exactly, and for the same reason
 * -- a check followed by an await followed by a mutation is not a check.
 */

/** 32 random bytes, base64url-encoded: 43 characters, no padding. */
export const GRANT_HANDLE_BYTES = 32;
export const GRANT_HANDLE_LENGTH = 43;

/** Same size and encoding as a grant handle, and deliberately indistinguishable from one on the wire. */
export const WORKSPACE_SESSION_REF_LENGTH = 43;

/**
 * How long a workspace session ref stays usable (ADI-13). Thirty minutes.
 *
 * ## Why this is longer than a grant's five minutes, and why it is multi-use
 *
 * A *grant* is the record of one dialog the user just answered. It is single-use and short-lived
 * because its whole job is to carry that one answer across one round trip, and an approval that sat
 * usable for the rest of the session would let a much later action ride on a dialog the user has
 * long since forgotten.
 *
 * A *session ref* is a different thing: it is the handle for a workspace the user has already
 * trusted, and the daemon has already persisted that trust. Making it single-use would mean a user
 * who wants to run a second prompt against the folder they just approved has to answer the native
 * picker and the confirmation dialog again -- and a UI that makes people click through security
 * dialogs repeatedly for no new decision is a UI that teaches them to click through security
 * dialogs. So it is multi-use within its lifetime.
 *
 * What it does **not** do is grow into a standing capability. It still expires on the same five
 * events a grant does (navigation, `WebContents` destruction, a daemon restart, a trust revocation,
 * and its own TTL), it is still bound to the `WebContents` it was issued to, and the daemon
 * re-checks trust, identity, and the revocation epoch on every single `POST /v2/sessions` regardless
 * of what this process believes. The ref is a convenience over a decision the daemon owns; it is not
 * itself the decision. Thirty minutes is chosen as roughly one working session with a folder --
 * long enough that a normal sequence of prompts never re-prompts, short enough that a laptop left
 * open overnight starts from the dialog again.
 */
export const WORKSPACE_SESSION_REF_TTL_MS = 30 * 60 * 1000;

/** Five minutes. Long enough to read a dialog and start a task, short enough that a forgotten
 * approval does not sit usable for the rest of the session. */
export const GRANT_TTL_MS = 5 * 60 * 1000;

/** Why an outstanding grant stopped being usable. Every one of these is also an audit `reason`. */
export type GrantExpiryReason =
  | 'timeout'
  | 'navigation'
  | 'webcontents_destroyed'
  | 'daemon_generation'
  | 'trust_revoked';

/** Why a consumption was refused. A superset of the expiry reasons. */
export type GrantDenialReason =
  | GrantExpiryReason
  | 'wrong_webcontents'
  | 'unknown_handle'
  | 'already_consumed'
  | 'identity_drift'
  | 'not_trusted'
  | 'audit_failure';

/**
 * One outstanding grant.
 *
 * `canonicalPath` is the path the user picked, kept here so consumption can hand it back to the
 * daemon for re-resolution. **It never leaves this process.** It is not in `GrantOffer`, not in any
 * IPC response, not in the audit log, and not written to disk anywhere.
 */
export interface GrantRecord {
  handle: string;
  webContentsId: number;
  workspaceId: string;
  incarnation: string;
  provider: ProviderId;
  effects: WorkspaceGrantEffects;
  /** The daemon instance that produced `workspaceId`/`incarnation`. A different one invalidates this. */
  daemonInstanceId: string;
  canonicalPath: string;
  issuedAt: number;
  expiresAt: number;
}

/** Everything the renderer is allowed to learn about a granted workspace. */
export interface GrantDisplay {
  name: string;
  branch?: string;
  dirty: boolean;
  effects: WorkspaceGrantEffects;
}

export interface GrantOffer {
  grantHandle: string;
  display: GrantDisplay;
}

export type GrantStatus =
  | { state: 'active'; expiresInMs: number }
  | { state: 'gone'; reason: GrantDenialReason };

/**
 * One trusted workspace, addressable by an opaque handle (ADI-13).
 *
 * Structurally almost the same as a `GrantRecord`, and kept as a separate type on purpose: they mean
 * different things and have different lifetimes, and merging them would make it possible to spend a
 * grant by starting a session or to re-approve a folder by starting one. `canonicalPath` never
 * leaves this process, exactly as it does not on a `GrantRecord`.
 */
export interface WorkspaceSessionRefRecord {
  ref: string;
  webContentsId: number;
  workspaceId: string;
  incarnation: string;
  provider: ProviderId;
  /** **Main-process only.** Not in any IPC response, not in any log, not on disk. */
  canonicalPath: string;
  /** The daemon instance that resolved the identity above. A different one invalidates this ref. */
  daemonInstanceId: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * Consuming a grant now hands back a workspace session ref (ADI-13).
 *
 * Optional in the type so that the shape a caller sees for a *failed* consumption is unchanged, and
 * so a build whose daemon refused to mint one still type-checks at every call site.
 */
export type ConsumeResult =
  | { ok: true; workspaceSessionRef: string }
  | { ok: false; reason: GrantDenialReason };

/** Why a session could not be started. Reason-only, and every member is a fixed token. */
export type StartSessionDenialReason =
  | GrantDenialReason
  | 'unknown_workspace_ref'
  | 'daemon_unavailable'
  | 'workspace_lease_conflict'
  /**
   * The folder a still-valid workspace session ref names stopped being a folder this build can host
   * a session in, between the approval and this request: deleted, renamed, on an unplugged drive
   * (`invalid_workspace_path`), or remapped to a UNC share (`unc_workspace_unsupported`). Distinct
   * tokens rather than `refused`, because they are the two refusals a user can actually resolve.
   */
  | 'unc_workspace_unsupported'
  | 'invalid_workspace_path'
  | 'unknown_resume_target'
  | 'resume_not_allowed'
  | 'active_session_limit'
  | 'storage_full'
  | 'invalid_request'
  | 'refused';

/**
 * What the renderer learns about a started session.
 *
 * Deliberately **not** the daemon's `AgentSessionV2View`: that view carries `cwd`, a real filesystem
 * path, and the entire point of this boundary is that the renderer is never told where anything is.
 * Everything here is an id, an enum, or a model name the renderer itself may have asked for.
 */
export interface WorkspaceSessionStarted {
  sessionId: string;
  provider: ProviderId;
  status: string;
  model?: string;
}

export type StartSessionResult =
  | { ok: true; session: WorkspaceSessionStarted }
  | { ok: false; reason: StartSessionDenialReason };

/** What the renderer may ask for. Note the absences: no path, no workspace id, no incarnation. */
export interface StartSessionInput {
  workspaceSessionRef: unknown;
  prompt: unknown;
  resumeProviderSessionId?: unknown;
  capabilities?: unknown;
}

/** What the daemon's `POST /v2/sessions` reports back, already mapped to path-free values. */
export type DaemonCreateSessionOutcome =
  | { ok: true; session: WorkspaceSessionStarted }
  | { ok: false; reason: StartSessionDenialReason };

/** What the daemon's consume-grant call reports back. Deliberately reason-only: no paths, no ids. */
export type DaemonConsumeOutcome = { ok: true } | { ok: false; reason: GrantDenialReason };

export interface WorkspaceGrantDeps {
  /** `POST /v2/workspaces/inspect`. */
  inspectWorkspace(input: { path: string; provider: ProviderId }): Promise<WorkspaceTrustView>;
  /** `POST /v2/workspaces/consume-grant`. */
  consumeGrant(input: {
    path: string;
    provider: ProviderId;
    workspaceId: string;
    incarnation: string;
    sessionId?: string;
  }): Promise<DaemonConsumeOutcome>;
  /** `POST /v2/workspaces/grant-events`. Rejects if the daemon could not record the event. */
  recordGrantEvent(input: {
    event: 'grant.issued' | 'grant.denied';
    workspaceId: string;
    incarnation: string;
    provider: ProviderId;
    reason?: GrantDenialReason;
    actor: 'user' | 'timeout' | 'navigation' | 'daemon_restart' | 'policy';
  }): Promise<void>;
  /**
   * `POST /v2/sessions` (ADI-13).
   *
   * Takes the real path and the real identity, because it is the main-to-daemon leg and main is the
   * party that holds them. It must return only path-free values: mapping the daemon's response
   * (including its error codes) happens at the call site in main.ts, against a closed table, exactly
   * as `consumeGrant` above does.
   */
  createSession(input: {
    path: string;
    provider: ProviderId;
    workspaceId: string;
    incarnation: string;
    prompt: string;
    resumeProviderSessionId?: string;
    capabilities?: unknown;
  }): Promise<DaemonCreateSessionOutcome>;
  /** The native directory picker. Returns null when the user cancelled. */
  pickDirectory(): Promise<string | null>;
  /** The native confirmation dialog. See workspace-confirm.ts. */
  confirm(input: WorkspaceConfirmInput): Promise<boolean>;
  /** The daemon instance id captured at readiness. `undefined` when no daemon is connected. */
  daemonInstanceId(): string | undefined;
  /** Human-facing provider name for the dialog. */
  providerName(provider: ProviderId): string;
  now?: () => number;
  ttlMs?: number;
  /** ADI-13. Defaults to `WORKSPACE_SESSION_REF_TTL_MS`; see that constant for why it differs. */
  sessionRefTtlMs?: number;
  newHandle?: () => string;
  onEvent?: (message: string, meta?: Record<string, unknown>) => void;
}

/** Thrown when a workspace cannot be granted at all, with a message safe to show the user. */
export class WorkspaceGrantRefusedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WorkspaceGrantRefusedError';
  }
}

function defaultHandle(): string {
  return randomBytes(GRANT_HANDLE_BYTES).toString('base64url');
}

export class WorkspaceGrantManager {
  readonly #grants = new Map<string, GrantRecord>();
  /** Why each recently-gone handle went away, so a late consumer gets a reason and not a shrug. */
  readonly #gone = new Map<string, GrantDenialReason>();
  /** ADI-13. Trusted workspaces addressable by an opaque, multi-use, main-process-only handle. */
  readonly #sessionRefs = new Map<string, WorkspaceSessionRefRecord>();
  readonly #deps: WorkspaceGrantDeps;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #refTtlMs: number;
  readonly #newHandle: () => string;

  /**
   * Bounds the tombstone map. A grant is a few dozen bytes and a session hands out very few, but a
   * map that only ever grows is a leak in a process that runs for days.
   */
  static readonly MAX_TOMBSTONES = 256;

  constructor(deps: WorkspaceGrantDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#ttlMs = deps.ttlMs ?? GRANT_TTL_MS;
    this.#refTtlMs = deps.sessionRefTtlMs ?? WORKSPACE_SESSION_REF_TTL_MS;
    this.#newHandle = deps.newHandle ?? defaultHandle;
  }

  /** Outstanding (not yet expired, not yet consumed) grants. Test and diagnostics surface only. */
  get outstanding(): number {
    this.#sweepExpired();
    return this.#grants.size;
  }

  /** Live workspace session refs. Test and diagnostics surface only; never sent anywhere. */
  get outstandingSessionRefs(): number {
    this.#sweepExpired();
    return this.#sessionRefs.size;
  }

  /**
   * The full issue flow: pick, inspect, confirm, mint, audit.
   *
   * Takes **no path argument, ever** -- the signature has nowhere to put one. A renderer that calls
   * the IPC channel with a path simply has that argument dropped at the preload boundary and again
   * here, because the only source of a path in this flow is the native picker.
   *
   * Returns `null` for both cancellations (the picker and the dialog), which are the same outcome
   * from the caller's point of view: no grant exists, and nothing was recorded.
   */
  async requestGrant(provider: ProviderId, webContentsId: number): Promise<GrantOffer | null> {
    const path = await this.#deps.pickDirectory();
    if (path === null) return null;

    const daemonInstanceId = this.#deps.daemonInstanceId();
    if (!daemonInstanceId) {
      throw new WorkspaceGrantRefusedError('the agent daemon is not ready yet', 'daemon_unavailable');
    }

    const view = await this.#deps.inspectWorkspace({ path, provider });

    if (!view.reusable) {
      // Refused before the dialog, not after. A non-reusable identity can never be revalidated, so
      // the daemon would refuse the consumption anyway -- and asking the user to approve something
      // that is already guaranteed to fail is worse than refusing it plainly.
      throw new WorkspaceGrantRefusedError(
        'this folder cannot be used as an agent workspace: the filesystem does not report a stable ' +
          'identity for it, which usually means a network drive or a virtual filesystem. Choose a ' +
          'folder on a local disk.',
        'workspace_not_reusable',
      );
    }

    const approved = await this.#deps.confirm({
      displayName: view.displayName,
      ...(view.branch === undefined ? {} : { branch: view.branch }),
      dirty: view.dirty,
      effects: 'unbounded_cli',
      providerName: this.#deps.providerName(provider),
    });
    // The cancel path writes nothing: no grant, and no audit entry. An audit line for "the user was
    // asked and said no" would record a non-decision, and it would let anyone fill the audit log
    // (whose cap denies real actions) just by opening and dismissing a dialog.
    if (!approved) return null;

    const issuedAt = this.#now();
    const record: GrantRecord = {
      handle: this.#newHandle(),
      webContentsId,
      workspaceId: view.workspaceId,
      incarnation: view.incarnation,
      provider,
      effects: 'unbounded_cli',
      daemonInstanceId,
      canonicalPath: path,
      issuedAt,
      expiresAt: issuedAt + this.#ttlMs,
    };

    // Audited before the handle is handed out, and the failure is fatal to the request: an
    // unrecorded approval is exactly what the audit store exists to prevent. Note the ordering --
    // the record is not in the map yet, so a failed audit leaves no usable grant behind.
    //
    // The catch is not softening that: it still throws, and nothing is registered. What it stops is
    // an *arbitrary* error escaping to the renderer over IPC. `recordGrantEvent` talks to the daemon
    // over HTTP, and the failures on that path (a fetch error naming a socket, an audit fault whose
    // message quotes a log file path) carry text this process has not reviewed -- and the whole
    // point of this module is that the renderer learns nothing about the filesystem. Only a
    // `WorkspaceGrantRefusedError`, whose message main.ts chose from a closed table, passes through
    // unchanged; anything else is replaced with a fixed one.
    try {
      await this.#deps.recordGrantEvent({
        event: 'grant.issued',
        workspaceId: record.workspaceId,
        incarnation: record.incarnation,
        provider,
        actor: 'user',
      });
    } catch (err) {
      if (err instanceof WorkspaceGrantRefusedError) throw err;
      this.#deps.onEvent?.('could not record a workspace grant issuance in the audit log', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new WorkspaceGrantRefusedError(
        'this approval could not be recorded in the security log, so no workspace was granted',
        'audit_failure',
      );
    }

    this.#grants.set(record.handle, record);

    return {
      grantHandle: record.handle,
      display: {
        name: view.displayName,
        ...(view.branch === undefined ? {} : { branch: view.branch }),
        dirty: view.dirty,
        effects: 'unbounded_cli',
      },
    };
  }

  /**
   * Consumes a grant exactly once, on behalf of exactly the `WebContents` it was issued to.
   *
   * **Everything above the first `await` is one uninterrupted turn of the event loop**, and that is
   * the single-use enforcement: the record is deleted before any asynchronous work begins, so a
   * second concurrent call for the same handle finds nothing. Adding an `await` above the
   * `#grants.delete` -- including one hidden in a helper -- reintroduces double-consumption.
   */
  async consumeGrant(
    handle: unknown,
    callerWebContentsId: number,
    sessionId?: string,
  ): Promise<ConsumeResult> {
    // ---- await-free critical section: begin -------------------------------------------------
    if (typeof handle !== 'string' || handle.length !== GRANT_HANDLE_LENGTH) {
      return { ok: false, reason: 'unknown_handle' };
    }
    const record = this.#grants.get(handle);
    if (!record) {
      return { ok: false, reason: this.#gone.get(handle) ?? 'unknown_handle' };
    }
    if (record.webContentsId !== callerWebContentsId) {
      // Deliberately does NOT delete the record. A grant presented by the wrong WebContents is
      // either a bug or an attempt to use someone else's approval; either way, letting the wrong
      // caller destroy a legitimate grant would turn a refusal into a denial-of-service primitive.
      return { ok: false, reason: 'wrong_webcontents' };
    }
    if (this.#now() >= record.expiresAt) {
      this.#forget(handle, 'timeout');
      return { ok: false, reason: 'timeout' };
    }
    const daemonInstanceId = this.#deps.daemonInstanceId();
    if (daemonInstanceId !== record.daemonInstanceId) {
      // The daemon that answered the inspection is gone. Its successor never saw the user's
      // approval, and the identity digests were minted by a process that no longer exists.
      this.#forget(handle, 'daemon_generation');
      return { ok: false, reason: 'daemon_generation' };
    }

    // The delete that makes this single-use. Tombstoned as `already_consumed` rather than simply
    // dropped, so the loser of a concurrent double-consumption learns that the handle was real and
    // was spent, not that it was never valid.
    this.#forget(handle, 'already_consumed');
    // ---- await-free critical section: end ---------------------------------------------------

    const outcome = await this.#deps.consumeGrant({
      path: record.canonicalPath,
      provider: record.provider,
      workspaceId: record.workspaceId,
      incarnation: record.incarnation,
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    if (!outcome.ok) {
      this.#deps.onEvent?.('workspace grant consumption was refused by the daemon', {
        reason: outcome.reason,
      });
      return outcome;
    }

    // ADI-13. The daemon has now persisted trust for this workspace, so the identity and the path
    // this process has been holding are worth keeping: before this ticket they were simply dropped
    // here, which is why nothing could start a session against a folder the user had just approved.
    // The ref is minted only on a successful consumption -- a refused one leaves nothing behind.
    const issuedAt = this.#now();
    const ref: WorkspaceSessionRefRecord = {
      ref: this.#newHandle(),
      webContentsId: callerWebContentsId,
      workspaceId: record.workspaceId,
      incarnation: record.incarnation,
      provider: record.provider,
      canonicalPath: record.canonicalPath,
      daemonInstanceId: record.daemonInstanceId,
      issuedAt,
      expiresAt: issuedAt + this.#refTtlMs,
    };
    this.#sessionRefs.set(ref.ref, ref);
    return { ok: true, workspaceSessionRef: ref.ref };
  }

  /**
   * Starts a session in a workspace the user already trusted, addressed only by an opaque ref.
   *
   * The renderer supplies a ref, a prompt, and optionally a resume target and a capability list.
   * It cannot supply a path, a `workspaceId`, or an `incarnation`: those come from the ref record in
   * this process, which is why the signature has nowhere to put them. Anything else a caller
   * attached to the IPC payload has no reader here.
   *
   * Every check below is a *local* precondition, not the authorization: the daemon re-resolves the
   * identity from the path, re-checks trust and the revocation epoch, and takes an exclusive
   * workspace lease before it starts anything. A stale ref that somehow survived here still gets
   * refused there. These checks exist so the common failures (a navigated-away window, a restarted
   * daemon, an expired ref) are answered without a round trip and without the daemon logging a
   * denial for something this process already knew about.
   */
  async startSession(input: StartSessionInput, callerWebContentsId: number): Promise<StartSessionResult> {
    const { workspaceSessionRef, prompt } = input;
    if (typeof workspaceSessionRef !== 'string' || workspaceSessionRef.length !== WORKSPACE_SESSION_REF_LENGTH) {
      return { ok: false, reason: 'unknown_workspace_ref' };
    }
    if (typeof prompt !== 'string' || prompt.length === 0) {
      return { ok: false, reason: 'invalid_request' };
    }
    const resumeProviderSessionId = input.resumeProviderSessionId;
    if (resumeProviderSessionId !== undefined && typeof resumeProviderSessionId !== 'string') {
      return { ok: false, reason: 'invalid_request' };
    }

    const record = this.#sessionRefs.get(workspaceSessionRef);
    if (!record) return { ok: false, reason: 'unknown_workspace_ref' };
    if (record.webContentsId !== callerWebContentsId) {
      // Deliberately does not delete the record, for the same reason `consumeGrant` does not: letting
      // the wrong caller destroy a legitimate ref would turn a refusal into a denial-of-service.
      return { ok: false, reason: 'wrong_webcontents' };
    }
    if (this.#now() >= record.expiresAt) {
      this.#sessionRefs.delete(workspaceSessionRef);
      return { ok: false, reason: 'timeout' };
    }
    if (this.#deps.daemonInstanceId() !== record.daemonInstanceId) {
      // The daemon that resolved this identity is gone. Its successor may well still trust the
      // workspace (trust is persisted), but the digests this ref carries were minted by a process
      // that no longer exists, so the honest move is to make the user re-establish the workspace.
      this.#sessionRefs.delete(workspaceSessionRef);
      return { ok: false, reason: 'daemon_generation' };
    }

    // Note that the ref is NOT consumed: see `WORKSPACE_SESSION_REF_TTL_MS` for why this is
    // deliberately multi-use where the grant handle that preceded it is single-use.
    const outcome = await this.#deps.createSession({
      path: record.canonicalPath,
      provider: record.provider,
      workspaceId: record.workspaceId,
      incarnation: record.incarnation,
      prompt,
      ...(resumeProviderSessionId === undefined ? {} : { resumeProviderSessionId }),
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    });

    if (!outcome.ok) {
      this.#deps.onEvent?.('starting a workspace session was refused by the daemon', {
        reason: outcome.reason,
      });
    }
    return outcome;
  }

  /** What happened to a handle, without consuming it. Reason-only: never a path, never an id. */
  grantStatus(handle: unknown): GrantStatus {
    if (typeof handle !== 'string' || handle.length !== GRANT_HANDLE_LENGTH) {
      return { state: 'gone', reason: 'unknown_handle' };
    }
    this.#sweepExpired();
    const record = this.#grants.get(handle);
    if (!record) return { state: 'gone', reason: this.#gone.get(handle) ?? 'unknown_handle' };
    return { state: 'active', expiresInMs: Math.max(0, record.expiresAt - this.#now()) };
  }

  /** Expires every grant issued to one `WebContents`: its navigation or its destruction. */
  expireForWebContents(webContentsId: number, reason: GrantExpiryReason): GrantRecord[] {
    return this.#expireWhere((record) => record.webContentsId === webContentsId, reason);
  }

  /**
   * Expires every outstanding grant. Called when the daemon instance id changes, because every
   * grant refers to identity digests minted by a process that no longer exists.
   */
  expireAll(reason: GrantExpiryReason): GrantRecord[] {
    return this.#expireWhere(() => true, reason);
  }

  /** Expires every grant for one workspace: what a trust revocation triggers. */
  expireForWorkspace(workspaceId: string, reason: GrantExpiryReason = 'trust_revoked'): GrantRecord[] {
    return this.#expireWhere((record) => record.workspaceId === workspaceId, reason);
  }

  /**
   * Reports an expiry to the daemon's audit log, best-effort and explicitly so.
   *
   * This is the one place in this module where a failed audit write is *not* fatal, and the
   * asymmetry is deliberate: an unrecorded **grant** is an unrecorded authorization, while an
   * unrecorded **expiry** is an unrecorded de-authorization. The grant it refers to is already gone
   * from memory and can never be used again regardless of what the log says, so failing the whole
   * navigation or window-close over it would trade a real behavior for a bookkeeping entry.
   */
  async reportExpiries(
    records: readonly GrantRecord[],
    reason: GrantExpiryReason,
    actor: 'timeout' | 'navigation' | 'daemon_restart' | 'policy',
  ): Promise<void> {
    for (const record of records) {
      try {
        await this.#deps.recordGrantEvent({
          event: 'grant.denied',
          workspaceId: record.workspaceId,
          incarnation: record.incarnation,
          provider: record.provider,
          reason,
          actor,
        });
      } catch (err) {
        this.#deps.onEvent?.('could not record a workspace grant expiry in the audit log', {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Expires grants and workspace session refs together, by the same predicate.
   *
   * The two are dropped in one place on purpose. Every caller of `expireForWebContents`,
   * `expireAll`, and `expireForWorkspace` means "this window / this daemon / this workspace is no
   * longer a thing we hold approval for", and a ref that outlived the grant it came from would keep
   * exactly the authority those calls exist to withdraw. Refs are not *reported* to the audit log,
   * though: the returned list is only the grants, because an expiring ref is not an approval being
   * withdrawn (the daemon's persisted trust is untouched), it is a local handle going stale.
   */
  #expireWhere(
    // Narrowed to the two fields every caller's predicate actually reads, so the same predicate can
    // be applied to a `WorkspaceSessionRefRecord` without a cast or a second copy of the rule.
    predicate: (record: { webContentsId: number; workspaceId: string }) => boolean,
    reason: GrantExpiryReason,
  ): GrantRecord[] {
    const expired: GrantRecord[] = [];
    for (const [handle, record] of [...this.#grants]) {
      if (!predicate(record)) continue;
      expired.push(record);
      this.#forget(handle, reason);
    }
    for (const [ref, record] of [...this.#sessionRefs]) {
      // A ref has the same three identifying fields a grant does, so the same predicate applies to
      // it without a second, separately-maintained rule that could drift out of agreement.
      if (predicate(record)) this.#sessionRefs.delete(ref);
    }
    return expired;
  }

  #sweepExpired(): void {
    const now = this.#now();
    for (const [handle, record] of [...this.#grants]) {
      if (now >= record.expiresAt) this.#forget(handle, 'timeout');
    }
    for (const [ref, record] of [...this.#sessionRefs]) {
      if (now >= record.expiresAt) this.#sessionRefs.delete(ref);
    }
  }

  #forget(handle: string, reason: GrantDenialReason): void {
    this.#grants.delete(handle);
    this.#gone.set(handle, reason);
    while (this.#gone.size > WorkspaceGrantManager.MAX_TOMBSTONES) {
      const oldest = this.#gone.keys().next();
      if (oldest.done) break;
      this.#gone.delete(oldest.value);
    }
  }
}
