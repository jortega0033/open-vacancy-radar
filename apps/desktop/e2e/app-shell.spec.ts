import { ensureLightTheme, expect, goto, test } from './fixtures.js';

/**
 * The one flow every other spec depends on being right: the app boots, every destination is
 * reachable, and the sidebar carries no fake per-user data — the exact regression this suite exists
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
    // Already on Settings — ensureLightTheme just navigated here to click "Light".
    await expect(window).toHaveScreenshot('settings-page.png');

    await goto(window, 'Search');
    await expect(window).toHaveScreenshot('search-page.png');
  });
});
