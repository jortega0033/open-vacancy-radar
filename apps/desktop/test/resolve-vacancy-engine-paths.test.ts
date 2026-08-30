import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveVacancyEngineDataRoot,
  resolveVacancyEngineMigrationsFolder,
} from '../electron/resolve-vacancy-engine-paths.js';

const PROJECT_ROOT = join('D:', 'app', 'packages', 'vacancy-engine');
const RESOURCES_PATH = join('D:', 'app', 'resources');
const USER_DATA_PATH = join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'Open Vacancy Radar');

describe('resolveVacancyEngineMigrationsFolder', () => {
  it('dev/unpacked: resolves drizzle/ next to the monorepo project root', () => {
    const result = resolveVacancyEngineMigrationsFolder({
      vacancyEngineProjectRoot: PROJECT_ROOT,
      isPackaged: false,
      resourcesPath: RESOURCES_PATH,
    });
    expect(result).toBe(join(PROJECT_ROOT, 'drizzle'));
  });

  it('packaged: resolves drizzle/ from resourcesPath, never from the monorepo path', () => {
    const result = resolveVacancyEngineMigrationsFolder({
      vacancyEngineProjectRoot: PROJECT_ROOT,
      isPackaged: true,
      resourcesPath: RESOURCES_PATH,
    });
    expect(result).toBe(join(RESOURCES_PATH, 'vacancy-engine', 'drizzle'));
    expect(result).not.toContain('packages');
  });
});

describe('resolveVacancyEngineDataRoot', () => {
  it('dev/unpacked: resolves to the monorepo project root, not userData', () => {
    const result = resolveVacancyEngineDataRoot({
      vacancyEngineProjectRoot: PROJECT_ROOT,
      isPackaged: false,
      userDataPath: USER_DATA_PATH,
    });
    expect(result).toBe(PROJECT_ROOT);
  });

  it('packaged: resolves to a vacancy-engine subdirectory under userData, never the monorepo path', () => {
    const result = resolveVacancyEngineDataRoot({
      vacancyEngineProjectRoot: PROJECT_ROOT,
      isPackaged: true,
      userDataPath: USER_DATA_PATH,
    });
    expect(result).toBe(join(USER_DATA_PATH, 'vacancy-engine'));
    expect(result).not.toContain('packages');
  });
});
