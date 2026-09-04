// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '**/dist/**',
      '**/dist-electron/**',
      '**/dist-packages/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/release/**',
    ],
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // ADI-15, widened by issue #176: `process/spawn-process.ts` is the single point where the
    // default-deny provider environment allowlist is applied, immediately above the only `spawn()`
    // call in packages/agent-runtime. That "structural, not per-call-site" guarantee rested purely
    // on convention within this one package — a future `execFile`/`spawnSync` import in
    // apps/daemon or apps/desktop/electron (both of which spawn processes of their own: `git` for
    // workspace identity, the daemon sidecar) would have silently bypassed it with nothing to
    // catch it. Enforced across all three now, each with its own single named exception below.
    // Tests are not covered: they legitimately spawn processes directly, including as negative
    // controls.
    files: [
      'packages/agent-runtime/src/**/*.ts',
      'apps/daemon/src/**/*.ts',
      'apps/desktop/electron/**/*.ts',
    ],
    ignores: [
      'packages/agent-runtime/src/process/spawn-process.ts',
      // The one legitimate git spawn (workspace identity, D8/issue #176): env is built through
      // `buildProviderEnvironment` via `gitSafeEnv`, not passed through unchecked.
      'apps/daemon/src/workspace-identity.ts',
      // The one legitimate spawn: the daemon sidecar itself, launched with a filtered environment
      // (`daemon-environment.ts`, ADI-21), not a provider or user-directed child.
      'apps/desktop/electron/main.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:child_process',
              message:
                'Spawn through process/spawn-process.ts, which applies the provider environment allowlist (ADI-15). See SECURITY.md#environment-allowlist-for-spawned-provider-processes.',
            },
            {
              // Node resolves this identically to 'node:child_process' -- the bare specifier is not
              // a weaker or legacy form, just a second valid way to write the same import. Both must
              // be blocked or this rule is a suggestion, not the structural guarantee it claims to be.
              name: 'child_process',
              message:
                'Spawn through process/spawn-process.ts, which applies the provider environment allowlist (ADI-15). See SECURITY.md#environment-allowlist-for-spawned-provider-processes.',
            },
          ],
        },
      ],
    },
  },
  {
    // Bundled into both the renderer (plain Vite) and the Electron main process
    // (vite-plugin-electron) — an Electron- or Node-only import here would compile fine for main
    // and only break (or silently misbehave) in the renderer's build, so it's blocked here rather
    // than relying on a comment alone.
    files: ['apps/desktop/electron/workspace/cv-profile-schema.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['node:*', 'electron', 'electron/*'],
          paths: ['electron', 'fs', 'path', 'os', 'crypto', 'better-sqlite3', 'drizzle-orm'],
        },
      ],
    },
  },
);
