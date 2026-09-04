/**
 * Public surface of the Search feature. The app shell only needs `SearchPage`, whose one prop
 * (`onGenerateLetter`, for the Search -> Letters handoff -- see App.tsx) is optional; the pieces
 * below it are exported for tests and for a future layout that splits the master/detail pair
 * across screens.
 */
export { SearchPage, savedJobInputFor, selectedVacancyFor, toVacancyLead } from './SearchPage.js';
export type { SearchPageProps } from './SearchPage.js';
export { SearchFilterBar } from './SearchFilterBar.js';
export type { SearchFilterBarProps } from './SearchFilterBar.js';
export { SearchResultList, SearchResultRow } from './SearchResultList.js';
export type { SearchResultListProps, SearchResultRowProps } from './SearchResultList.js';
export { VacancyDetail } from './VacancyDetail.js';
export type { SaveState, VacancyDetailProps } from './VacancyDetail.js';
export { SectionHeading, VerificationSection } from './VerificationSection.js';
export type { VerificationSectionProps } from './VerificationSection.js';
export {
  DEFAULT_FILTERS,
  WORLDWIDE_VERIFICATION,
  countryOptions,
  decisionLabel,
  employmentOptions,
  filterResults,
  formatDate,
  formatDiscoverySalary,
  isStalePosting,
  isWebUrl,
  orNotStated,
  sortResults,
  sourceOptions,
  toWorldwideResults,
  worldwideVerification,
} from './results.js';
export type { PostedWithin, SearchFilters, SearchResult, Verification, VerificationLevel } from './results.js';
