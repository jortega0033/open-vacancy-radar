import { z } from 'zod';
import { providerIdSchema } from './schemas.js';

/**
 * The v2 **workspace trust** vocabulary: workspace identity views, the audit entry shape, and the
 * request/response bodies for the three workspace routes the daemon exposes (ADI-06).
 *
 * Deliberately *not* a port of upstream AgentDock's `policy-v2.ts`. That module models a negotiated
 * `CapabilitySelection`/`Effect` catalog that this repo has no producer or consumer for, and whose
 * approval round-trip (`approval.requested` frames, a turn protocol, an interaction broker) is
 * explicitly ADI-08's scope. Importing it here would ship a large schema surface that nothing can
 * exercise, and -- worse for a security surface -- would let a confirmation dialog claim a narrowed
 * effect set that this repo's single `legacy-one-shot` transport cannot actually enforce. See
 * `workspaceEffectsSchema` below and docs/adr-agentdock-v2-provenance.md#adi-06.
 *
 * Every object here is `.strict()`, for the same reason `session-v2.ts` is: both producer and
 * consumer ship from this repo, and on a trust surface "an extra key showed up" must fail loudly.
 */

/** Bumped only when a v2 workspace view shape changes incompatibly. */
export const V2_WORKSPACE_VIEW_SCHEMA_VERSION = 1;

/**
 * A lowercase hex sha256, or an equivalently-sized random value for a non-reusable identity. Both
 * `workspaceId` and `incarnation` are digests by construction and never carry a path, so pinning
 * the exact charset and length here is also what stops a raw path being smuggled through either
 * field by a future call site that forgot which value it was holding.
 */
export const workspaceDigestSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);

/**
 * Trust states, ported from upstream's shape. `revoking` is a real state and not a transient
 * detail: revocation cancels live sessions, which takes time, and a workspace that is mid-revocation
 * must already be refused by every new admission decision before the revocation has finished.
 */
export const workspaceTrustStateSchema = z.enum(['trusted', 'untrusted', 'revoking']);
export type WorkspaceTrustState = z.infer<typeof workspaceTrustStateSchema>;

/**
 * What a granted workspace actually authorizes, as a single literal.
 *
 * This is the honest answer, not a placeholder for a richer type. Over this repo's one transport
 * (`legacy-one-shot`) the provider CLI is spawned with the workspace as its `cwd` and is not
 * constrained afterwards: it can read, write, run commands, and reach the network. A narrowed
 * `['read', 'write']`-style array would be a *false claim in a security confirmation dialog*, which
 * is worse than no claim at all. Mirrors the `accountEvidence: 'cli_owned'` literal ADI-04
 * introduced for exactly the same reason. ADI-08 is the ticket that may replace this with a real
 * negotiated set, once there is machinery that can enforce one.
 */
export const workspaceEffectsSchema = z.literal('unbounded_cli');
export type WorkspaceEffects = z.infer<typeof workspaceEffectsSchema>;

/** Bounds on the two human-readable strings a workspace view is allowed to carry. */
export const MAX_WORKSPACE_DISPLAY_NAME_LENGTH = 128;
export const MAX_WORKSPACE_BRANCH_LENGTH = 256;

/**
 * The only human-readable string in this module: a directory's own basename, bounded.
 *
 * It exists because a confirmation dialog that cannot name the directory is not a confirmation at
 * all. It is deliberately the basename and never the full path -- see `workspaceTrustViewSchema` --
 * and it never reaches the audit log, which stores digests only.
 */
export const workspaceDisplayNameSchema = z.string().min(1).max(MAX_WORKSPACE_DISPLAY_NAME_LENGTH);

/**
 * A Git branch label. Control characters are rejected rather than escaped: this string is rendered
 * into a native message box, and a value carrying `\r`, `\n`, or an ANSI escape is either a corrupt
 * Git ref or an attempt to reshape the dialog's text, and neither is worth displaying.
 */
