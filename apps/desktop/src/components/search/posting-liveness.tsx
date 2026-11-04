import type { PostingLivenessState, PostingLivenessView } from '../../window.js';
import {
  formatCheckedAgo,
  formatCheckedAt,
  postingSourceLabel,
  unableReasonText,
} from '../applications/posting-verification-text.js';

/**
 * The one plain liveness vocabulary for search results (#720). Exactly four states, in words a person
 * uses; no internal enum or provider jargon by default. Detail (who answered, when exactly, why a check
 * could not answer) lives behind "How we know".
 */
export const LIVENESS_LABEL: Record<PostingLivenessState, string> = {
  open: 'Open',
  not_checked: 'Not checked yet',
  unverifiable: "Couldn't check",
  closed: 'Closed/removed',
};

/** What the page knows for a result, or the honest default when it knows nothing yet. */
export function livenessFor(
  vacancyKey: string,
  known: ReadonlyMap<string, PostingLivenessView> | undefined,
): PostingLivenessView {
  return (
    known?.get(vacancyKey) ?? {
      vacancyKey,
      state: 'not_checked',
      checkedAt: null,
      source: null,
      sourceRef: null,
      reason: null,
      checkable: false,
    }
  );
}

/** The default line: the state, plus when it was checked if it was. */
export function livenessLine(view: PostingLivenessView, now: Date = new Date()): string {
  const label = LIVENESS_LABEL[view.state];
  return view.checkedAt === null ? label : `${label} · checked ${formatCheckedAgo(view.checkedAt, now)}`;
}

/** Behind "How we know": the exact time, who answered and, when it could not answer, why. */
export function livenessProvenance(view: PostingLivenessView): string[] {
  const lines: string[] = [];
  const source = postingSourceLabel(view.source);
  const host = view.sourceRef?.split('/')[0] ?? null;
  if (view.checkedAt !== null) {
    lines.push(`Checked ${formatCheckedAt(view.checkedAt)}${source ? ` with ${source}${host ? ` (${host})` : ''}` : ''}.`);
  }
  if (view.state === 'closed') {
    lines.push(
      view.reason === 'not_listed'
        ? "The employer's official job board no longer lists this posting."
        : "The employer's own job system says this posting no longer exists.",
    );
  } else if (view.state === 'open') {
    lines.push("The posting was returned by the employer's own job system.");
  } else if (view.state === 'unverifiable') {
    lines.push(unableReasonText(view.reason));
    lines.push('This does not mean the posting is closed.');
  } else {
    lines.push('Selecting a result checks it once, when its job source can be checked.');
  }
  return lines;
}

const TONE: Record<PostingLivenessState, string> = {
  open: 'badge-success badge-soft',
  closed: 'badge-error badge-soft',
  unverifiable: 'badge-ghost',
  not_checked: 'badge-ghost',
};

/** The compact state chip placed directly beside a fit score. */
export function LivenessChip({ view, size = 'sm' }: { view: PostingLivenessView; size?: 'xs' | 'sm' }) {
  return (
    <span
      className={`badge ${size === 'xs' ? 'badge-xs' : 'badge-sm'} flex-none whitespace-nowrap font-normal ${TONE[view.state]}`}
      data-testid="posting-liveness"
      data-state={view.state}
    >
      <span className="sr-only">Posting: </span>
      {LIVENESS_LABEL[view.state]}
    </span>
  );
}
