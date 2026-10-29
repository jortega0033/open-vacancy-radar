/**
 * #692: the rules behind local due actions, as pure functions. No Node, Electron or database import:
 * the main process validates with them at the IPC/store boundary and the renderer shows the result with
 * the very same code, so what a person is told is what was stored.
 *
 * Time model (stated once, enforced here):
 *  - A due moment is ALWAYS tied to a named IANA time zone. The machine's zone is only what the form
 *    proposes; nothing is ever re-read in another zone later, so a laptop that travels or restarts never
 *    moves a stored action.
 *  - `date`: a calendar date in that zone. It is overdue only after that day has ended there. No time of
 *    day is invented for it.
 *  - `datetime`: a wall-clock time in that zone. A time that does not exist (spring-forward gap) is
 *    refused, never shifted. A time that happens twice (fall-back fold) is refused until the person
 *    says which one they mean.
 *  - `dueAt` (UTC) is the single value overdue is judged against.
 */

export const ACTION_KINDS = ['follow_up', 'thank_you', 'send_information', 'prepare', 'other'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_CHANNELS = ['email', 'phone', 'linkedin', 'portal', 'in_person', 'other', 'unspecified'] as const;
export type ActionChannel = (typeof ACTION_CHANNELS)[number];
export const ACTION_STATES = ['open', 'completed', 'dismissed'] as const;
export type ActionState = (typeof ACTION_STATES)[number];
export const DUE_KINDS = ['date', 'datetime'] as const;
export type DueKind = (typeof DUE_KINDS)[number];
export const AMBIGUITY_CHOICES = ['earlier', 'later'] as const;
export type AmbiguityChoice = (typeof AMBIGUITY_CHOICES)[number];
export const ACTION_ORIGINS = ['user', 'suggestion_accepted'] as const;
export type ActionOrigin = (typeof ACTION_ORIGINS)[number];

export const ACTION_KIND_LABEL: Record<ActionKind, string> = {
  follow_up: 'Follow up',
  thank_you: 'Thank you note',
  send_information: 'Send information',
  prepare: 'Prepare',
  other: 'Other',
};
export const ACTION_CHANNEL_LABEL: Record<ActionChannel, string> = {
  email: 'Email',
  phone: 'Phone',
  linkedin: 'LinkedIn',
  portal: 'Employer portal',
  in_person: 'In person',
  other: 'Other',
  unspecified: 'Not set',
};

export const ACTION_LIMITS = {
  titleChars: 120,
  noteChars: 1000,
  contactChars: 200,
  perApplication: 100,
  draftSubjectChars: 200,
  draftBodyChars: 8000,
} as const;

export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/* ------------------------------------------------------------------------- parsing ----- */

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}
export interface WallTime extends CalendarDate {
  hour: number;
  minute: number;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A real calendar date `YYYY-MM-DD` inside the supported years, or null. */
export function parseCalendarDate(value: unknown): CalendarDate | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  return { year, month, day };
}

/** A real wall-clock time `YYYY-MM-DDTHH:mm`, or null. Seconds, offsets and `Z` are refused. */
export function parseWallTime(value: unknown): WallTime | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = parseCalendarDate(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!date || hour > 23 || minute > 59) return null;
  return { ...date, hour, minute };
}

const zoneCache = new Map<string, string | null>();

/**
 * The canonical IANA name of a zone, or null. Offsets ("+02:00"), abbreviations ("CET") and anything
 * that is not a region name are refused: they do not say how a date behaves across daylight saving.
 */
export function canonicalZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return null;
  const cached = zoneCache.get(zone);
  if (cached !== undefined) return cached;
  let result: string | null = null;
  if (/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone) && (zone === 'UTC' || zone.includes('/'))) {
    try {
      const resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
      // Only the letter case is normalised. A link name the person picked (Asia/Kolkata) is kept as named,
      // because the engine's own canonical spelling for it (Asia/Calcutta) varies between versions.
      result = resolved.toLowerCase() === zone.toLowerCase() ? resolved : zone;
    } catch {
      result = null;
    }
  }
  zoneCache.set(zone, result);
  return result;
}

