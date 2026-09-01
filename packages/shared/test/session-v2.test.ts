import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_LIMIT_V2,
  V2_SESSION_VIEW_SCHEMA_VERSION,
  activeSessionCapacitySchema,
  agentSessionV2ViewSchema,
  frozenLaunchScopeViewSchema,
  opaqueCursorV2Schema,
  pageLimitV2Schema,
  sessionStatusSchema,
  sessionStatusV2Schema,
  terminalReasonV2Schema,
  unknownFrameViewSchema,
} from '../src/index.js';

const VALID_VIEW = {
  schemaVersion: 1,
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'claude',
  protocolVersion: 2,
  transportId: 'legacy-one-shot',
  cwd: '/workspace',
  status: 'completed',
  terminalReason: 'provider_completed',
  acceptedWork: 'accepted',
  rootSessionId: '11111111-1111-4111-8111-111111111111',
  continuationKind: 'fresh',
  startedAt: '2026-09-01T10:00:00.000Z',
  completedAt: '2026-09-01T10:01:00.000Z',
  earliestSequence: 0,
  eventCount: 12,
  eventsTruncated: false,
  scope: {
    authenticated: 'authenticated',
    platform: 'win32',
    accountEvidence: 'cli_owned',
  },
  unknownFrames: [],
};

describe('v2 status vocabulary', () => {
  it('adds "interrupted" on top of every v1 status', () => {
    expect(sessionStatusV2Schema.options).toEqual([...sessionStatusSchema.options, 'interrupted']);
  });

  it('does not add "interrupted" to the frozen v1 status schema', () => {
    // v1 is a shipped, version-frozen contract: a client built against it cannot render a status it
    // has never seen. A recovered session is projected onto `failed` for v1 readers instead.
    expect(sessionStatusSchema.safeParse('interrupted').success).toBe(false);
  });

  it('names every terminal reason the daemon can record', () => {
    expect(terminalReasonV2Schema.options).toEqual([
      'provider_completed',
      'provider_error',
      'cancelled_by_client',
      'launch_failed',
      'daemon_restart',
    ]);
  });
});

describe('agentSessionV2ViewSchema', () => {
  it('accepts a well-formed view', () => {
    expect(agentSessionV2ViewSchema.safeParse(VALID_VIEW).success).toBe(true);
  });

  it('rejects an unknown key rather than passing it through', () => {
    expect(agentSessionV2ViewSchema.safeParse({ ...VALID_VIEW, prompt: 'leaked' }).success).toBe(false);
  });

  it('rejects a transport this repo does not have', () => {
    expect(agentSessionV2ViewSchema.safeParse({ ...VALID_VIEW, transportId: 'app-server' }).success).toBe(false);
  });

  it('rejects a protocol version outside {1, 2}', () => {
    expect(agentSessionV2ViewSchema.safeParse({ ...VALID_VIEW, protocolVersion: 3 }).success).toBe(false);
  });

  it('accepts all three accepted-work states in the read view, including not_accepted', () => {
    // Unlike the *persisted* record, the read view can legitimately report `not_accepted` for a
    // live session whose provider has not yet been handed the prompt.
    for (const acceptedWork of ['not_accepted', 'unknown', 'accepted']) {
      expect(agentSessionV2ViewSchema.safeParse({ ...VALID_VIEW, acceptedWork }).success).toBe(true);
    }
  });

  it('requires a uuid for the session and lineage ids', () => {
    expect(agentSessionV2ViewSchema.safeParse({ ...VALID_VIEW, id: 'not-a-uuid' }).success).toBe(false);
    expect(agentSessionV2ViewSchema.safeParse({ ...VALID_VIEW, rootSessionId: 'nope' }).success).toBe(false);
  });

  it('pins the view schema version at 1', () => {
    expect(V2_SESSION_VIEW_SCHEMA_VERSION).toBe(1);
    expect(agentSessionV2ViewSchema.safeParse({ ...VALID_VIEW, schemaVersion: 2 }).success).toBe(false);
  });
});

describe('scope and unknown-frame views', () => {
  it('pins accountEvidence to the documented limitation marker', () => {
    expect(frozenLaunchScopeViewSchema.safeParse({ ...VALID_VIEW.scope, accountEvidence: 'account_id' }).success).toBe(
      false,
    );
  });

  it('accepts a content-free unknown-frame entry and rejects one carrying a raw line', () => {
    const frame = {
      kind: 'unparseable_line',
      bytes: 42,
      sha256: 'a'.repeat(64),
      occurrences: 3,
      firstSeenAtMs: 1,
      lastSeenAtMs: 2,
    };
    expect(unknownFrameViewSchema.safeParse(frame).success).toBe(true);
    expect(unknownFrameViewSchema.safeParse({ ...frame, rawLine: 'leaked' }).success).toBe(false);
  });

  it('requires at least one occurrence: a frame nobody saw is not a frame', () => {
    expect(
      unknownFrameViewSchema.safeParse({
        kind: 'unparseable_line',
        bytes: 0,
        sha256: 'a'.repeat(64),
        occurrences: 0,
        firstSeenAtMs: 1,
        lastSeenAtMs: 1,
      }).success,
    ).toBe(false);
  });
});

describe('capacity and paging', () => {
  it('accepts a capacity snapshot and rejects a partial one', () => {
    expect(
      activeSessionCapacitySchema.safeParse({
        global: { active: 2, limit: 4 },
        provider: { active: 1, limit: 2 },
      }).success,
    ).toBe(true);
    expect(activeSessionCapacitySchema.safeParse({ global: { active: 2, limit: 4 } }).success).toBe(false);
  });

  it('bounds the page limit and defaults well inside it', () => {
    expect(pageLimitV2Schema.safeParse(1).success).toBe(true);
    expect(pageLimitV2Schema.safeParse(100).success).toBe(true);
    expect(pageLimitV2Schema.safeParse(0).success).toBe(false);
    expect(pageLimitV2Schema.safeParse(101).success).toBe(false);
    expect(pageLimitV2Schema.safeParse(1.5).success).toBe(false);
    expect(pageLimitV2Schema.safeParse(DEFAULT_PAGE_LIMIT_V2).success).toBe(true);
  });

  it('restricts a cursor to a bounded, URL-safe charset', () => {
    expect(opaqueCursorV2Schema.safeParse('abcDEF-_123').success).toBe(true);
    expect(opaqueCursorV2Schema.safeParse('').success).toBe(false);
    expect(opaqueCursorV2Schema.safeParse('has space').success).toBe(false);
    expect(opaqueCursorV2Schema.safeParse('../../etc/passwd').success).toBe(false);
    expect(opaqueCursorV2Schema.safeParse('a'.repeat(257)).success).toBe(false);
  });
});
