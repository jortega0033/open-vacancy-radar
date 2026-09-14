import { expect, goto, test } from './fixtures.js';

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1000, height: 720 },
  { width: 800, height: 600 },
] as const;

test('application, CV, and letter actions stay reachable at supported desktop widths', async ({
  electronApp,
  window,
}) => {
  await window.evaluate(async () => {
    await self.workspace.createApplication({
      role: 'Senior Frontend Engineer for International Design Systems',
      company: 'Northstar Product Engineering and Platform Operations',
      location: 'Amsterdam, Netherlands',
      verification: 'Official employer page verified',
      status: 'preparing',
      nextStep: 'Review the prepared application documents',
      contact: 'Recruiting team',
    });
    await self.workspace.createCvDocument({
      name: 'Frontend Product Engineer Resume for Netherlands.pdf',
      kind: 'manual',
      targetRole: 'Senior Frontend Product Engineer',
    });
    await self.workspace.createCvDocument({
      name: 'Backend Platform Engineer Resume.pdf',
      kind: 'manual',
      targetRole: 'Backend Platform Engineer',
    });
    await self.workspace.createLetter({
      title: 'Motivation letter for Northstar Product Engineering',
      company: 'Northstar Product Engineering and Platform Operations',
      role: 'Senior Frontend Engineer for International Design Systems',
      status: 'draft',
      body: 'Dear hiring team,',
    });
  });

  const pages = [
    {
      destination: 'Applications',
      testId: 'applications-responsive-table',
      actions: [/^edit$/i, /^archive$/i, /^delete$/i],
    },
    {
      destination: 'CV',
      testId: 'cv-responsive-table',
      actions: [/^export$/i, /^edit$/i, /^delete$/i, /set as default/i],
    },
    {
      destination: 'Letters',
      testId: 'letters-responsive-table',
      actions: [/^open$/i, /^duplicate$/i, /^delete$/i],
    },
  ] as const;

  for (const theme of ['openvacancyradar', 'openvacancyradar-dark']) {
    for (const density of ['comfortable', 'compact']) {
      await window.evaluate(
        ({ theme, density }) => {
          document.documentElement.dataset.theme = theme;
          if (density === 'compact') document.documentElement.dataset.density = 'compact';
          else delete document.documentElement.dataset.density;
        },
        { theme, density },
      );

      for (const viewport of VIEWPORTS) {
        await electronApp.evaluate(
          ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds),
          viewport,
        );

        for (const page of pages) {
          await goto(window, page.destination);
          const container = window.getByTestId(page.testId);
          await expect(container).toBeVisible();

          const geometry = await container.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const requiredControlBounds = [
              ...element.querySelectorAll<HTMLElement>(
                'button, select, [data-label="Status"] .badge, [data-label="Default"] .badge',
              ),
            ]
              .map((control) => control.getBoundingClientRect())
              .filter((rect) => rect.width > 0 && rect.height > 0)
              .map((rect) => ({
                left: rect.left,
                right: rect.right,
                width: rect.width,
                height: rect.height,
              }));
            return {
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              left: bounds.left,
              right: bounds.right,
              requiredControlBounds,
            };
          });

          expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
          expect(geometry.requiredControlBounds.length).toBeGreaterThan(page.actions.length);
          for (const action of page.actions)
            await expect(container.getByRole('button', { name: action }).first()).toBeVisible();
          for (const control of geometry.requiredControlBounds) {
            expect(control.width).toBeGreaterThan(0);
            expect(control.height).toBeGreaterThan(0);
            expect(control.left).toBeGreaterThanOrEqual(geometry.left - 1);
            expect(control.right).toBeLessThanOrEqual(geometry.right + 1);
          }

          if (
            theme === 'openvacancyradar-dark' &&
            density === 'compact' &&
            viewport.width === 800
          ) {
            await expect(container.getByRole('table')).toBeVisible();
            for (const action of page.actions) {
              const button = container.getByRole('button', { name: action }).first();
              await button.focus();
              await expect(button).toBeFocused();
            }
            const screenshotPath = test.info().outputPath(`${page.testId}-800-dark-compact.png`);
            await window.screenshot({ animations: 'disabled', path: screenshotPath });
            await test.info().attach(`${page.testId}-800-dark-compact`, {
              path: screenshotPath,
              contentType: 'image/png',
            });
          }
        }
      }
    }
  }
});