export const workspaceBranchSchema = z
  .string()
  .min(1)
  .max(MAX_WORKSPACE_BRANCH_LENGTH)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'branch label must not contain control characters');

/**
 * `POST /v2/workspaces/inspect`.
 *
 * This body carries a **real filesystem path**, and that is correct: the caller is the desktop
 * app's Electron main process talking to its own daemon over loopback, and main is the party that
 * already holds the path (the user picked it in a native dialog that main opened). The stop
 * condition ADI-06 is written against is the *renderer* boundary, not the main-to-daemon one: no
 * IPC channel exposed by `preload.ts` accepts or returns a path, and the renderer only ever holds
 * an opaque grant handle plus a bounded display name. See apps/desktop/electron/workspace-grant.ts.
 */
export const workspaceInspectRequestSchema = z
  .object({
    path: z.string().min(1).max(4096),
    provider: providerIdSchema,
  })
  .strict();

export type WorkspaceInspectRequest = z.infer<typeof workspaceInspectRequestSchema>;

/**
 * What the daemon knows about one workspace, as returned by inspect and by grant consumption.
 *
 * Note what is absent: any path. `displayName` is a bounded basename and `branch` a bounded ref
 * label; everything else is a digest, a boolean, or an enum.
 */
export const workspaceTrustViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: workspaceDigestSchema,
    incarnation: workspaceDigestSchema,
    displayName: workspaceDisplayNameSchema,
    branch: workspaceBranchSchema.optional(),
    dirty: z.boolean(),
    /**
     * False when the filesystem could not give a stable object identity for this directory (a
     * `dev`/`ino` of 0, an SMB share, or two consecutive stats disagreeing). A non-reusable
     * identity is assigned a random `incarnation` that can never revalidate, and the trust store
     * refuses to mark one trusted at all -- so this flag is the fail-closed marker, not a hint.
     */
    reusable: z.boolean(),
    state: workspaceTrustStateSchema,
  })
  .strict();

export type WorkspaceTrustView = z.infer<typeof workspaceTrustViewSchema>;

/**
 * `POST /v2/workspaces/consume-grant`: the one endpoint that can turn a workspace trusted, and only
 * as a side effect of consuming a grant that main minted after showing the user a confirmation
 * dialog.
 *
 * The claimed `{ workspaceId, incarnation }` are what the grant vouches for; the daemon re-resolves
 * identity from `path` itself and refuses when the two disagree (`identity_drift`). A caller cannot
 * assert trust by naming a pair, because the pair is checked against the filesystem, and it cannot
 * assert trust by naming a path, because the pair must also match what it claimed before the check.
 */
export const workspaceConsumeGrantRequestSchema = z
  .object({
    path: z.string().min(1).max(4096),
    provider: providerIdSchema,
    workspaceId: workspaceDigestSchema,
    incarnation: workspaceDigestSchema,
    sessionId: z.string().uuid().optional(),
  })
  .strict();

export type WorkspaceConsumeGrantRequest = z.infer<typeof workspaceConsumeGrantRequestSchema>;

/**
 * `PUT /v2/workspaces/:workspaceId/trust`.
 *
 * `'trusted'` is **structurally absent from this enum**, and that absence is the entire point (D3).
 * Upstream lets the renderer send `{ cwd, incarnation, state: 'trusted' }` and the daemon obeys,
 * which makes trust self-assertable by whichever process can reach the route. Here the only path to
 * `trusted` runs through grant consumption above, so this route can lower trust and never raise it.
 * A body naming `'trusted'` is rejected with a 400 rather than ignored, so a caller that believed it
 * could set trust learns it cannot.
 */
export const workspaceTrustUpdateStateSchema = z.enum(['untrusted', 'revoking']);

export const workspaceTrustUpdateRequestSchema = z
  .object({
    state: workspaceTrustUpdateStateSchema,
  })
  .strict();

export type WorkspaceTrustUpdateRequest = z.infer<typeof workspaceTrustUpdateRequestSchema>;

