import {
  ACTION_CHANNELS,
  ACTION_KINDS,
  localDateAt,
  systemZone,
  wallPartsAt,
  type ActionChannel,
  type ActionKind,
  type AmbiguityChoice,
} from '../../../electron/application-actions-core.js';
import type { ActionView, DueRequest } from '../../../electron/application-actions-types.js';

/**
 * The follow-up form as plain data, so the page and its tests share one definition of how what a
 * person typed becomes a request. The zone is always part of the request: the form proposes the
 * machine's zone but the person sees it, can change it, and the wire never leaves it implicit.
 */

export interface ActionForm {
  kind: ActionKind;
  title: string;
  note: string;
  channel: ActionChannel;
  contactDetail: string;
  dueMode: 'date' | 'datetime';
  date: string;
  time: string;
  timeZone: string;
  ambiguity: AmbiguityChoice | null;
}

export const KIND_OPTIONS: readonly ActionKind[] = ACTION_KINDS;
export const CHANNEL_OPTIONS: readonly ActionChannel[] = ACTION_CHANNELS;

/** A blank form: today in the machine's zone, whole-day, nothing chosen for the person. */
export function emptyForm(nowMs: number, kind: ActionKind = 'follow_up'): ActionForm {
  const timeZone = systemZone() ?? 'UTC';
  return {
    kind,
    title: '',
    note: '',
    channel: 'unspecified',
    contactDetail: '',
    dueMode: 'date',
    date: localDateAt(nowMs, timeZone),
    time: '09:00',
    timeZone,
    ambiguity: null,
  };
}

export function formFromAction(action: ActionView): ActionForm {
  const wall = action.dueKind === 'datetime' && action.dueLocal ? action.dueLocal : null;
  return {
    kind: action.kind,
    title: action.title,
    note: action.note,
    channel: action.channel,
    contactDetail: action.contactDetail,
    dueMode: action.dueKind,
    date: action.dueKind === 'date' ? (action.dueDate ?? '') : (wall?.slice(0, 10) ?? ''),
    time: wall ? wall.slice(11, 16) : '09:00',
    timeZone: action.dueTimeZone,
    ambiguity: action.dueResolution === 'earlier' || action.dueResolution === 'later' ? action.dueResolution : null,
  };
}

export function toDueRequest(form: ActionForm): DueRequest {
  return form.dueMode === 'date'
    ? { kind: 'date', date: form.date, timeZone: form.timeZone.trim() }
    : {
        kind: 'datetime',
        local: `${form.date}T${form.time}`,
        timeZone: form.timeZone.trim(),
        ...(form.ambiguity ? { ambiguity: form.ambiguity } : {}),
      };
}

export function toFields(form: ActionForm) {
  return {
    kind: form.kind,
    title: form.title.trim(),
    note: form.note.trim(),
    channel: form.channel,
    contactDetail: form.contactDetail.trim(),
  };
}

/** The region names this engine knows, for the zone picker. Empty when the engine cannot list them. */
export function knownZones(extra: readonly string[]): string[] {
  let listed: string[];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    listed = supported ? supported('timeZone') : [];
  } catch {
    listed = [];
  }
  return [...new Set([...extra.filter(Boolean), ...listed, 'UTC'])].sort((a, b) => a.localeCompare(b));
}

/** "09:30" in a zone at an instant, for the earlier/later choice of a repeated hour. */
export function clockIn(instantIso: string, zone: string): string {
  const parts = wallPartsAt(Date.parse(instantIso), zone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}
