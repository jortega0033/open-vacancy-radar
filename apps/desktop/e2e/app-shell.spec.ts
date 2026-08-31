import { ensureLightTheme, expect, goto, test } from './fixtures.js';

/**
 * The one flow every other spec depends on being right: the app boots, every destination is
 * reachable, and the sidebar carries no fake per-user data: the exact regression this suite exists
 * to catch a repeat of (see AppSidebar.tsx's history: a hardcoded "JO" avatar was shipped and only
 * caught by manual testing).
 */
test.describe('app shell', () => {
  test('boots to Search and every sidebar destination is reachable', async ({ window }) => {
    // `WorkspaceHeader`'s title is the one `<h1>` in the shell; a page's own content heading (e.g.
    // Applications' `<h2>`) can legitimately repeat the same text, so the level distinguishes them
    // without needing to know which pages happen to duplicate their title and which (Search) don't.
    const headerTitle = (name: string) => window.getByRole('heading', { level: 1, name, exact: true });
    await expect(headerTitle('Search Jobs')).toBeVisible();

    const destinations: Array<[label: string, heading: string]> = [
      ['Saved Jobs', 'Saved Jobs'],
      ['Applications', 'Applications'],
      ['CV', 'CV'],
      ['Letters', 'Letters'],
      ['AI Runtime', 'AI Runtime'],
      ['Settings', 'Settings'],
      ['Search', 'Search Jobs'],
    ];
    for (const [label, heading] of destinations) {
      await goto(window, label);
      await expect(headerTitle(heading)).toBeVisible();
    }
  });

  test('the sidebar profile indicator carries no fake identity', async ({ window }) => {
    // Regression guard for the hardcoded "JO" avatar bug: whatever the sidebar's profile footer
    // renders, it must never be literal initials with no real data behind them.
    await expect(window.getByText('JO', { exact: true })).toHaveCount(0);
    await expect(window.getByText('Local profile')).toBeVisible();
  });

  test('Search and Settings page visual baselines', async ({ window }) => {
    await ensureLightTheme(window);
    // The daemon connects asynchronously after launch (App.tsx's "Connecting to local daemon..."
    // banner); without waiting for it to settle, a screenshot taken this soon after launch is racing
    // daemon startup and its content/layout depends on how far that race got, not on the app itself.
    // Waiting for the connecting banner to disappear isn't enough on its own: App.tsx replaces it
    // with either nothing (ready) or a "Daemon unavailable" banner (failed) — both hide the
    // connecting text, so that wait alone could let a failed-to-start daemon through and quietly
    // lock in a broken-daemon screenshot as the accepted baseline. Asserting the unavailable banner
    // is absent turns that into a loud test failure instead.
    await expect(window.getByText('Connecting to local daemon…')).toBeHidden({ timeout: 20_000 });
    await expect(window.getByText(/^Daemon unavailable:/)).toHaveCount(0);
    // Already on Settings. ensureLightTheme just navigated here to click "Light".
    await expect(window).toHaveScreenshot('settings-page.png');

    await goto(window, 'Search');
    await expect(window).toHaveScreenshot('search-page.png');
  });

  test('collapsed sidebar visual baseline', async ({ window }) => {
    // Regression guard for a real bug: NavGroup's collapsed nav buttons carried both
    // `justify-start` (unconditional) and `justify-center` (collapsed-only) at once, so the icon
    // sat pinned to the button's start edge inside its 44px `ovr-nav-icon` box instead of centered.
    // Scoped to the sidebar element alone, not the full window, so this baseline is unaffected by
    // whatever the main content pane happens to be showing.
    await ensureLightTheme(window);
    await window.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(window.getByRole('complementary', { name: 'Main' })).toHaveScreenshot('sidebar-collapsed.png');
  });
});
