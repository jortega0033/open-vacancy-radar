import type { CvFile } from '../../window.js';

/** The loaded CV, as returned by `window.cv.selectAndRead()`. */
export type CvDocument = CvFile;

/**
 * The vacancy shape these features need in order to write a prompt.
 *
 * Deliberately a *structural subset* of `DiscoveryVacancyAudit`
 * (packages/vacancy-engine/src/global-remote/models.ts) rather than an import of it: every field
 * that type declares as required is required here too and with the same type, so the Search page
 * can pass a `DiscoveryVacancyAudit` straight in with no adapter, while this package keeps
 * no build-time coupling to the engine's model, and stays usable with a hand-built vacancy in a
 * test or a future manually-entered one.
 *
 * `description` / `requirements` are the interesting extras: the engine's discovery audit does not
 * carry posting text today, so the prompt builders treat them as optional and say so explicitly to
 * the model rather than letting it invent requirements that were never in the posting.
 */
export interface VacancyLead {
  title: string;
  company: string;
  location: string;
  url: string;
  description?: string | null;
  requirements?: string[] | null;
  employmentType?: string | null;
  currency?: string | null;
  salaryPeriod?: string | null;
  advertisedMinimum?: number | null;
}