/** The machine's current zone as the form's default proposal. Null when it cannot be named. */
export function systemZone(): string | null {
  try {
    return canonicalZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ zone maths ----- */

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The wall clock in `zone` at an instant, as parts. */
export function wallPartsAt(instantMs: number, zone: string): WallTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter(zone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** The UTC offset of `zone` at an instant, in minutes (positive = east of UTC). */
export function offsetMinutesAt(instantMs: number, zone: string): number {
  const wall = wallPartsAt(instantMs, zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / MINUTE_MS);
}

export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export interface WallCandidate {
  choice: AmbiguityChoice | 'only';
  instantMs: number;
  offsetMinutes: number;
}

/** Every instant at which `zone`'s clock shows this wall time: none (gap), one, or two (fold). */
export function wallCandidates(wall: WallTime, zone: string): WallCandidate[] {
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsets = [...new Set([offsetMinutesAt(wallAsUtc - DAY_MS, zone), offsetMinutesAt(wallAsUtc + DAY_MS, zone)])];
  const found = offsets
    .map((offsetMinutes) => ({ offsetMinutes, instantMs: wallAsUtc - offsetMinutes * MINUTE_MS }))
    .filter((candidate) => offsetMinutesAt(candidate.instantMs, zone) === candidate.offsetMinutes)
    .sort((a, b) => a.instantMs - b.instantMs);
  if (found.length === 1) return [{ choice: 'only', ...found[0]! }];
  return found.map((candidate, index) => ({ choice: index === 0 ? 'earlier' : 'later', ...candidate }));
}

/** The first instant of a calendar day in a zone (a day that begins in a gap begins at the jump). */
export function startOfLocalDay(date: CalendarDate, zone: string): number {
  const wall: WallTime = { ...date, hour: 0, minute: 0 };
  const candidates = wallCandidates(wall, zone);
  if (candidates.length > 0) return candidates[0]!.instantMs;
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day);
  return wallAsUtc - offsetMinutesAt(wallAsUtc - DAY_MS, zone) * MINUTE_MS;
}

function nextDay(date: CalendarDate): CalendarDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day) + DAY_MS);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
export const formatCalendarDate = (date: CalendarDate): string => `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
export const formatWallTime = (wall: WallTime): string => `${formatCalendarDate(wall)}T${pad(wall.hour)}:${pad(wall.minute)}`;

/** The calendar date it is in `zone` right now. */
export function localDateAt(instantMs: number, zone: string): string {
  return formatCalendarDate(wallPartsAt(instantMs, zone));
}

/* ------------------------------------------------------------------------- due input ----- */

export type DueInput =
  | { kind: 'date'; date: string; timeZone: string }
  | { kind: 'datetime'; local: string; timeZone: string; ambiguity?: AmbiguityChoice };

export const DUE_ISSUES = [
  'invalid_date',
  'invalid_time',
  'invalid_timezone',
  'nonexistent_local_time',
  'ambiguous_local_time',
] as const;
export type DueIssueCode = (typeof DUE_ISSUES)[number];

export const DUE_ISSUE_MESSAGE: Record<DueIssueCode, string> = {
  invalid_date: 'That is not a real calendar date between 2000 and 2100. Use the format YYYY-MM-DD.',
  invalid_time: 'That is not a real time of day. Use the format YYYY-MM-DDTHH:mm.',
  invalid_timezone: 'That is not a named time zone. Pick a region such as Europe/Amsterdam; offsets and abbreviations are not accepted.',
  nonexistent_local_time: 'That time does not exist in this time zone on that day because the clocks skip it. Pick a different time.',
  ambiguous_local_time: 'That time happens twice in this time zone on that day because the clocks go back. Say which one you mean.',
};

export interface ResolvedDue {
  dueKind: DueKind;
  dueDate: string | null;
  dueLocal: string | null;
  dueTimeZone: string;
  dueUtcOffsetMinutes: number | null;
  dueResolution: 'unique' | 'earlier' | 'later' | null;
  /** UTC milliseconds: the instant after which an open action is overdue. */
  dueAt: number;
}

export type DueResult =
  | { ok: true; due: ResolvedDue }
  | {
      ok: false;
      code: DueIssueCode;
      options?: Array<{ choice: AmbiguityChoice; instantMs: number; offsetMinutes: number }>;
    };

export function resolveDue(input: DueInput): DueResult {
  const zone = canonicalZone(input.timeZone);
  if (!zone) return { ok: false, code: 'invalid_timezone' };
  if (input.kind === 'date') {
    const date = parseCalendarDate(input.date);
    if (!date) return { ok: false, code: 'invalid_date' };
    return {
      ok: true,
      due: {
        dueKind: 'date',
        dueDate: formatCalendarDate(date),
        dueLocal: null,
        dueTimeZone: zone,
        dueUtcOffsetMinutes: null,
        dueResolution: null,
        dueAt: startOfLocalDay(nextDay(date), zone),
      },
    };
  }
  const wall = parseWallTime(input.local);
  if (!wall) return { ok: false, code: 'invalid_time' };
  const candidates = wallCandidates(wall, zone);
  if (candidates.length === 0) return { ok: false, code: 'nonexistent_local_time' };
  let chosen = candidates[0]!;
  let resolution: 'unique' | 'earlier' | 'later' = 'unique';
  if (candidates.length > 1) {
    if (input.ambiguity !== 'earlier' && input.ambiguity !== 'later') {
      return {
        ok: false,
        code: 'ambiguous_local_time',
        options: candidates.map((candidate) => ({
          choice: candidate.choice as AmbiguityChoice,
          instantMs: candidate.instantMs,
          offsetMinutes: candidate.offsetMinutes,
        })),
      };
    }
    resolution = input.ambiguity;
    chosen = candidates[input.ambiguity === 'earlier' ? 0 : 1]!;
  }
  return {
    ok: true,
    due: {
      dueKind: 'datetime',
      dueDate: null,
      dueLocal: formatWallTime(wall),
      dueTimeZone: zone,
      dueUtcOffsetMinutes: chosen.offsetMinutes,
      dueResolution: resolution,
      dueAt: chosen.instantMs,
    },
  };
}

export function sameDue(a: ResolvedDue, b: ResolvedDue): boolean {
  return (
    a.dueKind === b.dueKind &&
    a.dueDate === b.dueDate &&
    a.dueLocal === b.dueLocal &&
    a.dueTimeZone === b.dueTimeZone &&
    a.dueUtcOffsetMinutes === b.dueUtcOffsetMinutes &&
    a.dueAt === b.dueAt
  );
}

/* ------------------------------------------------------------------- due state & text ----- */

export interface DueFields {
  state: ActionState;
  dueKind: DueKind;
  dueDate: string | null;
  dueLocal: string | null;
  dueTimeZone: string;
  /** UTC milliseconds. */
  dueAtMs: number;
}

export type DueState = 'overdue' | 'due_today' | 'upcoming' | 'closed';

/** Open actions are judged against `dueAt`; "today" is the due day in the action's own zone. */
export function dueStateOf(action: DueFields, nowMs: number): DueState {
  if (action.state !== 'open') return 'closed';
  if (nowMs >= action.dueAtMs) return 'overdue';
  const dueDay = action.dueKind === 'date' ? action.dueDate : action.dueLocal?.slice(0, 10);
  return dueDay && localDateAt(nowMs, action.dueTimeZone) === dueDay ? 'due_today' : 'upcoming';
}

function formatIn(instantMs: number, zone: string, locale: string | undefined, withTime: boolean): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
  }).format(new Date(instantMs));
}

export interface DueText {
  /** "Fri, 6 Nov 2026, 09:30 Europe/Amsterdam (UTC+01:00)" or "Fri, 6 Nov 2026 (whole day, Europe/Amsterdam)". */
  primary: string;
  /** The same moment in the viewer's zone when it differs; null otherwise (and always null for a whole day). */
  viewerLocal: string | null;
}

export function describeDue(
  action: DueFields & { dueUtcOffsetMinutes: number | null },
  viewerZone: string | null,
  locale?: string,
): DueText {
  if (action.dueKind === 'date') {
    const date = parseCalendarDate(action.dueDate);
    // A date is rendered from its own fields at noon UTC so no zone can shift the day shown.
    const shown = date
      ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(
          new Date(Date.UTC(date.year, date.month - 1, date.day, 12)),
        )
      : (action.dueDate ?? '');
    return { primary: `${shown} (whole day, ${action.dueTimeZone})`, viewerLocal: null };
  }
  // The stored due moment is the instant; the wall time is shown in the ORIGINAL zone.
  const offset = action.dueUtcOffsetMinutes ?? offsetMinutesAt(action.dueAtMs, action.dueTimeZone);
  const primary = `${formatIn(action.dueAtMs, action.dueTimeZone, locale, true)} ${action.dueTimeZone} (${offsetLabel(offset)})`;
  const viewer = viewerZone ? canonicalZone(viewerZone) : null;
  const viewerLocal =
    viewer && viewer !== action.dueTimeZone && offsetMinutesAt(action.dueAtMs, viewer) !== offset
      ? `${formatIn(action.dueAtMs, viewer, locale, true)} in your time zone (${viewer})`
      : null;
  return { primary, viewerLocal };
}

/* ------------------------------------------------------ submission basis & suggestions ----- */

export type ApplicationStatusValue =
  | 'preparing'
  | 'applied'
  | 'recruiter_screen'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'withdrawn';

export interface RowFacts {
  status: ApplicationStatusValue;
  archived: boolean;
  appliedAt: string | null;
  /** The newest linked pipeline attempt (`listApplications().attempt`), or null for a row entered by hand. */
  attempt: { checkpoint: string; evidence: 'user_reported' | 'receipt_confirmed' | null } | null;
}

/**
 * How a row's "sent" state is known. Kept apart on purpose:
 *  - `receipt_backed`  this app observed the employer's confirmation.
 *  - `user_reported`   the person told the app they applied.
 *  - `user_stated`     the person moved the status past "preparing" themselves.
 *  - `unconfirmed`     the app sent or tried to send but could not tell what happened.
 *  - `prepared`        a package exists but nothing records it as sent (draft, preparing, ready,
 *                      failed, skipped; also what a handoff-only row looks like).
 *  - `not_recorded`    nothing at all.
 * Opening the employer page is not evidence of any of these.
 */
export const SUBMISSION_CLASSES = ['receipt_backed', 'user_reported', 'user_stated', 'unconfirmed', 'prepared', 'not_recorded'] as const;
export type SubmissionClass = (typeof SUBMISSION_CLASSES)[number];

export const SUBMISSION_CLASS_LABEL: Record<SubmissionClass, string> = {
  receipt_backed: 'Sent. This app saw the employer confirmation.',
  user_reported: 'Sent, as you reported. This app did not see a confirmation.',
  user_stated: 'Marked as applied by you.',
  unconfirmed: 'This app could not confirm whether it was sent.',
  prepared: 'Prepared, but not recorded as sent.',
  not_recorded: 'Nothing is recorded as sent.',
};

export function classifySubmission(row: RowFacts): SubmissionClass {
  const attempt = row.attempt;
  if (attempt?.checkpoint === 'submitted' && attempt.evidence === 'receipt_confirmed') return 'receipt_backed';
  if (attempt?.checkpoint === 'user_reported') return 'user_reported';
  if (attempt?.checkpoint === 'submitted' || attempt?.checkpoint === 'submission_unknown') {
    return row.status !== 'preparing' ? 'user_stated' : 'unconfirmed';
  }
  if (row.status !== 'preparing') return 'user_stated';
  return attempt ? 'prepared' : 'not_recorded';
}

export const TERMINAL_STATUSES: ReadonlySet<ApplicationStatusValue> = new Set(['offer', 'rejected', 'withdrawn']);

export const SUGGESTION_REASONS = [
  'eligible',
  'archived',
  'suppressed',
  'terminal',
  'in_conversation',
  'not_submitted',
  'unknown_submission',
  'has_open_action',
] as const;
export type SuggestionReason = (typeof SUGGESTION_REASONS)[number];

export interface Suggestion {
  eligible: boolean;
  reason: SuggestionReason;
}

/**
 * Whether to offer "Plan a follow-up" on a row. There is deliberately NO day count: the app does not
 * decide when a person should chase. It only declines to offer the prompt where it would be wrong:
 * not sent, not known to be sent, already in conversation, finished, archived, silenced by the person,
 * or already covered by an open action. Silence is never treated as a rejection.
 */
export function followUpSuggestion(row: RowFacts, context: { suppressed: boolean; openActions: number }): Suggestion {
  const no = (reason: SuggestionReason): Suggestion => ({ eligible: false, reason });
  if (row.archived) return no('archived');
  if (TERMINAL_STATUSES.has(row.status)) return no('terminal');
  if (context.suppressed) return no('suppressed');
  const sent = classifySubmission(row);
  if (sent === 'unconfirmed') return no('unknown_submission');
  if (sent === 'prepared' || sent === 'not_recorded' || row.status === 'preparing') return no('not_submitted');
  if (row.status !== 'applied') return no('in_conversation');
  if (context.openActions > 0) return no('has_open_action');
  return { eligible: true, reason: 'eligible' };
}

export const SUGGESTION_LINE: Record<SuggestionReason, string> = {
  eligible: 'This app has no record of a reply. Plan a follow-up if you want one; you choose when.',
  archived: 'Archived.',
  suppressed: 'You turned off follow-up suggestions for this application.',
  terminal: 'This application has a final outcome, so no follow-up is suggested.',
  in_conversation: 'A conversation has started, so no follow-up is suggested.',
  not_submitted: 'Nothing is recorded as sent, so no follow-up is suggested.',
  unknown_submission: 'This app could not confirm it was sent, so no follow-up is suggested.',
  has_open_action: 'A follow-up is already planned.',
};

/* ------------------------------------------------------------------- open-action summary ----- */

export interface OpenActionFacts extends DueFields {
  id: string;
}

export interface OpenSummary {
  open: number;
  overdue: number;
  dueToday: number;
  /** The open action due first (overdue ones first), or null. */
  next: { id: string; state: Exclude<DueState, 'closed'> } | null;
}

export function summarizeOpenActions(actions: readonly OpenActionFacts[], nowMs: number): OpenSummary {
  const open = actions.filter((action) => action.state === 'open').sort((a, b) => a.dueAtMs - b.dueAtMs);
  const states = open.map((action) => ({ id: action.id, state: dueStateOf(action, nowMs) as Exclude<DueState, 'closed'> }));
  const first = states[0];
  return {
    open: open.length,
    overdue: states.filter((entry) => entry.state === 'overdue').length,
    dueToday: states.filter((entry) => entry.state === 'due_today').length,
    next: first ? { id: first.id, state: first.state } : null,
  };
}

/** The derived one-line summary for a row. It is NEVER written to `nextStep`; that stays the person's own text. */
export function actionSummaryLine(summary: OpenSummary): string | null {
  if (summary.open === 0) return null;
  const parts: string[] = [];
  if (summary.overdue > 0) parts.push(`${summary.overdue} overdue`);
  if (summary.dueToday > 0) parts.push(`${summary.dueToday} due today`);
  const upcoming = summary.open - summary.overdue - summary.dueToday;
  if (upcoming > 0) parts.push(`${upcoming} upcoming`);
  return parts.join(', ');
}

/* ---------------------------------------------------------------------- follow-up basis ----- */

/**
 * What a follow-up draft was written from, stored with the draft so the label never changes later.
 * `submitted_package`: the #691 package resolved to one recorded submission. `current_context`: no
 * unique recorded package, so the CURRENT linked documents and row facts were used and the draft says so.
 */
export interface FollowUpDraftBasis {
  mode: 'submitted_package' | 'current_context';
  label: string;
  submissionClass: SubmissionClass;
  packageId: string | null;
  packageVersion: number | null;
  manifestHash: string | null;
  documents: Array<{ slot: 'cv' | 'letter'; provenance: string; version: number | null }>;
  /** Hash of the facts the draft was generated from; a late result is discarded when this has moved. */
  factsHash: string;
}