import { describe, expect, it } from 'vitest';
import {
  parseBlindApplyAnswerResult,
  parseBlindApplyEnableResult,
  parseBlindApplyEvidence,
  parseBlindApplyFeed,
  parseBlindApplyOpenResult,
  parseBlindApplyStatus,
  parseBlindApplyStopResult,
} from '../electron/blind-apply-parse.js';
import { BLIND_APPLY_STATE_LABELS } from '../electron/blind-apply-types.js';

/** The preload's readers fail closed: a malformed reply can never look like a success. */
describe('Blind Apply preload parsers', () => {
  it('reads anything unrecognisable as "not active, nothing to show"', () => {
    for (const bad of [null, undefined, 'x', 42, [], { active: 'yes' }]) {
      const status = parseBlindApplyStatus(bad);
      expect(status.active).toBe(false);
      expect(status.authorization).toBeNull();
      expect(status.paused).toBeNull();
      expect(Object.values(status.counts).every((count) => count === 0)).toBe(true);
    }
    expect(parseBlindApplyFeed({ not: 'a list' })).toEqual([]);
    expect(parseBlindApplyEnableResult(undefined)).toEqual({ ok: false, reason: 'declined' });
    expect(parseBlindApplyStopResult(null)).toEqual({ stopped: false, itemsStopped: 0 });
    expect(parseBlindApplyAnswerResult('ok')).toEqual({ ok: false, reason: 'not_waiting' });
    expect(parseBlindApplyOpenResult({ ok: true })).toEqual({ ok: false, reason: 'not_openable' });
  });

  it('is only active when an authorization comes with it', () => {
    expect(parseBlindApplyStatus({ active: true }).active).toBe(false);
    const status = parseBlindApplyStatus({
      active: true,
      authorization: { createdAt: 't', roleFamilies: ['frontend'], filters: ['a', 3], cvName: null },
      counts: { submitted: 3, skipped: -1, nonsense: 9 },
      supported: { real: ['A'], testOnly: [] },
    });
    expect(status).toMatchObject({ active: true, authorization: { filters: ['a'] }, counts: { submitted: 3, skipped: 0 }, supported: { real: ['A'] } });
    expect('nonsense' in status.counts).toBe(false);
  });

  it('drops items in an unknown state and derives the label from the state, never from the reply', () => {
    const feed = parseBlindApplyFeed([
      { id: 'a', state: 'submitted', label: 'Totally fine, honest', company: 'C', role: 'R' },
      { id: 'b', state: 'teleported', company: 'C', role: 'R' },
      { state: 'submitted' },
      { id: 'c', state: 'needs_you', intervention: 'wizardry', open: 'elsewhere', company: 'C', role: 'R' },
    ]);
    expect(feed.map((item) => item.id)).toEqual(['a', 'c']);
    expect(feed[0]?.label).toBe(BLIND_APPLY_STATE_LABELS.submitted);
    expect(feed[1]).toMatchObject({ intervention: null, open: null });
  });

  it('keeps only well-formed missing fields', () => {
    const [item] = parseBlindApplyFeed([
      { id: 'a', state: 'needs_answer', company: 'C', role: 'R', missingFields: [{ label: 'Q', controlType: 'select', options: ['x', 1], optionSetHash: 'h' }, { label: 'Bad', controlType: 'file' }, 'nope'] },
    ]);
    expect(item?.missingFields).toEqual([{ label: 'Q', controlType: 'select', options: ['x'], optionSetHash: 'h' }]);
  });

  it('evidence must answer for the item that was asked about', () => {
    expect(parseBlindApplyEvidence({ itemId: 'other', gate: {} }, 'wanted')).toBeNull();
    const evidence = parseBlindApplyEvidence({ itemId: 'wanted', gate: { filters: 'maybe', duplicateCheck: 'duplicate' }, answers: [{ label: 'x', provenance: 'invented' }], events: [], receipt: null }, 'wanted');
    expect(evidence).toMatchObject({ itemId: 'wanted', gate: { filters: 'unknown', duplicateCheck: 'duplicate' }, answers: [], receipt: null });
  });

  it('an open result needs its ids to count as success', () => {
    expect(parseBlindApplyOpenResult({ ok: true, kind: 'review', attemptId: 'a' })).toEqual({ ok: true, kind: 'review', attemptId: 'a' });
    expect(parseBlindApplyOpenResult({ ok: true, kind: 'apply_yourself', attemptId: 'a' })).toEqual({ ok: false, reason: 'not_openable' });
    expect(parseBlindApplyOpenResult({ ok: true, kind: 'apply_yourself', attemptId: 'a', savedJobId: 's' })).toMatchObject({ ok: true, kind: 'apply_yourself' });
  });
});
