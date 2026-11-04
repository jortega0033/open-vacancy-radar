import type { PostingVerificationView } from '../../window.js';

/**
 * Plain wording for the live posting check (#687). Kept apart from the component so every state's
 * sentence is testable and so the wording promise is in one place: only a positive answer from the
 * posting's own job system is ever called "closed"; everything else that goes wrong is "could not
 * check", and says so.
 */

/** The detail sentences main writes when preparation stops on a finding. Compared against main's own
 * constants in a test, so the two cannot drift apart silently. */
export const POSTING_CLOSED_DETAIL =
  "This posting looks closed: the employer's own job system says it no longer exists. Open the posting to check, or get ready anyway.";
export const POSTING_CHANGED_DETAIL =
  'This posting changed since it was read. Review what changed, then refresh your application from the updated posting or keep what you have.';

/** What a preparation that stopped on a finding says once a later check found the posting open again. */
export const POSTING_REOPENED_DETAIL = 'The posting is open again, so this application can be prepared now.';

/** #720: preparation stopped before any AI work because nothing could confirm the posting is open. */
export const POSTING_UNVERIFIED_DETAIL =
  "We couldn't check automatically whether this posting is still open. Open the posting, and if it is still listed, confirm it's open to continue.";

export function isPostingFindingDetail(detail: string): boolean {
  return detail === POSTING_CLOSED_DETAIL || detail === POSTING_CHANGED_DETAIL;
}

/**
 * A stored sentence that belongs to a preparation which stopped on a posting finding. The notice
 * above it already says everything and owns the actions, so screens show no generic blocker, Details
 * or Resume of their own for it.
 */
export function isPostingPreparationStopDetail(detail: string): boolean {
  return isPostingFindingDetail(detail) || detail === POSTING_REOPENED_DETAIL || detail === POSTING_UNVERIFIED_DETAIL;
}

const SOURCE_LABEL: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workable: 'Workable',
  jobgether: 'Jobgether',
  ashby: 'Ashby',
};

/** The display name of a checking source, or null for none. */
export function postingSourceLabel(source: string | null): string | null {
  return source ? (SOURCE_LABEL[source] ?? source) : null;
}

