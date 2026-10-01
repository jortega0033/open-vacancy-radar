import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ResolveAppIconInput {
  /** Electron's app.getAppPath(); used by development and unpacked builds. */
  appPath: string;
  /** Electron's app.isPackaged. */
  isPackaged: boolean;
  /** Electron's process.resourcesPath; used only by packaged builds. */
  resourcesPath: string;
  /** Injectable for tests; defaults to node:fs existsSync. */
  fileExists?: (path: string) => boolean;
}

/**
 * Resolves a shipped app-icon PNG without assuming a source-tree path in packaged mode.
 * electron-builder copies each packaged icon outside app.asar at the same assets-relative path.
 * Shared by `resolveWindowIcon` (the 256px `BrowserWindow` icon) and `resolveTrayIcon` (the 32px
 * `Tray` icon) -- same dual dev/packaged root logic, different filename.
 */
export function resolveAppIcon(input: ResolveAppIconInput, fileName: string): string | undefined {
  const root = input.isPackaged ? input.resourcesPath : input.appPath;
  const iconPath = join(root, 'assets', 'app-icons', 'png', fileName);
  return (input.fileExists ?? existsSync)(iconPath) ? iconPath : undefined;
}

export type ResolveWindowIconInput = ResolveAppIconInput;

/** Resolves the BrowserWindow icon (256px). */
export function resolveWindowIcon(input: ResolveWindowIconInput): string | undefined {
  return resolveAppIcon(input, 'icon-256.png');
}

export type ResolveTrayIconInput = ResolveAppIconInput;

/** Resolves the system-tray icon (32px -- Windows scales it for high-DPI displays itself). */
export function resolveTrayIcon(input: ResolveTrayIconInput): string | undefined {
  return resolveAppIcon(input, 'icon-32.png');
}
