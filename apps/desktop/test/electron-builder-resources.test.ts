// @vitest-environment node
//
// This test does pure Node work (read a file, run a regex) and touches no DOM, so it opts out of
// this package's default jsdom environment: that also sidesteps a real jsdom quirk where the global
// `URL` constructor resolves a relative second argument against jsdom's own document location
// instead of the given base, silently producing an http: URL instead of the intended file: one.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const configSource = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');

/**
 * `to:` only ever appears inside `extraResources` entries in this config today, so a single pass
 * over the whole file is enough -- not a general YAML parser, and no YAML dependency exists in this
 * package yet to justify pulling one in for a single test. This is deliberately fragile to a
 * reformat (flow-style YAML, a quoted key, a trailing inline comment): that's an accepted trade,
 * not an oversight, because a false failure here is loud and cheap to fix, while the alternative
 * (a hand-rolled YAML dependency for one test) is not obviously cheaper.
 */
function extraResourcesToPaths(yaml: string): string[] {
  return [...yaml.matchAll(/^\s*to:\s*(\S+?)\s*\r?$/gm)].map((match) => match[1]!);
}

describe('electron-builder.yml extraResources vs. runtime path resolution', () => {
  // resolve-daemon-entry.ts, resolve-window-icon.ts, and main.ts's vacancyEngineConfig() each join
  // `process.resourcesPath` with one of these exact relative paths once packaged. Unit tests cover
  // resolve-daemon-entry.ts's and resolve-window-icon.ts's logic in isolation, but nothing
  // previously checked that electron-builder.yml actually ships a file at each path they expect.
  // This only catches drift on the yaml side (a `to:` path renamed or removed here without the
  // resolver following); it can't catch the opposite direction (a resolver's inline path literal
  // renamed without this yaml following), since neither resolver exports its path segments as a
  // named constant this test could import instead of hardcoding its own copy. It is not a
  // substitute for an actual `electron-builder` packaging run.
  it('declares an extraResource "to" path for every location the packaged-app path resolvers expect', () => {
    const toPaths = extraResourcesToPaths(configSource);

    expect(toPaths).toEqual(
      expect.arrayContaining([
        'daemon', // resolve-daemon-entry.ts: join(resourcesPath, 'daemon', 'index.js')
        'assets/app-icons/png/icon-256.png', // resolve-window-icon.ts: resolveWindowIcon()
        'assets/app-icons/png/icon-32.png', // resolve-window-icon.ts: resolveTrayIcon()
        'vacancy-engine/drizzle', // resolve-vacancy-engine-paths.ts: resolveVacancyEngineMigrationsFolder()
        'vacancy-engine/config', // electron/main.ts: vacancyEngineConfig() joins resourcesPath directly
      ]),
    );
  });
});
