import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import electron from 'vite-plugin-electron/simple';

// Bundles electron/main.ts and electron/preload.ts with esbuild and drives the Electron
// process during `vite dev` (launch + reload on change); `vite build` produces the same
// dist-electron/ output for packaging. This is the one non-boring dependency in the desktop
// app — chosen over hand-rolled esbuild+concurrently scripting because it's small,
// purpose-built for exactly this main/preload/renderer split, and needs no extra config.

/**
 * `workspace/client.ts`'s `migrate()` call resolves its migrations folder as
 * `<bundle-dir>/drizzle` at runtime (see that file). Rollup only emits the JS it bundles, so the
 * actual `electron/workspace/drizzle/*.sql` + `meta/` files never reach `dist-electron/drizzle`
 * on their own — every `workspace:*` IPC handler would then fail with "Can't find
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
              // at require-time — CJS globals that don't exist once Rollup inlines it into this
              // ESM bundle ("__filename is not defined" at runtime). Keeping it external means
              // it's `require`d from node_modules like any native addon, never bundled.
              external: ['electron', 'better-sqlite3'],
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
  },
});
