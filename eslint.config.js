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
