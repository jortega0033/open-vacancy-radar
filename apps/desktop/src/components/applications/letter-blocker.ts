import { classifyProviderError, type ProviderErrorInfo } from '../../provider-error.js';

/** Written by `application-pipeline.ts` before the reason the cover letter was not produced. */
const BLOCKER_MARKER = 'Cover letter blocker:';
/** The pipeline's own instruction after the reason; the card offers those actions as buttons. */
const BLOCKER_TAIL = '. Use Generate letter';
const GENERATION_STOPPED = 'automatic cover letter generation stopped:';

export interface LetterBlocker {
  /** One plain sentence for the person. */
  message: string;
  /** The pipeline's raw reason, for a Details disclosure. */
  detail: string;
  /** Set when Claude's usage limit stopped the letter, so Try again can wait for the reset. */
  limit?: ProviderErrorInfo;
}

/**
 * Why the cover letter of a manual handoff is missing (#565). Reads the reason the pipeline stored
 * after "Cover letter blocker:" in the attempt's checkpoint detail. A reset time is placed relative
 * to when the attempt last changed, so a stored message read later does not move the reset forward.
 * Returns null when the detail carries no blocker.
 */
export function describeLetterBlocker(checkpointDetail: string, updatedAt?: string): LetterBlocker | null {
  const start = checkpointDetail.indexOf(BLOCKER_MARKER);
  if (start < 0) return null;
  const rest = checkpointDetail.slice(start + BLOCKER_MARKER.length);
  const end = rest.lastIndexOf(BLOCKER_TAIL);
  const detail = (end < 0 ? rest : rest.slice(0, end)).trim().replace(/\.$/, '');

  if (detail.startsWith(GENERATION_STOPPED)) {
    const when = updatedAt === undefined ? NaN : Date.parse(updatedAt);
    const info = classifyProviderError(
      detail.slice(GENERATION_STOPPED.length),
      Number.isNaN(when) ? new Date() : new Date(when),
    );
    if (info.kind === 'usage_limit') {
      return {
        message: `Claude has reached its usage limit${info.resetLabel ? ` until ${info.resetLabel}` : ''}, so the cover letter was not written.`,
        detail,
        limit: info,
      };
    }
    if (info.kind === 'not_signed_in') {
      return { message: 'Claude Code is not signed in, so the cover letter was not written.', detail };
    }
    return { message: 'The cover letter could not be written.', detail };
  }
  if (/has no final content/i.test(detail)) {
    return { message: 'The letter saved for this job is empty.', detail };
  }
  if (/could not be produced/i.test(detail)) {
    return { message: 'The cover letter file could not be made.', detail };
  }
  return { message: 'The cover letter could not be written.', detail };
}
