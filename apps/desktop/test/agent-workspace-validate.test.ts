// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NAV_PAGES as SHELL_NAV_PAGES } from '../src/components/shell/nav.js';
import {
  AGENT_WORKSPACE_PREF_LIMITS,
  NAV_PAGES,
  PAGE_LIMIT_BOUNDS,
  parseAgentWorkspaceAttachInput,
  parseAgentWorkspaceDetachInput,
  parseAgentWorkspaceEventsInput,
  parseAgentWorkspaceGetInput,
  parseAgentWorkspaceListInput,
  parseArchivedSessionIds,
  parseSessionId,
  parseSettingsPatch,
  parseUnreadCounts,
} from '../electron/workspace/validate.js';

/**
 * Input validation for the five `agent-workspace:*` channels and the three preference fields
 * (ADI-07).
 *
 * The rule specific to these channels, on top of this module's usual allow-list-and-bound
 * discipline, is that **nothing here accepts a location**. There is no `path`, `cwd`,
 * `workspaceId`, or `incarnation` parser, so a renderer that attaches one has it dropped in main,
 * on top of the preload bridge already refusing to put it on the wire.
 */

const VALID_ID = '11111111-2222-4333-8444-555555555555';

describe('parseSessionId', () => {
  it('accepts a canonical uuid in either case', () => {
    expect(parseSessionId(VALID_ID)).toBe(VALID_ID);
    expect(parseSessionId(VALID_ID.toUpperCase())).toBe(VALID_ID.toUpperCase());
  });

  it('rejects everything that is not one, rather than passing it into a URL path', () => {
    // These are the values that would matter if this ever reached `/v2/sessions/${id}`.
    for (const bad of [
      '',
      'abc',
      '../../etc/passwd',
      `${VALID_ID}/../../admin`,
      `${VALID_ID}?x=1`,
      'C:/Users/someone',
      `${VALID_ID} `,
      VALID_ID.replace('-', ''),
      42,
      null,
      undefined,
      { toString: () => VALID_ID },
    ]) {
      expect(() => parseSessionId(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('agent-workspace:list', () => {
  it('defaults to a bounded page when given nothing at all', () => {
    expect(parseAgentWorkspaceListInput(undefined)).toEqual({ limit: PAGE_LIMIT_BOUNDS.default });
    expect(parseAgentWorkspaceListInput(null)).toEqual({ limit: PAGE_LIMIT_BOUNDS.default });
    expect(parseAgentWorkspaceListInput({})).toEqual({ limit: PAGE_LIMIT_BOUNDS.default });
  });

  it('accepts an opaque cursor and a bounded limit', () => {
    expect(parseAgentWorkspaceListInput({ cursor: 'abc-DEF_123', limit: 10 })).toEqual({
      cursor: 'abc-DEF_123',
      limit: 10,
    });
  });

  it('rejects a limit outside the daemon own bounds instead of clamping it silently', () => {
    expect(() => parseAgentWorkspaceListInput({ limit: 0 })).toThrow(/between/);
    expect(() => parseAgentWorkspaceListInput({ limit: PAGE_LIMIT_BOUNDS.max + 1 })).toThrow(/between/);
    expect(() => parseAgentWorkspaceListInput({ limit: 1.5 })).toThrow(/integer/);
    expect(() => parseAgentWorkspaceListInput({ limit: '10' })).toThrow(/integer/);
  });

  it('rejects a cursor that is not opaque-cursor shaped', () => {
    for (const bad of ['a b', 'a/b', '../x', 'x'.repeat(257), '?limit=999', 'a=1&b=2']) {
      expect(() => parseAgentWorkspaceListInput({ cursor: bad }), bad).toThrow();
    }
  });

  it('drops every location-shaped key a caller attaches', () => {
    expect(
      parseAgentWorkspaceListInput({
        limit: 5,
        cwd: 'C:/Users/someone',
        path: '/etc/passwd',
        workspaceId: 'a'.repeat(64),
        incarnation: 'b'.repeat(64),
        provider: 'claude',
      }),
    ).toEqual({ limit: 5 });
  });
});

describe('agent-workspace:get / :detach', () => {
  it('takes a session id and nothing else', () => {
    expect(parseAgentWorkspaceGetInput({ sessionId: VALID_ID, cwd: 'C:/x' })).toBe(VALID_ID);
    expect(parseAgentWorkspaceDetachInput({ sessionId: VALID_ID, path: '/etc' })).toBe(VALID_ID);
  });

  it('requires a real session id', () => {
    expect(() => parseAgentWorkspaceGetInput({})).toThrow();
    expect(() => parseAgentWorkspaceGetInput(null)).toThrow();
    expect(() => parseAgentWorkspaceDetachInput({ sessionId: 'nope' })).toThrow();
  });
});

describe('agent-workspace:events', () => {
  it('combines a session id with a bounded page', () => {
    expect(parseAgentWorkspaceEventsInput({ sessionId: VALID_ID, cursor: 'abc', limit: 25 })).toEqual({
      sessionId: VALID_ID,
      cursor: 'abc',
      limit: 25,
    });
    expect(parseAgentWorkspaceEventsInput({ sessionId: VALID_ID })).toEqual({
      sessionId: VALID_ID,
      limit: PAGE_LIMIT_BOUNDS.default,
    });
  });

  it('drops anything location-shaped alongside the id', () => {
    expect(parseAgentWorkspaceEventsInput({ sessionId: VALID_ID, cwd: 'C:/Users/someone' })).toEqual({
      sessionId: VALID_ID,
      limit: PAGE_LIMIT_BOUNDS.default,
    });
  });
});

describe('agent-workspace:attach', () => {
  it('accepts a non-negative integer lastSeq, and omits it otherwise', () => {
    expect(parseAgentWorkspaceAttachInput({ sessionId: VALID_ID, lastSeq: 0 })).toEqual({
      sessionId: VALID_ID,
      lastSeq: 0,
    });
    expect(parseAgentWorkspaceAttachInput({ sessionId: VALID_ID, lastSeq: 41 })).toEqual({
      sessionId: VALID_ID,
      lastSeq: 41,
    });
    expect(parseAgentWorkspaceAttachInput({ sessionId: VALID_ID })).toEqual({ sessionId: VALID_ID });
    expect(parseAgentWorkspaceAttachInput({ sessionId: VALID_ID, lastSeq: null })).toEqual({ sessionId: VALID_ID });
  });

  it('rejects a lastSeq that is not an index', () => {
    // It becomes a `Last-Event-ID` header on the daemon request, so it is an index, never a cursor.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', {}]) {
      expect(() => parseAgentWorkspaceAttachInput({ sessionId: VALID_ID, lastSeq: bad }), String(bad)).toThrow(
        /non-negative integer/,
      );
    }
  });
});

describe('the AI Workspace preference fields', () => {
  it('accepts the three fields through the settings patch', () => {
    expect(
      parseSettingsPatch({
        agentSelectedSessionId: VALID_ID,
        agentArchivedSessionIds: ['a', 'b'],
        agentUnreadCounts: { a: 3 },
      }),
    ).toEqual({
      agentSelectedSessionId: VALID_ID,
      agentArchivedSessionIds: ['a', 'b'],
      agentUnreadCounts: { a: 3 },
    });
  });

  it('accepts null as a real "nothing selected" value', () => {
    expect(parseSettingsPatch({ agentSelectedSessionId: null })).toEqual({ agentSelectedSessionId: null });
  });

  it('deduplicates archived ids, so archiving stays idempotent across a reload', () => {
    expect(parseArchivedSessionIds(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(parseArchivedSessionIds(null)).toEqual([]);
    expect(parseArchivedSessionIds(undefined)).toEqual([]);
  });

  it('bounds the collections against a hostile renderer', () => {
    const tooMany = Array.from({ length: AGENT_WORKSPACE_PREF_LIMITS.archivedSessions + 1 }, (_v, i) => `s${i}`);
    expect(() => parseArchivedSessionIds(tooMany)).toThrow(/at most/);

    const counts: Record<string, number> = {};
    for (let i = 0; i <= AGENT_WORKSPACE_PREF_LIMITS.unreadSessions; i += 1) counts[`s${i}`] = 1;
    expect(() => parseUnreadCounts(counts)).toThrow(/at most/);

    expect(() => parseArchivedSessionIds(['x'.repeat(AGENT_WORKSPACE_PREF_LIMITS.sessionId + 1)])).toThrow();
    expect(() => parseArchivedSessionIds('not-an-array')).toThrow(/must be an array/);
  });

  it('caps an unread count rather than storing an unbounded integer', () => {
    expect(parseUnreadCounts({ a: 10_000_000 })).toEqual({ a: AGENT_WORKSPACE_PREF_LIMITS.maxUnread });
    expect(parseUnreadCounts({})).toEqual({});
    expect(parseUnreadCounts(null)).toEqual({});
  });

  it('rejects an unread count that is not a non-negative integer', () => {
    for (const bad of [-1, 1.5, '3', null, {}]) {
      expect(() => parseUnreadCounts({ a: bad }), String(bad)).toThrow(/non-negative integer/);
    }
  });
});

describe('nav page agreement', () => {
  it('accepts agent-workspace as a lastOpenedPage', () => {
    expect(parseSettingsPatch({ lastOpenedPage: 'agent-workspace' })).toEqual({
      lastOpenedPage: 'agent-workspace',
    });
  });

  it('keeps main and the renderer telling the same story about what a destination is', () => {
    // Two independent declarations of the same list (electron/workspace/validate.ts is deliberately
    // dependency-free, so the renderer's nav table cannot be imported into it). They must agree, or
    // "restore the page the user was on" resolves to a page main will not persist.
    expect([...NAV_PAGES]).toEqual([...SHELL_NAV_PAGES]);
  });

  it('does not offer agent-workspace as a start page', () => {
    // A screen whose whole purpose is to show what is running right now is a poor thing to land on
    // cold, so `START_PAGES` is deliberately not widened alongside `NAV_PAGES`.
    expect(() => parseSettingsPatch({ startPage: 'agent-workspace' })).toThrow(/must be one of/);
  });
});
