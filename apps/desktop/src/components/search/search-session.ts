import type { DiscoveryVacancyAudit, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { DEFAULT_FILTERS, type SearchFilters } from './results.js';

/** Transient Search workspace owned by the mounted app shell. Reports stay referenced, not copied. */
export interface SearchSessionState {
  filters: SearchFilters;
  appliedFilters: SearchFilters;
  pendingScanFilters: SearchFilters | null;
  report: GlobalRemoteReport | null;
  reportHydrated: boolean;
  settingsHydrated: boolean;
  partialVacancies: DiscoveryVacancyAudit[];
  selectedKey: string | null;
  assistantForKey: string | null;
  page: number;
  sourceWarningsOpen: boolean;
  listScrollTop: number;
  detailScrollTop: number;
}

export function createSearchSessionState(): SearchSessionState {
  return {
    filters: { ...DEFAULT_FILTERS },
    appliedFilters: { ...DEFAULT_FILTERS },
    pendingScanFilters: null,
    report: null,
    reportHydrated: false,
    settingsHydrated: false,
    partialVacancies: [],
    selectedKey: null,
    assistantForKey: null,
    page: 0,
    sourceWarningsOpen: false,
    listScrollTop: 0,
    detailScrollTop: 0,
  };
}
