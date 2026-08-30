import type { LetterLength, LetterStatus, LetterTone, LetterType } from '../../window.js';
import type { VacancyLead } from '../cv/types.js';

/**
 * A vacancy the generator can write about.
 *
 * `VacancyLead` (components/cv/types.ts) is already the structural subset both AI features need to
 * build a prompt, and `DiscoveryVacancyAudit` from the engine satisfies it. The one thing a letter
 * additionally wants is the discovery `key`, because `letters.vacancy_key` is what links a saved
 * letter back to the vacancy it was written for. It stays optional: a letter typed in by hand, or
 * written for a saved job that was never in a scan, legitimately has no key.
 */
export interface SelectedVacancy extends VacancyLead {
  key?: string | null;
}

export interface LetterOption<T extends string> {
  id: T;
  label: string;
  /** One line under the control explaining what the choice actually changes in the prompt. */
  hint?: string;
}

/**
 * The four document types, spelled the way the database stores them. Labels (and the hints) are
 * the app's own words; the ids are the `letters.type` column values from
 * `electron/workspace/types.ts`, so nothing has to be translated on the way in or out.
 */
export const LETTER_TYPE_OPTIONS: readonly LetterOption<LetterType>[] = [
  { id: 'motivation_letter', label: 'Motivation letter' },
  { id: 'cover_letter', label: 'Cover letter' },
  { id: 'recruiter_message', label: 'Recruiter message' },
  { id: 'short_application_message', label: 'Short application message' },
];

export const LETTER_TONE_OPTIONS: readonly LetterOption<LetterTone>[] = [
  { id: 'formal', label: 'Formal' },
  { id: 'natural', label: 'Natural' },
  { id: 'confident', label: 'Confident' },
  { id: 'concise', label: 'Concise' },
];

export const LETTER_LENGTH_OPTIONS: readonly LetterOption<LetterLength>[] = [
  { id: 'short', label: 'Short' },
  { id: 'standard', label: 'Standard' },
  { id: 'detailed', label: 'Detailed' },
];

export const LETTER_STATUS_OPTIONS: readonly LetterOption<LetterStatus>[] = [
  { id: 'draft', label: 'Draft' },
  { id: 'final', label: 'Final' },
  { id: 'sent', label: 'Sent' },
];

export function labelFor<T extends string>(options: readonly LetterOption<T>[], id: T): string {
  return options.find((option) => option.id === id)?.label ?? id;
}

/**
 * Monochrome on purpose, for the same reason App.tsx keeps run statuses grayscale: draft/final/sent
 * are lifecycle positions, not outcomes. A sent letter is not "good" and a draft is not "bad", so
 * the three real state hues in the token set stay reserved for things that genuinely are (see
 * DESIGN-TOKENS.md). The status word itself is always rendered, so the badge is never the only cue.
 */
export const LETTER_STATUS_BADGE_CLASS: Record<LetterStatus, string> = {
  draft: 'badge badge-ghost',
  final: 'badge badge-outline',
  sent: 'badge badge-neutral',
};

/**
 * `updatedAt` crosses IPC as an ISO string. A malformed one should degrade to the raw value rather
 * than rendering "Invalid Date" in a table the user is trying to read.
 */
export function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
