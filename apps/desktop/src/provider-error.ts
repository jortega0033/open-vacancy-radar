import type { ProviderId } from '@agent-dock/shared';

/**
 * One boundary for what a failed AI run means (#461). A provider CLI reports a usage limit, a
 * missing sign-in and a crash through the same free-text channel; the renderer decides what to
 * offer from the kind returned here and nowhere else.
 *
 * A reset time is parsed only from an explicit "resets <clock time>" phrase, and only turned into
 * an instant when it is unambiguous (no time zone named, or the zone is this machine's). Anything
 * less leaves `resetAt` undefined: the notice then names no time rather than guessing one.
 */
export type ProviderErrorKind = 'usage_limit' | 'not_signed_in' | 'unavailable' | 'other';

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  /** The reset time exactly as the provider wrote it, e.g. "12:10pm (Europe/Amsterdam)". */
  resetLabel?: string;
  /** Epoch ms, only when the clock time could be placed with confidence. */
  resetAt?: number;
  /** The raw message with home-folder paths shortened, for the Details disclosure. */
  details: string;
}

const LIMIT_PATTERNS = [
  /\b(?:session|usage|weekly|daily|monthly|5-hour|five-hour|rate)[- ]limit\b/i,
  /\bhit your (?:\w+ )?limit\b/i,
  /\breached (?:your|the|its) (?:\w+ )?(?:usage )?limit\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
  /\btoo many requests\b/i,
  /\b429\b/,
];
const AUTH_PATTERNS = [
  /not (?:logged|signed) in/i,
  /\b(?:please|run|try) .*\blogin\b/i,
  /\bauthenticat(?:e|ion)\b.*\b(?:required|failed|expired)\b/i,
  /\b(?:invalid|missing|expired) (?:api key|credentials|token)\b/i,
  /\bunauthori[sz]ed\b/i,
];
const UNAVAILABLE_PATTERNS = [
  /\bnot installed\b/i,
  /\bcommand not found\b/i,
  /\bENOENT\b/,
  /\bspawn .* (?:failed|ENOENT)\b/i,
  /\bcould not (?:start|launch)\b/i,
  /\b(?:daemon|helper) (?:is )?(?:not running|unavailable)\b/i,
];

/** "resets 12:10pm (Europe/Amsterdam)", "resets at 5 PM", "reset at 17:30". Needs a colon or am/pm. */
const RESET_PATTERN = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i;

/**
 * Replaces the profile folder in home paths with `~`. The folder name may contain spaces
 * ("Jane Doe"), so it runs to the next path separator, quote or line end rather than to whitespace.
 */
export function redactHomePaths(text: string): string {
  return text
    .replace(/\/(?:Users|home)\/[^/\r\n"'<>`]+/g, '~')
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n"'<>`]+/g, '~');
}

function localTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function parseReset(message: string, now: Date): Pick<ProviderErrorInfo, 'resetLabel' | 'resetAt'> {
  const match = RESET_PATTERN.exec(message);
  if (!match) return {};
  const [whole, hourText, minuteText, meridiemText, zone] = match;
  const hasMeridiem = meridiemText !== undefined;
  // A bare "resets 12" could be anything; require a colon or am/pm before trusting a clock time.
  if (minuteText === undefined && !hasMeridiem) return {};
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return {};
  if (hasMeridiem) {
    if (hour < 1 || hour > 12) return {};
    const pm = meridiemText.toLowerCase().startsWith('p');
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (hour > 23) {
    return {};
  }
  const label = whole.replace(/^resets?\s+(?:at\s+)?/i, '').trim();
  const sameZone = zone === undefined || zone === localTimeZone();
  if (!sameZone) return { resetLabel: label };
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return { resetLabel: label, resetAt: at.getTime() };
}

export function classifyProviderError(raw: string, now: Date = new Date()): ProviderErrorInfo {
  const details = redactHomePaths(raw.trim());
  if (LIMIT_PATTERNS.some((pattern) => pattern.test(raw))) {
    return { kind: 'usage_limit', ...parseReset(raw, now), details };
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(raw))) return { kind: 'not_signed_in', details };
  if (UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(raw))) return { kind: 'unavailable', details };
  return { kind: 'other', details };
}

export type { ProviderId };
