import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  ACTIVE_CAPABILITY_EXTENSION_IDS,
  MODEL_SELECT_CAPABILITY_ID,
  V2_SESSION_VIEW_SCHEMA_VERSION,
  createSessionV2RequestSchema,
  type AuditReasonV2,
  type CapabilitySelectionV2,
  type CapabilityUnavailableReasonV2,
  type OpaqueExtension,
  type ProviderStatus,
} from '@agent-dock/shared';
import { resolveModelSelection } from '@agent-dock/vacancy-agent-adapter';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';
import type { AuditStore } from '../audit-store.js';
import { ActiveSessionLimitError } from '../active-session-limiter.js';
import {
  RevokedWorkspaceError,
  StaleWorkspaceGrantError,
  type SessionManager,
} from '../session-manager.js';
import { StorageFullError, type SessionLineageStore } from '../session-lineage-store.js';
import { resolveWorkspaceIdentity, type WorkspaceIdentity } from '../workspace-identity.js';
import {
  WorkspaceLeaseConflictError,
  workspaceLeaseModeFor,
  type WorkspaceExecutionLeaseManager,
  type WorkspaceLease,
} from '../workspace-execution-lease.js';
import { appendAudit, replyForIdentityError, writeAudit } from './v2-route-helpers.js';
import { toV2View } from './v2-sessions.js';

/**
 * `POST /v2/sessions` (ADI-13): the first v2 route that *does* something.
 *
 * ADI-05 deferred this deliberately, and ADI-06 shipped three things dormant waiting for it -- the
 * execution-lease manager, `SessionManager.workspaceIsTrusted`, and the `session.workspace_allowed`
 * / `session.workspace_denied` audit events. This route is what gives all three a real caller.
 *
 * ## Its own file, and why
 *
 * `routes/v2-sessions.ts` is read-only and holds only the durable store and the limiter. This route
 * needs the trust store, the audit store, and the lease manager on top of those -- strictly more
 * authority -- and is registered by its own call inside `server.ts`'s existing `v2.workspace` gate.
 * Deleting that one call rolls session *creation* back to v1-only while leaving v1, the v2 read
 * routes, and ADI-06's workspace/audit routes completely untouched. That is the rollback story, and
 * `v2-sessions-create.rollback.test.ts` pins it.
 *
 * ## The pre-flight sequence, and why it is ordered this way
 *
 * `SessionManager.create()` is synchronous and `await`-free by construction (ADI-05), so **every**
 * asynchronous decision has to be finished before it is called. The order below is not arbitrary:
 *
 *  1. parse the body                       -- cheapest refusal, and no workspace is named yet
 *  2. resolve the provider                 -- ditto
 *  3. blocked check + capture the epoch    -- synchronous, one instant, before any await
 *  4. resolve the real identity from `cwd`
 *  5. compare it against the caller's claim
 *  6. `workspaceIsTrusted`, epoch-bracketed
 *  7. `provider.detect()`                  -- one call, serving both the resume check and the catalog
 *  8. resume resolution                    -- BEFORE any capability resolution; see below
 *  9. capability resolution                -- fresh sessions only
 * 10. mint the session id
 * 11. **audit `session.workspace_allowed`, awaited to fsync**
 * 12. re-check admission
 * 13. acquire the workspace lease
 * 14. `create()` -- which re-checks admission one last time, synchronously, with no gap
 *
 * Steps 1 and 2 write no audit entry, for the same reason `POST /v2/workspaces/consume-grant`'s
 * identity-error path writes none: no workspace has been identified, so the only id available to
 * file an entry under is the caller's own unverified claim. Every refusal from step 3 onward that
 * *has* identified a real workspace writes `session.workspace_denied` -- best-effort on that path,
 * because an audit failure while reporting a denial must not replace the denial with a different
 * error the caller cannot act on.
 *
 * ## Audit before effect
 *
 * Step 11 is awaited, and `AuditStore.append` resolves only after its fsync. Nothing irreversible
 * has happened when it runs: no lease, no record, no process. If it fails, the request is refused
 * with the same closed code table every other route uses and **no session exists**. This is the
 * discipline ADI-06's review had to fix in the grant path, applied here from the start rather than
 * retrofitted, and `v2-sessions-create.routes.test.ts` proves the ordering with spies rather than
 * asserting it in a comment.
 *
 * ## Resume is resolved before capabilities, and a resume may not name a model
 *
 * A resume continues a provider-native thread that was already granted a model. Two rules fall out,
 * and both are stricter than v1:
 *
 * - **An unknown resume target is a 409, not a fresh session.** v1 passes an unrecognized
 *   `resumeProviderSessionId` straight to the CLI. Here it is refused, because "resume a thread this
 *   daemon has no record of" is indistinguishable from "start a fresh session while claiming to be a
 *   continuation" -- and the second is a way to launder a model choice past the rule below.
 * - **A model-select capability on a resume is a 400, unconditionally.** The *presence* of the field
 *   is what is refused, not a mismatching value. Comparing values would mean a caller who guesses
 *   the parent's model correctly gets to send the field, which teaches exactly the wrong thing about
 *   what the rule is; and a value that matches today is still a request to re-resolve against a
 *   catalog that may have changed since.
 *
 * A valid resume therefore performs **no capability resolution at all** and inherits `model` and
 * `selection` from the parent record verbatim. If the parent has no `selection` (a v1-originated or
 * pre-ADI-13 record), the child gets none either -- absence is inherited like any other value, and
 * synthesizing an empty selection would invent a negotiation that never happened.
 */