/**
 * The audit event vocabulary. Closed enum, no free text: an audit line must be interpretable
 * without a human reading a message, and a free-text field is a place for content to leak.
 */
export const auditEventV2Schema = z.enum([
  'grant.issued',
  'grant.consumed',
  'grant.denied',
  'trust.granted',
  'trust.revocation_started',
  'trust.revoked',
  'session.workspace_allowed',
  'session.workspace_denied',
]);

export type AuditEventV2 = z.infer<typeof auditEventV2Schema>;

/** Why an event happened. Also a closed enum, for the same reason. */
export const auditReasonV2Schema = z.enum([
  'timeout',
  'navigation',
  'webcontents_destroyed',
  'daemon_generation',
  'trust_revoked',
  'wrong_webcontents',
  'unknown_handle',
  'already_consumed',
  'identity_drift',
  'not_trusted',
  'audit_failure',
]);

export type AuditReasonV2 = z.infer<typeof auditReasonV2Schema>;

/** Who or what caused the event. `policy` covers a decision the daemon made on its own rules. */
export const auditActorV2Schema = z.enum([
  'user',
  'policy',
  'timeout',
  'daemon_restart',
  'navigation',
  'audit_failure',
]);

export type AuditActorV2 = z.infer<typeof auditActorV2Schema>;

/**
 * One audit line.
 *
 * `.strict()`, and every field is a digest, an enum, an integer, a uuid, or an ISO timestamp. There
 * is deliberately **no `displayName`** here even though the trust view has one: a directory's own
 * name is the user's data (a project name, a client name, an employer name), and ADI-05's
 * "no content on disk" discipline applies to this store too. The audit answers "which workspace
 * object, and what happened to it", which `workspaceId` already answers unambiguously; it does not
 * answer "what was it called".
 */
export const auditEntryV2Schema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().nonnegative(),
    entryId: z.string().uuid(),
    recordedAt: z.string().min(1).max(64),
    event: auditEventV2Schema,
    workspaceId: workspaceDigestSchema,
    incarnation: workspaceDigestSchema,
    provider: providerIdSchema,
    transport: z.literal('legacy-one-shot'),
    sessionId: z.string().uuid().optional(),
    reason: auditReasonV2Schema.optional(),
    actor: auditActorV2Schema,
  })
  .strict();

export type AuditEntryV2 = z.infer<typeof auditEntryV2Schema>;

/**
 * `POST /v2/workspaces/grant-events`: the narrow channel through which the desktop app's main
 * process reports the two grant-lifecycle facts only it can observe.
 *
 * The grant state machine lives in Electron main (it is bound to a `WebContents`, a native dialog,
 * and a navigation lifecycle the daemon knows nothing about), while the audit log lives in the
 * daemon. Without this, `grant.issued` and every expiry would be invisible to the log, and an audit
 * that records only consumption cannot answer "how many approvals were handed out and never used".
 *
 * The `event` enum deliberately admits **only** these two. It is not a general "write me an audit
 * line" endpoint: `trust.granted`, `trust.revoked`, and both `session.*` events are decisions the
 * daemon makes itself, and it writes those from the code that makes them, never on request.
 */
export const workspaceGrantEventSchema = z.enum(['grant.issued', 'grant.denied']);

export const workspaceGrantEventRequestSchema = z
  .object({
    event: workspaceGrantEventSchema,
    workspaceId: workspaceDigestSchema,
    incarnation: workspaceDigestSchema,
    provider: providerIdSchema,
    reason: auditReasonV2Schema.optional(),
    actor: auditActorV2Schema,
  })
  .strict();

export type WorkspaceGrantEventRequest = z.infer<typeof workspaceGrantEventRequestSchema>;

/** What `GET /v2/audit` returns. */
export const auditPageV2Schema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(auditEntryV2Schema),
    nextCursor: z.string().optional(),
  })
  .strict();

export type AuditPageV2 = z.infer<typeof auditPageV2Schema>;
