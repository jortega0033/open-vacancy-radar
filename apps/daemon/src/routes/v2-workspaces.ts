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
import { AuditCapacityError, AuditUnavailableError, type AuditStore } from '../audit-store.js';
import type { SessionManager } from '../session-manager.js';
import {
  InvalidWorkspacePathError,
  UncWorkspacePathError,
  resolveWorkspaceIdentity,
  type WorkspaceIdentity,
} from '../workspace-identity.js';
import { NonReusableWorkspaceError, type WorkspaceTrustStore } from '../workspace-trust-store.js';
import { isWorkspaceDirty } from '../workspace-execution-lease.js';

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
 * ## Audit before allow, always
 *
 * Every route below that changes trust writes its audit entry *and awaits its fsync* before the
 * response is sent. An audit failure is a denial, never a warning: see `withAudit`.
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

/**
 * Translates an identity-resolution failure into a client-visible refusal.
 *
 * The UNC case gets its own code and its own full message (D6): "network locations are not
 * supported" is actionable, whereas the generic invalid-path error would leave a user retrying the
 * same share forever. Returns `true` when it handled the error, so the caller can `return`.
 */
function replyForIdentityError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof UncWorkspacePathError) {
    reply.code(400).send({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof InvalidWorkspacePathError) {
    reply.code(400).send({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

export function registerV2WorkspaceRoutes(app: FastifyInstance, options: V2WorkspaceRouteOptions): void {
  const { trustStore, auditStore, sessionManager } = options;
  const resolveIdentity = options.resolveIdentity ?? ((path: string) => resolveWorkspaceIdentity(path));
  const isDirty = options.isDirty ?? isWorkspaceDirty;

  /**
   * Writes one audit entry and reports whether the caller may proceed.
   *
   * The contract is deliberately blunt: **if this returns false, deny.** An audit log that is
   * "best-effort" is not an audit log, so a capacity error and a latched-unhealthy store both stop
   * the action rather than being logged past. The two are distinguished in the response only
   * because one is recoverable by archiving a file and the other needs a restart.
   */
  async function writeAudit(
    reply: FastifyReply,
    entry: Parameters<AuditStore['append']>[0],
  ): Promise<boolean> {
    try {
      await auditStore.append(entry);
      return true;
    } catch (err) {
      if (err instanceof AuditCapacityError) {
        reply.code(507).send({ error: err.message, code: err.code });
        return false;
      }
      if (err instanceof AuditUnavailableError) {
        reply.code(503).send({ error: err.message, code: err.code });
        return false;
      }
      reply.code(500).send({ error: 'the workspace audit log could not be written', code: 'audit_write_failed' });
      return false;
    }
  }

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
   * 4. refuse a workspace whose trust was revoked while this request was in flight;
   * 5. **audit `grant.consumed`, awaited to fsync**, and deny if that write fails;
   * 6. persist trust, then audit `trust.granted`;
   * 7. only then allow.
   *
   * Step 5 preceding steps 6 and 7 is what makes "audit before allow" structural rather than a
   * convention: there is no ordering of these statements that grants access without a durable record
   * of it existing first.
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

    if (!(await writeAudit(reply, buildConsumed(identity, provider, sessionId)))) return;

    try {
      await trustStore.setTrusted(identity, provider);
    } catch (err) {
      if (err instanceof NonReusableWorkspaceError) {
        reply.code(409).send({ error: err.message, code: err.code });
        return;
      }
      // Trust could not be persisted. The consumption is already recorded, so the honest recovery is
      // to make the state on disk match what was actually achieved (nothing) rather than leave a
      // half-granted workspace: block it, and report the failure.
      sessionManager.blockWorkspace(identity.workspaceId);
      reply.code(500).send({ error: 'workspace trust could not be saved', code: 'trust_write_failed' });
      return;
    }

    if (
      !(await writeAudit(reply, {
        event: 'trust.granted',
        workspaceId: identity.workspaceId,
        incarnation: identity.incarnation,
        provider,
        transport: 'legacy-one-shot',
        ...(sessionId === undefined ? {} : { sessionId }),
        actor: 'user',
      }))
    ) {
      // The grant was consumed and trust was written, but the record of the grant *taking effect*
      // could not be. Rolling trust back is the only outcome that leaves the log truthful: an
      // unrecorded trusted workspace is precisely the state this store exists to make impossible.
      sessionManager.blockWorkspace(identity.workspaceId);
      await trustStore.setUntrusted(identity.workspaceId).catch(() => undefined);
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

    if (!(await writeAudit(reply, { ...auditBase, event: 'trust.revocation_started' }))) return;

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
