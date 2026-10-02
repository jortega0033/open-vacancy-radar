/** Spoken progress is throttled to one message per this many newly arrived vacancies. */
export const PROGRESS_ANNOUNCE_STEP = 40;

export const SCAN_STARTED_ANNOUNCEMENT = 'Scan started';
export const SCAN_FAILED_ANNOUNCEMENT = 'The scan stopped with an error';

export function scanFinishedAnnouncement(count: number): string {
  return `Scan finished, ${count.toLocaleString()} ${count === 1 ? 'vacancy' : 'vacancies'}`;
}

/**
 * The text to speak for a new live arrival count, or `undefined` while it has not moved a full
 * step past `lastAnnounced`. A scan can stream hundreds of rows in bursts, so announcing every
 * arrival would flood speech output.
 */
export function progressAnnouncement(count: number, lastAnnounced: number): string | undefined {
  if (count < lastAnnounced + PROGRESS_ANNOUNCE_STEP) return undefined;
  return `${count.toLocaleString()} live ${count === 1 ? 'vacancy' : 'vacancies'} so far`;
}
