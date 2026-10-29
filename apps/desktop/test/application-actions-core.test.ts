// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  actionSummaryLine,
  canonicalZone,
  classifySubmission,
  describeDue,
  dueStateOf,
  followUpSuggestion,
  offsetMinutesAt,
  parseCalendarDate,
  parseWallTime,
  resolveDue,
  summarizeOpenActions,
  type DueFields,
  type RowFacts,
} from '../electron/application-actions-core.js';

const iso = (value: string): number => Date.parse(value);

describe('calendar and wall-clock parsing', () => {
  it('accepts only real dates in the supported years', () => {
    expect(parseCalendarDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseCalendarDate('2028-02-29')).not.toBeNull();
    for (const bad of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-10', '1999-12-31', '2101-01-01', '2026-1-1', '2026-01-01T00:00', '', 5, null]) {
      expect(parseCalendarDate(bad)).toBeNull();
    }
  });

  it('accepts only YYYY-MM-DDTHH:mm wall times', () => {
    expect(parseWallTime('2026-11-06T09:30')).toMatchObject({ hour: 9, minute: 30 });
    for (const bad of ['2026-11-06T24:00', '2026-11-06T09:60', '2026-11-06T09:30:00', '2026-11-06T09:30Z', '2026-11-06 09:30', '2026-02-30T09:30']) {
      expect(parseWallTime(bad)).toBeNull();
    }
  });

  it('accepts region names and refuses offsets, abbreviations and junk', () => {
    expect(canonicalZone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
    expect(canonicalZone('UTC')).toBe('UTC');
    for (const bad of ['', 'CET', 'EST', '+02:00', 'UTC+2', 'GMT+2', 'Mars/Olympus', 'Europe/Amsterdam; drop', 5, null, 'a'.repeat(80)]) {
      expect(canonicalZone(bad)).toBeNull();
    }
  });
});

describe('daylight saving boundaries are explicit, never guessed', () => {
  it('refuses a wall time the clocks skip (spring forward) in Amsterdam and New York', () => {
    expect(resolveDue({ kind: 'datetime', local: '2026-03-29T02:30', timeZone: 'Europe/Amsterdam' })).toMatchObject({
      ok: false,
      code: 'nonexistent_local_time',
    });
    expect(resolveDue({ kind: 'datetime', local: '2026-03-08T02:30', timeZone: 'America/New_York' })).toMatchObject({
      ok: false,
      code: 'nonexistent_local_time',
    });
    // The minute before and the minute after the jump both exist.
    expect(resolveDue({ kind: 'datetime', local: '2026-03-29T01:59', timeZone: 'Europe/Amsterdam' }).ok).toBe(true);
    expect(resolveDue({ kind: 'datetime', local: '2026-03-29T03:00', timeZone: 'Europe/Amsterdam' }).ok).toBe(true);
  });

  it('handles a half-hour gap (Lord Howe)', () => {
    expect(resolveDue({ kind: 'datetime', local: '2026-10-04T02:15', timeZone: 'Australia/Lord_Howe' })).toMatchObject({
      ok: false,
      code: 'nonexistent_local_time',
    });
    expect(resolveDue({ kind: 'datetime', local: '2026-10-04T02:30', timeZone: 'Australia/Lord_Howe' }).ok).toBe(true);
  });

  it('refuses an ambiguous wall time until the person says which, then records the choice', () => {
    const asked = resolveDue({ kind: 'datetime', local: '2026-10-25T02:30', timeZone: 'Europe/Amsterdam' });
    expect(asked).toMatchObject({ ok: false, code: 'ambiguous_local_time' });
    if (asked.ok || !asked.options) throw new Error('expected options');
    expect(asked.options.map((option) => [option.choice, new Date(option.instantMs).toISOString(), option.offsetMinutes])).toEqual([
      ['earlier', '2026-10-25T00:30:00.000Z', 120],
      ['later', '2026-10-25T01:30:00.000Z', 60],
    ]);

    const earlier = resolveDue({ kind: 'datetime', local: '2026-10-25T02:30', timeZone: 'Europe/Amsterdam', ambiguity: 'earlier' });
    const later = resolveDue({ kind: 'datetime', local: '2026-10-25T02:30', timeZone: 'Europe/Amsterdam', ambiguity: 'later' });
    expect(earlier).toMatchObject({ ok: true, due: { dueAt: iso('2026-10-25T00:30:00Z'), dueUtcOffsetMinutes: 120, dueResolution: 'earlier' } });
    expect(later).toMatchObject({ ok: true, due: { dueAt: iso('2026-10-25T01:30:00Z'), dueUtcOffsetMinutes: 60, dueResolution: 'later' } });

    expect(resolveDue({ kind: 'datetime', local: '2026-11-01T01:30', timeZone: 'America/New_York' })).toMatchObject({ code: 'ambiguous_local_time' });
    expect(resolveDue({ kind: 'datetime', local: '2026-04-05T01:45', timeZone: 'Australia/Lord_Howe' })).toMatchObject({ code: 'ambiguous_local_time' });
  });

  it('does not ask about ambiguity on an ordinary time, and ignores a needless choice', () => {
    const plain = resolveDue({ kind: 'datetime', local: '2026-11-06T09:30', timeZone: 'Europe/Amsterdam', ambiguity: 'later' });
    expect(plain).toMatchObject({ ok: true, due: { dueAt: iso('2026-11-06T08:30:00Z'), dueUtcOffsetMinutes: 60, dueResolution: 'unique' } });
  });

  it('keeps the zone the person named, whatever zone this machine is in', () => {
    const tokyo = resolveDue({ kind: 'datetime', local: '2026-11-06T09:30', timeZone: 'Asia/Tokyo' });
    const kolkata = resolveDue({ kind: 'datetime', local: '2026-11-06T09:30', timeZone: 'Asia/Kolkata' });
    expect(tokyo).toMatchObject({ ok: true, due: { dueTimeZone: 'Asia/Tokyo', dueAt: iso('2026-11-06T00:30:00Z') } });
    expect(kolkata).toMatchObject({ ok: true, due: { dueTimeZone: 'Asia/Kolkata', dueAt: iso('2026-11-06T04:00:00Z') } });
  });

  it('reports precise issues for malformed requests', () => {
    expect(resolveDue({ kind: 'date', date: '2026-02-30', timeZone: 'UTC' })).toMatchObject({ code: 'invalid_date' });
    expect(resolveDue({ kind: 'datetime', local: '2026-11-06T25:00', timeZone: 'UTC' })).toMatchObject({ code: 'invalid_time' });
    expect(resolveDue({ kind: 'date', date: '2026-11-06', timeZone: 'CET' })).toMatchObject({ code: 'invalid_timezone' });
  });
});

describe('whole-day dates and UTC/local day boundaries', () => {
  it('a date is due until that day has ended IN ITS OWN ZONE', () => {
    const utc = resolveDue({ kind: 'date', date: '2026-11-06', timeZone: 'UTC' });
    const auckland = resolveDue({ kind: 'date', date: '2026-11-06', timeZone: 'Pacific/Auckland' });
    const honolulu = resolveDue({ kind: 'date', date: '2026-11-06', timeZone: 'Pacific/Honolulu' });
    if (!utc.ok || !auckland.ok || !honolulu.ok) throw new Error('expected valid dues');
    expect(new Date(utc.due.dueAt).toISOString()).toBe('2026-11-07T00:00:00.000Z');
    expect(new Date(auckland.due.dueAt).toISOString()).toBe('2026-11-06T11:00:00.000Z');
    expect(new Date(honolulu.due.dueAt).toISOString()).toBe('2026-11-07T10:00:00.000Z');

    const at = (zone: string, due: typeof utc.due) =>
      ({ state: 'open', dueKind: 'date', dueDate: '2026-11-06', dueLocal: null, dueTimeZone: zone, dueAtMs: due.dueAt }) as DueFields;
    const now = iso('2026-11-06T20:00:00Z');
    expect(dueStateOf(at('UTC', utc.due), now)).toBe('due_today');
    expect(dueStateOf(at('Pacific/Auckland', auckland.due), now)).toBe('overdue');
    expect(dueStateOf(at('Pacific/Honolulu', honolulu.due), now)).toBe('due_today');
    expect(dueStateOf(at('UTC', utc.due), iso('2026-11-07T00:00:00Z'))).toBe('overdue');
    expect(dueStateOf(at('UTC', utc.due), iso('2026-11-06T23:59:59Z'))).toBe('due_today');
    expect(dueStateOf(at('UTC', utc.due), iso('2026-11-05T23:59:59Z'))).toBe('upcoming');
  });

  it('a day that begins inside a gap begins at the jump (Sao Paulo, 2018-11-04)', () => {
    const due = resolveDue({ kind: 'date', date: '2018-11-03', timeZone: 'America/Sao_Paulo' });
    if (!due.ok) throw new Error('expected valid');
    // 2018-11-04 00:00 did not exist; the clocks jumped from 00:00 (-03:00) to 01:00 (-02:00) at 03:00Z.
    expect(new Date(due.due.dueAt).toISOString()).toBe('2018-11-04T03:00:00.000Z');
  });

  it('a 23-hour and a 25-hour day still end at local midnight', () => {
    const spring = resolveDue({ kind: 'date', date: '2026-03-29', timeZone: 'Europe/Amsterdam' });
    const fall = resolveDue({ kind: 'date', date: '2026-10-25', timeZone: 'Europe/Amsterdam' });
    if (!spring.ok || !fall.ok) throw new Error('expected valid');
    expect(new Date(spring.due.dueAt).toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(new Date(fall.due.dueAt).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('a timed action is overdue at the minute, not the day', () => {
    const due = resolveDue({ kind: 'datetime', local: '2026-11-06T09:30', timeZone: 'Europe/Amsterdam' });
    if (!due.ok) throw new Error('expected valid');
    const action = { state: 'open', dueKind: 'datetime', dueDate: null, dueLocal: due.due.dueLocal, dueTimeZone: 'Europe/Amsterdam', dueAtMs: due.due.dueAt } as DueFields;
    expect(dueStateOf(action, iso('2026-11-06T08:29:59Z'))).toBe('due_today');
    expect(dueStateOf(action, iso('2026-11-06T08:30:00Z'))).toBe('overdue');
    expect(dueStateOf(action, iso('2026-11-05T08:30:00Z'))).toBe('upcoming');
    expect(dueStateOf({ ...action, state: 'completed' }, iso('2027-01-01T00:00:00Z'))).toBe('closed');
  });
});

describe('how a due moment is shown', () => {
  it('names the zone and offset, and the viewer-local time only when it differs', () => {
    const due = resolveDue({ kind: 'datetime', local: '2026-11-06T09:30', timeZone: 'Europe/Amsterdam' });
    if (!due.ok) throw new Error('expected valid');
    const action = {
      state: 'open' as const,
      dueKind: 'datetime' as const,
      dueDate: null,
      dueLocal: due.due.dueLocal,
      dueTimeZone: 'Europe/Amsterdam',
      dueUtcOffsetMinutes: due.due.dueUtcOffsetMinutes,
      dueAtMs: due.due.dueAt,
    };
    const elsewhere = describeDue(action, 'America/New_York', 'en-GB');
    expect(elsewhere.primary).toContain('09:30');
    expect(elsewhere.primary).toContain('Europe/Amsterdam');
    expect(elsewhere.primary).toContain('UTC+01:00');
    expect(elsewhere.viewerLocal).toContain('America/New_York');
    expect(elsewhere.viewerLocal).toContain('03:30');
    expect(describeDue(action, 'Europe/Amsterdam', 'en-GB').viewerLocal).toBeNull();
    expect(describeDue(action, null, 'en-GB').viewerLocal).toBeNull();
  });

  it('a whole-day date is shown as a whole day in its zone, with no invented time', () => {
    const text = describeDue(
      { state: 'open', dueKind: 'date', dueDate: '2026-11-06', dueLocal: null, dueTimeZone: 'Pacific/Auckland', dueUtcOffsetMinutes: null, dueAtMs: iso('2026-11-06T11:00:00Z') },
      'America/New_York',
      'en-GB',
    );
    expect(text.primary).toBe('Fri, 6 Nov 2026 (whole day, Pacific/Auckland)');
    expect(text.viewerLocal).toBeNull();
  });

  it('offsets match the zone rules on either side of a change', () => {
    expect(offsetMinutesAt(iso('2026-03-29T00:59:59Z'), 'Europe/Amsterdam')).toBe(60);
    expect(offsetMinutesAt(iso('2026-03-29T01:00:00Z'), 'Europe/Amsterdam')).toBe(120);
  });
});

const row = (over: Partial<RowFacts> = {}): RowFacts => ({ status: 'applied', archived: false, appliedAt: '2026-10-12T09:00:00.000Z', attempt: null, ...over });

describe('what counts as sent, and when a follow-up is suggested', () => {
  it('keeps receipt-backed, reported, stated, unconfirmed, prepared and unrecorded apart', () => {
    expect(classifySubmission(row({ attempt: { checkpoint: 'submitted', evidence: 'receipt_confirmed' } }))).toBe('receipt_backed');
    expect(classifySubmission(row({ attempt: { checkpoint: 'user_reported', evidence: 'user_reported' } }))).toBe('user_reported');
    expect(classifySubmission(row())).toBe('user_stated');
    expect(classifySubmission(row({ status: 'preparing', attempt: { checkpoint: 'submission_unknown', evidence: null } }))).toBe('unconfirmed');
    expect(classifySubmission(row({ status: 'preparing', attempt: { checkpoint: 'submitted', evidence: null } }))).toBe('unconfirmed');
    for (const checkpoint of ['queued', 'tailoring', 'ready', 'needs_user', 'submitting', 'failed', 'skipped']) {
      expect(classifySubmission(row({ status: 'preparing', attempt: { checkpoint, evidence: null } }))).toBe('prepared');
    }
    expect(classifySubmission(row({ status: 'preparing' }))).toBe('not_recorded');
  });

  it('suggests only for a sent, still-quiet, live application with nothing planned', () => {
    const ctx = { suppressed: false, openActions: 0 };
    expect(followUpSuggestion(row(), ctx)).toEqual({ eligible: true, reason: 'eligible' });
    expect(followUpSuggestion(row({ attempt: { checkpoint: 'submitted', evidence: 'receipt_confirmed' } }), ctx).eligible).toBe(true);
    expect(followUpSuggestion(row({ attempt: { checkpoint: 'user_reported', evidence: 'user_reported' } }), ctx).eligible).toBe(true);
  });

  it('never treats draft, preparing, handoff-only or unconfirmed rows as unanswered submissions', () => {
    const ctx = { suppressed: false, openActions: 0 };
    expect(followUpSuggestion(row({ status: 'preparing' }), ctx).reason).toBe('not_submitted');
    expect(followUpSuggestion(row({ status: 'preparing', attempt: { checkpoint: 'ready', evidence: null } }), ctx).reason).toBe('not_submitted');
    expect(followUpSuggestion(row({ status: 'preparing', attempt: { checkpoint: 'needs_user', evidence: null } }), ctx).reason).toBe('not_submitted');
    expect(followUpSuggestion(row({ status: 'preparing', attempt: { checkpoint: 'submission_unknown', evidence: null } }), ctx).reason).toBe('unknown_submission');
  });

  it('stops for conversation, final outcomes, archive, the person switching it off, and an existing plan', () => {
    expect(followUpSuggestion(row({ status: 'recruiter_screen' }), { suppressed: false, openActions: 0 }).reason).toBe('in_conversation');
    expect(followUpSuggestion(row({ status: 'interview' }), { suppressed: false, openActions: 0 }).reason).toBe('in_conversation');
    for (const status of ['rejected', 'withdrawn', 'offer'] as const) {
      expect(followUpSuggestion(row({ status }), { suppressed: false, openActions: 0 }).reason).toBe('terminal');
    }
    expect(followUpSuggestion(row({ archived: true }), { suppressed: false, openActions: 0 }).reason).toBe('archived');
    expect(followUpSuggestion(row(), { suppressed: true, openActions: 0 }).reason).toBe('suppressed');
    expect(followUpSuggestion(row(), { suppressed: false, openActions: 1 }).reason).toBe('has_open_action');
  });

  it('has no cadence: a row applied just now and one applied long ago are treated alike', () => {
    const ctx = { suppressed: false, openActions: 0 };
    expect(followUpSuggestion(row({ appliedAt: '2026-10-29T10:00:00.000Z' }), ctx)).toEqual(followUpSuggestion(row({ appliedAt: '2025-01-01T10:00:00.000Z' }), ctx));
  });
});

describe('open-action summary', () => {
  it('counts overdue, due today and upcoming from the same state function', () => {
    const facts = (id: string, dueAtMs: number, dueDate: string): Parameters<typeof summarizeOpenActions>[0][number] => ({
      id,
      state: 'open',
      dueKind: 'date',
      dueDate,
      dueLocal: null,
      dueTimeZone: 'UTC',
      dueAtMs,
    });
    const now = iso('2026-11-06T12:00:00Z');
    const summary = summarizeOpenActions(
      [facts('late', iso('2026-11-05T00:00:00Z'), '2026-11-04'), facts('today', iso('2026-11-07T00:00:00Z'), '2026-11-06'), facts('later', iso('2026-11-10T00:00:00Z'), '2026-11-09')],
      now,
    );
    expect(summary).toEqual({ open: 3, overdue: 1, dueToday: 1, next: { id: 'late', state: 'overdue' } });
    expect(actionSummaryLine(summary)).toBe('1 overdue, 1 due today, 1 upcoming');
    expect(actionSummaryLine(summarizeOpenActions([], now))).toBeNull();
  });
});
