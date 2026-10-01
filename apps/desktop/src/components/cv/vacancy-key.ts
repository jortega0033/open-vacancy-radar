/**
 * `vacancyKeyFor`/`mintManualCaseKey` moved to `electron/workspace/cv-evidence-schema.ts` (#421)
 * so Electron main can call them too, without main importing from `src/`. Re-exported here
 * unchanged so every existing renderer import site (`RequirementMapping.tsx`, `ComposedCvReview
 * .tsx`) keeps working without touching its own import line.
 */
export { vacancyKeyFor, mintManualCaseKey } from '../../../electron/workspace/cv-evidence-schema.js';
