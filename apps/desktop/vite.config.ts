import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import electron from 'vite-plugin-electron/simple';

// Bundles electron/main.ts and electron/preload.ts with esbuild and drives the Electron
// process during `vite dev` (launch + reload on change); `vite build` produces the same
// dist-electron/ output for packaging. This is the one non-boring dependency in the desktop
// app: chosen over hand-rolled esbuild+concurrently scripting because it's small,
// purpose-built for exactly this main/preload/renderer split, and needs no extra config.

/**
 * `workspace/client.ts`'s `migrate()` call resolves its migrations folder as
 * `<bundle-dir>/drizzle` at runtime (see that file). Rollup only emits the JS it bundles, so the
 * actual `electron/workspace/drizzle/*.sql` + `meta/` files never reach `dist-electron/drizzle`
 * on their own: every `workspace:*` IPC handler would then fail with "Can't find
 * meta/_journal.json" the first time the app runs against a fresh database. Copy them alongside
 * the bundle explicitly, once per build.
 */
function copyWorkspaceMigrations(): Plugin {
  return {
    name: 'copy-workspace-migrations',
    closeBundle() {
      cpSync(
        fileURLToPath(new URL('./electron/workspace/drizzle', import.meta.url)),
        fileURLToPath(new URL('./dist-electron/drizzle', import.meta.url)),
        { recursive: true },
      );
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          plugins: [copyWorkspaceMigrations()],
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // better-sqlite3 ships a native .node binding it locates via __dirname/__filename
              // at require-time: CJS globals that don't exist once Rollup inlines it into this
              // ESM bundle ("__filename is not defined" at runtime). Keeping it external means
              // it's `require`d from node_modules like any native addon, never bundled.
              //
              // pino and cheerio (both pulled in transitively via
              // @open-vacancy-radar/vacancy-engine) are external for a different reason: each has
              // an internal dependency whose own CJS module calls `require(<node builtin>)` from
              // inside a dynamically-invoked module factory (pino itself does `require("node:os")`;
              // cheerio's encoding-sniffer -> iconv-lite chain does `require("buffer")`). Vite 8's
              // default bundler (Rolldown) doesn't rewrite that nested `require` the way Rollup
              // did, so it survives into the bundle as a literal `require()` call with no real
              // `require` in scope ("Calling `require` for \"<name>\" in an environment that
              // doesn't expose the `require` function"), crashing the app before any window opens.
              // Externalizing the whole package sidesteps bundling its internals at all -- Node's
              // own ESM-importing-CJS interop loads it directly, same as any other external CJS
              // dependency. If a future dependency bump surfaces the same crash for some other
              // transitively-bundled package, the fix is the same: add it here and move it from
              // devDependencies to a real "dependencies" entry so electron-builder's dependency
              // walker packages it (see the file-level comment in electron-builder.yml).
              external: ['electron', 'better-sqlite3', 'pino', 'cheerio'],
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              // Electron's sandboxed preload loader only supports CommonJS, so force .js/cjs
              // output even though the rest of this project is ESM ("type": "module").
              output: { format: 'cjs', entryFileNames: 'preload.js' },
            },
          },
        },
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // `e2e/**/*.spec.ts` are Playwright specs (see playwright.config.ts), not vitest's: vitest's
    // default include glob would otherwise try to run them too and fail on the API mismatch.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