/** What one refusal answers with, plus how it is filed in the audit log. */
interface Refusal {
  status: number;
  code: string;
  message: string;
  /**
   * The closed-enum audit reason, or omitted.
   *
   * Omitted is deliberate and is used for every refusal whose cause has no honest member in
   * `auditReasonV2Schema` (a lease conflict, a malformed capability request, a resume that named a
   * model). `reason` is optional on an audit entry, and an entry with no reason says "this was
   * denied" without claiming a cause that is not true. Squeezing them into `not_trusted` would put a
   * false statement in the one log that exists to be believed.
   */
  reason?: AuditReasonV2;
}

const REFUSALS = {
  workspace_revoked: {
    status: 403,
    code: 'workspace_revoked',
    message: 'this workspace is no longer trusted, so a new session cannot start in it',
    reason: 'trust_revoked',
  },
  workspace_grant_stale: {
    status: 409,
    code: 'workspace_grant_stale',
    message: 'this workspace changed trust state while the session was being admitted; try again',
    reason: 'not_trusted',
  },
  workspace_identity_drift: {
    status: 409,
    code: 'workspace_identity_drift',
    message: 'this folder is not the folder the request claimed it was',
    reason: 'identity_drift',
  },
  workspace_not_reusable: {
    status: 409,
    code: 'workspace_not_reusable',
    message: 'the filesystem does not report a stable identity for this folder, so it cannot host a session',
    reason: 'not_trusted',
  },
  workspace_not_trusted: {
    status: 403,
    code: 'workspace_not_trusted',
    message: 'this workspace has not been approved for agent sessions',
    reason: 'not_trusted',
  },
  resume_not_supported: {
    status: 400,
    code: 'resume_not_supported',
    message: 'this provider cannot resume a previous session',
  },
  unknown_resume_target: {
    status: 409,
    code: 'unknown_resume_target',
    message: 'there is no retained session for the thread this request asked to resume',
  },
  resume_cannot_override_model: {
    status: 400,
    code: 'resume_cannot_override_model',
    message:
      'a resumed session keeps the model it was started with, so a model-select capability cannot ' +
      'be requested on a resume',
  },
  invalid_capability_request: {
    status: 400,
    code: 'invalid_capability_request',
    message: 'a requested capability was malformed',
  },
  active_session_limit: {
    status: 409,
    code: 'active_session_limit',
    message: 'too many active sessions',
  },
  storage_full: {
    status: 507,
    code: 'storage_full',
    message: 'session storage is full',
  },
} as const satisfies Record<string, Refusal>;

