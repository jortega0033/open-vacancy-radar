import { join } from 'node:path';

/**
 * Pure path-resolution logic for the vendored vacancy engine's dev-vs-packaged split, factored out
 * of main.ts so it's testable without an Electron runtime (this file imports nothing from
 * 'electron'), matching resolve-daemon-entry.ts's pattern for the same class of bug: something
 * that works in dev and silently breaks once packaged.
 */
export interface ResolveVacancyEngineMigrationsFolderInput {
  /** The dev-mode monorepo path to packages/vacancy-engine. */
  vacancyEngineProjectRoot: string;
  /** Electron's `app.isPackaged`. */
  isPackaged: boolean;
  /** Electron's `process.resourcesPath`; only read when `isPackaged` is true. */
  resourcesPath: string;
}

/** Read-only migration SQL, shipped as an extraResource (see electron-builder.yml) once packaged. */
export function resolveVacancyEngineMigrationsFolder(
  input: ResolveVacancyEngineMigrationsFolderInput,
): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'vacancy-engine', 'drizzle')
    : join(input.vacancyEngineProjectRoot, 'drizzle');
}

export interface ResolveVacancyEngineDataRootInput {
  /** The dev-mode monorepo path to packages/vacancy-engine. */
  vacancyEngineProjectRoot: string;
  /** Electron's `app.isPackaged`. */
  isPackaged: boolean;
  /** Electron's `app.getPath('userData')`; only read when `isPackaged` is true. */
  userDataPath: string;
}

/**
 * Where the engine reads `config/*.json` and writes `reports/`/`.data/`. Once packaged,
 * `resourcesPath` isn't guaranteed writable and isn't the project source tree, so this resolves to
 * a `vacancy-engine` subdirectory under the same per-user app-data directory the database itself
 * lives in; the caller is responsible for seeding `config/` into it from the packaged copy (a
 * side effect, deliberately kept out of this pure function).
 */
export function resolveVacancyEngineDataRoot(input: ResolveVacancyEngineDataRootInput): string {
  return input.isPackaged
    ? join(input.userDataPath, 'vacancy-engine')
    : input.vacancyEngineProjectRoot;
}
