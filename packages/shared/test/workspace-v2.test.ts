import { describe, expect, it } from 'vitest';
import {
  auditEntryV2Schema,
  healthResponseSchema,
  workspaceConsumeGrantRequestSchema,
  workspaceDigestSchema,
  workspaceGrantEventRequestSchema,
  workspaceInspectRequestSchema,
  workspaceTrustUpdateRequestSchema,
  workspaceTrustViewSchema,
} from '../src/index.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function view(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    workspaceId: DIGEST_A,
    incarnation: DIGEST_B,
    displayName: 'my-project',
    dirty: false,
    reusable: true,
    state: 'untrusted',
    ...overrides,
  };
}

function auditEntry(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sequence: 0,
    entryId: '11111111-2222-4333-8444-555555555555',
    recordedAt: '2026-09-02T00:00:00.000Z',
    event: 'grant.consumed',
    workspaceId: DIGEST_A,
    incarnation: DIGEST_B,
    provider: 'claude',
    transport: 'legacy-one-shot',
    actor: 'user',
    ...overrides,
  };
}

describe('digests are digests, so a path cannot be smuggled through an id field', () => {
  it('accepts only 64 lowercase hex characters', () => {
    expect(workspaceDigestSchema.safeParse(DIGEST_A).success).toBe(true);
    for (const bad of [
      'C:\\Users\\someone\\project',
      '/home/someone/project',
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      '',
    ]) {
      expect(workspaceDigestSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('trust cannot be expressed by a client (D3)', () => {
  it('has no "trusted" member in the trust-update enum at all', () => {
    expect(workspaceTrustUpdateRequestSchema.safeParse({ state: 'untrusted' }).success).toBe(true);
    expect(workspaceTrustUpdateRequestSchema.safeParse({ state: 'revoking' }).success).toBe(true);
    // The absence is structural, not a runtime check the daemon happens to perform: there is no
    // request shape in this package that carries `state: 'trusted'`.
    expect(workspaceTrustUpdateRequestSchema.safeParse({ state: 'trusted' }).success).toBe(false);
  });

  it('rejects an extra key on the trust update, so a "trusted" field cannot ride along', () => {
    expect(
      workspaceTrustUpdateRequestSchema.safeParse({ state: 'untrusted', trusted: true }).success,
    ).toBe(false);
  });

  it('limits the grant-event channel to the two facts only the main process can observe', () => {
    const base = {
      workspaceId: DIGEST_A,
      incarnation: DIGEST_B,
      provider: 'claude',
      actor: 'user',
    };
    expect(workspaceGrantEventRequestSchema.safeParse({ ...base, event: 'grant.issued' }).success).toBe(true);
    expect(workspaceGrantEventRequestSchema.safeParse({ ...base, event: 'grant.denied' }).success).toBe(true);
    // Everything the daemon decides for itself is refused here, so this endpoint cannot be used to
    // fabricate a record of a decision that was never made.
    for (const event of ['trust.granted', 'trust.revoked', 'session.workspace_allowed']) {
      expect(workspaceGrantEventRequestSchema.safeParse({ ...base, event }).success, event).toBe(false);
    }
  });
});

describe('the trust view carries no path', () => {
  it('accepts a bounded display name and rejects an unbounded one', () => {
    expect(workspaceTrustViewSchema.safeParse(view()).success).toBe(true);
    expect(workspaceTrustViewSchema.safeParse(view({ displayName: 'x'.repeat(129) })).success).toBe(false);
    expect(workspaceTrustViewSchema.safeParse(view({ displayName: '' })).success).toBe(false);
  });

  it('rejects an added path field rather than passing it through', () => {
    expect(
      workspaceTrustViewSchema.safeParse(view({ canonicalPath: 'C:\\Users\\someone\\project' })).success,
    ).toBe(false);
    expect(workspaceTrustViewSchema.safeParse(view({ path: '/home/someone' })).success).toBe(false);
  });

  it('rejects a branch label carrying a control character, and one that is too long', () => {
    expect(workspaceTrustViewSchema.safeParse(view({ branch: 'main' })).success).toBe(true);
    expect(workspaceTrustViewSchema.safeParse(view({ branch: 'feature/x-1' })).success).toBe(true);
    // A branch is rendered into a native message box: a newline or an ANSI escape in it is either
    // corrupt or an attempt to reshape a security dialog's text.
    expect(workspaceTrustViewSchema.safeParse(view({ branch: 'main\nAllow' })).success).toBe(false);
    expect(workspaceTrustViewSchema.safeParse(view({ branch: 'main\u001b[2J' })).success).toBe(false);
    expect(workspaceTrustViewSchema.safeParse(view({ branch: 'x'.repeat(257) })).success).toBe(false);
  });
});

describe('the request bodies', () => {
  it('accepts a real path on inspect: this is the main-to-daemon boundary, not the renderer one', () => {
    expect(
      workspaceInspectRequestSchema.safeParse({ path: 'C:\\Users\\someone\\project', provider: 'claude' })
        .success,
    ).toBe(true);
    expect(workspaceInspectRequestSchema.safeParse({ path: '', provider: 'claude' }).success).toBe(false);
    expect(
      workspaceInspectRequestSchema.safeParse({ path: 'x'.repeat(5000), provider: 'claude' }).success,
    ).toBe(false);
    expect(
      workspaceInspectRequestSchema.safeParse({ path: '/p', provider: 'claude', extra: 1 }).success,
    ).toBe(false);
  });

  it('requires both halves of the claimed identity on consume-grant', () => {
    const base = { path: '/p', provider: 'claude', workspaceId: DIGEST_A, incarnation: DIGEST_B };
    expect(workspaceConsumeGrantRequestSchema.safeParse(base).success).toBe(true);
    expect(workspaceConsumeGrantRequestSchema.safeParse({ ...base, workspaceId: undefined }).success).toBe(
      false,
    );
    expect(workspaceConsumeGrantRequestSchema.safeParse({ ...base, incarnation: undefined }).success).toBe(
      false,
    );
    expect(
      workspaceConsumeGrantRequestSchema.safeParse({ ...base, state: 'trusted' }).success,
    ).toBe(false);
  });
});

describe('the audit entry shape', () => {
  it('accepts the documented shape and rejects every extra field', () => {
    expect(auditEntryV2Schema.safeParse(auditEntry()).success).toBe(true);
    for (const extra of [
      { path: 'C:\\Users\\someone' },
      // Deliberately absent even though the trust view has one: a directory's name is the user's
      // data, and ADI-05's no-content-on-disk rule applies to this store too.
      { displayName: 'my-project' },
      { message: 'free text' },
      { branch: 'main' },
    ]) {
      expect(auditEntryV2Schema.safeParse({ ...auditEntry(), ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it('pins the event, reason, and actor vocabularies as closed enums', () => {
    expect(auditEntryV2Schema.safeParse(auditEntry({ event: 'grant.made.up' })).success).toBe(false);
    expect(auditEntryV2Schema.safeParse(auditEntry({ reason: 'because' })).success).toBe(false);
    expect(auditEntryV2Schema.safeParse(auditEntry({ actor: 'renderer' })).success).toBe(false);
    expect(auditEntryV2Schema.safeParse(auditEntry({ reason: 'identity_drift' })).success).toBe(true);
    expect(auditEntryV2Schema.safeParse(auditEntry({ actor: 'audit_failure' })).success).toBe(true);
  });

  it('pins the transport literal, so a second transport cannot appear without a schema change', () => {
    expect(auditEntryV2Schema.safeParse(auditEntry({ transport: 'app-server' })).success).toBe(false);
  });
});

describe('daemonInstanceId is additive on /health (D7)', () => {
  it('validates a pre-ADI-06 daemon response that omits it', () => {
    expect(
      healthResponseSchema.safeParse({ status: 'ok', uptimeSeconds: 1, protocolVersion: 1 }).success,
    ).toBe(true);
  });

  it('carries the id through when present, and rejects one that is not a uuid', () => {
    const parsed = healthResponseSchema.safeParse({
      status: 'ok',
      uptimeSeconds: 1,
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      daemonInstanceId: '11111111-2222-4333-8444-555555555555',
    });
    expect(parsed.success).toBe(true);
    // Zod strips unknown keys, so a field that is not in the schema silently vanishes: this asserts
    // the field really is declared, which is what makes the desktop app able to read it at all.
    expect(parsed.success && parsed.data.daemonInstanceId).toBe('11111111-2222-4333-8444-555555555555');

    expect(
      healthResponseSchema.safeParse({
        status: 'ok',
        uptimeSeconds: 1,
        protocolVersion: 1,
        daemonInstanceId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });
});
