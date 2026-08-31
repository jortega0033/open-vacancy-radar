import { expect, goto, test } from './fixtures.js';

/**
 * Search e2e coverage is deliberately scoped to UI mechanics that need no real data: this suite
 * never triggers "Search" / "Run the first scan" (the two buttons that can start a scan; there is
 * no longer a separate, merely-filtering action), because both hit real external job-board APIs
 * (SearchPage.tsx's docstring: "Scanning hits real external feeds and can take a couple of
 * minutes"), which would be slow, flaky, and inappropriate for CI. `window.vacancyRadar.getStatus`/
 * `getNetherlandsReport`/`getReport` are read-only IPC calls to the local engine config, not to any
 * external service, so hydrating a fresh workspace's (always-empty) report is safe to exercise here.
 */
test.describe('Search', () => {
  test('shows the no-report-yet empty state for a fresh workspace, per market', async ({ window }) => {
    await goto(window, 'Search');

    // Fresh workspace: the persisted default market is 'worldwide' (never Netherlands; see
    // schema.ts's `defaultMarket` column default), and neither market has ever been scanned, so
    // SearchPage's hydrate-then-optionally-scan effect resolves to `hasReport === false` and
    // renders the "No search yet" EmptyState (SearchPage.tsx line ~397), never the results list.
    await expect(window.getByRole('heading', { name: 'No search yet' })).toBeVisible();
    await expect(
      window.getByText(/No Worldwide \/ Remote scan has been run yet, so there is nothing to filter/i),
    ).toBeVisible();
    await expect(window.getByRole('button', { name: /run the first scan/i })).toBeVisible();
    await expect(window.getByText('Salary shown only where advertised')).toBeVisible();

    // Netherlands-only filter chips must be absent on the default market ...
    await expect(window.getByRole('checkbox', { name: /IND-recognised sponsors only/i })).toHaveCount(0);
    // ... and worldwide-only ones don't appear until a report with rows exists (no employment types
    // are known yet), but the country filter is static and always offered for this market.
    await expect(window.getByRole('combobox', { name: 'Country' })).toBeVisible();

    // Switching market must swap in that market's own empty-state copy (SALARY_NOTE and the
    // EmptyState description are both keyed by market), not just relabel the selector.
    await window.getByRole('combobox', { name: 'Market' }).selectOption('netherlands');

    await expect(window.getByRole('heading', { name: 'No search yet' })).toBeVisible();
    await expect(
      window.getByText(/No Netherlands scan has been run yet, so there is nothing to filter/i),
    ).toBeVisible();
    await expect(window.getByRole('button', { name: /run the first scan/i })).toBeVisible();
    await expect(window.getByRole('checkbox', { name: /IND-recognised sponsors only/i })).toBeVisible();
    await expect(window.getByText('No salary in the Netherlands report')).toBeVisible();

    // Switching back to worldwide restores its own copy and its own filter chips.
    await window.getByRole('combobox', { name: 'Market' }).selectOption('worldwide');
    await expect(
      window.getByText(/No Worldwide \/ Remote scan has been run yet, so there is nothing to filter/i),
    ).toBeVisible();
    await expect(window.getByRole('checkbox', { name: /IND-recognised sponsors only/i })).toHaveCount(0);
    await expect(window.getByText('Salary shown only where advertised')).toBeVisible();
  });
});
