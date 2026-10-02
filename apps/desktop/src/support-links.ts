/**
 * Outbound links the app shows as plain anchors. Both open through the existing
 * `setWindowOpenHandler` path in electron/main.ts (https only), so nothing here calls
 * `shell.openExternal` or makes a request of its own. One place, so a link is never copied twice.
 */
export const REPOSITORY_URL = 'https://github.com/jortega0033/open-vacancy-radar';
export const COFFEE_URL = 'https://buymeacoffee.com/jortega0033';
