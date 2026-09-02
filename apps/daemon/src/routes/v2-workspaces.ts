import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  V2_WORKSPACE_VIEW_SCHEMA_VERSION,
  workspaceConsumeGrantRequestSchema,
  workspaceDigestSchema,
  workspaceGrantEventRequestSchema,
  workspaceInspectRequestSchema,
  workspaceTrustUpdateRequestSchema,
  type ProviderId,
  type WorkspaceTrustView,
} from '@agent-dock/shared';
import type { AuditStore } from '../audit-store.js';
import type { SessionManager } from '../session-manager.js';
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from '../workspace-identity.js';
import { NonReusableWorkspaceError, type WorkspaceTrustStore } from '../workspace-trust-store.js';
import { isWorkspaceDirty } from '../workspace-execution-lease.js';
import {
  appendAudit as appendAuditEntry,
  replyForIdentityError,
  writeAudit as writeAuditEntry,
  type AuditFailure,
} from './v2-route-helpers.js';

/**
 * The v2 **workspace trust** routes. Registered only when the trust store and the audit store both
 * opened (see server.ts): absence is the downgrade path, exactly as it is for the ADI-05 routes.
 *
 * ## D3: no HTTP caller can assert trust
 *
 * This is the invariant the whole ticket turns on, so it is worth stating precisely.
 *
 * Upstream's equivalent route accepts `{ cwd, incarnation, state: 'trusted' }` from the renderer and
 * writes exactly that. Here, `PUT /v2/workspaces/:workspaceId/trust` cannot express `'trusted'` at
 * all -- the schema's enum is `['untrusted', 'revoking']` -- and a body naming it is answered with a
 * 400 rather than being ignored, so a caller that believed it could set trust finds out it cannot.
 * The route can only ever *lower* trust.
 *
 * The one path to `trusted` is `POST /v2/workspaces/consume-grant`, and reaching it is not enough:
 * the daemon re-resolves the workspace identity from the filesystem itself and refuses unless it
 * matches the `{ workspaceId, incarnation }` pair the caller claimed. So a caller cannot assert
 * trust by naming a state (no route accepts it), cannot assert it by naming a pair (the pair is
 * checked against the filesystem), and cannot assert it by naming a path (the path must produce the
 * pair it already claimed). What it must have is a pair produced by a real inspection of a real
 * directory that has not changed since -- which, in the shipped app, only exists because the user
 * approved that directory in a native dialog.
 *
 * ## Audit before effect, always
 *
 * Every route below that *raises* trust writes its audit entry -- and awaits its fsync -- before the
 * durable, externally-observable effect it describes, not after. An audit failure is a denial, never
 * a warning: see `writeAudit`.
 *
 * The one deliberate exception is revocation, and it points the other way: there, the effect
 * (blocking admission and cancelling live sessions) must happen even if the audit write fails,
 * because a workspace the user revoked must never keep running sessions because a log was full. The
 * rule is not "audit before everything"; it is **"never grant unrecorded, never fail to revoke"**.
 */

export interface V2WorkspaceRouteOptions {
  trustStore: WorkspaceTrustStore;
  auditStore: AuditStore;
  sessionManager: SessionManager;
  /** Injection seam for tests. Defaults to the real identity resolver. */
  resolveIdentity?: (path: string) => Promise<WorkspaceIdentity>;
  /** Injection seam for tests. Defaults to the real fail-closed `git status` check. */
  isDirty?: (canonicalPath: string) => Promise<boolean>;
}

/** Maps an identity plus its stored trust state onto the wire view. Never carries a path. */
function toTrustView(
  identity: WorkspaceIdentity,
  state: WorkspaceTrustView['state'],
  dirty: boolean,
): WorkspaceTrustView {
  return {
    schemaVersion: V2_WORKSPACE_VIEW_SCHEMA_VERSION as 1,
    workspaceId: identity.workspaceId,
    incarnation: identity.incarnation,
    displayName: identity.displayName,
    ...(identity.git?.branch === undefined ? {} : { branch: identity.git.branch }),
    dirty,
    reusable: identity.reusable,
    state,
  };
}

