import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, goto, test } from './fixtures.js';

/**
 * Letter GENERATION is deliberately out of scope for this suite: `LetterGenerator`'s "Generate"
 * button starts a real AgentDock session on the user's own Claude/Codex CLI (see its docstring:
 * "Generated on your own Claude Code CLI through AgentDock"), which is not reliably available or
 * authenticated on a CI runner. This is the same boundary `packages/agent-runtime/test/` draws for
 * its own CLI-detection tests ("end-to-end failure paths (mocked exec, no real CLI)") — a real CLI
 * invocation is never part of the automated suite.
 *
 * Reading `LetterGenerator.tsx` shows there is no UI path to a non-empty body other than a
 * completed generation: the body `<textarea>` only renders once `hasBody` is true, and for a brand
 * new letter `body` starts as `''`, so "type a first draft by hand into a blank letter" is not a
 * supported flow (confirmed by `LetterGenerator.test.tsx`, whose own hand-edit tests all render
 * `letter={makeLetter()}`, never a body typed into a fresh blank editor). The one supported path to
 * a hand-editable body without AI is opening an *existing* saved letter, whose body is already text.
 * So this suite seeds one saved letter directly through `window.workspace.createLetter` — the exact
 * IPC channel `LetterGenerator`'s own "Save letter" button calls (`handleSave` in
 * `LetterGenerator.tsx`) — and drives everything else (open, hand-edit, save, library, copy,
 * export) through real UI interaction, the same way a user would once that first letter exists.
 */
test.describe('Letters', () => {
  test('opens a saved letter, hand-edits and saves it, then copies and exports it', async ({
    window,
    electronApp,
  }) => {
    // Electron denies every permission request by default (main.ts's `setPermissionRequestHandler`
    // callback(false)), which would make `navigator.clipboard.writeText` reject in this app just as
    // it would for camera/mic/notifications. Granting it here is a test-only override, the renderer
    // equivalent of `cv-library.spec.ts`'s `dialog.showOpenDialog` stub for the native file picker.
    await electronApp.evaluate(({ session }) => {
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
      session.defaultSession.setPermissionCheckHandler(() => true);
    });

    // `window` is Playwright's `Page` fixture in this test's own scope (see `fixtures.ts`), which
    // would shadow the browser global of the same name inside an arrow function closed over it, so
    // this reaches the exposed bridge via `self` (the same object as the page's `window`, typed as
    // `Window & typeof globalThis` in lib.dom, unlike bare `globalThis`) instead.
    const seededBody = 'Dear hiring team, I am writing to express interest in the Senior Frontend Engineer role.';
    const seeded = await window.evaluate(
      (body) =>
        self.workspace.createLetter({
          title: 'Motivation letter — Redwood Software',
          company: 'Redwood Software',
          role: 'Senior Frontend Engineer',
          status: 'draft',
          body,
        }),
      seededBody,
    );
    expect(seeded.body).toBe(seededBody);

    await goto(window, 'Letters');

    // The Library tab is the default view, and it loads on mount, so the seeded letter is already
    // there without needing a manual refresh.
    const row = window.getByRole('row', { name: /Redwood Software/ });
    await expect(row).toContainText('Motivation letter — Redwood Software');
    await expect(row).toContainText('Senior Frontend Engineer');

    await row.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(window.getByRole('tab', { name: 'Generator' })).toHaveAttribute('aria-selected', 'true');

    const body = window.getByRole('textbox', { name: /letter body/i });
    await expect(body).toHaveValue(seededBody);

    const editedBody = `${seededBody} I would welcome the chance to discuss the role further.`;
    await body.fill(editedBody);
    await expect(window.getByText('Unsaved changes.')).toBeVisible();

    await window.getByRole('button', { name: /save changes/i }).click();
    await expect(window.getByText('Saved to your letters.')).toBeVisible();

    // Round-trip through the library and back in, to prove the edit is really persisted (not just
    // held in the editor's own local state) before exercising copy/export against it. Reuses the
    // `row`/`body` locators from above rather than re-querying: Playwright locators re-resolve
    // lazily against the live DOM, so they remain valid across the tab switch and re-render.
    await window.getByRole('tab', { name: 'Library' }).click();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(body).toHaveValue(editedBody);

    // CI runs this suite on headless Linux under xvfb with no window manager (see
    // .github/workflows/e2e.yml), so the BrowserWindow is not guaranteed to already hold real
    // input focus the way it would on a developer's desktop. `navigator.clipboard.writeText`
    // additionally requires `document.hasFocus()`, independent of the permission grant above, so
    // force it explicitly rather than assume the preceding clicks already established it.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
    await window.getByRole('button', { name: /^copy$/i }).click();
    await expect(window.getByText('Copied to clipboard.')).toBeVisible();

    // Export: `system:save-file` (electron/main.ts) drives a real native save dialog, which
    // Playwright cannot click through directly, so it is stubbed exactly like the CV upload
    // picker in `cv-library.spec.ts` — to a real path in a throwaway directory this test owns and
    // cleans up itself, rather than trying to inspect Electron's native dialog.
    const exportDir = mkdtempSync(join(tmpdir(), 'ovr-e2e-letters-export-'));
    try {
      const exportPath = join(exportDir, 'letter.md');
      await electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, exportPath);

      // The export menu is a daisyUI CSS-`:focus`-driven dropdown, not a React-managed open flag
      // (LetterGenerator.tsx's `dropdown dropdown-end`), so the menu item must be waited on
      // explicitly rather than clicked immediately after the toggle: a click dispatched while the
      // dropdown's focus state hasn't settled yet would otherwise be a flaky "not visible" timeout
      // instead of a deterministic pass.
      await window.getByRole('button', { name: /^export$/i }).click();
      const markdownOption = window.getByRole('button', { name: /markdown \(\.md\)/i });
      await expect(markdownOption).toBeVisible();
      await markdownOption.click();
      await expect(window.getByText('Exported.')).toBeVisible();
    } finally {
      rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
