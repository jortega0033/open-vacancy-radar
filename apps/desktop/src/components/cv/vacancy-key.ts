import { vacancyKeyFor } from '../../../electron/workspace/cv-evidence-schema.js';
import type { VacancyLead } from './types.js';

/**
 * `vacancyKeyFor`/`mintManualCaseKey` moved to `electron/workspace/cv-evidence-schema.ts` (#421)
 * so Electron main can call them too, without main importing from `src/`. Re-exported here
 * unchanged so every existing renderer import site keeps working without touching its own import
 * line.
 */
export { vacancyKeyFor, mintManualCaseKey } from '../../../electron/workspace/cv-evidence-schema.js';

/** The key a tailoring case is stored under: the minted `manual:` key for a manual case, otherwise
 * the vacancy's own key. Every panel that reads or writes the case must go through this (#419). */
export function caseKeyFor(vacancy: VacancyLead): string {
  return vacancy.caseKey ?? vacancyKeyFor(vacancy);
}
