// Produces a self-contained dist/index.js plus any native runtime assets: `tsc` alone can't, because
// packages/shared and packages/agent-runtime intentionally publish TypeScript source (their
// package.json "main" points at src/index.ts, not a built dist/) so dev tools that already
// understand TS — tsx, Vite, Vitest — get live source with no separate build step. A plain
// `node dist/index.js` run of the compiled daemon can't resolve those the same way (Node's ESM
// loader has no TypeScript support), so this bundles the daemon and every workspace/npm
// dependency it imports into plain JavaScript that Node can run standalone — which is
// exactly what Electron's packaged-mode sidecar (electron/main.ts) needs.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  entryNames: 'index',
  assetNames: '[name]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  loader: { '.node': 'file' },
  banner: {
    // Some bundled CJS dependencies call require() at runtime; under an ESM output there is no
    // ambient `require`, so this is the standard esbuild shim for node+esm bundles.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
