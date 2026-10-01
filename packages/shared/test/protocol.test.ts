import { describe, expect, it } from 'vitest';
import { AGENT_DOCK_PROTOCOL_VERSION, AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS } from '../src/protocol.js';

describe('AGENT_DOCK_PROTOCOL_VERSION', () => {
  it('is a stable positive integer', () => {
    expect(Number.isInteger(AGENT_DOCK_PROTOCOL_VERSION)).toBe(true);
    expect(AGENT_DOCK_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('stays frozen at 1 even as supported versions grow', () => {
    expect(AGENT_DOCK_PROTOCOL_VERSION).toBe(1);
  });
});

describe('AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS', () => {
  it('includes the legacy version and the new v2 version, in order', () => {
    expect(AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS).toEqual([1, 2]);
  });

  it('always includes AGENT_DOCK_PROTOCOL_VERSION', () => {
    expect(AGENT_DOCK_SUPPORTED_PROTOCOL_VERSIONS).toContain(AGENT_DOCK_PROTOCOL_VERSION);
  });
});
