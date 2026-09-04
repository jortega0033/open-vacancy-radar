import type { AtsHttpClient } from './http.js';
import { AshbyAdapter } from './ashby.js';
import { CompanySiteJsonLdAdapter } from './company-site.js';
import { GreenhouseAdapter } from './greenhouse.js';
import { LeverAdapter } from './lever.js';
import { PersonioAdapter } from './personio.js';
import { RecruiteeAdapter } from './recruitee.js';
import { SmartRecruitersAdapter } from './smartrecruiters.js';
import { SuccessFactorsAdapter } from './successfactors.js';
import { TeamtailorAdapter } from './teamtailor.js';
import { WorkableAdapter } from './workable.js';
import { WorkdayAdapter } from './workday.js';
import type { VacancyAdapter } from '../domain/models.js';

/**
 * Relocated from the now-deleted curated `pipeline/vacancies.ts` (the per-company-site scan loop
 * that used it is gone with the rest of the curated Netherlands pipeline), since the ATS parsers
 * themselves are shared with the worldwide pipeline (`global-remote/official.ts` uses them too).
 * This factory has no pipeline-specific logic of its own -- it is purely "which adapter class does
 * this provider string select" -- so it moves to the ATS layer rather than being deleted with its
 * former caller.
 */
export function createVacancyAdapter(provider: string, http: AtsHttpClient): VacancyAdapter | null {
  switch (provider) {
    case 'ashby':
      return new AshbyAdapter(http);
    case 'greenhouse':
      return new GreenhouseAdapter(http);
    case 'lever':
      return new LeverAdapter(http);
    case 'personio':
      return new PersonioAdapter(http);
    case 'teamtailor':
      return new TeamtailorAdapter(http);
    case 'recruitee':
      return new RecruiteeAdapter(http);
    case 'smartrecruiters':
      return new SmartRecruitersAdapter(http);
    case 'successfactors':
      return new SuccessFactorsAdapter(http);
    case 'workable':
      return new WorkableAdapter(http);
    case 'workday':
      return new WorkdayAdapter(http);
    case 'json_ld':
      return new CompanySiteJsonLdAdapter(http);
    default:
      return null;
  }
}
