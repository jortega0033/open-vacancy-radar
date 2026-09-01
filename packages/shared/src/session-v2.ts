import { z } from 'zod';
import { providerIdSchema } from './schemas.js';

/**
 * The v2 session *read view*: what `GET /v2/sessions` and friends return, and nothing else.
 *
 * This is deliberately **not** a port of upstream AgentDock's `protocol-v2.ts`. That module models
 * an interactive, capability-negotiated session-creation protocol (turn commands, approval
 * round-trips, transport descriptors) that this repo has no counterpart for -- ADI-05 ships only
 * read routes, so importing a creation protocol here would mean shipping a large schema surface
 * with no producer and no consumer. See docs/adr-agentdock-v2-provenance.md#adi-05.
 *
 * Every object here is `.strict()`: an unexpected key is a validation failure, not something to
 * pass through. The v1 schemas in schemas.ts are deliberately permissive in places (see the AD-15
 * note on `providerCapabilitiesSchema`) because they must tolerate a peer one version ahead. These
 * do not: both producer and consumer of a v2 read view ship from this same repo, and the shapes
 * below carry redaction-relevant fields, where "an extra key showed up" is exactly the thing that
 * should fail loudly rather than round-trip.
 */

/**
 * Bumped only when a v2 read-view shape changes incompatibly. Separate from
 * `AGENT_DOCK_PROTOCOL_VERSION` (frozen at 1, the HTTP/SSE contract version) and from the durable
 * store's own on-disk `schemaVersion`, which advances independently: the wire view and the on-disk
 * record are allowed to diverge, and conflating them would force a disk migration for a purely
 * presentational change.
 */
export const V2_SESSION_VIEW_SCHEMA_VERSION = 1;

/**
 * The v2 status set. `'interrupted'` exists **only** here, never in v1's `sessionStatusSchema`: a
 * v1 client has no way to interpret a status it was not built against, so a session recovered after
 * a daemon restart is presented to v1 as `status: 'failed'` with an explanatory `error` string (see
 * `INTERRUPTED_SESSION_V1_ERROR` in apps/daemon/src/persisted-session-schema.ts), and only a v2
 * client sees the more precise state.
 */
export const sessionStatusV2Schema = z.enum([
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export type SessionStatusV2 = z.infer<typeof sessionStatusV2Schema>;

/** Why a session left the running set. `daemon_restart` is the recovery path's reason. */
export const terminalReasonV2Schema = z.enum([
  'provider_completed',
  'provider_error',
  'cancelled_by_client',
  'launch_failed',
  'daemon_restart',
]);

export type TerminalReasonV2 = z.infer<typeof terminalReasonV2Schema>;

/**
 * The read-view projection of `FrozenLaunchScope` (packages/agent-runtime). Deliberately narrower
 * than the runtime type: `cwd`, `provider`, `model`, and `transportId` are already top-level fields
 * on the session view, so repeating them inside the scope would create two places for the same
 * fact to disagree.
 *
 * `accountEvidence` is the literal `'cli_owned'` for the same reason it is a literal on
 * `FrozenLaunchScope`: it is a documented limitation marker, not an account fingerprint. See
 * docs/adr-agentdock-v2-provenance.md#limitation-accountevidence-cli_owned-is-not-an-account-fingerprint.
 */
export const frozenLaunchScopeViewSchema = z
  .object({
    executablePath: z.string().optional(),
    providerVersion: z.string().optional(),
    authenticated: z.string(),
    platform: z.string(),
    accountEvidence: z.literal('cli_owned'),
  })
  .strict();

export type FrozenLaunchScopeView = z.infer<typeof frozenLaunchScopeViewSchema>;

/**
 * Mirrors `NormalizedUnknownFrame` from @agent-dock/agent-runtime, which is already content-free by
 * construction (only a hash and a byte count of a line this repo could not interpret). Restated as
 * a schema here rather than imported so the wire shape is pinned independently of a runtime type
 * that a later ticket may widen.
 */
export const unknownFrameViewSchema = z
  .object({
    kind: z.enum([
      'unrecognized_event_type',
      'unparseable_line',
      'frame_bounds_exceeded',
      'non_object_frame',
    ]),
    eventType: z.string().optional(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
    boundsViolation: z.string().optional(),
    occurrences: z.number().int().positive(),
    firstSeenAtMs: z.number(),
    lastSeenAtMs: z.number(),
  })
  .strict();

export type UnknownFrameView = z.infer<typeof unknownFrameViewSchema>;

/**
 * One session, as a v2 client sees it.
 *
 * `acceptedWork` is the field this whole schema exists to carry across a daemon restart: it answers
 * "is it safe to run this prompt again?" and never "did it finish?". `'not_accepted'` is a positive
 * safety claim and is therefore **never** persisted (see `persisted-session-schema.ts`); it appears
 * in this view only for a live, still-in-memory session whose provider process has not yet been
 * handed the prompt.
 */
export const agentSessionV2ViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    provider: providerIdSchema,
    protocolVersion: z.union([z.literal(1), z.literal(2)]),
    transportId: z.literal('legacy-one-shot'),
    cwd: z.string(),
    model: z.string().optional(),
    status: sessionStatusV2Schema,
    terminalReason: terminalReasonV2Schema.optional(),
    acceptedWork: z.enum(['not_accepted', 'accepted', 'unknown']),
    providerSessionId: z.string().optional(),
    rootSessionId: z.string().uuid(),
    parentSessionId: z.string().uuid().optional(),
    continuationKind: z.enum(['fresh', 'resume']),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    earliestSequence: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    eventsTruncated: z.boolean(),
    scope: frozenLaunchScopeViewSchema,
    unknownFrames: z.array(unknownFrameViewSchema),
  })
  .strict();

export type AgentSessionV2View = z.infer<typeof agentSessionV2ViewSchema>;

/**
 * How much of the active-session budget is already spoken for, at both scopes. Returned alongside
 * every session listing so a client can render "3 of 4 running" without a second round trip, and
 * so a 409 body and a list response describe capacity in exactly the same shape.
 */
export const activeSessionCapacitySchema = z
  .object({
    global: z.object({ active: z.number().int(), limit: z.number().int() }).strict(),
    provider: z.object({ active: z.number().int(), limit: z.number().int() }).strict(),
  })
  .strict();

export type ActiveSessionCapacityView = z.infer<typeof activeSessionCapacitySchema>;

/**
 * Pagination cursors are opaque to clients on purpose: today one is just a session id or a sequence
 * number, and a client that parsed it would pin an implementation detail this repo intends to keep
 * free to change. The charset is restricted to URL-safe base64 characters and the length is capped
 * so a hostile or corrupted cursor cannot become an unbounded string flowing into a store lookup.
 */
export const opaqueCursorV2Schema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const pageLimitV2Schema = z.number().int().min(1).max(100);

/** Default page size when a request omits `limit`. Well under `pageLimitV2Schema`'s cap. */
export const DEFAULT_PAGE_LIMIT_V2 = 50;
