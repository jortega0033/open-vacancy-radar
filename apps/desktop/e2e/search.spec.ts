import { expect, goto, test } from './fixtures.js';

/**
 * Search e2e coverage is deliberately scoped to UI mechanics that need no real data: this suite
 * never clicks either "Search" button (the filter bar one and the empty-state role buttons start a scan; there is
 * no separate, merely-filtering action), because both hit real external job-board APIs
 * (SearchPage.tsx's docstring: "Scanning hits real external feeds and can take a couple of
 * minutes"), which would be slow, flaky, and inappropriate for CI. `window.vacancyRadar.getStatus`/
 * `getReport` are read-only IPC calls to the local engine config, not to any external service, so
 * hydrating a fresh workspace's (always-empty) report is safe to exercise here.
 */
test.describe('Search', () => {
  test('shows the no-report-yet empty state for a fresh workspace, with a plain country filter', async ({
    window,
  }) => {
    await goto(window, 'Search');

    // Fresh workspace: nothing has ever been scanned, so SearchPage's hydrate-then-optionally-scan
    // effect resolves to `hasReport === false` and renders the "No search yet" EmptyState, never
    // the results list.
    await expect(window.getByRole('heading', { name: 'No search yet' })).toBeVisible();
    await expect(
      window.getByText(/Enter a role and search to find jobs/i),
    ).toBeVisible();
    await expect(window.getByRole('button', { name: 'Search', exact: true }).first()).toBeVisible();
    // The e2e data root ships the default candidate profile, so the first three of its target
    // roles show as buttons. No disabled duplicate Search button, and one Browse all (#636).
    const roleButtons = window.getByRole('button', { name: /^Search for / });
    await expect(roleButtons).toHaveText([
      'Search for Senior Frontend Engineer',
      'Search for Frontend Developer',
      'Search for React Developer',
    ]);
    // Scoped to the page: the sidebar also has a Search nav button.
    await expect(window.getByRole('main').getByRole('button', { name: 'Search', exact: true })).toHaveCount(1);
    await expect(window.getByRole('button', { name: 'Browse all vacancies' })).toHaveCount(1);
    // Secondary filters (and the salary note) sit behind the Filters button (#578).
    await expect(window.getByRole('combobox', { name: 'Job source' })).toHaveCount(0);
    await window.getByRole('button', { name: /^Filters/ }).click();
    await expect(window.getByText('Salary shown only where advertised')).toBeVisible();
    await window.keyboard.press('Escape');

    // The plain country selector is always offered -- there is no separate pipeline switch any
    // more. The best-effort sponsor-match filter is Netherlands-specific (the engine never
    // attempts that check for any other country), so it starts hidden on "All countries".
    const countrySelect = window.getByRole('combobox', { name: 'Country' });
    await expect(countrySelect).toBeVisible();
    await expect(countrySelect).toHaveValue('all');
    await expect(window.getByRole('checkbox', { name: /possible IND sponsor match only/i })).toHaveCount(0);

    // Picking a country is a plain, instant filter over whatever is already loaded -- it never
    // starts a scan or changes the empty-state copy. Selecting Netherlands reveals the sponsor
    // filter; leaving it hides it again.
    await countrySelect.selectOption('Netherlands');
    await expect(countrySelect).toHaveValue('Netherlands');
    await expect(window.getByRole('heading', { name: 'No search yet' })).toBeVisible();
    await window.getByRole('button', { name: /^Filters/ }).click();
    await expect(window.getByRole('checkbox', { name: /possible IND sponsor match only/i })).toBeVisible();

    await countrySelect.selectOption('all');
    await expect(countrySelect).toHaveValue('all');
    await expect(window.getByRole('checkbox', { name: /possible IND sponsor match only/i })).toHaveCount(0);
  });
});