export interface V2SessionCreateRouteOptions {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  store: SessionLineageStore;
  auditStore: AuditStore;
  leaseManager: WorkspaceExecutionLeaseManager;
  /** Injection seam for tests. Defaults to the real identity resolver. */
  resolveIdentity?: (path: string) => Promise<WorkspaceIdentity>;
}

/**
 * Resolves one requested capability against a provider's detected catalog.
 *
 * Returns either an enabled entry, an unavailable entry, or `'invalid'` -- and the three-way split
 * is the whole point:
 *
 * - **unavailable** is not a failure. A capability this build does not implement, a model the
 *   provider does not offer, and a provider with no catalog at all are all recorded in
 *   `unavailableOptional` and the session starts anyway, on the provider's own default model. That
 *   is what keeps a newer client talking to an older daemon: an id the daemon has never heard of
 *   must never be a request error.
 * - **invalid** fails the whole request. A malformed constraint is not "we cannot honor this", it is
 *   "you sent something that is not a well-formed ask", and answering 201 to it would leave the
 *   caller believing a capability was considered when it was never even parsed.
 *
 * `resolveModelSelection`'s `invalid_request` outcome carries a human-readable Zod message. It is
 * read here only to decide which of the three branches applies and is **never** carried into the
 * result: `unavailableOptional` entries are destined for the durable store, whose rule is that no
 * caller-supplied or free-form text reaches disk.
 */
function resolveCapability(
  extension: OpaqueExtension,
  catalog: readonly string[] | undefined,
):
  | { kind: 'enabled'; entry: OpaqueExtension; model: string }
  | { kind: 'unavailable'; id: string; reason: CapabilityUnavailableReasonV2 }
  | { kind: 'invalid' } {
  // An id outside the active registry is not resolvable by definition: there is no handler behind
  // it. This is checked before the model-select branch so that adding a second active capability
  // later means adding a branch, not remembering to widen a condition.
  if (!ACTIVE_CAPABILITY_EXTENSION_IDS.includes(extension.id)) {
    return { kind: 'unavailable', id: extension.id, reason: 'unsupported_capability' };
  }

  if (extension.id === MODEL_SELECT_CAPABILITY_ID) {
    const outcome = resolveModelSelection(extension.constraints, catalog);
    switch (outcome.outcome) {
      case 'selected':
        return { kind: 'enabled', entry: extension, model: outcome.model };
      case 'unknown_model':
        return { kind: 'unavailable', id: extension.id, reason: 'unknown_model' };
      case 'no_catalog':
        return { kind: 'unavailable', id: extension.id, reason: 'no_catalog' };
      case 'invalid_request':
        return { kind: 'invalid' };
      default: {
        const unhandled: never = outcome;
        void unhandled;
        return { kind: 'invalid' };
      }
    }
  }

  // Reachable only if `ACTIVE_CAPABILITY_EXTENSION_IDS` gains an id with no branch above. Reporting
  // it as unsupported rather than throwing keeps the fail-safe direction: an activation registry
  // that ran ahead of its handler degrades to "we could not honor this", never to a 500.
  return { kind: 'unavailable', id: extension.id, reason: 'unsupported_capability' };
}

