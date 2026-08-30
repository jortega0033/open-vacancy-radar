import type { WorkspaceCounts } from '../../window.js';

/**
 * The app's seven destinations.
 *
 * These ids are deliberately the same strings the persistence schema stores in
 * `app_settings.start_page` / `app_settings.last_opened_page` (see
 * electron/workspace/schema.ts), so "restore the page the user was on" is a direct comparison
 * with no translation table in between. `startPage` additionally allows `'last_opened'`, which is
 * an instruction rather than a destination and therefore is not a `NavPage`.
 */
export type NavPage = 'search' | 'saved' | 'applications' | 'cv' | 'letters' | 'runtime' | 'settings';

export const NAV_PAGES: readonly NavPage[] = [
  'search',
  'saved',
  'applications',
  'cv',
  'letters',
  'runtime',
  'settings',
];

export function isNavPage(value: unknown): value is NavPage {
  return typeof value === 'string' && (NAV_PAGES as readonly string[]).includes(value);
}

export type NavBadge = 'savedJobs' | 'activeApplications' | 'letters';

export interface NavItem {
  id: NavPage;
  label: string;
  /** Which count from `WorkspaceCounts` to show at the end of the row, if any. */
  badge?: NavBadge;
}

/** The primary group: the job-hunting workflow itself. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { id: 'search', label: 'Search' },
  { id: 'saved', label: 'Saved Jobs', badge: 'savedJobs' },
  { id: 'applications', label: 'Applications', badge: 'activeApplications' },
  { id: 'cv', label: 'CV' },
  { id: 'letters', label: 'Letters', badge: 'letters' },
];

/** Below the divider: things that configure the app rather than track a job hunt. */
export const SECONDARY_NAV: readonly NavItem[] = [
  { id: 'runtime', label: 'AI Runtime' },
  { id: 'settings', label: 'Settings' },
];

export const EMPTY_COUNTS: WorkspaceCounts = { savedJobs: 0, activeApplications: 0, letters: 0 };

export function badgeCount(counts: WorkspaceCounts, badge: NavBadge | undefined): number | undefined {
  return badge === undefined ? undefined : counts[badge];
}

/**
 * Title + contextual subtitle for the 52px workspace header.
 *
 * The subtitles are counts and plain statements of fact on purpose — this header is the one
 * always-visible piece of chrome, so it is the wrong place for a claim the app cannot back up.
 */
export function headerCopy(page: NavPage, counts: WorkspaceCounts): { title: string; subtitle: string } {
  switch (page) {
    case 'search':
      return {
        title: 'Search Jobs',
        subtitle: 'Find relevant roles, evaluate employers, and prepare applications',
      };
    case 'saved':
      return { title: 'Saved Jobs', subtitle: `${counts.savedJobs} saved` };
    case 'applications':
      return { title: 'Applications', subtitle: `${counts.activeApplications} active` };
    case 'cv':
      return { title: 'CV', subtitle: 'Documents used for match analysis and letters' };
    case 'letters':
      return { title: 'Letters', subtitle: `${counts.letters} documents` };
    case 'runtime':
      return { title: 'AI Runtime', subtitle: 'Your own Claude Code / Codex CLI, via AgentDock' };
    case 'settings':
      return { title: 'Settings', subtitle: 'Saved automatically to local data' };
  }
}
