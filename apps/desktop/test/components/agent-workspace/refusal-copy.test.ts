import { describe, expect, it } from 'vitest';
import {
  ATTACH_REFUSAL_COPY,
  HISTORY_ONLY_EXPLANATION,
  REFUSAL_COPY,
  START_SESSION_DENIAL_REASONS,
  refusalCopy,
} from '../../../src/components/agent-workspace/refusal-copy.js';

/**
 * Every refusal has copy, and the copy says nothing the daemon wrote (ADI-07).
 *
 * `satisfies Record<StartSessionDenialReason, RefusalCopy>` already makes a missing reason a
 * compile error. This walks `START_SESSION_DENIAL_REASONS` at runtime so the *other* direction is
 * covered too: a reason added to the type union but not to that array. Same two-sided discipline
 * ADI-05 applies to its redactor's event-type inventory.
 */

describe('refusal copy exhaustiveness', () => {
  it('has a title and a detail for every reason in the real inventory', () => {
    expect(START_SESSION_DENIAL_REASONS.length).toBeGreaterThan(0);
    for (const reason of START_SESSION_DENIAL_REASONS) {
      const copy = REFUSAL_COPY[reason];
      expect(copy, `no copy for ${reason}`).toBeDefined();
      expect(copy.title.length, reason).toBeGreaterThan(0);
      expect(copy.detail.length, reason).toBeGreaterThan(0);
    }
  });

  it('has no copy for anything outside the inventory', () => {
    expect(Object.keys(REFUSAL_COPY).sort()).toEqual([...START_SESSION_DENIAL_REASONS].sort());
  });

  it('falls back to the generic refusal for a reason this build does not know', () => {
    expect(refusalCopy('something_a_newer_daemon_invented')).toBe(REFUSAL_COPY.refused);
    expect(refusalCopy('')).toBe(REFUSAL_COPY.refused);
  });
});

describe('the two 409s read as different situations', () => {
  const limit = REFUSAL_COPY.active_session_limit;
  const lease = REFUSAL_COPY.workspace_lease_conflict;

  it('does not share a sentence between them', () => {
    expect(limit.title).not.toBe(lease.title);
    expect(limit.detail).not.toBe(lease.detail);
  });

  it('points each at the remedy that actually works for it', () => {
    // Too many sessions anywhere: waiting or stopping one fixes it, changing folder does not.
    expect(limit.detail.toLowerCase()).toMatch(/wait|stop/);
    expect(limit.detail.toLowerCase()).not.toContain('folder');
    // Another session holds this folder: a different folder fixes it, stopping an unrelated
    // session does not.
    expect(lease.detail.toLowerCase()).toContain('folder');
  });
});

describe('refusal copy says nothing a path could hide in', () => {
  const allText = [
    ...START_SESSION_DENIAL_REASONS.map((reason) => `${REFUSAL_COPY[reason].title} ${REFUSAL_COPY[reason].detail}`),
    ...Object.values(ATTACH_REFUSAL_COPY),
    HISTORY_ONLY_EXPLANATION,
  ].join('\n');

  it('contains no drive letter, UNC prefix, or POSIX-looking absolute path', () => {
    expect(allText).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(allText).not.toContain('\\\\');
    expect(allText).not.toMatch(/(?:^|\s)\/[A-Za-z]/);
  });

  it('uses no em dash, per this repo-wide UI copy convention', () => {
    expect(allText).not.toContain('—');
  });

  it('never borrows an error vocabulary for a state that is not an error', () => {
    // A session that simply is not being streamed is not a failure, and the copy must not say so.
    for (const sentence of Object.values(ATTACH_REFUSAL_COPY)) {
      expect(sentence.toLowerCase()).not.toMatch(/\berror\b|\bfailed\b|\bcrash/);
    }
    expect(HISTORY_ONLY_EXPLANATION.toLowerCase()).not.toMatch(/\berror\b|\bfailed\b/);
  });

  it('covers every attach refusal reason the bridge can produce', () => {
    expect(Object.keys(ATTACH_REFUSAL_COPY).sort()).toEqual(
      ['attach_limit', 'daemon_unavailable', 'invalid_session_id'].sort(),
    );
  });
});