/** An exact, local date and time for "How we know" (the relative "2 hours ago" stays in the default line). */
export function formatCheckedAt(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.valueOf()) ? at : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatCheckedAgo(checkedAt: string, now: Date): string {
  const elapsed = now.getTime() - Date.parse(checkedAt);
  if (Number.isNaN(elapsed) || elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function formatDeadline(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf())
    ? date
    : parsed.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
}

const UNABLE_REASON: Record<string, string> = {
  timeout: 'The check timed out.',
  denied: 'The site declined the check. It may need you to sign in.',
  login_wall: 'The site asked for a sign-in.',
  rate_limited: 'The site asked for fewer requests.',
  server_error: 'The site had a problem on its side.',
  network_error: 'The connection failed.',
  redirected_elsewhere: 'The link now leads to a different site.',
  no_authoritative_source: 'This job source cannot be checked automatically.',
  board_not_found: "The employer's job board could not be found.",
  unexpected_response: 'The site answered in a way we could not read.',
  empty_content: 'The site returned no posting text.',
  content_too_large: 'The posting is too large to check automatically.',
  check_failed: 'The check could not start on this computer.',
};

/** The plain sentence for why a check could not answer (#720 shares it with search results). */
export function unableReasonText(reason: string | null): string {
  return UNABLE_REASON[reason ?? ''] ?? 'The check did not finish.';
}

export type PostingNoticeTone = 'quiet' | 'warning' | 'info';

export interface PostingNoticeText {
  tone: PostingNoticeTone;
  headline: string;
  /** Short sentences; each is its own line. */
  lines: string[];
  /**
   * Provenance behind "How we know" (#720): the exact check time and who answered, and the time the
   * person recorded "It's open". Empty when nothing was checked or confirmed.
   */
  howWeKnow: string[];
}

/** Closed wording per reason: an omitted board listing is not the same evidence as a 404. */
function closedEvidence(reason: string | null): string {
  return reason === 'not_listed'
    ? "The employer's official job board no longer lists this posting."
    : "The employer's own job system says this posting no longer exists.";
}

/**
 * The provenance lines for one view (what the default lines do not already say): the exact check time
 * and who answered, and when the person recorded "It's open". Never invents a time it was not given.
 */
export function postingProvenance(view: PostingVerificationView): string[] {
  const lines: string[] = [];
  const source = postingSourceLabel(view.source);
  const host = view.sourceRef?.split('/')[0] ?? null;
  if (view.checkedAt !== null) {
    lines.push(`Checked ${formatCheckedAt(view.checkedAt)}${source ? ` with ${source}${host ? ` (${host})` : ''}` : ''}.`);
  }
  if (view.personConfirmedAt) {
    lines.push(`You confirmed it's open on ${formatCheckedAt(view.personConfirmedAt)}.`);
  }
  return lines;
}

/**
 * The one description of a view. `open` is deliberately a single quiet line: nothing about an
 * unchanged, still-open posting asks the person for anything.
 */
export function describePostingVerification(view: PostingVerificationView, now: Date = new Date()): PostingNoticeText {
  const source = view.source ? (SOURCE_LABEL[view.source] ?? view.source) : null;
  const checked =
    view.checkedAt === null
      ? null
      : `Checked ${formatCheckedAgo(view.checkedAt, now)}${source ? ` with ${source}` : ''}.`;
  const lines: string[] = [];
  switch (view.status) {
    case 'confirmed_open': {
      if (checked) lines.push(checked);
      const deadlinePassed = view.deadline !== null && Date.parse(`${view.deadline.date}T23:59:59Z`) < now.getTime();
      if (view.deadline) {
        lines.push(
          deadlinePassed
            ? `The posting states a deadline of ${formatDeadline(view.deadline.date)}, which has passed.`
            : `The posting states a deadline of ${formatDeadline(view.deadline.date)}.`,
        );
      } else if (view.noDeadlineStated) {
        lines.push('The posting states no deadline.');
      }
      if (view.resolution === 'refreshed') lines.push('Your application uses the updated posting.');
      if (view.actions.includes('prepare_now')) {
        lines.push('Preparing this application paused earlier. Nothing is left to decide, so you can prepare it now.');
      }
      return {
        tone: deadlinePassed ? 'warning' : 'quiet',
        headline: deadlinePassed ? 'The posting is still listed, but its deadline has passed.' : 'The posting is still open.',
        lines,
        howWeKnow: postingProvenance(view),
      };
    }
    case 'confirmed_closed': {
      if (checked) lines.push(checked);
      lines.push(closedEvidence(view.reason));
      if (view.resolution === 'prepare_anyway') {
        lines.push('You chose to get ready anyway.');
      } else if (view.held) {
        lines.push('Your prepared application is paused until you choose. Get ready anyway puts it back exactly as it was.');
      } else {
        lines.push('Open the posting to check for yourself. You can still get ready anyway.');
      }
      pushRecheck(view, lines);
      return { tone: 'warning', headline: 'This posting looks closed.', lines, howWeKnow: postingProvenance(view) };
    }
    case 'materially_changed': {
      if (checked) lines.push(checked);
      if (view.resolution === 'keep_current') {
        lines.push('You chose to keep your application as prepared.');
      } else if (view.held) {
        lines.push(
          'Your prepared application is paused until you choose. Keep my application puts it back exactly as it was; refreshing prepares it again from the updated posting.',
        );
      } else {
        lines.push('Your application was prepared from the earlier text. Nothing has been changed yet.');
      }
      pushRecheck(view, lines);
      return {
        tone: 'warning',
        headline:
          view.changeKind === 'text'
            ? 'The posting text changed a lot since it was read.'
            : 'The requirements in this posting changed since it was read.',
        lines,
        howWeKnow: postingProvenance(view),
      };
    }
    case 'unable_to_verify': {
      lines.push(UNABLE_REASON[view.reason ?? ''] ?? 'The check did not finish.');
      lines.push('This does not mean the posting is closed.');
      if (checked) lines.push(checked);
      if (view.actions.includes('prepare_now')) {
        lines.push(
          view.personConfirmedAt
            ? "You confirmed it's open, so you can prepare this application now."
            : 'An earlier check found it open, so you can still prepare this application now.',
        );
      }
      if (view.actions.includes('confirm_open')) {
        lines.push("Nothing is prepared until you look at the posting and confirm it's open.");
      }
      return {
        tone: 'info',
        headline: 'We could not check whether this posting is still open.',
        lines,
        howWeKnow: postingProvenance(view),
      };
    }
    case 'not_applicable':
      return {
        tone: 'quiet',
        headline: 'The posting is not rechecked after you apply.',
        lines: ['The documents you used stay exactly as they were.'],
        howWeKnow: [],
      };
    case 'not_checked':
      return { tone: 'quiet', headline: 'The posting has not been checked yet.', lines: [], howWeKnow: [] };
  }
}

function pushRecheck(view: PostingVerificationView, lines: string[]): void {
  if (view.recheck === null || view.recheck === undefined) return;
  const why = UNABLE_REASON[view.recheck.reason] ?? 'The check did not finish.';
  lines.push(`A later check could not reach the posting. ${why} This finding still stands.`);
}

export const POSTING_ACTION_LABEL = {
  check_again: 'Check again',
  open_posting: 'Open the posting',
  refresh: 'Refresh from the updated posting',
  keep_current: 'Keep my application',
  prepare_anyway: 'Get ready anyway',
  prepare_now: 'Prepare now',
  confirm_open: "It's open",
} as const;

/** What a button says while its request is running. */
export const POSTING_ACTION_PENDING_LABEL = {
  check_again: 'Checking…',
  refresh: 'Refreshing…',
  keep_current: 'Restoring…',
  prepare_anyway: 'Working…',
  prepare_now: 'Preparing…',
  confirm_open: 'Saving…',
} as const;