export function registerV2WorkspaceRoutes(app: FastifyInstance, options: V2WorkspaceRouteOptions): void {
  const { trustStore, auditStore, sessionManager } = options;
  const resolveIdentity = options.resolveIdentity ?? ((path: string) => resolveWorkspaceIdentity(path));
  const isDirty = options.isDirty ?? isWorkspaceDirty;

  /**
   * The two audit helpers, bound to this route's store.
   *
   * Both moved to `v2-route-helpers.ts` in ADI-13 so `POST /v2/sessions` uses the identical closed
   * failure table and the identical "if this returns false, deny" contract. Their behavior here is
   * unchanged; only the definition site moved. Revocation still calls `appendAudit` directly,
   * because it must tear the workspace down whether or not the write succeeded.
   */
  const appendAudit = (entry: Parameters<AuditStore['append']>[0]): Promise<AuditFailure | undefined> =>
    appendAuditEntry(auditStore, entry);
  const writeAudit = (reply: FastifyReply, entry: Parameters<AuditStore['append']>[0]): Promise<boolean> =>
    writeAuditEntry(auditStore, reply, entry);

  /**
   * `POST /v2/workspaces/inspect`. Read-only: resolves identity and reports the current trust state.
   *
   * Writes no audit entry, on purpose. Inspection is not a decision -- nothing is authorized by it
   * and nothing changes because of it -- and auditing it would fill the log with lines that say only
   * that a folder picker was opened, while making the *cap* (which denies real actions when it is
   * reached) reachable by browsing.
   */
  app.post('/v2/workspaces/inspect', async (req, reply) => {
    const parsed = workspaceInspectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', code: 'invalid_request' });
      return;
    }

    let identity: WorkspaceIdentity;
    try {
      identity = await resolveIdentity(parsed.data.path);
    } catch (err) {
      if (replyForIdentityError(reply, err)) return;
      throw err;
    }

    const inspection = await trustStore.inspect(identity.workspaceId);
    // A stored record that is `trusted` at a *different* incarnation is reported as `untrusted`:
    // the user approved a directory, and this is no longer the thing they approved.
    const state =
      inspection.state === 'trusted' && inspection.incarnation !== identity.incarnation
        ? 'untrusted'
        : inspection.state;

    const dirty = await isDirty(identity.canonicalPath);
    reply.send({
      schemaVersion: V2_WORKSPACE_VIEW_SCHEMA_VERSION,
      workspace: toTrustView(identity, sessionManager.isWorkspaceBlocked(identity.workspaceId) ? 'untrusted' : state, dirty),
    });
  });

  /**
   * `POST /v2/workspaces/consume-grant`. The only route that can produce `state: 'trusted'`.
   *
   * The order below is the security argument, and every step is a refusal point:
   *
   * 1. re-resolve identity from the path (a symlink or junction swapped since the dialog fails here);
   * 2. compare against the claimed pair (`identity_drift` if either half differs);
   * 3. refuse a non-reusable identity outright;
   * 4. refuse a workspace whose trust was revoked before this request reached here, and record the
   *    revocation epoch in the same synchronous turn as that check;
   * 5. **audit `grant.consumed`, awaited to fsync**, and deny if that write fails;
   * 6. **audit `trust.granted`, awaited to fsync**, and deny if that write fails;
   * 7. re-check the revocation epoch, then persist trust;
   * 8. re-check it again, then open admission.
   *
   * ## Why `trust.granted` is written *before* the trust it describes
   *
   * The entry means "the daemon has decided to trust this workspace and is about to persist that",
   * not "the trust file has been written". The framing is deliberate, because the alternative is
   * unsound: `setTrusted` is durable on disk and immediately visible to a concurrent `inspect`, so
   * writing the entry afterwards leaves a window -- one full await -- in which a crash, a power
   * loss, or a latching audit failure produces a permanently trusted workspace with no record of it
   * ever having been granted. That is the exact state this store exists to make impossible, and no
   * amount of rollback code can reach a process that is no longer running.
   *
   * Reversing the order moves the residue to the safe side: a crash between the entry and the write
   * leaves an audit line for a grant that did not take effect, which is a *readable, conservative*
   * discrepancy -- the log claims more authority was given than actually was. `grant.denied` /
   * `trust.revoked` lines around it, plus the trust file itself, say what really happened.
   *
   * ## Why the epoch is re-checked at steps 7 and 8
   *
   * Steps 5 and 6 are awaits, and `SessionManager.blockWorkspace` is synchronous, so a revocation
   * arriving while this request is in flight always lands *entirely* inside one of those gaps. The
   * check at step 4 cannot see it, and `allowWorkspace` at step 8 would clear the very block that
   * revocation just installed. This is the same discipline `SessionManager.workspaceIsTrusted`
   * applies, for the same reason, and the re-reads are placed with no await between them and the
   * mutation they guard.
   */
  app.post('/v2/workspaces/consume-grant', async (req, reply) => {
    const parsed = workspaceConsumeGrantRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', code: 'invalid_request' });
      return;
    }
    const { path, provider, workspaceId, incarnation, sessionId } = parsed.data;

    const denial = (reason: Parameters<AuditStore['append']>[0]['reason'], status: number, code: string) =>
      ({ reason, status, code }) as const;

    let identity: WorkspaceIdentity;
    try {
      identity = await resolveIdentity(path);
    } catch (err) {
      if (replyForIdentityError(reply, err)) {
        // Deliberately no audit entry: nothing was decided about a workspace, because no workspace
        // could be identified. There is no `workspaceId` to attribute an entry to that would not be
        // the caller's own unverified claim.
        return;
      }
      throw err;
    }

    const drifted = identity.workspaceId !== workspaceId || identity.incarnation !== incarnation;
    const failure = drifted
      ? denial('identity_drift', 409, 'workspace_identity_drift')
      : !identity.reusable
        ? denial('not_trusted', 409, 'workspace_not_reusable')
        : sessionManager.isWorkspaceBlocked(identity.workspaceId)
          ? denial('trust_revoked', 403, 'workspace_revoked')
          : undefined;

    // Read in the same synchronous turn as the block check above, so the two describe one instant.
    // Every later re-check compares against this value.
    const epochAtDecision = sessionManager.workspaceEpoch(identity.workspaceId);

    /**
     * What (if anything) changed this workspace's trust state since `epochAtDecision`.
     *
     * `blocked` is an outright revocation. `epoch_moved` is the subtler case: the counter also moves
     * on `allowWorkspace`, so a block-and-allow cycle that completed inside one of this request's
     * awaits leaves nothing blocked but still means this consumption was decided against a state
     * that no longer holds. Both deny -- the difference is only in what is recorded and answered,
     * because calling the second one a revocation would put a fact in the audit log that is not one.
     */
    const changedSinceDecision = (): 'blocked' | 'epoch_moved' | undefined => {
      if (sessionManager.isWorkspaceBlocked(identity.workspaceId)) return 'blocked';
      if (sessionManager.workspaceEpoch(identity.workspaceId) !== epochAtDecision) return 'epoch_moved';
      return undefined;
    };

    /** Audits and answers a mid-flight denial. Never grants, and never opens admission. */
    const denyMidFlight = async (change: 'blocked' | 'epoch_moved'): Promise<void> => {
      const refusal =
        change === 'blocked'
          ? denial('trust_revoked', 403, 'workspace_revoked')
          : denial('not_trusted', 409, 'workspace_grant_stale');
      const audited = await writeAudit(reply, {
        event: 'grant.denied',
        workspaceId: identity.workspaceId,
        incarnation: identity.incarnation,
        provider,
        transport: 'legacy-one-shot',
        ...(sessionId === undefined ? {} : { sessionId }),
        reason: refusal.reason,
        actor: 'policy',
      });
      if (!audited) return;
      reply.code(refusal.status).send({ error: 'the workspace grant was refused', code: refusal.code });
    };

    if (failure) {
      // The denial is audited against the *resolved* identity, not the claimed one: the claim is
      // exactly the thing that was found to be wrong, so recording it would file the entry under a
      // workspace id that may not exist.
      const audited = await writeAudit(reply, {
        event: 'grant.denied',
        workspaceId: identity.workspaceId,
        incarnation: identity.incarnation,
        provider,
        transport: 'legacy-one-shot',
        ...(sessionId === undefined ? {} : { sessionId }),
        reason: failure.reason,
        actor: 'policy',
      });
      if (!audited) return;
      reply.code(failure.status).send({ error: 'the workspace grant was refused', code: failure.code });
      return;
    }

    // Steps 5 and 6. Both records exist, fsynced, before anything durable or observable happens.
    // Either failing denies outright: nothing was mutated yet, so there is nothing to roll back and
    // no block to install -- the workspace is exactly as untrusted as it was before the request.
    if (!(await writeAudit(reply, buildConsumed(identity, provider, sessionId)))) return;
    if (!(await writeAudit(reply, buildGranted(identity, provider, sessionId)))) return;

    // Step 7's re-check, with no await between it and the mutation it guards.
    const beforePersist = changedSinceDecision();
    if (beforePersist) {
      // Deliberately no `blockWorkspace` here: nothing was persisted, so there is nothing to
      // contain, and blocking would let a losing racer close a workspace that a concurrent,
      // legitimate grant had just opened.
      await denyMidFlight(beforePersist);
      return;
    }

    try {
      await trustStore.setTrusted(identity, provider);
    } catch (err) {
      if (err instanceof NonReusableWorkspaceError) {
        reply.code(409).send({ error: err.message, code: err.code });
        return;
      }
      // Trust could not be persisted, and the log already says it was about to be. The honest
      // recovery is to make the state on disk match what was actually achieved (nothing): block the
      // workspace, undo any partial write, and report the failure. The rollback's *own* failure is
      // logged rather than swallowed -- it is the one path that can leave the two disagreeing, so a
      // silent catch here is the difference between a diagnosable state and an inexplicable one.
      sessionManager.blockWorkspace(identity.workspaceId);
      await trustStore.setUntrusted(identity.workspaceId).catch((rollbackErr: unknown) => {
        app.log.error(
          { err: rollbackErr },
          'workspace trust could not be rolled back after a failed grant; the workspace is blocked in memory but its stored state may be stale',
        );
      });
      app.log.error({ err }, 'workspace trust could not be persisted while consuming a grant');
      reply.code(500).send({ error: 'workspace trust could not be saved', code: 'trust_write_failed' });
      return;
    }

    // Step 8's re-check. `setTrusted` above is an await, so a revocation can land inside it, and
    // `allowWorkspace` below would otherwise clear the block that revocation just installed --
    // silently converting a revocation into a grant. Here the block *is* re-asserted, because
    // something durable was written and must not stay trusted while unblocked.
    const afterPersist = changedSinceDecision();
    if (afterPersist) {
      sessionManager.blockWorkspace(identity.workspaceId);
      await trustStore.setUntrusted(identity.workspaceId).catch((rollbackErr: unknown) => {
        app.log.error(
          { err: rollbackErr },
          'workspace trust could not be rolled back after a revocation raced the grant; the workspace is blocked in memory but its stored state may be stale',
        );
      });
      await denyMidFlight(afterPersist);
      return;
    }

    // Admission is opened last, and only here. Until this line a concurrent `create()` for this
    // workspace would still be refused, which is the correct direction to fail while the decision
    // is only partly recorded.
    sessionManager.allowWorkspace(identity.workspaceId);

    const dirty = await isDirty(identity.canonicalPath);
    reply.send({
      schemaVersion: V2_WORKSPACE_VIEW_SCHEMA_VERSION,
      workspace: toTrustView(identity, 'trusted', dirty),
    });
  });

  /**
   * `PUT /v2/workspaces/:workspaceId/trust`. Lowers trust, and can never raise it (D3).
   *
   * Both accepted states do the same two irreversible things -- block admission and cancel every
   * live session in the workspace -- and differ only in what they persist. `revoking` is for a
   * caller that wants the workspace held closed while it decides; `untrusted` is the terminal state.
   * Blocking happens *before* either store write, so a failing write cannot leave the workspace
   * admitting sessions.
   *
   * **Nothing here is gated on the audit write.** The `trust.revocation_started` entry is attempted
   * and its failure is logged and answered, but the block and the session cancellation happen
   * regardless: a revoked-and-cancelled-but-under-audited workspace is strictly better than a
   * revoked workspace with the user's files still open under a running CLI. That inverts the grant
   * path's rule on purpose -- see the module comment.
   */
  app.put('/v2/workspaces/:workspaceId/trust', async (req, reply) => {
    const workspaceId = workspaceDigestSchema.safeParse(
      (req.params as { workspaceId?: unknown }).workspaceId,
    );
    if (!workspaceId.success) {
      reply.code(400).send({ error: 'invalid workspace id', code: 'invalid_workspace_id' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.state === 'trusted') {
      // The explicit D3 refusal. Answered specifically rather than falling through to the generic
      // schema failure below, so the reason is unambiguous to anyone who tries it: this is not a
      // malformed request, it is a request for something no HTTP caller is allowed to do.
      reply.code(400).send({
        error:
          'trust cannot be set over HTTP. A workspace becomes trusted only when the daemon consumes ' +
          'a grant that the user approved in a native confirmation dialog.',
        code: 'trust_not_self_assertable',
      });
      return;
    }

    const parsed = workspaceTrustUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', code: 'invalid_request' });
      return;
    }

    const existing = trustStore.inspectSync(workspaceId.data);
    if (existing.incarnation === undefined) {
      // Nothing was ever granted for this id, so there is no incarnation or provider to attribute an
      // audit entry to, and fabricating either would put an invented fact in the log.
      reply.code(404).send({ error: 'workspace not found', code: 'workspace_not_found' });
      return;
    }
    const record = trustStore.all().find((candidate) => candidate.workspaceId === workspaceId.data);
    const provider: ProviderId = record?.provider ?? 'claude';

    // Synchronous, and first: from this statement onward no new session can start in this
    // workspace, regardless of what any store write below does.
    sessionManager.blockWorkspace(workspaceId.data);

    const auditBase = {
      workspaceId: workspaceId.data,
      incarnation: existing.incarnation,
      provider,
      transport: 'legacy-one-shot',
      actor: 'user',
    } as const;

    // Attempted, not gated on. This is the deliberate inversion of the rule the grant path follows,
    // and the asymmetry is the whole point: an unrecorded *grant* hands out authority nothing
    // remembers, while an unrecorded *revocation* only under-documents authority being taken away.
    // Returning here on a failed write -- which is what this route used to do -- would skip
    // `revokeWorkspace()` below, the only call that actually kills the CLI processes already running
    // in this workspace, leaving them alive in a folder the user just revoked because a log file was
    // full. `blockWorkspace()` has already run synchronously above, so new sessions are refused
    // either way; the cancellation of the live ones must not be skippable by an audit fault.
    const startFailure = await appendAudit({ ...auditBase, event: 'trust.revocation_started' });
    if (startFailure) {
      app.log.error(
        { code: startFailure.code, workspaceId: workspaceId.data },
        'the start of a workspace revocation could not be audited; cancelling its live sessions anyway',
      );
    }

    // Persisted state and live sessions are torn down independently, and a failure in either must
    // not skip the other: a workspace whose trust file could not be updated must still lose its
    // running sessions, and vice versa.
    const [, cancelled] = await Promise.all([
      (parsed.data.state === 'revoking'
        ? trustStore.beginRevocation(workspaceId.data)
        : trustStore.setUntrusted(workspaceId.data)
      ).catch((err: unknown) => {
        app.log.error({ err }, 'workspace trust state could not be persisted during revocation');
      }),
      sessionManager.revokeWorkspace(workspaceId.data),
    ]);

    // Reported only now, after the teardown actually happened. The caller still learns the audit log
    // is broken -- with the same closed code every other route uses -- but learns it about a
    // revocation that was carried out, not one that was abandoned.
    if (startFailure) {
      reply.code(startFailure.status).send({ error: startFailure.message, code: startFailure.code });
      return;
    }

    if (parsed.data.state === 'untrusted') {
      if (!(await writeAudit(reply, { ...auditBase, event: 'trust.revoked' }))) return;
    }

    reply.send({
      schemaVersion: V2_WORKSPACE_VIEW_SCHEMA_VERSION,
      workspaceId: workspaceId.data,
      state: parsed.data.state,
      cancelledSessions: cancelled.length,
    });
  });

  /**
   * `POST /v2/workspaces/grant-events`. The narrow reporting channel for the two grant-lifecycle
   * facts only Electron main can observe (issuance, and expiry before use).
   *
   * Restricted by schema to `grant.issued` and `grant.denied`. It cannot write `trust.granted`,
   * `trust.revoked`, or either `session.*` event: those are decisions the daemon makes, and it
   * writes them from the code that makes them. So the worst a caller can do here is add noise to its
   * own audit trail, never change what is authorized.
   */
  app.post('/v2/workspaces/grant-events', async (req, reply) => {
    const parsed = workspaceGrantEventRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', code: 'invalid_request' });
      return;
    }
    const { event, workspaceId, incarnation, provider, reason, actor } = parsed.data;
    const written = await writeAudit(reply, {
      event,
      workspaceId,
      incarnation,
      provider,
      transport: 'legacy-one-shot',
      ...(reason === undefined ? {} : { reason }),
      actor,
    });
    if (!written) return;
    reply.code(202).send({ schemaVersion: V2_WORKSPACE_VIEW_SCHEMA_VERSION, recorded: true });
  });
}

/**
 * The `trust.granted` entry: "this daemon has decided to trust this workspace and is about to
 * persist that", written immediately *before* `setTrusted`. See the route's own comment for why the
 * pre-commit framing is the only one that keeps "no trust without a record" true across a crash.
 */
function buildGranted(
  identity: WorkspaceIdentity,
  provider: ProviderId,
  sessionId: string | undefined,
): Parameters<AuditStore['append']>[0] {
  return {
    event: 'trust.granted',
    workspaceId: identity.workspaceId,
    incarnation: identity.incarnation,
    provider,
    transport: 'legacy-one-shot',
    ...(sessionId === undefined ? {} : { sessionId }),
    actor: 'user',
  };
}

function buildConsumed(
  identity: WorkspaceIdentity,
  provider: ProviderId,
  sessionId: string | undefined,
): Parameters<AuditStore['append']>[0] {
  return {
    event: 'grant.consumed',
    workspaceId: identity.workspaceId,
    incarnation: identity.incarnation,
    provider,
    transport: 'legacy-one-shot',
    ...(sessionId === undefined ? {} : { sessionId }),
    actor: 'user',
  };
}
