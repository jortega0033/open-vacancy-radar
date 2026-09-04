import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveTrayIcon, resolveWindowIcon } from '../electron/resolve-window-icon.js';

const APP_PATH = join('D:', 'app', 'apps', 'desktop');
const RESOURCES_PATH = join('D:', 'app', 'resources');
const WINDOW_ICON_SUFFIX = ['assets', 'app-icons', 'png', 'icon-256.png'];
const TRAY_ICON_SUFFIX = ['assets', 'app-icons', 'png', 'icon-32.png'];

describe('resolveWindowIcon', () => {
  it('resolves development and unpacked builds from app.getAppPath()', () => {
    const iconPath = join(APP_PATH, ...WINDOW_ICON_SUFFIX);

    expect(
      resolveWindowIcon({
        appPath: APP_PATH,
        isPackaged: false,
        resourcesPath: RESOURCES_PATH,
        fileExists: (path) => path === iconPath,
      }),
    ).toBe(iconPath);
  });

  it('resolves packaged builds from process.resourcesPath, outside app.asar', () => {
    const iconPath = join(RESOURCES_PATH, ...WINDOW_ICON_SUFFIX);
    const fileExists = vi.fn((path: string) => path === iconPath);

    expect(
      resolveWindowIcon({
        appPath: join(RESOURCES_PATH, 'app.asar'),
        isPackaged: true,
        resourcesPath: RESOURCES_PATH,
        fileExists,
      }),
    ).toBe(iconPath);
    expect(fileExists).toHaveBeenCalledWith(iconPath);
  });

  it('returns undefined when the icon is missing', () => {
    expect(
      resolveWindowIcon({
        appPath: APP_PATH,
        isPackaged: false,
        resourcesPath: RESOURCES_PATH,
        fileExists: () => false,
      }),
    ).toBeUndefined();
  });
});

describe('resolveTrayIcon', () => {
  it('resolves development and unpacked builds from app.getAppPath()', () => {
    const iconPath = join(APP_PATH, ...TRAY_ICON_SUFFIX);

    expect(
      resolveTrayIcon({
        appPath: APP_PATH,
        isPackaged: false,
        resourcesPath: RESOURCES_PATH,
        fileExists: (path) => path === iconPath,
      }),
    ).toBe(iconPath);
  });

  it('resolves packaged builds from process.resourcesPath, outside app.asar', () => {
    const iconPath = join(RESOURCES_PATH, ...TRAY_ICON_SUFFIX);
    const fileExists = vi.fn((path: string) => path === iconPath);

    expect(
      resolveTrayIcon({
        appPath: join(RESOURCES_PATH, 'app.asar'),
        isPackaged: true,
        resourcesPath: RESOURCES_PATH,
        fileExists,
      }),
    ).toBe(iconPath);
    expect(fileExists).toHaveBeenCalledWith(iconPath);
  });

  it('returns undefined when the icon is missing', () => {
    expect(
      resolveTrayIcon({
        appPath: APP_PATH,
        isPackaged: false,
        resourcesPath: RESOURCES_PATH,
        fileExists: () => false,
      }),
    ).toBeUndefined();
  });

  it('resolves a different path than resolveWindowIcon (32px, not 256px)', () => {
    const trayPath = resolveTrayIcon({
      appPath: APP_PATH,
      isPackaged: false,
      resourcesPath: RESOURCES_PATH,
      fileExists: () => true,
    });
    const windowPath = resolveWindowIcon({
      appPath: APP_PATH,
      isPackaged: false,
      resourcesPath: RESOURCES_PATH,
      fileExists: () => true,
    });
    expect(trayPath).not.toBe(windowPath);
  });
});
