import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './electron/workspace/schema.ts',
  out: './electron/workspace/drizzle',
  dbCredentials: {
    url: '.data/workspace-dev.db',
  },
  strict: true,
  verbose: true,
});
