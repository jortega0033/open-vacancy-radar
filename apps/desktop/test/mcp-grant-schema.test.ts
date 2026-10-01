import { describe, expect, it } from 'vitest';
import { describeMcpGrantBlockers, mcpGrantCoversCase, type McpClientGrant } from '../electron/workspace/mcp-grant-schema.js';

function grant(partial: Partial<McpClientGrant> = {}): McpClientGrant {
  return {
    id: 'grant-1',
    name: 'Test client',
    scopeType: 'source_cv',
    sourceCvId: 'cv-1',
    caseIds: [],
    canReadFinalSnapshot: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    revokedAt: '',
    ...partial,
  };
}

describe('describeMcpGrantBlockers (#421)', () => {
  it('is clean for an active, unexpired, unrevoked grant', () => {
    expect(describeMcpGrantBlockers(grant(), '2026-10-01T00:00:00.000Z')).toEqual([]);
  });

  it('flags a revoked grant', () => {
    expect(describeMcpGrantBlockers(grant({ revokedAt: '2026-09-15T00:00:00.000Z' }), '2026-10-01T00:00:00.000Z')).toEqual([
      'this grant was revoked',
    ]);
  });

  it('flags an expired grant', () => {
    expect(describeMcpGrantBlockers(grant({ expiresAt: '2026-09-01T00:00:00.000Z' }), '2026-10-01T00:00:00.000Z')).toEqual([
      'this grant has expired',
    ]);
  });

  it('reports both reasons together when both are true', () => {
    const blockers = describeMcpGrantBlockers(
      grant({ revokedAt: '2026-09-15T00:00:00.000Z', expiresAt: '2026-09-01T00:00:00.000Z' }),
      '2026-10-01T00:00:00.000Z',
    );
    expect(blockers).toEqual(['this grant was revoked', 'this grant has expired']);
  });
});

describe('mcpGrantCoversCase (#421)', () => {
  it('covers exactly the case ids in the list, regardless of scope type', () => {
    const withCases = grant({ caseIds: ['case-1', 'case-2'] });
    expect(mcpGrantCoversCase(withCases, 'case-1')).toBe(true);
    expect(mcpGrantCoversCase(withCases, 'case-3')).toBe(false);
  });

  it('covers nothing for a source_cv grant that has not started any case yet', () => {
    expect(mcpGrantCoversCase(grant({ scopeType: 'source_cv', caseIds: [] }), 'case-1')).toBe(false);
  });
});
