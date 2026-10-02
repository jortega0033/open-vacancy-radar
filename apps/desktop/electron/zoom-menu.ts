import type { MenuItemConstructorOptions } from 'electron';

/**
 * The application menu this app installs, kept in its own module (like external-url.ts and
 * resolve-daemon-entry.ts) so the template is unit-testable without an Electron runtime.
 *
 * Removing the application menu entirely also removes the accelerators Electron's `zoomIn`,
 * `zoomOut` and `resetZoom` roles carry, so users could no longer enlarge text (WCAG 1.4.4, issue
 * #457). This keeps a View menu with only those three roles. The window sets `autoHideMenuBar`, so
 * no menu bar is drawn unless the user presses Alt; the accelerators work either way.
 */
export function buildZoomMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
        // Many layouts type "+" as Shift+=, which Chromium reports as Plus.
        { role: 'zoomIn', accelerator: 'CommandOrControl+Plus', visible: false },
        { role: 'zoomOut', accelerator: 'CommandOrControl+-' },
        { role: 'resetZoom', accelerator: 'CommandOrControl+0' },
      ],
    },
  ];
}