export function registerV2SessionCreateRoute(
  app: FastifyInstance,
  options: V2SessionCreateRouteOptions,
): void {
  const { registry, sessionManager, store, auditStore, leaseManager } = options;
  const resolveIdentity = options.resolveIdentity ?? ((path: string) => resolveWorkspaceIdentity(path));

  app.post('/v2/sessions', async (req, reply) => {
    // ---- Step 1: the request shape -----------------------------------------------------------
    const parsed = createSessionV2RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid request body', code: 'invalid_request' });
      return;
    }
    const { provider, cwd, prompt, resumeProviderSessionId, capabilities } = parsed.data;
    const claimed = { workspaceId: parsed.data.workspaceId, incarnation: parsed.data.incarnation };

    // ---- Step 2: the provider ----------------------------------------------------------------
    const providerImpl = registry.get(provider);
    if (!providerImpl) {
      reply.code(400).send({ error: `unsupported provider: ${provider}`, code: 'unsupported_provider' });
      return;
    }

    /**
     * Answers a refusal, filing a `session.workspace_denied` entry against the workspace it
     * concerns.
     *
     * The audit write here is **best-effort, and deliberately so**, which is the exact inverse of
     * step 11's rule and the same asymmetry `v2-workspaces.ts` draws around revocation: an
     * unrecorded *grant* hands out authority nothing remembers, while an unrecorded *denial* only
     * under-documents authority being withheld. Replacing a 403 with a 507 because the log was full
     * would tell the caller to archive a file when what actually happened is that its workspace is
     * not trusted. The failure is logged for an operator instead.
     */
    const deny = async (
      refusal: Refusal,
      identity: Pick<WorkspaceIdentity, 'workspaceId' | 'incarnation'>,
      sessionId?: string,
    ): Promise<void> => {
      const failure = await appendAudit(auditStore, {
        event: 'session.workspace_denied',
        workspaceId: identity.workspaceId,
        incarnation: identity.incarnation,
        provider,
        transport: 'legacy-one-shot',
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(refusal.reason === undefined ? {} : { reason: refusal.reason }),
        actor: 'policy',
      });
      if (failure) {
        app.log.error(
          { code: failure.code, workspaceId: identity.workspaceId },
          'a session denial could not be audited; the denial itself still stands',
        );
      }
      reply.code(refusal.status).send({ error: refusal.message, code: refusal.code });
    };

    // ---- Step 3: blocked check and the epoch, in one synchronous turn -------------------------
    // Read together so the two describe one instant. Every later re-check compares against this
    // value, and it is captured against the *claimed* id, which step 5 then proves is the real one.
    if (sessionManager.isWorkspaceBlocked(claimed.workspaceId)) {
      await deny(REFUSALS.workspace_revoked, claimed);
      return;
    }
    const epochAtDecision = sessionManager.workspaceEpoch(claimed.workspaceId);

    // ---- Step 4: the real identity, from the filesystem ---------------------------------------
    let identity: WorkspaceIdentity;
    try {
      identity = await resolveIdentity(cwd);
    } catch (err) {
      // No audit entry: no workspace could be identified, so the only id available to file one under
      // is the caller's own unverified claim. Same reasoning as the consume-grant route's.
      if (replyForIdentityError(reply, err)) return;
      throw err;
    }

    // ---- Step 5: the claim must match what the filesystem says --------------------------------
    if (identity.workspaceId !== claimed.workspaceId || identity.incarnation !== claimed.incarnation) {
      // Filed against the *resolved* identity, not the claimed one: the claim is exactly the thing
      // that was found to be wrong.
      await deny(REFUSALS.workspace_identity_drift, identity);
      return;
    }
    if (!identity.reusable) {
      await deny(REFUSALS.workspace_not_reusable, identity);
      return;
    }

    // ---- Step 6: trust, epoch-bracketed ------------------------------------------------------
    // The first production caller of a method ADI-06 shipped with none. Every re-check inside it
    // compares against `epochAtDecision`, so a revocation landing in any of its await gaps denies.
    const trusted = await sessionManager.workspaceIsTrusted({
      workspaceId: identity.workspaceId,
      incarnation: identity.incarnation,
      canonicalPath: identity.canonicalPath,
      expectedEpoch: epochAtDecision,
    });
    if (!trusted) {
      await deny(REFUSALS.workspace_not_trusted, identity);
      return;
    }

    // ---- Step 7: one detect(), serving both the resume check and the model catalog ------------
    const status: ProviderStatus = await providerImpl.detect();

    // ---- Step 8: resume, resolved before any capability work ----------------------------------
    let selection: CapabilitySelectionV2 | undefined;
    let resolvedModel: string | undefined;

    if (resumeProviderSessionId !== undefined) {
      if (!status.capabilities.resume) {
        await deny(REFUSALS.resume_not_supported, identity);
        return;
      }

      // The same index `SessionManager.create()` will use to attach the lineage, deliberately: a
      // route that resolved the parent differently could admit a session that then attached itself
      // somewhere else, or none at all.
      const parent = store.findByProviderSessionId(resumeProviderSessionId);
      if (!parent) {
        await deny(REFUSALS.unknown_resume_target, identity);
        return;
      }

      // Presence, not value. See this module's header for why comparing values would be weaker.
      if ((capabilities ?? []).some((entry) => entry.id === MODEL_SELECT_CAPABILITY_ID)) {
        await deny(REFUSALS.resume_cannot_override_model, identity);
        return;
      }

      // Inherited verbatim, never re-resolved: the parent's catalog is not necessarily this
      // catalog, and a resume that silently moved to a different model is the exact continuation
      // hazard ADI-03's resolver was written to avoid. An absent parent `selection` is inherited as
      // absent -- there is no negotiation to describe, and inventing an empty one would say there
      // was.
      selection = parent.session.selection;
      resolvedModel = parent.session.model;
    } else {
      // ---- Step 9: capability resolution, fresh sessions only --------------------------------
      const enabled: OpaqueExtension[] = [];
      const unavailableOptional: { id: string; reason: CapabilityUnavailableReasonV2 }[] = [];

      for (const extension of capabilities ?? []) {
        const outcome = resolveCapability(extension, status.availableModels);
        if (outcome.kind === 'invalid') {
          await deny(REFUSALS.invalid_capability_request, identity);
          return;
        }
        if (outcome.kind === 'unavailable') {
          unavailableOptional.push({ id: outcome.id, reason: outcome.reason });
          continue;
        }
        enabled.push(outcome.entry);
        resolvedModel = outcome.model;
      }

      // Present-and-possibly-empty, and only when the caller actually asked for something. A request
      // that named no capabilities negotiated nothing, so its session carries no `selection` at all
      // -- the same absence a v1 session has, and for the same reason.
      if (capabilities !== undefined) selection = { enabled, unavailableOptional };
    }

    // ---- Step 10: the session id -------------------------------------------------------------
    // Minted here, before the audit write, so the entry below names the session it authorizes.
    const sessionId = randomUUID();

    // ---- Step 11: audit before effect --------------------------------------------------------
    // Awaited, and therefore fsynced, before a lease is taken or a record is written. A failure here
    // is a refusal: `writeAudit` has already answered the caller with the mapped status.
    const allowed = await writeAudit(auditStore, reply, {
      event: 'session.workspace_allowed',
      workspaceId: identity.workspaceId,
      incarnation: identity.incarnation,
      provider,
      transport: 'legacy-one-shot',
      sessionId,
      actor: 'policy',
    });
    if (!allowed) return;

    // ---- Step 12: re-check, because step 11 was an await -------------------------------------
    // `blockWorkspace` is synchronous, so a revocation racing this request lands entirely inside one
    // of the awaits above. There is no await between this check and the lease acquisition it guards.
    const changed = changedSince(sessionManager, identity.workspaceId, epochAtDecision);
    if (changed) {
      await deny(changed === 'blocked' ? REFUSALS.workspace_revoked : REFUSALS.workspace_grant_stale, identity, sessionId);
      return;
    }

    // ---- Step 13: the workspace lease --------------------------------------------------------
    // `workspaceLeaseModeFor('legacy-one-shot')` is `'write'` unconditionally, because over this
    // repo's one transport the CLI is spawned into the workspace and is not constrained afterwards
    // (D4). So this is an exclusive lease, and a second concurrent session for the same folder is
    // refused rather than allowed to interleave writes with the first.
    let lease: WorkspaceLease;
    try {
      lease = await leaseManager.acquire({
        workspaceId: identity.workspaceId,
        sessionId,
        mode: workspaceLeaseModeFor('legacy-one-shot'),
        canonicalPath: identity.canonicalPath,
      });
    } catch (err) {
      if (err instanceof WorkspaceLeaseConflictError) {
        await deny(
          {
            status: 409,
            code: err.code,
            message: 'another session is already using this workspace',
          },
          identity,
          sessionId,
        );
        // The reason is machine-readable and belongs in the body, but it is not an `AuditReasonV2`,
        // so it rides on the response rather than being forced into the log's closed enum.
        return;
      }
      throw err;
    }

    // ---- Step 14: create ---------------------------------------------------------------------
    // `create()` is synchronous, and it performs the *final* admission re-check itself, with no
    // statement between the check and the reservation. That is why there is no third route-side
    // re-check here: a check followed by a call is weaker than a check inside the call.
    //
    // This route holds **no lease release**. Every way this session can end -- refused here,
    // failing to launch, completing, failing, cancelled, abandoned -- releases through one of
    // `SessionManager`'s two cleanup sites, which is the same single-release-site discipline ADI-04
    // and ADI-05 established for the active-session limiter.
    try {
      sessionManager.create(provider, cwd, prompt, resumeProviderSessionId, resolvedModel, 2, identity.workspaceId, {
        sessionId,
        lease,
        expectedWorkspaceEpoch: epochAtDecision,
        ...(selection === undefined ? {} : { selection }),
      });
    } catch (err) {
      if (err instanceof RevokedWorkspaceError) {
        await deny(REFUSALS.workspace_revoked, identity, sessionId);
        return;
      }
      if (err instanceof StaleWorkspaceGrantError) {
        await deny(REFUSALS.workspace_grant_stale, identity, sessionId);
        return;
      }
      if (err instanceof ActiveSessionLimitError) {
        await deny(REFUSALS.active_session_limit, identity, sessionId);
        return;
      }
      if (err instanceof StorageFullError) {
        await deny(REFUSALS.storage_full, identity, sessionId);
        return;
      }
      throw err;
    }

    // ---- Step 15: the response ---------------------------------------------------------------
    // Projected through the *same* function `GET /v2/sessions/:id` uses, so the two cannot disagree
    // about the shape of a session -- including about whether it carries a `selection` at all.
    const record = store.get(sessionId);
    if (!record) {
      // Only reachable with no durable store, which cannot happen: this route is registered only
      // alongside one (see server.ts). Answered rather than crashed, because the session itself is
      // live and running, and a 500 would suggest otherwise.
      app.log.error({ sessionId }, 'a v2 session was created but no durable record was found for it');
      reply.code(500).send({ error: 'the session was created but could not be described', code: 'session_unreadable' });
      return;
    }
    reply.code(201).send({ schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION, session: toV2View(record) });
  });
}

/**
 * What (if anything) changed this workspace's admission state since `expectedEpoch`.
 *
 * `blocked` is an outright revocation. `epoch_moved` is the subtler one: the counter also moves on
 * `allowWorkspace`, so a block-and-allow cycle that completed inside one of this request's awaits
 * leaves nothing blocked but still means the decision was made against a state that no longer holds.
 * Both deny; they are distinguished because calling the second a revocation would put a fact in the
 * audit log that is not one. Identical reasoning, and identical shape, to `v2-workspaces.ts`.
 */
function changedSince(
  sessionManager: SessionManager,
  workspaceId: string,
  expectedEpoch: number,
): 'blocked' | 'epoch_moved' | undefined {
  if (sessionManager.isWorkspaceBlocked(workspaceId)) return 'blocked';
  if (sessionManager.workspaceEpoch(workspaceId) !== expectedEpoch) return 'epoch_moved';
  return undefined;
}
