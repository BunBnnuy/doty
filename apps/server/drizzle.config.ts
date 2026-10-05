import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config for the online brain's Postgres schema.
 *
 * Only needed for `push`/`generate`/`migrate` — the dev server runs entirely
 * in-memory without a database. Point `DATABASE_URL` at a real instance to
 * generate migrations.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/doty',
  },
  strict: true,
  verbose: true,
});
