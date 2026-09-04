import type { WorkspaceCounts } from '../../window.js';

/**
 * The app's eight destinations.
 *
 * These ids are deliberately the same strings the persistence schema stores in
 * `app_settings.start_page` / `app_settings.last_opened_page` (see
 * electron/workspace/schema.ts), so "restore the page the user was on" is a direct comparison
 * with no translation table in between. `startPage` additionally allows `'last_opened'`, which is
 * an instruction rather than a destination and therefore is not a `NavPage`.
 *
 * ADI-07 added `'agent-workspace'` as the eighth. It is a `NavPage` (so it can be remembered as
 * `lastOpenedPage`) but deliberately **not** a `startPage` option: a screen whose whole purpose is
 * to show what is running right now is a poor thing to land on cold, and `START_PAGES` in
 * electron/workspace/validate.ts is left unchanged for that reason. The order here matches that
 * file's own `NAV_PAGES` array, so the two lists read the same way.
 */
export type NavPage =
  | 'search'
  | 'saved'
  | 'applications'
  | 'cv'
  | 'letters'
  | 'agent-workspace'
  | 'runtime'
  | 'settings';

export const NAV_PAGES: readonly NavPage[] = [
  'search',
  'saved',
  'applications',
  'cv',
  'letters',
  'agent-workspace',
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

/**
 * Below the divider: the AI surfaces and the things that configure the app, rather than the job
 * hunt itself.
 *
 * "AI Workspace" sits directly above "AI Runtime" because the two answer adjacent questions (what
 * is running, and what could run) and because the Workspace's refusal copy points at the Runtime
 * page by name when the local runtime is down.
 */
export const SECONDARY_NAV: readonly NavItem[] = [
  { id: 'agent-workspace', label: 'AI Workspace' },
  { id: 'runtime', label: 'AI Runtime' },
  { id: 'settings', label: 'Settings' },
];

/**
 * `undefined` means "not loaded yet, or the last fetch failed" -- deliberately not defaulted to a
 * zeroed `WorkspaceCounts` (issue #178). A "0" badge or "0 saved" subtitle rendered before the
 * first successful `getCounts()` call looked identical to a genuine zero, which is exactly the
 * fabricated-count `headerCopy`'s own doc comment already promises not to show. Callers render
 * nothing (badge) or a loading placeholder (subtitle) for `undefined` instead of guessing.
 */
export function badgeCount(counts: WorkspaceCounts | undefined, badge: NavBadge | undefined): number | undefined {
  return badge === undefined || counts === undefined ? undefined : counts[badge];
}

/**
 * Title + contextual subtitle for the 52px workspace header.
 *
 * The subtitles are counts and plain statements of fact on purpose. This header is the one
 * always-visible piece of chrome, so it is the wrong place for a claim the app cannot back up --
 * including, per issue #178, a count that has not actually loaded yet.
 */
export function headerCopy(
  page: NavPage,
  counts: WorkspaceCounts | undefined,
): { title: string; subtitle: string } {
  switch (page) {
    case 'search':
      return {
        title: 'Search Jobs',
        subtitle: 'Find relevant roles, evaluate employers, and prepare applications',
      };
    case 'saved':
      return { title: 'Saved Jobs', subtitle: counts === undefined ? 'Loading…' : `${counts.savedJobs} saved` };
    case 'applications':
      return {
        title: 'Applications',
        subtitle: counts === undefined ? 'Loading…' : `${counts.activeApplications} active`,
      };
    case 'cv':
      return { title: 'CV', subtitle: 'Documents used for match analysis and letters' };
    case 'letters':
      return { title: 'Letters', subtitle: counts === undefined ? 'Loading…' : `${counts.letters} documents` };
    case 'agent-workspace':
      // No count: the number of sessions is not part of `WorkspaceCounts` (it lives in the daemon,
      // not the workspace database), and inventing a badge for it would mean a second source of
      // truth the shell would have to keep in step with the page's own list.
      return { title: 'AI Workspace', subtitle: 'Agent sessions running in folders you approved' };
    case 'runtime':
      return { title: 'AI Runtime', subtitle: 'Your own Claude Code / Codex CLI, via AgentDock' };
    case 'settings':
      return { title: 'Settings', subtitle: 'Saved automatically to local data' };
  }
}
