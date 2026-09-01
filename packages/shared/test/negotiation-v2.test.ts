import { describe, expect, it } from 'vitest';
import {
  AGENT_DOCK_PROTOCOL_VERSION,
  AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION_V2,
  daemonProtocolVersions,
  negotiateProtocolVersion,
  supportsProtocolVersion,
} from '../src/index.js';

describe('daemonProtocolVersions', () => {
  it('falls back to [protocolVersion] for a pre-v2 daemon with no supportedProtocolVersions field', () => {
    expect(daemonProtocolVersions({ protocolVersion: 1 })).toEqual([1]);
  });

  it('uses supportedProtocolVersions directly when present', () => {
    expect(daemonProtocolVersions({ protocolVersion: 1, supportedProtocolVersions: [1, 2] })).toEqual([1, 2]);
  });
});

describe('negotiateProtocolVersion', () => {
  it('selects the highest common version', () => {
    expect(negotiateProtocolVersion([1, 2], [1, 2])?.selected).toBe(2);
  });

  it('selects the only shared version when the sets partially overlap', () => {
    expect(negotiateProtocolVersion([1, 2], [1])?.selected).toBe(1);
  });

  it('is order-independent and ignores versions neither side shares', () => {
    const negotiation = negotiateProtocolVersion([1, 2], [2, 1, 99]);
    expect(negotiation?.selected).toBe(2);
  });

  it('returns undefined when there is no shared version at all', () => {
    expect(negotiateProtocolVersion([1, 2], [9])).toBeUndefined();
  });

  it('records the raw client and daemon version lists alongside the selection', () => {
    const negotiation = negotiateProtocolVersion([1, 2], [1, 2, 3]);
    expect(negotiation).toEqual({ clientVersions: [1, 2], daemonVersions: [1, 2, 3], selected: 2 });
  });
});

describe('supportsProtocolVersion', () => {
  it('treats the legacy protocol version as supported whenever the daemon lists it, regardless of the negotiated top', () => {
    const negotiation = negotiateProtocolVersion([1, 2], [1, 2])!;
    expect(supportsProtocolVersion(negotiation, AGENT_DOCK_PROTOCOL_VERSION)).toBe(true);
  });

  it('treats a newer version as supported only when it is the actual negotiated top', () => {
    // A hypothetical daemon that lists [1, 2] but a client capped at [1] only shares v1: v2 must
    // not read as usable even though the daemon itself advertises it.
    const negotiation = negotiateProtocolVersion([1], [1, 2])!;
    expect(supportsProtocolVersion(negotiation, PROTOCOL_VERSION_V2)).toBe(false);
    expect(supportsProtocolVersion(negotiation, AGENT_DOCK_PROTOCOL_VERSION)).toBe(true);
  });

  it('reports v1 as unsupported when the daemon never lists it at all', () => {
    const negotiation = negotiateProtocolVersion(Array.from(AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS), [2])!;
    expect(supportsProtocolVersion(negotiation, AGENT_DOCK_PROTOCOL_VERSION)).toBe(false);
    expect(supportsProtocolVersion(negotiation, PROTOCOL_VERSION_V2)).toBe(true);
  });

  it('reports a fully-shared version as supported even when it is not the negotiated top -- a future v3 must not silently break v2', () => {
    // Regression guard: a check phrased as `selected === version` instead of shared-set membership
    // would wrongly reject version 2 the moment a higher version (3) enters both sides' lists, even
    // though 2 is still genuinely usable by both.
    const negotiation = negotiateProtocolVersion([1, 2, 3], [1, 2, 3])!;
    expect(negotiation.selected).toBe(3);
    expect(supportsProtocolVersion(negotiation, PROTOCOL_VERSION_V2)).toBe(true);
  });
});
